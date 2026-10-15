import type { TmdlNode } from "../model/types";

/** Compact one-line description of a node, for assertions. */
export function printableTmdlShape(n: TmdlNode): string {
  const props = n.props.map((p) => `${p.key}=${typeof p.value === "object" && "Text" in p.value ? p.value.Text : ""}`).join(";");
  return `${n.kind} ${n.name ?? ""} ${props}`;
}
