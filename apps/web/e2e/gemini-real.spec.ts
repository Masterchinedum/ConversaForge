/**
 * Real Gemini Live smoke test — opt-in, uses the real Gemini key on the API (E2E_REAL_GEMINI=1) and the
 * seeded live-voice scenario named by E2E_SCENARIO_NAME (default "Active listening coaching").
 *
 * The microphone is synthetic. With E2E_ECHO=<gain> (e.g. 0.5) everything the page plays is fed back into
 * the mic after 60 ms at that gain: worst-case speaker echo with no echo cancellation, which is what made
 * the agent interrupt itself and repeat the greeting in the first real call. The test reports whether the
 * greeting played once and uninterrupted, how continuous the playback was (audible start/stop transitions),
 * the transcript rows shown, and any adapter warnings; it asserts the parts that must hold.
 */
import { expect, test } from '@playwright/test';
import { createSession, joinCall } from './helpers';

test('real Gemini Live: greeting plays once, uninterrupted, with (optional) simulated speaker echo', async ({ page }) => {
  test.skip(!process.env.E2E_REAL_GEMINI, 'set E2E_REAL_GEMINI=1 to run against the real Gemini Live API');
  test.setTimeout(150_000);
  const echoGain = Number(process.env.E2E_ECHO ?? '0');
  const listenMs = Number(process.env.E2E_LISTEN_MS ?? '35000');

  const sent: any[] = [];
  const received: any[] = [];
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
      try {
        received.push(JSON.parse(String(m)));
      } catch {
        /* ignore */
      }
      ws.send(m);
    });
  });
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(`${m.type()}: ${m.text()}`);
  });

  // Synthetic mic + speaker-echo tap: the app's AudioContext destination is replaced by a hub that plays
  // to the real output and, attenuated and delayed, into the MediaStream the fake getUserMedia returns.
  await page.addInitScript((gain: number) => {
    const w = window as any;
    const Orig = w.AudioContext;
    const tapped: { stream?: MediaStream } = {};
    class TappedContext extends Orig {
      constructor(...args: any[]) {
        super(...args);
        const real = super.destination;
        const hub = this.createGain();
        hub.connect(real);
        const echoDest = this.createMediaStreamDestination();
        const delay = this.createDelay(1);
        delay.delayTime.value = 0.06;
        const g = this.createGain();
        g.gain.value = gain;
        hub.connect(delay);
        delay.connect(g);
        g.connect(echoDest);
        Object.defineProperty(this, 'destination', { value: hub });
        tapped.stream = echoDest.stream;
      }
    }
    w.AudioContext = TappedContext;
    const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c: any) => {
      if (!c?.audio) return origGum(c);
      if (tapped.stream) return tapped.stream;
      const ctx = new Orig();
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  }, echoGain);

  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await expect(page.getByTestId('voice-mode')).toContainText('Google Gemini Live', { timeout: 30_000 });

  // Sample the adapter every 100 ms while the greeting (and whatever follows) plays.
  const samples: Array<{ t: number; playing: boolean; agentAudible: boolean; gateClosed: boolean; userSpeaking: boolean; generating: boolean; rows: number; player: any }> = [];
  const t0 = Date.now();
  while (Date.now() - t0 < listenMs) {
    samples.push(
      await page.evaluate(() => {
        const v = (window as any).__cfLive?.voice?.();
        const s = v?.debugState?.() ?? {};
        return {
          t: Date.now(),
          playing: !!s.playing,
          agentAudible: !!s.agentAudible,
          gateClosed: !!s.gateClosed,
          userSpeaking: !!s.userSpeaking,
          generating: !!s.generating,
          rows: document.querySelectorAll('[data-testid=transcript] li').length,
          player: s.player ?? null,
        };
      }),
    );
    await page.waitForTimeout(100);
  }

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=transcript] li')].map((li) => `${li.getAttribute('data-speaker')}/${li.getAttribute('data-status')}: ${(li.textContent || '').trim().slice(0, 140)}`),
  );
  const transcripts = sent.filter((m) => m.type === 'realtime.transcript');
  const starts = samples.filter((s, i) => s.playing && (i === 0 || !samples[i - 1]!.playing)).length;
  const firstPlay = samples.find((s) => s.playing);
  const audibleMs = samples.filter((s) => s.playing).length * 100;
  const gateClosedWhilePlaying = samples.filter((s) => s.playing && s.gateClosed).length;
  const playingSamples = samples.filter((s) => s.playing).length;
  const falseBargeIns = samples.filter((s, i) => s.userSpeaking && (i === 0 || !samples[i - 1]!.userSpeaking)).length;

  console.log('\n=== real Gemini Live smoke report ===');
  console.log(`echo gain: ${echoGain} | listened: ${listenMs} ms | first audio after ${firstPlay ? firstPlay.t - t0 : -1} ms`);
  const runs: string[] = [];
  for (let i = 0, from = -1; i <= samples.length; i++) {
    const playing = i < samples.length && samples[i]!.playing;
    if (playing && from < 0) from = i;
    if (!playing && from >= 0) {
      runs.push(`+${samples[from]!.t - t0}ms×${(i - from) * 100}ms`);
      from = -1;
    }
  }
  const last = samples[samples.length - 1]?.player;
  console.log(`audible playback: ${audibleMs} ms in ${starts} run(s) [${runs.join(', ')}]; gate closed during ${gateClosedWhilePlaying}/${playingSamples} playing samples; local speech starts: ${falseBargeIns}`);
  console.log(`player: ${last ? `${last.underruns} underrun(s), ${last.buffers} buffers, received ${last.receivedS.toFixed(2)} s, scheduled ${last.scheduledS.toFixed(2)} s, cushion ${last.cushionS.toFixed(2)} s` : 'n/a'}`);
  console.log(`transcripts mirrored: ${transcripts.map((m) => `${m.role}${m.interrupted ? '(interrupted)' : ''}: ${String(m.text).slice(0, 90)}`).join(' | ')}`);
  console.log(`rows shown (${rows.length}): ${rows.join(' || ')}`);
  console.log(`warnings: ${warnings.filter((x) => !/DevTools|preload|Ephemeral/.test(x)).join(' ; ') || 'none'}`);

  // End the call so the session (and the Gemini stream) does not run on.
  await page.getByRole('button', { name: 'End call' }).click();
  await page.getByRole('button', { name: 'End call' }).last().click();
  await expect(page.getByTestId('call-status')).not.toHaveText('Live', { timeout: 30_000 }).catch(() => undefined);

  // What must hold: the agent spoke, its greeting was mirrored once and not cut, and the transcript is not duplicated.
  expect(firstPlay).toBeTruthy();
  const assistant = transcripts.filter((m) => m.role === 'assistant');
  expect(assistant.length).toBeGreaterThanOrEqual(1);
  expect(assistant.filter((m) => m.interrupted)).toHaveLength(0);
  const agentRows = rows.filter((r) => r.startsWith('AGENT'));
  expect(new Set(agentRows.map((r) => r.replace(/^AGENT\/\w+: /, ''))).size).toBe(agentRows.length);
  // The greeting (≈5.5 s of audio) comes out as one continuous playback, not fragments.
  const longestRunMs = Math.max(0, ...runs.map((r) => Number(/×(\d+)ms/.exec(r)?.[1] ?? 0)));
  expect(longestRunMs).toBeGreaterThanOrEqual(4500);
});
