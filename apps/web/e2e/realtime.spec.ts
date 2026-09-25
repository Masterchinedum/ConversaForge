/**
 * OpenAIRealtimeAdapter protocol test without OpenAI: the ephemeral-token endpoint is mocked and the
 * SDP "calls" endpoint is answered by a second RTCPeerConnection inside the page that plays the role
 * of OpenAI (data channel "oai-events"). Verifies the WebRTC handshake shape (POST application/sdp with
 * the ephemeral key), mirroring of transcripts/tool calls to our server, and that tool results and
 * server instructions are forwarded to the model. Real OpenAI audio is NOT exercised here.
 */
import { expect, test } from '@playwright/test';
import { createSession, joinCall } from './helpers';

const FAKE_OPENAI = () => {
  const w = window as any;
  w.__fakeOpenAI = {
    received: [] as any[],
    channel: null as RTCDataChannel | null,
    async answer(offer: string) {
      const pc = new RTCPeerConnection();
      w.__fakeOpenAI.pc = pc;
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        w.__fakeOpenAI.label = ch.label;
        ch.onopen = () => (w.__fakeOpenAI.channel = ch);
        ch.onmessage = (m) => w.__fakeOpenAI.received.push(JSON.parse(m.data));
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: offer });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await new Promise<void>((r) => {
        if (pc.iceGatheringState === 'complete') return r();
        pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r();
        setTimeout(r, 2000);
      });
      return pc.localDescription!.sdp;
    },
    send(ev: unknown) {
      w.__fakeOpenAI.channel.send(JSON.stringify(ev));
    },
  };
};

test('realtime adapter: WebRTC handshake + transcript/tool mirroring + tool results back to the model', async ({ page }) => {
  await page.addInitScript(FAKE_OPENAI);
  let sdpRequest: { auth: string | null; type: string | null; body: string } | null = null;
  await page.route('**/api/runtime/sessions/*/realtime-token', (route) =>
    route.fulfill({ json: { provider: 'openai', model: 'gpt-realtime', clientSecret: 'ek_test_123', expiresAt: 0, callsUrl: `${new URL(page.url()).origin}/__fake_openai/calls` } }),
  );
  await page.route('**/__fake_openai/calls', async (route) => {
    const req = route.request();
    sdpRequest = { auth: req.headers()['authorization'] ?? null, type: req.headers()['content-type'] ?? null, body: req.postData() ?? '' };
    const answer = await page.evaluate((o) => (window as any).__fakeOpenAI.answer(o), sdpRequest.body);
    await route.fulfill({ status: 201, body: answer, contentType: 'application/sdp' });
  });
  const sent: any[] = [];
  let pageWs: any = null;
  await page.routeWebSocket(/\/ws\/session$/, (ws) => {
    pageWs = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      try {
        sent.push(JSON.parse(String(m)));
      } catch {
        /* ignore */
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const d = JSON.parse(String(m));
      if (d.type === 'welcome') d.config = { ...d.config, voiceMode: 'realtime', realtime: { provider: 'openai', model: 'gpt-realtime' } };
      ws.send(JSON.stringify(d));
    });
  });

  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await expect(page.getByTestId('voice-mode')).toContainText('OpenAI Realtime');

  await expect.poll(() => sdpRequest?.auth ?? null, { timeout: 20_000 }).toBe('Bearer ek_test_123');
  expect(sdpRequest!.type).toContain('application/sdp');
  expect(sdpRequest!.body).toContain('m=audio');
  expect(sdpRequest!.body).toContain('m=application'); // data channel
  await expect.poll(() => page.evaluate(() => !!(window as any).__fakeOpenAI.channel), { timeout: 20_000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__fakeOpenAI.label)).toBe('oai-events');

  const fake = (ev: unknown) => page.evaluate((e) => (window as any).__fakeOpenAI.send(e), ev);
  await fake({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_u1', delta: 'Hello from ' });
  await expect(page.getByTestId('partial')).toContainText('Hello from');
  await fake({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_u1', transcript: 'Hello from realtime' });
  await fake({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  await fake({ type: 'response.output_audio_transcript.delta', item_id: 'item_a1', delta: 'Hi, I am ' });
  await fake({ type: 'input_audio_buffer.speech_started' }); // participant barges in
  await fake({ type: 'response.output_audio_transcript.done', item_id: 'item_a1', transcript: 'Hi, I am the realtime agent.' });
  await fake({ type: 'output_audio_buffer.stopped', response_id: 'resp_1' });
  await fake({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'show_card', arguments: '{"title":"x"}' } });
  await fake({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'show_card', arguments: '{"title":"x"}' }); // duplicate signal

  await expect.poll(() => sent.filter((m) => m.type === 'realtime.transcript').length).toBe(2);
  expect(sent.find((m) => m.type === 'realtime.transcript' && m.role === 'user')).toMatchObject({ itemId: 'item_u1', text: 'Hello from realtime' });
  expect(sent.find((m) => m.type === 'realtime.transcript' && m.role === 'assistant')).toMatchObject({ itemId: 'item_a1', interrupted: true });
  await expect.poll(() => sent.filter((m) => m.type === 'realtime.tool_call').length).toBe(1);
  expect(sent.find((m) => m.type === 'realtime.tool_call')).toMatchObject({ callId: 'call_1', name: 'show_card' });
  // Browser-side turn events are not duplicated into the pipeline protocol in realtime mode.
  expect(sent.some((m) => m.type === 'participant.final' || m.type === 'agent.playback')).toBe(false);

  // Server → client: tool result and an instruction are forwarded to the model.
  pageWs.send(JSON.stringify({ type: 'realtime.tool_result', callId: 'call_1', output: '{"ok":true}' }));
  pageWs.send(JSON.stringify({ type: 'realtime.instruction', text: 'Wrap up in one minute.', respond: false }));
  await expect
    .poll(() => page.evaluate(() => (window as any).__fakeOpenAI.received.map((e: any) => e.type)))
    .toEqual(expect.arrayContaining(['conversation.item.create', 'response.create']));
  const received = await page.evaluate(() => (window as any).__fakeOpenAI.received);
  expect(received.find((e: any) => e.item?.type === 'function_call_output')).toMatchObject({ item: { call_id: 'call_1', output: '{"ok":true}' } });
  expect(received.find((e: any) => e.item?.role === 'system')?.item.content[0].text).toBe('Wrap up in one minute.');

  // "I'm done answering" commits the input buffer.
  await page.getByRole('button', { name: /I’m done answering/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fakeOpenAI.received.some((e: any) => e.type === 'input_audio_buffer.commit'))).toBe(true);
});
