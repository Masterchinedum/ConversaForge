import { normalizePhone } from './twilio/twiml';

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM). Returns rows of raw strings. */
export function parseCsv(text: string, maxRows = 10_000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new CsvError(`Too many rows (max ${maxRows - 1} data rows)`);
  };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') pushRow();
    else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else field += c;
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field');
  if (field !== '' || row.length) pushRow();
  return rows;
}

export class CsvError extends Error {}

export interface ParsedTarget {
  phone: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  variables: Record<string, string>;
}

export interface TargetParseResult {
  targets: ParsedTarget[];
  errors: Array<{ row: number; message: string }>;
  ignoredColumns: string[];
  duplicates: number;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const PHONE_COLUMNS = ['phone', 'phone_number', 'number', 'to', 'mobile'];

/**
 * Outbound call targets from CSV. Header row required. Recognized columns:
 *   phone (required, E.164 — also phone_number/number/to/mobile), name, email, external_id/externalId
 * Any other column whose name (optionally prefixed "var_") is a key in the scenario's variable
 * allowlist becomes a runtime variable; everything else is reported in ignoredColumns.
 */
export function parseTargetsCsv(text: string, allowlistKeys: string[], opts: { maxTargets?: number; maxValueLength?: number } = {}): TargetParseResult {
  const maxTargets = opts.maxTargets ?? 5000;
  const maxLen = opts.maxValueLength ?? 500;
  const rows = parseCsv(text, maxTargets + 1);
  if (!rows.length) throw new CsvError('The file is empty');
  const header = rows[0]!.map((h) => h.trim());
  const norm = header.map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
  const phoneIdx = norm.findIndex((h) => PHONE_COLUMNS.includes(h));
  if (phoneIdx < 0) throw new CsvError('A "phone" column is required (E.164, e.g. +14155550123)');
  const nameIdx = norm.indexOf('name');
  const emailIdx = norm.indexOf('email');
  const extIdx = norm.findIndex((h) => h === 'external_id' || h === 'externalid');
  const allow = new Set(allowlistKeys);
  const varCols: Array<{ idx: number; key: string }> = [];
  const ignored: string[] = [];
  norm.forEach((h, idx) => {
    if ([phoneIdx, nameIdx, emailIdx, extIdx].includes(idx)) return;
    const key = h.startsWith('var_') ? h.slice(4) : h;
    if (allow.has(key)) varCols.push({ idx, key });
    else if (header[idx]) ignored.push(header[idx]!);
  });

  const targets: ParsedTarget[] = [];
  const errors: TargetParseResult['errors'] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2; // 1-based incl. header
    if (r.every((c) => c.trim() === '')) return;
    const phone = normalizePhone(r[phoneIdx] ?? '');
    if (!phone) {
      errors.push({ row: rowNo, message: `Invalid phone number "${(r[phoneIdx] ?? '').slice(0, 40)}" (use E.164, e.g. +14155550123)` });
      return;
    }
    const email = emailIdx >= 0 ? (r[emailIdx] ?? '').trim().toLowerCase() : '';
    if (email && !EMAIL_RE.test(email)) {
      errors.push({ row: rowNo, message: `Invalid email "${email.slice(0, 60)}"` });
      return;
    }
    if (seen.has(phone)) {
      duplicates++;
      return;
    }
    seen.add(phone);
    const variables: Record<string, string> = {};
    for (const { idx, key } of varCols) {
      const v = (r[idx] ?? '').trim();
      if (v) variables[key] = v.slice(0, maxLen);
    }
    targets.push({
      phone,
      name: nameIdx >= 0 ? (r[nameIdx] ?? '').trim().slice(0, 120) || null : null,
      email: email || null,
      externalId: extIdx >= 0 ? (r[extIdx] ?? '').trim().slice(0, 200) || null : null,
      variables,
    });
  });
  if (targets.length > maxTargets) throw new CsvError(`Too many targets (max ${maxTargets})`);
  return { targets, errors, ignoredColumns: ignored, duplicates };
}
