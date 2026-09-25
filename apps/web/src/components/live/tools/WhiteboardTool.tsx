'use client';
import { Button, Textarea } from '@/components/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ToolProps } from './SimpleTools';

import { layoutDiagram, NODE_H, NODE_W, type WbEdge, type WbNode } from './diagram-layout';

function Diagram({ nodes, edges, title }: { nodes: WbNode[]; edges: WbEdge[]; title: string }) {
  const { pos, edges: valid, width, height } = useMemo(() => layoutDiagram(nodes, edges), [nodes, edges]);
  const markerId = useId().replace(/:/g, '');
  const desc = `${nodes.length} boxes: ${nodes.map((n) => n.label).join(', ')}. Connections: ${valid
    .map((e) => `${nodes.find((n) => n.id === e.from)?.label} to ${nodes.find((n) => n.id === e.to)?.label}${e.label ? ` (${e.label})` : ''}`)
    .join('; ')}.`;
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${title || 'Diagram'}. ${desc}`} className="max-w-none">
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
          </marker>
        </defs>
        {valid.map((e, i) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const forward = b.x > a.x;
          const x1 = forward ? a.x + NODE_W : a.x + NODE_W / 2;
          const y1 = forward ? a.y + NODE_H / 2 : a.y + NODE_H;
          const x2 = forward ? b.x : b.x + NODE_W / 2;
          const y2 = forward ? b.y + NODE_H / 2 : b.y;
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#64748b" strokeWidth={1.5} markerEnd={`url(#${markerId})`} />
              {e.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize={11} fill="#334155">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={8} fill="rgb(var(--brand-50))" stroke="rgb(var(--brand-600))" strokeWidth={1.5} />
              <foreignObject x={p.x + 4} y={p.y + 2} width={NODE_W - 8} height={NODE_H - 4}>
                <div className="flex h-full items-center justify-center text-center text-[12px] leading-tight text-slate-900">{n.label}</div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Sketch({ onStrokes, canvasRef }: { onStrokes: (n: number) => void; canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const drawing = useRef(false);
  const strokes = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = canvasRef.current;
    const w = wrap.current;
    if (!c || !w) return;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = w.clientWidth;
      if (!width || c.width === Math.round(width * ratio)) return;
      // Preserve the drawing across resizes.
      const prev = document.createElement('canvas');
      prev.width = c.width;
      prev.height = c.height;
      prev.getContext('2d')?.drawImage(c, 0, 0);
      c.width = Math.round(width * ratio);
      c.height = Math.round(240 * ratio);
      c.style.height = '240px';
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(prev, 0, 0);
      ctx.scale(ratio, ratio);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#0f172a';
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(w);
    return () => ro.disconnect();
  }, [canvasRef]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={wrap} className="w-full">
      <canvas
        ref={canvasRef}
        className="block w-full touch-none rounded-md border border-slate-300 bg-white"
        aria-label="Sketch area: draw with your mouse, finger or pen (use the text box below to explain it)"
        role="img"
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + 0.01, p.y + 0.01);
          ctx.stroke();
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d');
          const p = point(e);
          ctx?.lineTo(p.x, p.y);
          ctx?.stroke();
        }}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          strokes.current++;
          onStrokes(strokes.current);
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
    </div>
  );
}

/** Downscaled JPEG data URL of the sketch, or null if it cannot fit in ~17 KB. */
function sketchDataUrl(c: HTMLCanvasElement): string | null {
  for (const w of [480, 360, 240]) {
    const scale = Math.min(1, w / c.width);
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(c.width * scale));
    t.height = Math.max(1, Math.round(c.height * scale));
    const ctx = t.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, t.width, t.height);
    ctx.drawImage(c, 0, 0, t.width, t.height);
    for (const q of [0.6, 0.4]) {
      const url = t.toDataURL('image/jpeg', q);
      if (url.length <= 17000) return url;
    }
  }
  return null;
}

export function WhiteboardTool({ tool, respond, update }: ToolProps) {
  const nodes = (Array.isArray(tool.args.nodes) ? tool.args.nodes : []).filter(
    (n: any) => n && typeof n.id === 'string' && typeof n.label === 'string',
  ) as WbNode[];
  const edges = (Array.isArray(tool.args.edges) ? tool.args.edges : []).filter(
    (e: any) => e && typeof e.from === 'string' && typeof e.to === 'string',
  ) as WbEdge[];
  const title = typeof tool.args.title === 'string' ? tool.args.title : tool.title;
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState(0);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);
  const sid = useId();

  const clear = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
    setStrokes(0);
  };

  const share = async () => {
    setBusy(true);
    try {
      const text = summary.trim().slice(0, 4000) || (strokes ? 'The participant drew a sketch (no description given).' : '');
      // A small image of the sketch is stored with the tool state (bounded by the protocol's payload limit).
      const sketch = strokes > 0 && canvas.current ? sketchDataUrl(canvas.current) : null;
      update({ summary: text, ...(sketch ? { sketch } : {}) });
      respond({ summary: text });
      setShared(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {nodes.length > 0 && <Diagram nodes={nodes} edges={edges} title={title} />}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">Your sketch</p>
          <Button variant="ghost" size="sm" onClick={clear} disabled={!strokes}>
            Clear
          </Button>
        </div>
        <Sketch canvasRef={canvas} onStrokes={setStrokes} />
        <label htmlFor={sid} className="block text-sm font-medium text-slate-700">
          Describe your sketch (what the agent will read)
        </label>
        <Textarea id={sid} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="e.g. Load balancer → 3 API servers → Postgres primary with a read replica" />
        <div className="flex items-center gap-2">
          <Button onClick={share} loading={busy} disabled={!summary.trim() && !strokes}>
            Share sketch
          </Button>
          {shared && (
            <span className="text-sm text-emerald-700" role="status">
              ✓ Shared
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
