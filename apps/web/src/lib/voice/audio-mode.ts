/**
 * Gemini Live audio handling (experiment, 2026-09-30):
 *   - 'managed' (default): echo gate + local VAD decide what mic audio reaches Gemini; the agent is ducked
 *     and cut locally when the participant talks over it; start-of-speech sensitivity LOW.
 *   - 'plain': Google's reference setup — the mic streams continuously (browser echo cancellation only) and
 *     Gemini's own activity detection handles turn-taking and barge-in; default start sensitivity.
 *
 * Chosen on the device-check screen of your own test calls (▶ Try it), or with `?audio=plain` /
 * `?audio=managed` on the live page; remembered in this browser.
 */
export type LiveAudioMode = 'managed' | 'plain';

const KEY = 'cf.liveAudioMode';
const OWN_TEST = (sessionId: string) => `cf:selftest:${sessionId}`;

export function liveAudioMode(): LiveAudioMode {
  if (typeof window === 'undefined') return 'managed';
  try {
    const q = new URLSearchParams(window.location.search).get('audio');
    if (q === 'plain' || q === 'managed') {
      localStorage.setItem(KEY, q);
      return q;
    }
    return localStorage.getItem(KEY) === 'plain' ? 'plain' : 'managed';
  } catch {
    return 'managed';
  }
}

/** An explicit choice (device-check switch): stored, and a `?audio=` left in the URL no longer overrides it. */
export function setLiveAudioMode(mode: LiveAudioMode) {
  try {
    localStorage.setItem(KEY, mode);
    const url = new URL(window.location.href);
    if (url.searchParams.has('audio')) {
      url.searchParams.delete('audio');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
  } catch {
    /* storage unavailable: the call uses managed */
  }
}

/** A session this browser started with ▶ Try it (the experiment switch is shown only there). */
export function markOwnTestSession(sessionId: string) {
  try {
    localStorage.setItem(OWN_TEST(sessionId), '1');
  } catch {
    /* storage unavailable */
  }
}

export function isOwnTestSession(sessionId: string): boolean {
  try {
    return localStorage.getItem(OWN_TEST(sessionId)) === '1';
  } catch {
    return false;
  }
}
