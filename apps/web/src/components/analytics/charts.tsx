'use client';
/**
 * Lightweight inline-SVG charts (no chart library). Single-series only: one measure per chart, one
 * y-axis, brand color for the mark, text in neutral ink. Hover shows a crosshair + tooltip.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setW(Math.max(200, Math.floor(entries[0]!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

const shortDate = (d: string) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export interface LinePoint {
  x: string; // YYYY-MM-DD
  y: number | null;
  /** Extra tooltip line, e.g. "3 scored sessions". */
  note?: string;
}

/** Time series line (gaps where y is null) with a hover crosshair. */
export function LineChart({
  points,
  label,
  format = (v) => String(Math.round(v)),
  yMax,
  height = 180,
  empty = 'No data in this period',
}: {
  points: LinePoint[];
  label: string;
  format?: (v: number) => string;
  yMax?: number;
  height?: number;
  empty?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const values = points.map((p) => p.y).filter((v): v is number => v != null);
  const max = yMax ?? niceMax(Math.max(0, ...values));
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  // Path segments broken at nulls.
  const segments: string[] = [];
  let cur = '';
  points.forEach((p, i) => {
    if (p.y == null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const isolated = points.map((p, i) => ({ p, i })).filter(({ p, i }) => p.y != null && points[i - 1]?.y == null && points[i + 1]?.y == null);

  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
  const hp = hover != null ? points[hover] : null;

  return (
    <div ref={ref} className="relative w-full min-w-0">
      {!values.length ? (
        <p className="flex items-center justify-center text-sm text-slate-500" style={{ height }}>
          {empty}
        </p>
      ) : (
        <svg
          // Fluid width (a fixed pixel width would stop the card from shrinking on small screens);
          // the viewBox follows the measured width so the drawing is never distorted once measured.
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}: line chart over ${points.length} days`}
          className="block text-brand-600"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = e.clientX - rect.left;
            const i = points.length <= 1 ? 0 : Math.round(((px - pad.l) / iw) * (points.length - 1));
            setHover(Math.max(0, Math.min(points.length - 1, i)));
          }}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="stroke-slate-200" strokeWidth={1} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-slate-500 text-[10px]">
                {format(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text key={p.x} x={x(i)} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">
                {shortDate(p.x)}
              </text>
            ) : null,
          )}
          {segments.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {isolated.map(({ p, i }) => (
            <circle key={p.x} cx={x(i)} cy={y(p.y!)} r={3} fill="currentColor" />
          ))}
          {hp && hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="stroke-slate-400" strokeDasharray="3 3" />
              {hp.y != null && <circle cx={x(hover)} cy={y(hp.y)} r={4.5} fill="currentColor" stroke="white" strokeWidth={2} />}
            </g>
          )}
        </svg>
      )}
      {hp && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow"
          style={{ left: Math.min(Math.max(0, x(hover) - 60), width - 130) }}
          role="status"
        >
          <p className="font-medium text-slate-900">{shortDate(hp.x)}</p>
          <p className="text-slate-700">
            {label}: {hp.y == null ? '—' : format(hp.y)}
          </p>
          {hp.note && <p className="text-slate-500">{hp.note}</p>}
        </div>
      )}
    </div>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  value: number | null;
  hint?: string;
}

/** Horizontal bars (magnitude), value labels in neutral ink, hover tooltip per bar. */
export function BarList({
  data,
  format = (v) => String(Math.round(v)),
  max,
  empty = 'No data',
  label,
}: {
  data: BarDatum[];
  format?: (v: number) => string;
  max?: number;
  empty?: ReactNode;
  label: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (!data.length) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;
  const m = max ?? niceMax(Math.max(0, ...data.map((d) => d.value ?? 0)));
  return (
    <ul className="space-y-2" aria-label={label}>
      {data.map((d) => {
        const pct = d.value == null ? 0 : Math.max(0, Math.min(100, (d.value / m) * 100));
        return (
          <li
            key={d.key}
            className="relative"
            onMouseEnter={() => setHover(d.key)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(d.key)}
            onBlur={() => setHover(null)}
            tabIndex={0}
          >
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-slate-700" title={d.label}>
                {d.label}
              </span>
              <span className="shrink-0 tabular-nums text-slate-900">{d.value == null ? '—' : format(d.value)}</span>
            </div>
            <div className="mt-1 h-2 w-full rounded bg-slate-100">
              <div className="h-2 rounded bg-brand-600 transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            {hover === d.key && d.hint && (
              <div className="pointer-events-none absolute right-0 top-full z-10 mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 shadow">
                {d.hint}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Thin progress bar with an honest percentage label. */
export function ProgressBar({ percent, label, className }: { percent: number; label?: string; className?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={className}>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={p}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
      >
        <div className="h-2 rounded-full bg-brand-600" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}
