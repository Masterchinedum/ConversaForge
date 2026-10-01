/**
 * ServerPipelineAdapter end to end with mocked speech providers: the session runs on the real API,
 * the welcome config is rewritten to stt/tts = openai (as when a workspace has an OpenAI key), and the
 * /stt and /tts endpoints are fulfilled by the test (no provider credentials here).
 * The fake microphone plays a file with 1 s of tone followed by 4 s of silence (looped), so the energy
 * VAD produces real utterance segments.
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, joinCall } from './helpers';

function toneWav(toneSec: number, silenceSec: number, rate = 16000, freq = 220, amp = 0.35): Buffer {
  const n = Math.round((toneSec + silenceSec) * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t < toneSec ? Math.sin(2 * Math.PI * freq * t) * amp : 0;
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}

test('server speech pipeline: VAD segments → /stt (WAV) → committed turns; agent audio via /tts with playback events', async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), 'cf-e2e-'));
  const micFile = join(dir, 'speech.wav');
  writeFileSync(micFile, toneWav(1.2, 4));
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3000', permissions: ['microphone'] });
  const page = await context.newPage();

  const sttBodies: Buffer[] = [];
  let ttsCalls = 0;
  await page.route('**/api/runtime/sessions/*/stt', async (route) => {
    sttBodies.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
    await route.fulfill({ json: { text: `I would start with the requirements (${sttBodies.length}).`, confidence: 0.93 } });
  });
  await page.route('**/api/runtime/sessions/*/tts', async (route) => {
    ttsCalls++;
    await route.fulfill({ body: toneWav(0.6, 0.1, 24000, 440, 0.2), contentType: 'audio/wav' });
  });
  const sent: any[] = [];
  await page.routeWebSocket(/\/ws\/session$/, (ws) => {
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
      if (d.type === 'welcome') d.config = { ...d.config, stt: 'openai', tts: 'openai' };
      ws.send(JSON.stringify(d));
    });
  });

  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await expect(page.getByTestId('voice-mode')).toContainText('Server speech');

  // Agent greeting spoken through server TTS (WebAudio) → playback started/completed reported.
  await expect.poll(() => ttsCalls, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => sent.filter((m) => m.type === 'agent.playback').map((m) => m.event).join(','), { timeout: 20_000 })
    .toContain('started,completed');

  // Tone bursts become WAV segments posted to /stt; text is committed after the silence window.
  await expect.poll(() => sttBodies.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(sttBodies[0]!.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(sttBodies[0]!.subarray(8, 12).toString('latin1')).toBe('WAVE');
  await expect(page.locator('[data-testid="transcript"] li[data-speaker="PARTICIPANT"][data-status="saved"]').first()).toContainText(
    'I would start with the requirements',
    { timeout: 30_000 },
  );
  const final = sent.find((m) => m.type === 'participant.final');
  expect(final.source).toBe('server_stt');
  expect(sent.some((m) => m.type === 'participant.speaking' && m.speaking === true)).toBe(true);
  await browser.close();
});
