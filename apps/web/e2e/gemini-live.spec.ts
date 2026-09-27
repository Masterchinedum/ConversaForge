/**
 * GeminiLiveAdapter protocol test without Google: the ephemeral-token endpoint is mocked and the Gemini Live
 * WebSocket (wss://generativelanguage.googleapis.com/…BidiGenerateContentConstrained) is answered by a fake
 * server via `page.routeWebSocket`, driving the REAL @google/genai browser SDK. Verifies: the constrained
 * endpoint + ephemeral token, the setup message (no instructions/tools in the browser), PCM16 16 kHz mic
 * chunks, transcripts mirrored to our server exactly once (input → participant, output → agent), barge-in
 * (`interrupted`) stopping playback immediately with a truncated agent turn, tool calls round-tripping via
 * our server, instructions deferred while the model speaks, goAway → resumed connection with the handle,
 * and "I'm done answering" → audioStreamEnd. Real Gemini audio is NOT exercised here.
 */
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { createSession, joinCall } from './helpers';

/** base64 PCM16 mono of a 440 Hz tone (`ms` long) at `rate`. */
function tone(ms: number, rate = 24000): string {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  return buf.toString('base64');
}

interface FakeConn {
  url: string;
  ws: WebSocketRoute;
  received: any[];
}

test('Gemini Live adapter: ephemeral-token connect, transcripts once, barge-in, tools, instructions, resume', async ({ page }) => {
  test.setTimeout(150_000);
  const tokenRequests: any[] = [];
  let tokenN = 0;
  await page.route('**/api/runtime/sessions/*/realtime-token', async (route) => {
    tokenRequests.push(route.request().postDataJSON() ?? {});
    tokenN++;
    const resumeHandle = tokenRequests.at(-1)?.resumeHandle;
    await route.fulfill({
      json: {
        provider: 'google',
        model: 'gemini-live-test',
        token: `auth_tokens/test-eph-${tokenN}`,
        apiVersion: 'v1alpha',
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
        newSessionExpiresAt: Math.floor(Date.now() / 1000) + 120,
        voice: 'Kore',
        connectConfig: { responseModalities: ['AUDIO'], inputAudioTranscription: {}, outputAudioTranscription: {}, sessionResumption: resumeHandle ? { handle: resumeHandle } : {} },
        audio: { inputMimeType: 'audio/pcm;rate=16000', inputSampleRate: 16000, outputSampleRate: 24000 },
        resumed: !!resumeHandle,
      },
    });
  });

  // Fake Gemini Live server.
  const conns: FakeConn[] = [];
  await page.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    const c: FakeConn = { url: ws.url(), ws, received: [] };
    conns.push(c);
    ws.onMessage((m) => {
      const d = JSON.parse(typeof m === 'string' ? m : m.toString('utf8'));
      c.received.push(d);
      if (d.setup) ws.send(JSON.stringify({ setupComplete: {} }));
    });
  });

  // Our session socket: capture what the page sends; make the session look like a Gemini Live session.
  const sent: any[] = [];
  let pageWs: WebSocketRoute | null = null;
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
      if (d.type === 'welcome') d.config = { ...d.config, voiceMode: 'realtime', requestedVoiceMode: 'realtime', realtime: { provider: 'google', model: 'gemini-live-test' } };
      // The real session runs the pipeline; keep its agent turns out of this protocol test.
      if (['agent.start', 'agent.delta', 'agent.end'].includes(d.type)) return;
      ws.send(JSON.stringify(d));
    });
  });

  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await expect(page.getByTestId('voice-mode')).toContainText('Google Gemini Live');
  await expect(page.getByTestId('live-fallback')).toHaveCount(0);

  // ── Connection: constrained endpoint with the ephemeral token; setup carries no prompt/tools ──
  await expect.poll(() => conns.length, { timeout: 20_000 }).toBe(1);
  const c1 = conns[0]!;
  expect(c1.url).toContain('/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained');
  expect(c1.url).toContain('access_token=auth_tokens/test-eph-1');
  const setup = c1.received[0].setup;
  expect(setup.model).toBe('models/gemini-live-test');
  expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
  expect(setup.inputAudioTranscription).toEqual({});
  expect(setup.outputAudioTranscription).toEqual({});
  expect(setup.systemInstruction).toBeUndefined();
  expect(setup.tools).toBeUndefined();
  expect(tokenRequests[0]).toEqual({});

  // ── Mic audio streams as PCM16 16 kHz (~100 ms chunks) ──
  await expect.poll(() => c1.received.filter((m) => m.realtimeInput?.audio).length, { timeout: 20_000 }).toBeGreaterThan(3);
  const chunk = c1.received.find((m) => m.realtimeInput?.audio).realtimeInput.audio;
  expect(chunk.mimeType).toBe('audio/pcm;rate=16000');
  const bytes = Buffer.from(chunk.data, 'base64').length;
  expect(bytes % 2).toBe(0);
  expect(bytes).toBeGreaterThan(2400); // ≈ 3200 bytes per 100 ms at 16 kHz
  expect(bytes).toBeLessThan(4400);

  const gem = (msg: unknown) => c1.ws.send(JSON.stringify(msg));
  const voice = () => page.evaluate(() => (window as any).__cfLive.voice()?.debugState?.());
  const transcripts = () => sent.filter((m) => m.type === 'realtime.transcript');

  // ── The opening instruction reaches the model as a client text turn ──
  pageWs!.send(JSON.stringify({ type: 'realtime.instruction', text: 'Begin now. Say: Hello there.', respond: true }));
  await expect.poll(() => c1.received.filter((m) => m.clientContent).length).toBe(1);
  const opening = c1.received.find((m) => m.clientContent).clientContent;
  expect(opening.turnComplete).toBe(true);
  expect(opening.turns[0].role).toBe('user');
  expect(opening.turns[0].parts[0].text).toContain('Begin now. Say: Hello there.');
  expect(opening.turns[0].parts[0].text).toContain('not said by the participant');

  // ── Turn 1: participant speaks, the agent answers, participant barges in ──
  gem({ serverContent: { inputTranscription: { text: 'Hello from ' } } });
  await expect(page.getByTestId('partial')).toContainText('Hello from');
  gem({ serverContent: { inputTranscription: { text: 'Gemini.' } } });
  gem({ serverContent: { outputTranscription: { text: 'Hi, I am the Gemini agent and I will ask you a few questions today.' } } });
  gem({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone(3000) } }] } } });
  await expect.poll(async () => (await voice())?.playing, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await voice())?.agentAudible).toBe(true);
  // An instruction while the model is speaking is held back (client content would interrupt it).
  pageWs!.send(JSON.stringify({ type: 'realtime.instruction', text: 'Wrap up in one minute.', respond: false }));
  await page.waitForTimeout(700);
  gem({ serverContent: { interrupted: true } });
  await expect.poll(async () => (await voice())?.playing, { timeout: 2000 }).toBe(false);
  await expect.poll(async () => (await voice())?.agentAudible).toBe(false);
  expect(c1.received.filter((m) => m.clientContent).length).toBe(1);
  gem({ serverContent: { turnComplete: true } });

  await expect.poll(() => transcripts().length).toBe(2);
  const [u1, a1] = transcripts();
  expect(u1).toMatchObject({ role: 'user', text: 'Hello from Gemini.' });
  expect(a1).toMatchObject({ role: 'assistant', interrupted: true });
  expect(a1.text.length).toBeLessThan('Hi, I am the Gemini agent and I will ask you a few questions today.'.length);
  expect('Hi, I am the Gemini agent and I will ask you a few questions today.'.startsWith(a1.text)).toBe(true);
  expect(u1.itemId).not.toBe(a1.itemId);
  // The deferred instruction goes out once the model's turn is over (does not ask for a response).
  await expect.poll(() => c1.received.filter((m) => m.clientContent).length).toBe(2);
  const wrap = c1.received.filter((m) => m.clientContent)[1].clientContent;
  expect(wrap.turns[0].parts[0].text).toContain('Wrap up in one minute.');
  expect(wrap.turnComplete).toBe(false);

  // ── Turn 2: a complete answer; nothing is mirrored twice ──
  gem({ serverContent: { inputTranscription: { text: 'I lead the payments team.' } } });
  gem({ serverContent: { outputTranscription: { text: 'Thanks. ' } } });
  gem({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone(200) } }] } } });
  gem({ serverContent: { outputTranscription: { text: 'What changed as a result?' } } });
  gem({ serverContent: { generationComplete: true } });
  gem({ serverContent: { turnComplete: true } });
  await expect.poll(() => transcripts().length).toBe(4);
  expect(transcripts()[2]).toMatchObject({ role: 'user', text: 'I lead the payments team.' });
  expect(transcripts()[3]).toMatchObject({ role: 'assistant', text: 'Thanks. What changed as a result?' });
  expect(transcripts()[3].interrupted).toBeUndefined();
  // Browser-side turn events are not duplicated into the pipeline protocol in live mode.
  expect(sent.some((m) => m.type === 'participant.final' || m.type === 'agent.playback')).toBe(false);
  expect(new Set(transcripts().map((t) => t.itemId)).size).toBe(4);

  // ── Tool call round trip (deduplicated), result back via toolResponse ──
  gem({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'show_card', args: { title: 'x' } }] } });
  gem({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'show_card', args: { title: 'x' } }] } });
  await expect.poll(() => sent.filter((m) => m.type === 'realtime.tool_call').length).toBe(1);
  expect(sent.find((m) => m.type === 'realtime.tool_call')).toEqual({ type: 'realtime.tool_call', callId: 'fc-1', name: 'show_card', arguments: '{"title":"x"}' });
  pageWs!.send(JSON.stringify({ type: 'realtime.tool_result', callId: 'fc-1', output: '{"ok":true}' }));
  await expect.poll(() => c1.received.filter((m) => m.toolResponse).length).toBe(1);
  expect(c1.received.find((m) => m.toolResponse).toolResponse.functionResponses).toEqual([{ id: 'fc-1', name: 'show_card', response: { output: '{"ok":true}' } }]);

  // ── "I'm done answering" flushes Gemini's activity detection ──
  await page.getByRole('button', { name: /I’m done answering/ }).click();
  await expect.poll(() => c1.received.some((m) => m.realtimeInput?.audioStreamEnd === true)).toBe(true);

  // ── goAway → reconnect with a fresh token that resumes the session by handle ──
  gem({ sessionResumptionUpdate: { newHandle: 'resume-handle-1', resumable: true } });
  gem({ goAway: { timeLeft: '10s' } });
  await expect.poll(() => conns.length, { timeout: 20_000 }).toBe(2);
  expect(tokenRequests[1]).toEqual({ resumeHandle: 'resume-handle-1' });
  const c2 = conns[1]!;
  expect(c2.url).toContain('access_token=auth_tokens/test-eph-2');
  await expect.poll(() => c2.received[0]?.setup?.sessionResumption).toEqual({ handle: 'resume-handle-1' });
  await expect.poll(() => c2.received.filter((m) => m.realtimeInput?.audio).length, { timeout: 20_000 }).toBeGreaterThan(0);
  // Items on the new connection get new ids (the server dedupes by id).
  c2.ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'Still here.', finished: true } } }));
  await expect.poll(() => transcripts().length).toBe(5);
  expect(transcripts()[4]).toMatchObject({ role: 'user', text: 'Still here.' });
  expect(await page.getByTestId('voice-mode').innerText()).toContain('Google Gemini Live');
});

test('Gemini Live unavailable on the server → pipeline fallback is clearly indicated', async ({ page }) => {
  await page.route('**/api/runtime/sessions/*/realtime-token', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'provider_unavailable', message: 'Google Gemini Live is not configured.' } } }),
  );
  await page.routeWebSocket(/\/ws\/session$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const d = JSON.parse(String(m));
      if (d.type === 'welcome') d.config = { ...d.config, voiceMode: 'realtime', requestedVoiceMode: 'realtime', realtime: { provider: 'google', model: 'gemini-live-test' } };
      ws.send(JSON.stringify(d));
    });
  });
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await expect(page.getByTestId('live-fallback')).toContainText('Live voice unavailable — using');
  await expect(page.getByTestId('voice-mode')).not.toContainText('Gemini');
  await expect(page.getByText(/Live voice is not configured on the server/)).toBeVisible();
});
