import { useEffect, useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from "@fluentui/react-components";
import type { MApi } from "../../core/queries/types";

export interface Layout {
  nodes: { name: string; x: number; y: number; level: number }[];
  edges: { from: string; to: string }[];
  width: number;
  height: number;
}

const W = 150;
const H = 34;
const GAP_X = 70;
const GAP_Y = 22;

/** Layered layout: a query sits one column to the right of the queries it uses. `deps[a]` lists what `a` uses. */
export function layoutDependencies(deps: Record<string, string[]>): Layout {
  const names = Object.keys(deps);
  const level: Record<string, number> = {};
  const visit = (n: string, seen: string[]): number => {
    if (level[n] !== undefined) return level[n];
    if (seen.includes(n)) return 0; // a cycle: the evaluator reports it, the picture just must not hang
    const l = Math.max(-1, ...(deps[n] ?? []).filter((d) => d in deps).map((d) => visit(d, [...seen, n]))) + 1;
    level[n] = l;
    return l;
  };
  names.forEach((n) => visit(n, []));
  const perLevel: Record<number, string[]> = {};
  for (const n of names) (perLevel[level[n]] ??= []).push(n);
  const nodes = names.map((name) => {
    const l = level[name];
    const row = perLevel[l].indexOf(name);
    return { name, level: l, x: 16 + l * (W + GAP_X), y: 16 + row * (H + GAP_Y) };
  });
  const edges = names.flatMap((n) => (deps[n] ?? []).filter((d) => d in deps).map((d) => ({ from: d, to: n })));
  const maxLevel = Math.max(0, ...Object.values(level));
  const maxRows = Math.max(1, ...Object.values(perLevel).map((v) => v.length));
  return { nodes, edges, width: 32 + (maxLevel + 1) * (W + GAP_X) - GAP_X, height: 32 + maxRows * (H + GAP_Y) - GAP_Y };
}

export function DependenciesView({ m, texts, loaded, onClose }: { m: MApi; texts: Record<string, string>; loaded: Set<string>; onClose(): void }) {
  const [deps, setDeps] = useState<Record<string, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    m.dependencies(texts).then(setDeps, (e) => setError(String(e)));
  }, [m, texts]);
  const layout = deps ? layoutDependencies(deps) : null;
  const pos = (n: string) => layout!.nodes.find((x) => x.name === n)!;
  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: "90vw", width: 900 }}>
        <DialogBody>
          <DialogTitle>Query Dependencies</DialogTitle>
          <DialogContent>
            {error && <div role="alert">{error}</div>}
            {layout && (
              <div style={{ overflow: "auto", maxHeight: "60vh", border: "1px solid #e1dfdd" }}>
                <svg role="img" aria-label="Query dependencies" width={layout.width} height={layout.height} style={{ display: "block" }}>
                  <defs>
                    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill="#605e5c" />
                    </marker>
                  </defs>
                  {layout.edges.map((e) => {
                    const a = pos(e.from);
                    const b = pos(e.to);
                    return <line key={`${e.from}>${e.to}`} data-edge={`${e.from}>${e.to}`} x1={a.x + W} y1={a.y + H / 2} x2={b.x} y2={b.y + H / 2} stroke="#605e5c" markerEnd="url(#arrow)" />;
                  })}
                  {layout.nodes.map((n) => (
                    <g key={n.name} data-node={n.name}>
                      <rect x={n.x} y={n.y} width={W} height={H} rx={4} fill={loaded.has(n.name) ? "#e6f2fb" : "#f3f2f1"} stroke="#8a8886" />
                      <text x={n.x + 8} y={n.y + H / 2 + 4} fontSize={13} fontStyle={loaded.has(n.name) ? "normal" : "italic"}>
                        {n.name.length > 20 ? `${n.name.slice(0, 19)}…` : n.name}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            )}
            <div style={{ fontSize: 12, color: "#605e5c", marginTop: 6 }}>Arrows point from a query to the queries that use it. Queries loaded into the model are shaded blue.</div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
