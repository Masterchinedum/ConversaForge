/**
 * Evidence verification — the model is never trusted to quote correctly.
 * Every quote the model cites must actually appear (after normalization, with a small tolerance for
 * transcription noise) in the turn it cites, and that turn must be spoken by the evaluated subject.
 */

export type SpeakerKind = 'AGENT' | 'PARTICIPANT' | 'SYSTEM';

export interface TurnLike {
  seq: number;
  speaker: SpeakerKind;
  text: string;
}

export interface EvidenceItem {
  turnSeq: number;
  quote: string;
}

export const MAX_QUOTE_CHARS = 500;
export const MAX_EVIDENCE_PER_CRITERION = 6;

/** Lowercase, unify quotes/dashes, strip punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/'/g, '') // "don't" ≈ "dont"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

/** Longest common subsequence length of two token arrays. */
function lcs(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'hmm', 'mm', 'like', 'you', 'know']);

/**
 * Find a fragment inside a turn. Exact normalized substring first; otherwise a sliding-window fuzzy
 * match (token LCS ≥ 85% of the fragment, min 4 tokens) tolerating dropped fillers / STT noise.
 * Returns the index (in tokens) after the match, or -1.
 */
function findFragment(fragTokens: string[], turnTokens: string[], from: number): number {
  const m = fragTokens.length;
  if (!m) return from;
  // exact (token-aligned) match
  outer: for (let i = from; i + m <= turnTokens.length; i++) {
    for (let k = 0; k < m; k++) if (turnTokens[i + k] !== fragTokens[k]) continue outer;
    return i + m;
  }
  if (m < 4) return -1;
  const threshold = 0.85;
  const content = fragTokens.filter((t) => !FILLERS.has(t));
  const winMin = Math.max(1, Math.floor(m * 0.8));
  const winMax = Math.ceil(m * 1.25) + 1;
  for (let i = from; i < turnTokens.length; i++) {
    for (let w = winMin; w <= winMax && i + w <= turnTokens.length; w++) {
      const window = turnTokens.slice(i, i + w);
      const score = lcs(fragTokens, window) / m;
      const contentScore = content.length ? lcs(content, window.filter((t) => !FILLERS.has(t))) / content.length : score;
      if (score >= threshold || contentScore >= 0.9) return i + w;
    }
  }
  return -1;
}

/**
 * True if `quote` appears in `turnText`. Ellipses in a quote ("I led … the migration") split it into
 * fragments that must all appear, in order.
 */
export function quoteAppearsIn(quote: string, turnText: string): boolean {
  if (typeof quote !== 'string' || typeof turnText !== 'string') return false;
  const turnTokens = tokens(turnText);
  if (!turnTokens.length) return false;
  const fragments = quote
    .split(/\.{3,}|…|\[\s*\.\.\.\s*\]/)
    .map((f) => tokens(f))
    .filter((f) => f.length > 0);
  if (!fragments.length) return false;
  let pos = 0;
  for (const f of fragments) {
    pos = findFragment(f, turnTokens, pos);
    if (pos < 0) return false;
  }
  return true;
}

/**
 * Which speaker a rubric's "evaluated subject" refers to. Default: the participant.
 * Returns null when evidence may come from either side (e.g. "the conversation as a whole").
 */
export function subjectSpeaker(evaluatedSubject: string | undefined | null): SpeakerKind | null {
  const s = (evaluatedSubject ?? '').toLowerCase();
  const mentionsAgent = /\b(agent|assistant|ai|bot|interviewer|coach)\b/.test(s);
  const mentionsParticipant =
    /\b(participant|candidate|learner|user|student|rep|representative|seller|salesperson|employee|trainee|manager|caller|customer|applicant|you)\b/.test(
      s,
    );
  if (/\b(both|conversation|dialogue|everyone|all speakers)\b/.test(s)) return null;
  if (mentionsAgent && !mentionsParticipant) return 'AGENT';
  return 'PARTICIPANT';
}

export interface VerifyResult {
  kept: EvidenceItem[];
  dropped: Array<EvidenceItem & { reason: 'unknown_turn' | 'wrong_speaker' | 'quote_not_found' | 'malformed' }>;
}

/** Keep only evidence whose quote really appears in the cited turn spoken by the evaluated subject. */
export function verifyEvidence(
  evidence: unknown,
  turnsBySeq: Map<number, TurnLike>,
  requiredSpeaker: SpeakerKind | null,
): VerifyResult {
  const kept: EvidenceItem[] = [];
  const dropped: VerifyResult['dropped'] = [];
  if (!Array.isArray(evidence)) return { kept, dropped };
  const seen = new Set<string>();
  for (const raw of evidence) {
    const turnSeq = Number((raw as any)?.turnSeq);
    const quote = typeof (raw as any)?.quote === 'string' ? ((raw as any).quote as string).trim() : '';
    if (!Number.isInteger(turnSeq) || !quote) {
      dropped.push({ turnSeq: Number.isFinite(turnSeq) ? turnSeq : -1, quote, reason: 'malformed' });
      continue;
    }
    const turn = turnsBySeq.get(turnSeq);
    if (!turn) {
      dropped.push({ turnSeq, quote, reason: 'unknown_turn' });
      continue;
    }
    if (requiredSpeaker && turn.speaker !== requiredSpeaker) {
      dropped.push({ turnSeq, quote, reason: 'wrong_speaker' });
      continue;
    }
    if (!quoteAppearsIn(quote, turn.text)) {
      dropped.push({ turnSeq, quote, reason: 'quote_not_found' });
      continue;
    }
    const key = `${turnSeq}:${normalizeText(quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length < MAX_EVIDENCE_PER_CRITERION) {
      kept.push({ turnSeq, quote: quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS - 1)}…` : quote });
    }
  }
  return { kept, dropped };
}

/**
 * Safety net for the "never consider protected traits" rule: remove sentences from model-written text
 * that reference protected personal characteristics. Returns the cleaned text and how many were removed.
 */
const PROTECTED_RE =
  /\b(age|aged|ageing|aging|elderly|gender|sex|male|female|race|racial|ethnicity|ethnic|religion|religious|disability|disabled|pregnan\w*|nationality|national origin|accent|accented|sexual orientation|gay|lesbian|transgender|marital status|married|family status|health condition|medical condition|skin colou?r)\b/i;

export function redactProtected(text: string): { text: string; removed: number } {
  if (!text) return { text, removed: 0 };
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text];
  let removed = 0;
  const kept = sentences.filter((s) => {
    if (PROTECTED_RE.test(s)) {
      removed++;
      return false;
    }
    return true;
  });
  return { text: kept.join('').trim(), removed };
}
