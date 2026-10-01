/**
 * End-of-turn detection for client-side speech recognition.
 *
 * People pause while thinking. Committing a participant turn on the first short pause makes the agent
 * interrupt them, so we accumulate recognized text and only commit after `silenceMs` of silence — and
 * when the utterance looks unfinished (trailing filler/conjunction, very short, "let me think") we keep
 * waiting up to `graceMs` since the last speech. Push-to-talk release and "I'm done" commit immediately.
 *
 * Pure logic with injectable clock/timers so it can be unit-tested without a browser.
 */

const TRAILING_INCOMPLETE = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'er',
  'erm',
  'hmm',
  'mm',
  'so',
  'and',
  'because',
  'cause',
  'but',
  'like',
  'or',
  'then',
  'if',
  'that',
  'which',
  'with',
  'to',
  'the',
  'a',
  'an',
  'of',
  'for',
  'my',
  'our',
  'is',
  'was',
  'well',
  'also',
  'although',
  'however',
  'since',
  'when',
  'while',
]);

const TRAILING_PHRASES = ['i think', 'i guess', 'i mean', 'you know', 'kind of', 'sort of', 'let me see', 'the thing is'];

const THINKING_PHRASES = [
  'let me think',
  'let me see',
  'give me a second',
  'give me a sec',
  'give me a moment',
  'give me a minute',
  'one second',
  'one sec',
  'one moment',
  'hold on',
  'hang on',
  'just a second',
  'just a moment',
  'bear with me',
];

export const MIN_COMPLETE_WORDS = 3;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heuristic: does this utterance look like the speaker is still mid-thought? */
export function isLikelyIncomplete(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  // Trailing comma, dash or ellipsis from the recognizer's punctuation.
  if (/(,|…|\.\.\.|-|—|–)\s*$/.test(raw)) return true;
  const norm = normalize(raw);
  const words = norm.split(' ').filter(Boolean);
  if (words.length < MIN_COMPLETE_WORDS) return true;
  const last = words[words.length - 1]!;
  if (TRAILING_INCOMPLETE.has(last)) return true;
  const tail = words.slice(-3).join(' ');
  if (TRAILING_PHRASES.some((p) => tail.endsWith(p))) return true;
  // "let me think" / "give me a second" said near the end of what we have so far.
  const lastClause = words.slice(-7).join(' ');
  if (THINKING_PHRASES.some((p) => lastClause.includes(p))) return true;
  return false;
}

export interface EndOfTurnOptions {
  silenceMs: number;
  graceMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface EndOfTurnCallbacks {
  onCommit: (text: string, info: { startedAt: number; endedAt: number; confidence?: number; reason: CommitReason }) => void;
  onThinking?: (waiting: boolean) => void;
}

export type CommitReason = 'silence' | 'grace_elapsed' | 'manual';

export class EndOfTurnDetector {
  private finals: string[] = [];
  private confidences: number[] = [];
  private interim = '';
  private startedAt: number | null = null;
  private lastActivityAt = 0;
  private voiceActive = false;
  private timer: unknown = null;
  private waiting = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(
    private opts: EndOfTurnOptions,
    private cb: EndOfTurnCallbacks,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  updateOptions(o: Partial<Pick<EndOfTurnOptions, 'silenceMs' | 'graceMs'>>) {
    this.opts = { ...this.opts, ...o };
  }

  /** Current (uncommitted) utterance text. */
  get text(): string {
    return [...this.finals, this.interim].map((s) => s.trim()).filter(Boolean).join(' ');
  }

  get hasContent(): boolean {
    return this.text.length > 0;
  }

  get isWaitingForThought(): boolean {
    return this.waiting;
  }

  /** A recognizer result that will not change any more. */
  addFinal(segment: string, confidence?: number) {
    const s = segment.trim();
    this.interim = '';
    if (s) {
      this.finals.push(s);
      if (typeof confidence === 'number' && confidence > 0) this.confidences.push(confidence);
    }
    this.activity();
  }

  /** The recognizer's current hypothesis for the in-progress segment. */
  setInterim(segment: string) {
    const changed = segment.trim() !== this.interim;
    this.interim = segment.trim();
    if (changed) this.activity();
  }

  /** VAD edge: while the participant is making sound we never commit. */
  setVoiceActive(active: boolean) {
    if (active === this.voiceActive) return;
    this.voiceActive = active;
    if (active) {
      if (this.hasContent || this.startedAt !== null) this.activity();
      else this.clear();
    } else if (this.hasContent) {
      this.lastActivityAt = this.now();
      this.schedule();
    }
  }

  /** Commit immediately (push-to-talk release, "I'm done answering"). */
  commitNow() {
    this.commit('manual');
  }

  /** Discard the current utterance (e.g. it was agent echo). */
  reset() {
    this.clear();
    this.finals = [];
    this.confidences = [];
    this.interim = '';
    this.startedAt = null;
    this.setWaiting(false);
  }

  dispose() {
    this.clear();
  }

  private activity() {
    const t = this.now();
    if (this.startedAt === null && this.hasContent) this.startedAt = t;
    this.lastActivityAt = t;
    this.setWaiting(false);
    this.schedule();
  }

  private schedule() {
    this.clear();
    if (!this.hasContent || this.voiceActive) return;
    const elapsed = this.now() - this.lastActivityAt;
    const wait = Math.max(0, this.opts.silenceMs - elapsed);
    this.timer = this.setTimer(() => this.onSilence(), wait);
  }

  private onSilence() {
    this.timer = null;
    if (!this.hasContent || this.voiceActive) return;
    const silentFor = this.now() - this.lastActivityAt;
    const grace = Math.max(this.opts.graceMs, this.opts.silenceMs);
    if (silentFor < grace && isLikelyIncomplete(this.text)) {
      this.setWaiting(true);
      this.timer = this.setTimer(() => {
        this.timer = null;
        if (this.voiceActive) return;
        this.commit('grace_elapsed');
      }, grace - silentFor);
      return;
    }
    this.commit(silentFor >= grace && isLikelyIncomplete(this.text) ? 'grace_elapsed' : 'silence');
  }

  private commit(reason: CommitReason) {
    this.clear();
    const text = this.text;
    const startedAt = this.startedAt ?? this.now();
    const endedAt = reason === 'manual' ? this.now() : this.lastActivityAt || this.now();
    const confidence = this.confidences.length
      ? this.confidences.reduce((a, b) => a + b, 0) / this.confidences.length
      : undefined;
    this.finals = [];
    this.confidences = [];
    this.interim = '';
    this.startedAt = null;
    this.setWaiting(false);
    if (text) this.cb.onCommit(text, { startedAt, endedAt, confidence, reason });
  }

  private setWaiting(w: boolean) {
    if (w === this.waiting) return;
    this.waiting = w;
    this.cb.onThinking?.(w);
  }

  private clear() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
