// The DEFINE block of a DAX query: the measures, calculated columns and calculated tables it declares, so that the query
// view can write them into the model (Update model with changes).
import { tokenize, type Tok } from "./format";

export interface Definition {
  kind: "measure" | "column" | "table";
  /** The table a measure or column belongs to, or the name of the table. */
  table: string;
  /** The measure or column name (the table name for a table). */
  name: string;
  expression: string;
}

const unquoteTable = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
const unbracket = (s: string) => s.slice(1, -1).replace(/\]\]/g, "]");
const STOP = /^(DEFINE|MEASURE|COLUMN|TABLE|FUNCTION|EVALUATE)$/i;

export function parseDefinitions(text: string): Definition[] {
  const toks = tokenize(text).filter((t) => t.k !== "comment");
  const out: Definition[] = [];
  let depth = 0;
  const depthAt: number[] = toks.map((t) => {
    if (t.k === "close" || t.k === "rbrace") depth--;
    const d = depth;
    if (t.k === "open" || t.k === "lbrace") depth++;
    return d;
  });
  const isStop = (i: number) => depthAt[i] === 0 && toks[i].k === "id" && STOP.test(toks[i].s);
  const isOrderBy = (i: number) => depthAt[i] === 0 && /^(ORDER|START)$/i.test(toks[i].s) && /^(BY|AT)$/i.test(toks[i + 1]?.s ?? "");
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!(depthAt[i] === 0 && t.k === "id" && /^(MEASURE|COLUMN|TABLE)$/i.test(t.s))) continue;
    const kind = t.s.toLowerCase() as Definition["kind"];
    let eq = i + 1;
    while (eq < toks.length && !(toks[eq].k === "op" && toks[eq].s === "=" && depthAt[eq] === 0)) eq++;
    if (eq >= toks.length) throw new Error(`${t.s.toUpperCase()} needs = and an expression.`);
    let end = eq + 1;
    while (end < toks.length && !isStop(end) && !isOrderBy(end)) end++;
    if (end === eq + 1) throw new Error(`The expression of ${t.s.toUpperCase()} is empty.`);
    const head: Tok[] = toks.slice(i + 1, eq);
    const expression = text.slice(toks[eq + 1].at, toks[end - 1].end);
    if (kind === "table") {
      if (head.length !== 1) throw new Error("TABLE needs a table name.");
      out.push({ kind, table: unquoteTable(head[0].s), name: unquoteTable(head[0].s), expression });
    } else {
      const col = head.find((h) => h.k === "col");
      const tbl = head.find((h) => h.k === "id" || h.k === "table");
      if (!col || !tbl) throw new Error(`${t.s.toUpperCase()} needs a table and a name, like Sales[Name].`);
      out.push({ kind, table: unquoteTable(tbl.s), name: unbracket(col.s), expression });
    }
    i = end - 1;
  }
  return out;
}
