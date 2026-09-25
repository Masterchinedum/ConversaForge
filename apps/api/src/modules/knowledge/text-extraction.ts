import { UPLOAD_LIMITS } from '@cf/shared';

/**
 * Untrusted document handling: content sniffing (never trust the client-declared mime type),
 * text extraction for PDF / DOCX / plain text, and text sanitation.
 */

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
} as const;

export type DetectedKind = 'pdf' | 'docx' | 'text';

/** Hard cap on extracted characters per document (prevents runaway memory / chunk counts). */
export const MAX_EXTRACTED_CHARS = 2_000_000;
/** Maximum PDF pages we will parse. */
export const MAX_PDF_PAGES = 2_000;
/** Per-document extraction timeout. */
export const EXTRACTION_TIMEOUT_MS = 60_000;

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: 'unsupported_type' | 'invalid_file' | 'too_large' | 'timeout' | 'empty' = 'invalid_file',
  ) {
    super(message);
  }
}

/** Remove control chars (except \n \t), zero-width / bidi-override chars and BOMs; normalize line endings. */
export function sanitizeText(input: string): string {
  return (
    input
      .replace(/\r\n?/g, '\n')
      // C0 controls except \t (09) and \n (0A); DEL and C1 controls
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, ' ')
      // zero-width, word joiner, BOM, bidi embedding/override/isolate controls, soft hyphen
      .replace(/[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, '')
      // Unicode line/paragraph separators → newline
      .replace(/[  ]/g, '\n')
  );
}

/** Collapse runs of spaces, trim lines, keep paragraph breaks (max one blank line). */
export function normalizeWhitespace(input: string): string {
  return input
    .split('\n')
    .map((l) => l.replace(/[ \t  - 　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanText(input: string): string {
  return normalizeWhitespace(sanitizeText(input));
}

/** Sanitize an uploaded file name for display/storage: no paths, no control chars, bounded length. */
export function sanitizeFileName(name: string | undefined | null, fallback = 'document'): string {
  let base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .normalize('NFKC');
  base = sanitizeText(base).replace(/[\n\t]/g, ' ');
  base = base.replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+/, ''); // no hidden files / '..'
  if (!base) base = fallback;
  if (base.length > 120) {
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/** Storage-key-safe variant (ASCII only). */
export function storageSafeName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '');
  return (s || 'document').slice(0, 100);
}

function startsWith(buf: Buffer, sig: number[] | string, offset = 0): boolean {
  const bytes = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  if (buf.length < offset + bytes.length) return false;
  return buf.subarray(offset, offset + bytes.length).equals(bytes);
}

/**
 * Checks that a ZIP archive contains an entry named `word/document.xml` by scanning the central
 * directory / local headers for the file name. (No decompression; this is only a sniff.)
 */
export function zipHasEntry(buf: Buffer, entry: string): boolean {
  const name = Buffer.from(entry, 'utf8');
  // Central directory file header signature: PK\x01\x02, name at offset 46, length at 28.
  let idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (idx !== -1 && idx + 46 <= buf.length) {
    const nameLen = buf.readUInt16LE(idx + 28);
    const n = buf.subarray(idx + 46, idx + 46 + nameLen);
    if (n.equals(name)) return true;
    idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), idx + 4);
  }
  // Fallback: local file headers (PK\x03\x04, name at offset 30, length at 26).
  idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  while (idx !== -1 && idx + 30 <= buf.length) {
    const nameLen = buf.readUInt16LE(idx + 26);
    const n = buf.subarray(idx + 30, idx + 30 + nameLen);
    if (n.equals(name)) return true;
    idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), idx + 4);
  }
  return false;
}

/** True when the buffer is valid UTF-8 and contains no NUL bytes. */
export function isCleanUtf8(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine the real document type from the bytes. The declared mime type / file name only decide
 * between text flavors (plain/markdown/csv). Throws ExtractionError on anything unsupported.
 */
export function sniffDocument(
  buf: Buffer,
  declaredMime?: string | null,
  fileName?: string | null,
): { kind: DetectedKind; mimeType: string } {
  if (!buf.length) throw new ExtractionError('The file is empty', 'empty');
  if (startsWith(buf, '%PDF-')) return { kind: 'pdf', mimeType: MIME.pdf };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    if (zipHasEntry(buf, 'word/document.xml')) return { kind: 'docx', mimeType: MIME.docx };
    throw new ExtractionError('Unsupported ZIP-based file. Upload a PDF, Word (.docx), text, Markdown or CSV file.', 'unsupported_type');
  }
  // Strip UTF-8 BOM before validation.
  const body = startsWith(buf, [0xef, 0xbb, 0xbf]) ? buf.subarray(3) : buf;
  if (!isCleanUtf8(body)) {
    throw new ExtractionError(
      'Unsupported or binary file. Upload a PDF, Word (.docx), or UTF-8 text / Markdown / CSV file.',
      'unsupported_type',
    );
  }
  const lowerName = (fileName ?? '').toLowerCase();
  const mime = (declaredMime ?? '').toLowerCase().split(';')[0]!.trim();
  let mimeType: string = MIME.txt;
  if (mime === MIME.md || mime === 'text/x-markdown' || /\.(md|markdown)$/.test(lowerName)) mimeType = MIME.md;
  else if (mime === MIME.csv || /\.csv$/.test(lowerName)) mimeType = MIME.csv;
  return { kind: 'text', mimeType };
}

/** Assert the declared type is one we accept at all (defense in depth; sniffing decides). */
export function assertAllowedUpload(sizeBytes: number, detectedMime: string) {
  const lim = UPLOAD_LIMITS.knowledgeDocument;
  if (sizeBytes > lim.maxBytes) {
    throw new ExtractionError(`File is too large (max ${Math.round(lim.maxBytes / 1024 / 1024)} MB)`, 'too_large');
  }
  if (!(lim.mimeTypes as readonly string[]).includes(detectedMime)) {
    throw new ExtractionError('Unsupported file type', 'unsupported_type');
  }
}

export interface ExtractedPage {
  page: number | null;
  text: string;
}
export interface ExtractedDocument {
  pages: ExtractedPage[];
  pageCount: number | null;
  charCount: number;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new ExtractionError(`${what} timed out after ${Math.round(ms / 1000)} s`, 'timeout')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// unpdf is ESM-only; load it lazily via a real dynamic import (tsc would otherwise turn it into require()).
const importEsm = new Function('s', 'return import(s)') as <T = any>(s: string) => Promise<T>;

async function extractPdf(buf: Buffer): Promise<ExtractedDocument> {
  let unpdf: any;
  try {
    unpdf = await importEsm('unpdf');
  } catch (e: any) {
    throw new ExtractionError(`PDF support is unavailable: ${e?.message ?? e}`);
  }
  let pdf: any;
  try {
    pdf = await unpdf.getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/password/i.test(msg)) throw new ExtractionError('The PDF is password-protected. Remove the password and upload it again.');
    throw new ExtractionError(`Could not read the PDF (${msg.slice(0, 200)})`);
  }
  try {
    const numPages: number = pdf.numPages ?? 0;
    if (numPages > MAX_PDF_PAGES) throw new ExtractionError(`The PDF has ${numPages} pages (max ${MAX_PDF_PAGES})`, 'too_large');
    const res = await unpdf.extractText(pdf, { mergePages: false });
    const raw: string[] = Array.isArray(res.text) ? res.text : [String(res.text ?? '')];
    const pages: ExtractedPage[] = [];
    let total = 0;
    raw.forEach((t, i) => {
      const text = cleanText(t);
      total += text.length;
      if (total > MAX_EXTRACTED_CHARS) {
        throw new ExtractionError(`The document contains more than ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters of text`, 'too_large');
      }
      pages.push({ page: i + 1, text });
    });
    return { pages, pageCount: res.totalPages ?? numPages, charCount: total };
  } finally {
    try {
      await pdf.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

async function extractDocx(buf: Buffer): Promise<ExtractedDocument> {
  const mammoth: any = await import('mammoth');
  const fn = mammoth.extractRawText ?? mammoth.default?.extractRawText;
  let value: string;
  try {
    const r = await fn({ buffer: buf });
    value = String(r.value ?? '');
  } catch (e: any) {
    throw new ExtractionError(`Could not read the Word document (${String(e?.message ?? e).slice(0, 200)})`);
  }
  const text = cleanText(value);
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new ExtractionError(`The document contains more than ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters of text`, 'too_large');
  }
  return { pages: [{ page: null, text }], pageCount: null, charCount: text.length };
}

function extractPlain(buf: Buffer): ExtractedDocument {
  const text = cleanText(buf.toString('utf8'));
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new ExtractionError(`The document contains more than ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters of text`, 'too_large');
  }
  return { pages: [{ page: null, text }], pageCount: null, charCount: text.length };
}

/**
 * Extract text from an untrusted document buffer. The kind is always re-sniffed from the bytes.
 * Enforces size caps and a timeout.
 */
export async function extractDocument(
  buf: Buffer,
  declaredMime?: string | null,
  opts: { maxBytes?: number; timeoutMs?: number; fileName?: string | null } = {},
): Promise<ExtractedDocument & { mimeType: string; kind: DetectedKind }> {
  const maxBytes = opts.maxBytes ?? UPLOAD_LIMITS.knowledgeDocument.maxBytes;
  if (buf.length > maxBytes) throw new ExtractionError(`File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`, 'too_large');
  const { kind, mimeType } = sniffDocument(buf, declaredMime, opts.fileName);
  const timeoutMs = opts.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
  const doc =
    kind === 'pdf'
      ? await withTimeout(extractPdf(buf), timeoutMs, 'PDF text extraction')
      : kind === 'docx'
        ? await withTimeout(extractDocx(buf), timeoutMs, 'Word text extraction')
        : extractPlain(buf);
  return { ...doc, mimeType, kind };
}
