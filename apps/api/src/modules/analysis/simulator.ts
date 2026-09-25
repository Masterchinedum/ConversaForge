/**
 * LOCAL DEVELOPMENT SIMULATOR for post-session analysis — not an AI judgment.
 * Used only when no AI provider is configured. It is deterministic and uses only real transcript text:
 * every quote it cites is a verbatim excerpt of a participant turn. Results are always flagged simulated.
 */
import type { ExtractionVariable, RubricCriterion } from '@cf/shared';
import type { SpeakerKind, TurnLike } from './evidence';

export const SIMULATED_SUMMARY_PREFIX = 'Simulated analysis (no AI provider configured)';

const STOPWORDS = new Set(
  'a an and are as at be been being but by can could did do does doing for from had has have having he her here hers him his how i if in into is it its just me more most my no nor not of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours also able well good strong weak clear clearly uses using used shows show participant candidate agent person their them they about each every any all'.split(
    ' ',
  ),
);

function stem(w: string): string {
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ly')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function keywordStems(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 4 && !STOPWORDS.has(w)).map(stem));
}

function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/** A verbatim excerpt of `text` (≤ maxChars, cut at a word boundary) — always a real substring. */
function excerpt(text: string, maxChars = 220): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).trim();
}

function bestSentence(text: string, stems: Set<string>): string {
  let best = text;
  let bestHits = -1;
  for (const s of sentences(text)) {
    const hits = [...keywordStems(s)].filter((k) => stems.has(k)).length;
    if (hits > bestHits && s.split(/\s+/).length >= 3) {
      best = s;
      bestHits = hits;
    }
  }
  return excerpt(best);
}

interface Signals {
  numbers: number;
  firstPerson: number;
  examples: number;
  avgWords: number;
}

function signals(turns: TurnLike[]): Signals {
  let numbers = 0;
  let firstPerson = 0;
  let examples = 0;
  let totalWords = 0;
  for (const t of turns) {
    numbers += (t.text.match(/\b\d+(?:[.,]\d+)?\s*(?:%|percent|k|m|x|years?|months?|weeks?|days?|hours?|people|customers|users)?\b/gi) ?? []).length;
    firstPerson += (t.text.match(/\b(I|I'm|I've|I'd|my|we|our)\b/g) ?? []).length;
    examples += (t.text.match(/\b(for example|for instance|such as|when I|one time|last (?:year|quarter|month)|as a result|which led|so that)\b/gi) ?? []).length;
    totalWords += words(t.text).length;
  }
  return { numbers, firstPerson, examples, avgWords: turns.length ? totalWords / turns.length : 0 };
}

export interface SimCriterion {
  criterionId: string;
  score: number | null;
  insufficientEvidence: boolean;
  confidence: number;
  rationale: string;
  evidence: Array<{ turnSeq: number; quote: string }>;
}

export function simulateScoring(
  criteria: RubricCriterion[],
  turns: TurnLike[],
  subject: SpeakerKind | null,
): {
  criteria: SimCriterion[];
  summary: string;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
  notes: Array<{ text: string; turnSeqs: number[] }>;
} {
  const subjectTurns = turns.filter((t) => (subject ? t.speaker === subject : t.speaker !== 'SYSTEM') && t.text.trim());
  const results: SimCriterion[] = criteria.map((c) => {
    const stems = keywordStems(`${c.name} ${c.description} ${c.strongPerformance}`);
    const matches = subjectTurns
      .map((t) => ({ t, overlap: [...keywordStems(t.text)].filter((k) => stems.has(k)) }))
      .filter((m) => m.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length || a.t.seq - b.t.seq);
    if (!matches.length) {
      return {
        criterionId: c.id,
        score: null,
        insufficientEvidence: true,
        confidence: 0.2,
        rationale: `Simulated heuristic: no ${subject === 'AGENT' ? 'agent' : 'participant'} turn mentions anything related to "${c.name}", so there is not enough evidence to score it.`,
        evidence: [],
      };
    }
    const top = matches.slice(0, 3);
    const sig = signals(top.map((m) => m.t));
    const maxOverlap = top[0]!.overlap.length;
    let score = 40 + Math.min(20, maxOverlap * 6);
    score += Math.min(10, sig.numbers * 4) + Math.min(8, sig.firstPerson * 2) + Math.min(8, sig.examples * 4);
    if (sig.avgWords < 8) score -= 12;
    else if (sig.avgWords > 30) score += 8;
    else score += Math.round((sig.avgWords - 8) / 5);
    score = Math.max(5, Math.min(95, Math.round(score)));
    const matchedWords = [...new Set(top.flatMap((m) => m.overlap))].slice(0, 6);
    return {
      criterionId: c.id,
      score,
      insufficientEvidence: false,
      confidence: Math.min(0.6, 0.25 + 0.1 * matches.length),
      rationale:
        `Simulated heuristic (not an AI judgment): ${matches.length} turn(s) overlap with this criterion (${matchedWords.join(', ')}). ` +
        `Specificity signals in the best matches: ${sig.numbers} number(s), ${sig.firstPerson} first-person statement(s), ${sig.examples} example marker(s); average answer length ${Math.round(sig.avgWords)} words.`,
      evidence: top.slice(0, 2).map((m) => ({ turnSeq: m.t.seq, quote: bestSentence(m.t.text, stems) })),
    };
  });

  const scored = results.filter((r) => r.score !== null).sort((a, b) => b.score! - a.score!);
  const name = (id: string) => criteria.find((c) => c.id === id)?.name ?? id;
  const strengths = scored.slice(0, 2).filter((r) => r.score! >= 55).map((r) => `${name(r.criterionId)}: the answers touched on this topic with some specifics.`);
  const weaknesses = [
    ...scored.slice(-2).filter((r) => r.score! < 55).map((r) => `${name(r.criterionId)}: answers were brief or lacked concrete detail.`),
    ...results.filter((r) => r.insufficientEvidence).map((r) => `${name(r.criterionId)}: not addressed in the conversation.`),
  ];
  const improvements = results
    .filter((r) => r.insufficientEvidence || (r.score ?? 100) < 60)
    .slice(0, 4)
    .map((r) => {
      const c = criteria.find((x) => x.id === r.criterionId)!;
      return c.strongPerformance
        ? `Practise "${c.name}": aim for — ${c.strongPerformance}`
        : `Practise "${c.name}" with a specific example, including numbers and the outcome.`;
    });
  if (!improvements.length) improvements.push('Keep using concrete examples with measurable outcomes.');
  const longest = [...subjectTurns].sort((a, b) => b.text.length - a.text.length)[0];
  return {
    criteria: results,
    summary: `${SIMULATED_SUMMARY_PREFIX}. This is a deterministic keyword heuristic for local development, not an AI assessment. ${scored.length} of ${criteria.length} criteria had matching evidence in ${subjectTurns.length} ${subject === 'AGENT' ? 'agent' : 'participant'} turn(s).`,
    strengths,
    weaknesses,
    improvements,
    notes: longest ? [{ text: 'Longest answer in the conversation.', turnSeqs: [longest.seq] }] : [],
  };
}

// ── Extraction ──

function varStems(v: ExtractionVariable): Set<string> {
  return keywordStems(`${v.key.replace(/_/g, ' ')} ${v.description}`);
}

function parseNumber(s: string): number | null {
  const m = /(-?\$?\s?\d[\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)?\b/i.exec(s);
  if (!m) return null;
  let n = Number(m[1]!.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const suf = m[2]?.toLowerCase();
  if (suf === 'k' || suf === 'thousand') n *= 1000;
  if (suf === 'm' || suf === 'million') n *= 1_000_000;
  return n;
}

/** The number closest (in words) to a variable keyword, preferring sentences that mention the keyword. */
function numberNearKeyword(text: string, stems: Set<string>): number | null {
  const ranked = sentences(text)
    .map((s) => ({ s, hits: [...keywordStems(s)].filter((k) => stems.has(k)).length }))
    .filter((x) => /\d/.test(x.s))
    .sort((a, b) => b.hits - a.hits);
  for (const { s, hits } of ranked) {
    const toks = s.split(/\s+/);
    const kwPos = toks.map((w, i) => (stems.has(stem(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))) ? i : -1)).filter((i) => i >= 0);
    let best: { n: number; d: number } | null = null;
    toks.forEach((w, i) => {
      if (!/\d/.test(w) || /\d{4}-\d{2}-\d{2}/.test(w) || /^\d{1,2}:\d{2}/.test(w)) return;
      const n = parseNumber(toks.slice(i, i + 2).join(' '));
      if (n === null) return;
      const d = kwPos.length ? Math.min(...kwPos.map((k) => Math.abs(k - i))) : 99;
      if (!best || d < best.d) best = { n, d };
    });
    if (best && hits > 0) return (best as { n: number }).n;
  }
  return null;
}

export function simulateExtraction(
  vars: ExtractionVariable[],
  turns: TurnLike[],
): { values: Record<string, { value: unknown; evidenceTurnSeqs: number[]; confidence: number }> } {
  const spoken = turns.filter((t) => t.speaker !== 'SYSTEM' && t.text.trim());
  const participant = spoken.filter((t) => t.speaker === 'PARTICIPANT');
  const values: Record<string, { value: unknown; evidenceTurnSeqs: number[]; confidence: number }> = {};
  const none = { value: null, evidenceTurnSeqs: [], confidence: 0 };
  const participantFirst = (a: TurnLike, b: TurnLike) => (a.speaker === 'PARTICIPANT' ? 0 : 1) - (b.speaker === 'PARTICIPANT' ? 0 : 1) || a.seq - b.seq;

  for (const v of vars) {
    const stems = varStems(v);
    const mentions = (t: TurnLike) => [...keywordStems(t.text)].some((k) => stems.has(k));
    // Answers: a turn directly following a question (from the other speaker) that mentions the variable.
    const answers = spoken.filter((t, i) => {
      const prev = spoken[i - 1];
      return !!prev && prev.speaker !== t.speaker && prev.text.includes('?') && mentions(prev);
    });
    const related = spoken.filter(mentions).sort(participantFirst);
    const candidates = [...answers.sort(participantFirst), ...related.filter((t) => !answers.includes(t))];

    let found: { value: unknown; seq: number } | null = null;
    switch (v.type) {
      case 'number':
        for (const t of candidates) {
          const n = numberNearKeyword(t.text, stems);
          if (n !== null) {
            found = { value: n, seq: t.seq };
            break;
          }
        }
        break;
      case 'boolean':
        for (const t of answers) {
          const s = t.text.trim().toLowerCase();
          if (/^(yes|yeah|yep|sure|absolutely|definitely|correct|i do|i am|i have|i can)\b/.test(s)) found = { value: true, seq: t.seq };
          else if (/^(no|nope|not really|never|i don't|i do not|i'm not|i am not|i haven't|i can't)\b/.test(s)) found = { value: false, seq: t.seq };
          if (found) break;
        }
        break;
      case 'date':
        for (const t of [...candidates, ...participant]) {
          const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t.text);
          if (m) {
            found = { value: m[1], seq: t.seq };
            break;
          }
        }
        break;
      case 'list': {
        let best: { items: string[]; seq: number; score: number } | null = null;
        for (const t of candidates) {
          for (const s of sentences(t.text).filter((x) => x.includes(','))) {
            const tail = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
            const items = tail
              .split(/,|\band\b/)
              .map((x) => x.replace(/[.!?]$/, '').trim())
              .filter((x) => x && x.split(/\s+/).length <= 6 && !/^(yes|no|yeah|ok|okay)$/i.test(x));
            const score = items.length + (s.includes(':') ? 2 : 0) + (t.speaker === 'PARTICIPANT' ? 0.5 : 0);
            if (items.length >= 2 && (!best || score > best.score)) best = { items, seq: t.seq, score };
          }
        }
        if (best) found = { value: best.items, seq: best.seq };
        break;
      }
      case 'text':
        if (v.enumValues?.length) {
          outer: for (const t of [...candidates, ...participant]) {
            for (const ev of v.enumValues) {
              if (new RegExp(`\\b${ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t.text)) {
                found = { value: ev, seq: t.seq };
                break outer;
              }
            }
          }
        } else if (candidates[0]) {
          found = { value: bestSentence(candidates[0].text, stems), seq: candidates[0].seq };
        }
        break;
    }
    values[v.key] = found ? { value: found.value, evidenceTurnSeqs: [found.seq], confidence: 0.35 } : none;
  }
  return { values };
}
