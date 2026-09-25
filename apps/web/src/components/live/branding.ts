import type { CSSProperties } from 'react';

/** Parse "#4f46e5" / "#abc" / "rgb(1,2,3)" to [r,g,b]. */
export function parseColor(input?: string | null): [number, number, number] | null {
  if (!input) return null;
  const s = input.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1]!.split('').map((c) => parseInt(c + c, 16));
    return [r!, g!, b!];
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.min(255, v)) as [number, number, number];
  return null;
}

function mix(c: [number, number, number], target: number, amount: number): [number, number, number] {
  return c.map((v) => Math.round(v + (target - v) * amount)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]) {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * CSS variables (`--brand-*`, space-separated RGB for Tailwind's `rgb(var(--x) / alpha)`) derived from a
 * workspace primary color. Very light colors are darkened so white button text keeps ≥4.5:1 contrast.
 */
export function brandStyle(primary?: string | null): CSSProperties | undefined {
  let c = parseColor(primary);
  if (!c) return undefined;
  // Ensure white text on brand-600 is readable.
  let guard = 0;
  while (luminance(c) > 0.18 && guard++ < 10) c = mix(c, 0, 0.12);
  const t = (x: [number, number, number]) => x.join(' ');
  return {
    ['--brand-50' as any]: t(mix(c, 255, 0.92)),
    ['--brand-100' as any]: t(mix(c, 255, 0.84)),
    ['--brand-500' as any]: t(mix(c, 255, 0.12)),
    ['--brand-600' as any]: t(c),
    ['--brand-700' as any]: t(mix(c, 0, 0.18)),
  };
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'AI';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}
