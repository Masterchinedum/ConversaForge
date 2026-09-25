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

/** Sum of declared uncompressed sizes in a ZIP central directory (zip-bomb guard). */
export function zipUncompressedSize(buf: Buffer): number {
  let total = 0;
  const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let idx = buf.indexOf(sig);
  while (idx !== -1 && idx + 46 <= buf.length) {
    total += buf.readUInt32LE(idx + 24);
    idx = buf.indexOf(sig, idx + 4);
  }
  return total;
}

/** Max total uncompressed size of a DOCX archive. */
export const MAX_DOCX_UNCOMPRESSED = 200 * 1024 * 1024;

/**
 * PDF / DOCX parsing runs in a short-lived worker thread: a hostile file cannot block the event loop,
 * memory is capped via resourceLimits, and the worker is terminated on timeout.
 * (Also sidesteps unpdf's internal dynamic import, which does not work inside jest's VM.)
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const bytes = new Uint8Array(workerData.bytes);
    if (workerData.kind === 'pdf') {
      const u = require(workerData.modPath);
      const pdf = await u.getDocumentProxy(bytes, { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
      const numPages = pdf.numPages || 0;
      if (numPages > workerData.maxPages) {
        parentPort.postMessage({ ok: false, code: 'too_large', error: 'The PDF has ' + numPages + ' pages (max ' + workerData.maxPages + ')' });
        return;
      }
      const r = await u.extractText(pdf, { mergePages: false });
      const pages = Array.isArray(r.text) ? r.text : [String(r.text || '')];
      try { await pdf.destroy(); } catch (e) {}
      parentPort.postMessage({ ok: true, pages, totalPages: r.totalPages || numPages });
    } else {
      const m = require(workerData.modPath);
      const fn = m.extractRawText || (m.default && m.default.extractRawText);
      const r = await fn({ buffer: Buffer.from(bytes) });
      parentPort.postMessage({ ok: true, pages: [String(r.value || '')], totalPages: null });
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    parentPort.postMessage({ ok: false, code: /password/i.test(msg) ? 'password' : 'invalid_file', error: msg.slice(0, 300) });
  }
})();
`;

function runParser(
  kind: 'pdf' | 'docx',
  buf: Buffer,
  timeoutMs: number,
): Promise<{ pages: string[]; totalPages: number | null }> {
  const { Worker } = require('node:worker_threads') as typeof import('node:worker_threads');
  const modPath = require.resolve(kind === 'pdf' ? 'unpdf' : 'mammoth');
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { kind, modPath, bytes, maxPages: MAX_PDF_PAGES },
      transferList: [bytes as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      fn();
    };
    const label = kind === 'pdf' ? 'PDF' : 'Word document';
    const timer = setTimeout(
      () => done(() => reject(new ExtractionError(`${label} text extraction timed out after ${Math.round(timeoutMs / 1000)} s`, 'timeout'))),
      timeoutMs,
    );
    worker.once('message', (msg: any) =>
      done(() => {
        if (msg?.ok) return resolve({ pages: msg.pages, totalPages: msg.totalPages });
        if (msg?.code === 'too_large') return reject(new ExtractionError(msg.error, 'too_large'));
        if (msg?.code === 'password') {
          return reject(new ExtractionError('The PDF is password-protected. Remove the password and upload it again.'));
        }
        reject(new ExtractionError(`Could not read the ${label} (${msg?.error ?? 'unknown error'})`));
      }),
    );
    worker.once('error', (e: any) =>
      done(() =>
        reject(
          new ExtractionError(
            e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `The ${label} is too complex to process` : `Could not read the ${label} (${String(e?.message ?? e).slice(0, 200)})`,
            e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too_large' : 'invalid_file',
          ),
        ),
      ),
    );
    worker.once('exit', (code) => done(() => reject(new ExtractionError(`The ${label} parser stopped unexpectedly (exit ${code})`))));
  });
}

function tooMuchText(): ExtractionError {
  return new ExtractionError(`The document contains more than ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters of text`, 'too_large');
}

async function extractPdf(buf: Buffer, timeoutMs: number): Promise<ExtractedDocument> {
  const r = await runParser('pdf', buf, timeoutMs);
  const pages: ExtractedPage[] = [];
  let total = 0;
  r.pages.forEach((t, i) => {
    const text = cleanText(String(t ?? ''));
    total += text.length;
    if (total > MAX_EXTRACTED_CHARS) throw tooMuchText();
    pages.push({ page: i + 1, text });
  });
  return { pages, pageCount: r.totalPages ?? pages.length, charCount: total };
}

async function extractDocx(buf: Buffer, timeoutMs: number): Promise<ExtractedDocument> {
  if (zipUncompressedSize(buf) > MAX_DOCX_UNCOMPRESSED) {
    throw new ExtractionError('The Word document expands to more than 200 MB and cannot be processed', 'too_large');
  }
  const r = await runParser('docx', buf, timeoutMs);
  const text = cleanText(r.pages.join('\n\n'));
  if (text.length > MAX_EXTRACTED_CHARS) throw tooMuchText();
  return { pages: [{ page: null, text }], pageCount: null, charCount: text.length };
}

function extractPlain(buf: Buffer): ExtractedDocument {
  const text = cleanText(buf.toString('utf8'));
  if (text.length > MAX_EXTRACTED_CHARS) throw tooMuchText();
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
    kind === 'pdf' ? await extractPdf(buf, timeoutMs) : kind === 'docx' ? await extractDocx(buf, timeoutMs) : extractPlain(buf);
  return { ...doc, mimeType, kind };
}
