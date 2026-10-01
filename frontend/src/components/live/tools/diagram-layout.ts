/** Layered left-to-right layout for the whiteboard tool's boxes-and-arrows diagrams. */

export interface WbNode {
  id: string;
  label: string;
}
export interface WbEdge {
  from: string;
  to: string;
  label?: string;
}

export const NODE_W = 150;
export const NODE_H = 46;
const COL_GAP = 70;
const ROW_GAP = 26;

/** Layered left-to-right layout: column = longest path from a root (cycles are cut). */
export function layoutDiagram(nodes: WbNode[], edges: WbEdge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const valid = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const level = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Bellman-Ford style relaxation bounded by node count (breaks cycles).
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of valid) {
      const next = (level.get(e.from) ?? 0) + 1;
      if (next > (level.get(e.to) ?? 0) && next < nodes.length) {
        level.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const cols = new Map<number, WbNode[]>();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    cols.set(l, [...(cols.get(l) ?? []), n]);
  }
  const maxRows = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const pos = new Map<string, { x: number; y: number }>();
  const height = maxRows * NODE_H + (maxRows - 1) * ROW_GAP + 20;
  for (const [l, col] of cols) {
    const colH = col.length * NODE_H + (col.length - 1) * ROW_GAP;
    const top = (height - colH) / 2;
    col.forEach((n, i) => pos.set(n.id, { x: 10 + l * (NODE_W + COL_GAP), y: top + i * (NODE_H + ROW_GAP) }));
  }
  const width = 20 + (Math.max(0, ...cols.keys()) + 1) * (NODE_W + COL_GAP) - COL_GAP;
  return { pos, edges: valid, width: Math.max(width, NODE_W + 20), height };
}

