import type { ExtractedPage } from './text-extraction';

/**
 * Splits extracted document text into overlapping chunks for full-text retrieval.
 *
 * - Target ~800 tokens per chunk (≈ 3,300 chars at ~4 chars/token), hard max ~3,600 chars.
 * - ~15% overlap between consecutive chunks (taken from the end of the previous chunk, aligned
 *   to a sentence/word boundary).
 * - Splits on paragraph boundaries first, then sentences, then words (never mid-word unless a
 *   single "word" exceeds the max).
 * - Chunks never span PDF pages, so every chunk has an exact `page` (null for non-paginated docs).
 * - `heading` is the nearest preceding Markdown-style heading (`# …`) or a short Title-like line.
 */

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  overlapRatio?: number;
}

export interface Chunk {
  ordinal: number;
  text: string;
  page: number | null;
  heading: string | null;
  tokenCount: number;
}

const DEFAULTS: Required<ChunkOptions> = { targetChars: 3300, maxChars: 3600, overlapRatio: 0.15 };

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const MD_HEADING = /^(#{1,6})\s+(.{1,200}?)\s*#*$/;

/** Detect a heading line: Markdown `#` headings, or a numbered section title like "3.2 Refunds". */
export function headingOf(line: string): string | null {
  const t = line.trim();
  const m = MD_HEADING.exec(t);
  if (m) return m[2]!.trim();
  if (/^\d+(\.\d+)*\.?\s+[A-Z][^.!?]{1,80}$/.test(t) && t.length <= 90) return t;
  return null;
}

/** Split text into sentence-ish units (keeps terminal punctuation). */
function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    out.push(m[0]);
    if (re.lastIndex >= text.length) break;
  }
  return out.length ? out : [text];
}

/** Break an over-long unit into pieces ≤ max at word boundaries (hard-cut only if unavoidable). */
function splitLong(unit: string, max: number): string[] {
  if (unit.length <= max) return [unit];
  const parts: string[] = [];
  let rest = unit;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Overlap tail: last ~n chars of `text`, starting at a sentence (or word) boundary. */
function overlapTail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? '' : text;
  const start = text.length - n;
  const window = text.slice(start);
  // Prefer a sentence boundary in the first half of the window.
  const sent = window.search(/[.!?]\s+\S/);
  if (sent !== -1 && sent < n * 0.6) return window.slice(sent + 1).trimStart();
  const sp = window.indexOf(' ');
  return sp !== -1 && sp < n * 0.5 ? window.slice(sp + 1) : window;
}

interface Unit {
  text: string;
  heading: string | null;
  /** Paragraph separator before this unit. */
  sep: string;
  isHeading?: boolean;
}

function unitsForPage(text: string, headingState: { current: string | null }, max: number): Unit[] {
  const units: Unit[] = [];
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    const lines = para.split('\n');
    // Headings can appear as their own line at the top of a paragraph.
    const buf: string[] = [];
    for (const line of lines) {
      const h = headingOf(line);
      if (h) {
        if (buf.length) {
          pushPara(buf.join('\n'));
          buf.length = 0;
        }
        headingState.current = h;
        units.push({ text: line.trim(), heading: h, sep: '\n\n', isHeading: true });
      } else {
        buf.push(line);
      }
    }
    if (buf.length) pushPara(buf.join('\n'));
  }
  return units;

  function pushPara(p: string) {
    const trimmed = p.trim();
    if (!trimmed) return;
    if (trimmed.length <= max) {
      units.push({ text: trimmed, heading: headingState.current, sep: '\n\n' });
      return;
    }
    let first = true;
    for (const s of sentences(trimmed)) {
      for (const piece of splitLong(s.trim(), max)) {
        if (!piece) continue;
        units.push({ text: piece, heading: headingState.current, sep: first ? '\n\n' : ' ' });
        first = false;
      }
    }
  }
}

export function chunkDocument(pages: ExtractedPage[], options: ChunkOptions = {}): Chunk[] {
  const opt = { ...DEFAULTS, ...options };
  const overlapChars = Math.floor(opt.targetChars * opt.overlapRatio);
  const chunks: Chunk[] = [];
  const headingState = { current: null as string | null };

  for (const page of pages) {
    if (!page.text.trim()) continue;
    const units = unitsForPage(page.text, headingState, opt.maxChars - overlapChars);
    let cur = '';
    let curHeading: string | null = null;
    let hasNew = false; // chunk contains content beyond the overlap prefix

    const flush = () => {
      const text = cur.trim();
      if (text && hasNew) {
        chunks.push({ ordinal: chunks.length, text, page: page.page, heading: curHeading, tokenCount: estimateTokens(text) });
      }
      const tail = overlapTail(text, overlapChars);
      cur = tail;
      hasNew = false;
    };

    for (const u of units) {
      // Start a fresh chunk at a section heading once the current chunk has substance,
      // without carrying overlap from the previous section.
      if (u.isHeading && hasNew && cur.length > opt.targetChars * 0.4) {
        flush();
        cur = '';
      }
      const addition = (cur ? u.sep : '') + u.text;
      if (cur.length + addition.length > opt.targetChars && hasNew) {
        flush();
      }
      // A heading starting a new section: don't carry a tail from the previous section into it
      // if the chunk has nothing new yet (keeps sections clean).
      if (!hasNew) curHeading = u.heading;
      cur += (cur ? u.sep : '') + u.text;
      hasNew = true;
      if (cur.length > opt.maxChars) {
        // Only possible when overlap + a max-size unit exceeds maxChars; trim the overlap prefix.
        cur = cur.slice(cur.length - opt.maxChars);
      }
    }
    if (hasNew) flush();
  }
  return chunks;
}
