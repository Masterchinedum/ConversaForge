/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: any cell starting with = + - @ (or a
 * tab / carriage return) is prefixed with a single quote so Excel/Sheets treat it as text.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  // Plain finite numbers are safe (a negative number is data, not a formula).
  const isPlainNumber = typeof value === 'number' && Number.isFinite(value);
  if (!isPlainNumber && FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

/** UTF-8 BOM so Excel opens non-ASCII text correctly. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return `﻿${[csvRow(header), ...rows.map(csvRow)].join('\r\n')}\r\n`;
}

/** Safe `Content-Disposition` for downloads (ASCII fallback + RFC 5987 UTF-8 name). */
export function contentDisposition(fileName: string, kind: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = fileName.replace(/[^\w.\- ]/g, '_').slice(0, 150) || 'download';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName.slice(0, 150))}`;
}

export function slugForFile(s: string | null | undefined, fallback = 'session'): string {
  const out = (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return out || fallback;
}
