// Rewrites the references to a renamed table, column or measure in DAX text. A small tokenizer of its own (strings,
// 'quoted names', [bracket names], comments) so that text inside strings and comments is never touched and a name is
// only changed where DAX reads it as a reference. Pure functions.

export type RenameOp =
  | { kind: "table"; from: string; to: string }
  | { kind: "column"; table: string; from: string; to: string }
  | { kind: "measure"; table: string; from: string; to: string };

export interface RenameContext {
  /** The table the expression belongs to (the table of a calculated column or of a measure, the table of a security filter); null in a query. */
  host: string | null;
  /** Lower case names of every measure of the model: an unqualified [Name] is a measure when one has that name. */
  measures: ReadonlySet<string>;
}

type Kind = "string" | "quoted" | "bracket" | "ident" | "other";
interface Tok {
  kind: Kind;
  start: number;
  end: number;
  /** Name without its quotes or brackets (quoted, bracket, ident). */
  name: string;
}

export function tokenizeDax(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
    } else if (c === '"') {
      const s = i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i = Math.min(n, i + 1);
      out.push({ kind: "string", start: s, end: i, name: "" });
    } else if (c === "'" || c === "[") {
      const close = c === "'" ? "'" : "]";
      const s = i++;
      let name = "";
      while (i < n) {
        if (text[i] === close) {
          if (text[i + 1] === close) {
            name += close;
            i += 2;
          } else break;
        } else name += text[i++];
      }
      i = Math.min(n, i + 1);
      out.push({ kind: c === "'" ? "quoted" : "bracket", start: s, end: i, name });
    } else if (/[A-Za-z_À-￿]/.test(c)) {
      const s = i++;
      while (i < n && /[\w.À-￿]/.test(text[i])) i++;
      out.push({ kind: "ident", start: s, end: i, name: text.slice(s, i) });
    } else if (/\d/.test(c)) {
      const s = i++;
      while (i < n && /[\w.]/.test(text[i])) i++;
      out.push({ kind: "other", start: s, end: i, name: "" });
    } else {
      out.push({ kind: "other", start: i, end: i + 1, name: c });
      i++;
    }
  }
  return out;
}

const RESERVED = new Set(["define", "evaluate", "var", "return", "measure", "column", "table", "order", "by", "start", "at", "asc", "desc", "true", "false", "in", "not", "and", "or", "if", "function", "blank"]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A table name as DAX writes it: bare when it is a plain identifier, otherwise in single quotes. */
export function daxTableName(name: string, keepQuoted = false): string {
  return !keepQuoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase()) ? name : `'${name.replace(/'/g, "''")}'`;
}

const bracketName = (name: string) => `[${name.replace(/\]/g, "]]")}]`;

/** The text with every reference to the renamed object changed; the text is returned unchanged when nothing refers to it. */
export function renameInDax(text: string, op: RenameOp, ctx: RenameContext): string {
  const toks = tokenizeDax(text);
  const edits: { start: number; end: number; text: string }[] = [];
  // variables shadow a table of the same name
  const vars = new Set<string>();
  for (let i = 0; i + 1 < toks.length; i++) if (toks[i].kind === "ident" && eq(toks[i].name, "VAR") && toks[i + 1].kind === "ident") vars.add(toks[i + 1].name.toLowerCase());
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    if ((t.kind === "quoted" || (t.kind === "ident" && !RESERVED.has(t.name.toLowerCase()))) && next?.kind === "bracket") {
      // Table[Name]
      if (op.kind === "table") {
        if (eq(t.name, op.from)) edits.push({ start: t.start, end: t.end, text: daxTableName(op.to, t.kind === "quoted") });
      } else if (eq(t.name, op.table) && eq(next.name, op.from)) {
        edits.push({ start: next.start, end: next.end, text: bracketName(op.to) });
      }
      i++;
    } else if (t.kind === "bracket") {
      // [Name]: a measure, or (in a calculated column or a security filter) a column of the table the expression belongs to
      if (op.kind === "table" || !eq(t.name, op.from)) continue;
      const isMeasure = ctx.measures.has(t.name.toLowerCase());
      if (op.kind === "measure" && isMeasure) edits.push({ start: t.start, end: t.end, text: bracketName(op.to) });
      if (op.kind === "column" && !isMeasure && ctx.host !== null && eq(ctx.host, op.table)) edits.push({ start: t.start, end: t.end, text: bracketName(op.to) });
    } else if (op.kind === "table" && (t.kind === "quoted" || t.kind === "ident") && eq(t.name, op.from)) {
      // a table used as a table: FILTER(Sales, ...), SUM over a quoted name; never a function call or a variable
      if (t.kind === "ident" && (next?.kind === "other" && next.name === "(" || vars.has(t.name.toLowerCase()))) continue;
      edits.push({ start: t.start, end: t.end, text: daxTableName(op.to, t.kind === "quoted") });
    }
  }
  if (edits.length === 0) return text;
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
