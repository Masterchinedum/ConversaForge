/**
 * CSV helpers. String cells that a spreadsheet would treat as a formula (leading = + - @ tab CR) are
 * prefixed with a single quote (OWASP "CSV injection" guidance); cells are quoted when needed.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 correctly; CRLF line endings per RFC 4180.
  return '﻿' + [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}
