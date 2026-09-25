export function formatDate(d?: string | Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function formatDay(d?: string | Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
export function formatDuration(ms?: number | null) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r.toString().padStart(2, '0')}s` : `${r}s`;
}
export function formatMoneyMicros(micros?: number | string | bigint | null) {
  const n = Number(micros ?? 0) / 1_000_000;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
export function formatScore(s?: number | null) {
  return s == null ? '—' : `${Math.round(s)}`;
}
export function pluralize(n: number, word: string, plural = `${word}s`) {
  return `${n} ${n === 1 ? word : plural}`;
}
