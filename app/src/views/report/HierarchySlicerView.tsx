import { useMemo, useState } from "react";
import { Button, Checkbox, Input } from "@fluentui/react-components";
import { labelOf, valueToLit } from "../../core/report/chartData";
import type { Value } from "../../core/report/cells";
import { litEqual, type FieldRef, type Lit } from "../../core/report/fields";
import type { Cond, TuplesCond } from "../../core/report/filters";
import type { Theme } from "../../core/report/theme";
import type { SlicerSettings } from "../../core/report/slicerSettings";
import { cssFont } from "../../core/format/styles";

export interface HierarchySlicerProps {
  fields: FieldRef[];
  rows: Value[][];
  cond: Cond | null;
  look?: SlicerSettings;
  fieldName?: string;
  theme: Theme;
  width: number;
  height: number;
  search: boolean;
  onChange(cond: TuplesCond | null): void;
}

export interface TreeNode {
  /** The values from the top level down to this node. */
  path: Lit[];
  label: string;
  children: TreeNode[];
}

/** The tree of the distinct combinations, in the order the rows came. */
export function buildTree(rows: Value[][], levels: number): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const r of rows) {
    let list = roots;
    const path: Lit[] = [];
    for (let k = 0; k < levels; k++) {
      const lit = valueToLit(r[k]);
      path.push(lit);
      let node = list.find((n) => litEqual(n.path[k], lit));
      if (!node) {
        node = { path: [...path], label: labelOf(r[k]), children: [] };
        list.push(node);
      }
      list = node.children;
    }
  }
  return roots;
}

const leaves = (n: TreeNode): TreeNode[] => (n.children.length === 0 ? [n] : n.children.flatMap(leaves));
const samePath = (a: Lit[], b: Lit[]) => a.length === b.length && a.every((v, i) => litEqual(v, b[i]));
/** A selected prefix covers a path when it is the path or one of its ancestors. */
const covered = (cond: TuplesCond, path: Lit[]) => cond.rows.some((r) => r.length <= path.length && r.every((v, i) => litEqual(v, path[i])));

/** Whether a branch is selected wholly, partly (some descendant selected) or not at all. */
export function branchState(cond: TuplesCond | null, node: TreeNode): boolean | "mixed" {
  if (!cond) return false;
  if (covered(cond, node.path)) return true;
  const inside = cond.rows.some((r) => r.length > node.path.length && node.path.every((v, i) => litEqual(v, r[i])));
  return inside ? "mixed" : false;
}

/** The shortest prefixes that cover exactly the selected leaves. */
function compress(tree: TreeNode[], selected: Lit[][]): Lit[][] {
  const has = (p: Lit[]) => selected.some((s) => samePath(s, p));
  const rows: Lit[][] = [];
  const walk = (n: TreeNode) => {
    if (leaves(n).every((l) => has(l.path))) rows.push(n.path);
    else n.children.forEach(walk);
  };
  tree.forEach(walk);
  return rows;
}

/** Selection after clicking a branch: a fully selected branch is removed, any other is selected. Nothing or everything selected means no filter. */
export function toggleBranch(cond: TuplesCond | null, fields: FieldRef[], tree: TreeNode[], node: TreeNode): TuplesCond | null {
  const all = tree.flatMap(leaves).map((l) => l.path);
  const selected = cond ? all.filter((p) => covered(cond, p)) : [];
  const under = (p: Lit[]) => node.path.every((v, i) => litEqual(v, p[i]));
  const next = branchState(cond, node) === true ? selected.filter((p) => !under(p)) : [...selected.filter((p) => !under(p)), ...leaves(node).map((l) => l.path)];
  if (next.length === 0 || next.length === all.length) return null;
  return { kind: "tuples", fields, rows: compress(tree, next) };
}

/** The selection as a tuples condition: a plain list of values of the first level (what a one-level selection is stored as) counts too. */
export function asTuples(cond: Cond | null, fields: FieldRef[]): TuplesCond | null {
  if (!cond) return null;
  if (cond.kind === "tuples") return cond;
  if (cond.kind === "in" && cond.values.length > 0) return { kind: "tuples", fields, rows: cond.values.map((v) => [v]) };
  return null;
}

export function HierarchySlicerView(p: HierarchySlicerProps) {
  const { theme } = p;
  const tree = useMemo(() => buildTree(p.rows, p.fields.length), [p.rows, p.fields.length]);
  const cond = asTuples(p.cond, p.fields);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const key = (n: TreeNode) => JSON.stringify(n.path);
  const font = p.look ? cssFont(p.look.items.font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize + 2, color: theme.foreground }) : { color: theme.foreground, fontSize: theme.textClasses.label.fontSize + 2 };
  const matches = (n: TreeNode): boolean => !q || n.label.toLowerCase().includes(q.toLowerCase()) || n.children.some(matches);
  const header = p.look?.header.show ? (
    <div data-testid="slicer-header" style={{ ...cssFont(p.look.header.font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize + 2, color: theme.foreground }), background: p.look.header.background, fontWeight: 600 }}>
      {p.look.header.text || p.fieldName || ""}
    </div>
  ) : null;
  const row = (n: TreeNode, depth: number): React.ReactNode => {
    if (!matches(n)) return null;
    const expanded = !!q || open[key(n)];
    const st = branchState(cond, n);
    return (
      <li key={key(n)} role="treeitem" aria-expanded={n.children.length ? !!expanded : undefined} aria-level={depth + 1} aria-selected={st === true}>
        <div style={{ display: "flex", alignItems: "center", paddingLeft: depth * 16 }}>
          {n.children.length > 0 ? (
            <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${n.label}`} onClick={() => setOpen({ ...open, [key(n)]: !open[key(n)] })} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", width: 18 }}>
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span style={{ width: 18 }} />
          )}
          <Checkbox label={n.label} checked={st} onChange={() => p.onChange(toggleBranch(cond, p.fields, tree, n))} />
        </div>
        {n.children.length > 0 && expanded && (
          <ul role="group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {n.children.map((c) => row(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };
  return (
    <div style={{ width: p.width, height: p.height, boxSizing: "border-box", padding: 6 + (p.look?.items.padding ?? 0), ...font, background: p.look?.items.background, display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>
      {header}
      {(p.search || p.rows.length > 12) && <Input size="small" placeholder="Search" aria-label="Search values" value={q} onChange={(_, d) => setQ(d.value)} />}
      <ul role="tree" aria-label="Hierarchy values" aria-multiselectable style={{ listStyle: "none", margin: 0, padding: 0, overflow: "auto", flex: 1, minHeight: 0 }}>
        {tree.map((n) => row(n, 0))}
        {tree.length === 0 && <li style={{ color: theme.muted, padding: 4 }}>No values</li>}
      </ul>
      {cond && (
        <Button size="small" appearance="subtle" onClick={() => p.onChange(null)}>
          Clear selection
        </Button>
      )}
    </div>
  );
}
