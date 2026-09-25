/**
 * Browser-speech adapter + end-of-turn logic in the real UI against the real API.
 * Headless Chromium has no working speech recognition, so we install a scripted SpeechRecognition
 * (same event shape as Chrome's) and a silent fake microphone (so the energy VAD stays quiet).
 */
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, joinCall } from './helpers';

function silentWav(seconds = 30, rate = 16000): Buffer {
  const n = seconds * rate;
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
  return b;
}

const FAKE_SR = () => {
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = 'en-US';
    maxAlternatives = 1;
    onstart: any = null;
    onend: any = null;
    onerror: any = null;
    onresult: any = null;
    onspeechstart: any = null;
    onspeechend: any = null;
    running = false;
    results: Array<{ transcript: string; isFinal: boolean }> = [];
    start() {
      if (this.running) throw new DOMException('already started', 'InvalidStateError');
      this.running = true;
      (window as any).__sr = this;
      (window as any).__srStarts = ((window as any).__srStarts ?? 0) + 1;
      setTimeout(() => this.onstart?.(), 0);
    }
    stop() {
      this.finish();
    }
    abort() {
      this.finish();
    }
    private finish() {
      if (!this.running) return;
      this.running = false;
      this.results = [];
      setTimeout(() => this.onend?.(), 0);
    }
    emit(transcript: string, isFinal: boolean) {
      if (!this.running) return false;
      // Replace the trailing interim result (like Chrome), keep finals.
      const last = this.results[this.results.length - 1];
      const index = last && !last.isFinal ? this.results.length - 1 : this.results.length;
      this.results[index] = { transcript, isFinal };
      const list: any = this.results.map((r) => Object.assign([{ transcript: r.transcript, confidence: 0.9 }], { isFinal: r.isFinal }));
      this.onresult?.({ resultIndex: index, results: list });
      return true;
    }
  }
  (window as any).SpeechRecognition = FakeRecognition;
  (window as any).webkitSpeechRecognition = FakeRecognition;
};

async function say(page: Page, text: string, isFinal = true) {
  await expect.poll(() => page.evaluate(([t, f]) => (window as any).__sr?.emit(t, f) ?? false, [text, isFinal] as const)).toBe(true);
}

const participantSaved = (page: Page) => page.locator('[data-testid="transcript"] li[data-speaker="PARTICIPANT"][data-status="saved"]');

test('browser speech: thinking pauses are not cut off; silence, "I’m done" and PTT commit', async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'cf-e2e-'));
  const wav = join(dir, 'silence.wav');
  writeFileSync(wav, silentWav());
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  const context = await browser.newContext({ baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3000', permissions: ['microphone'] });
  await context.addInitScript(FAKE_SR);
  const page = await context.newPage();
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await expect(page.getByTestId('voice-mode')).toContainText('Browser speech');
  // Wait for the greeting to be spoken/finished and recognition to be running.
  await expect.poll(() => page.evaluate(() => !!(window as any).__sr?.running), { timeout: 30_000 }).toBe(true);

  // 1) Interim text shows as a grey partial.
  await say(page, 'So the first thing', false);
  await expect(page.getByTestId('partial')).toContainText('So the first thing');

  // 2) Utterance ending in a filler → not committed after the normal 1.2 s silence; indicator shown.
  await say(page, 'So the first thing I would do is, um', true);
  await expect(page.getByTestId('activity')).toHaveText('Listening… take your time', { timeout: 5000 });
  await page.waitForTimeout(3000);
  await expect(participantSaved(page)).toHaveCount(0);

  // 3) They continue; after the silence window the whole thought is committed as ONE turn.
  await say(page, 'add a cache in front of the database.', true);
  await expect(participantSaved(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(participantSaved(page).first()).toContainText('So the first thing I would do is, um add a cache in front of the database.');

  // 4) A complete sentence commits after ~endOfTurnSilenceMs (not immediately).
  await expect.poll(() => page.evaluate(() => !!(window as any).__sr?.running), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(500);
  const t0 = Date.now();
  await say(page, 'We would shard the users table by tenant id to spread the load.', true);
  await expect(participantSaved(page)).toHaveCount(2, { timeout: 10_000 });
  const took = Date.now() - t0;
  expect(took).toBeGreaterThan(1000);

  // 5) Short answer ("Yes") would wait for the thinking grace — "I’m done answering" commits now.
  await expect.poll(() => page.evaluate(() => !!(window as any).__sr?.running), { timeout: 30_000 }).toBe(true);
  await say(page, 'Yes', true);
  await expect(page.getByTestId('activity')).toHaveText('Listening… take your time', { timeout: 5000 });
  await page.getByRole('button', { name: /I’m done answering/ }).click();
  await expect(participantSaved(page)).toHaveCount(3, { timeout: 5000 });

  // 6) Push-to-talk: recognition only runs while held; release commits immediately.
  await page.getByLabel('Push to talk').check();
  await expect.poll(() => page.evaluate(() => !!(window as any).__sr?.running)).toBe(false);
  const talk = page.getByRole('button', { name: 'Hold to talk' });
  await talk.hover();
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => !!(window as any).__sr?.running)).toBe(true);
  await say(page, 'Push to talk works', false);
  await page.mouse.up();
  await expect(participantSaved(page)).toHaveCount(4, { timeout: 5000 });
  await expect(participantSaved(page).nth(3)).toContainText('Push to talk works');

  await browser.close();
});
