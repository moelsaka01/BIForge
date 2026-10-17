// Group helpers for the canvas and the Selection pane: who is in which group, what a click selects, what is hidden by
// a hidden group, and where members are shown while their group is being dragged. Pure; the operations that change the
// report are in reportOps.
import type { GroupModel, PageModel, Position, VisualModel } from "./visualDoc";

export type Item = VisualModel | GroupModel;

const byName = (page: PageModel): Map<string, Item> => new Map<string, Item>([...page.visuals, ...page.groups].map((i) => [i.name, i]));

/** The groups an item is in, outermost first (without the item). */
export function ancestorChain(page: PageModel, name: string): string[] {
  const items = byName(page);
  const chain: string[] = [];
  let cur = items.get(name)?.parent;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = items.get(cur)?.parent;
  }
  return chain;
}

/** Names of everything below a group. */
export function descendantNames(page: PageModel, group: string): string[] {
  const out: string[] = [];
  for (const i of [...page.visuals, ...page.groups]) if (i.parent === group) out.push(i.name, ...(page.groups.some((g) => g.name === i.name) ? descendantNames(page, i.name) : []));
  return out;
}

/**
 * What a click on a visual selects. A visual in a group first selects the outermost group; when that group (or another
 * member of it) is already selected, the click goes one level deeper, down to the visual itself.
 */
export function selectionTarget(page: PageModel, clicked: string, selection: string[]): string {
  const chain = ancestorChain(page, clicked);
  if (chain.length === 0) return clicked;
  const path = [...chain, clicked];
  // the deepest item of the path that is selected, or has a selected member
  let deepest = -1;
  for (let i = 0; i < path.length; i++) {
    const inside = selection.some((s) => s === path[i] || descendantNames(page, path[i]).includes(s));
    if (inside) deepest = i;
  }
  if (deepest === -1) return path[0];
  return path[Math.min(path.length - 1, deepest + 1)];
}

/** A visual or group is not shown when it or a group above it is hidden. */
export function effectivelyHidden(page: PageModel, name: string): boolean {
  const items = byName(page);
  if (items.get(name)?.hidden) return true;
  return ancestorChain(page, name).some((g) => items.get(g)?.hidden);
}

/** Items at the top level of the page (not in a group). */
export const topLevel = (page: PageModel): Item[] => [...page.visuals, ...page.groups].filter((i) => !i.parent);

/** Position of an item while a drag is in progress: a member follows its group's change. */
export function previewPosition(page: PageModel, name: string, cur: Record<string, Position>): Position | undefined {
  if (cur[name]) return cur[name];
  const items = byName(page);
  const self = items.get(name);
  if (!self) return undefined;
  // the nearest group above with a drag position
  for (const g of [...ancestorChain(page, name)].reverse()) {
    const dragged = cur[g];
    const orig = items.get(g)?.position;
    if (!dragged || !orig) continue;
    const scale = (items.get(g) as GroupModel).mode === "ScaleMode";
    const sx = scale && orig.width ? dragged.width / orig.width : 1;
    const sy = scale && orig.height ? dragged.height / orig.height : 1;
    const p = self.position;
    return { ...p, x: dragged.x + (p.x - orig.x) * sx, y: dragged.y + (p.y - orig.y) * sy, width: p.width * sx, height: p.height * sy };
  }
  return undefined;
}

export interface TreeRow {
  name: string;
  kind: "visual" | "group";
  depth: number;
  hidden: boolean;
  item: Item;
}

/** Rows of the Selection pane: front first, a group followed by its members. */
export function treeRows(page: PageModel, collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    const level = [...page.visuals, ...page.groups].filter((i) => i.parent === parent).sort((a, b) => b.position.z - a.position.z || a.name.localeCompare(b.name));
    for (const i of level) {
      const isGroup = page.groups.some((g) => g.name === i.name);
      rows.push({ name: i.name, kind: isGroup ? "group" : "visual", depth, hidden: i.hidden, item: i });
      if (isGroup && !collapsed.has(i.name)) walk(i.name, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}
