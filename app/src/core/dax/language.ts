// DAX editor language support that does not depend on Monaco: tokenizer rules, IntelliSense (completions and
// signature help) from the function catalog and the project's model, and marker conversion. Pure functions, so
// they are unit-tested without an editor.

import type { EditorDiagnostic, FunctionInfo } from "./types";
import { quoteTable } from "./measureQuery";

export const LANGUAGE_ID = "dax";

/** Words that are syntax, not functions. */
export const KEYWORDS = ["VAR", "RETURN", "DEFINE", "EVALUATE", "ORDER", "BY", "ASC", "DESC", "START", "AT", "MEASURE", "COLUMN", "TABLE", "FUNCTION", "IN", "NOT"];

/** Words that appear as arguments (intervals, data types, cross-filter directions). */
export const ENUM_WORDS = [
  "DAY", "WEEK", "MONTH", "QUARTER", "YEAR", "HOUR", "MINUTE", "SECOND", "BOTH", "NONE", "ONEWAY", "ONEWAY_LEFTFILTERING", "ONEWAY_RIGHTFILTERING", "SKIP", "DENSE",
  "INTEGER", "DOUBLE", "STRING", "BOOLEAN", "CURRENCY", "DATETIME",
];

/** Monarch tokenizer definition (plain data; handed to monaco.languages.setMonarchTokensProvider). */
export const monarchLanguage = {
  defaultToken: "",
  ignoreCase: true,
  keywords: KEYWORDS,
  enumWords: ENUM_WORDS,
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/--.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/"/, "string", "@string"],
      [/'/, "type", "@table"],
      [/\[/, "variable", "@column"],
      [/dt"[^"]*"/, "number"],
      [/\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
      [/[A-Za-z_][\w.]*(?=\s*\()/, { cases: { "@keywords": "keyword", "@default": "predefined" } }],
      [/[A-Za-z_][\w]*/, { cases: { "@keywords": "keyword", "@enumWords": "constant", "@default": "identifier" } }],
      [/[=<>+\-*\/^&|]+/, "operator"],
      [/[(){},]/, "delimiter"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
    string: [
      [/[^"]+/, "string"],
      [/""/, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    table: [
      [/[^']+/, "type"],
      [/''/, "type"],
      [/'/, "type", "@pop"],
    ],
    column: [
      [/[^\]]+/, "variable"],
      [/\]\]/, "variable"],
      [/\]/, "variable", "@pop"],
    ],
  },
};

// ---------------------------------------------------------------------------------------------------------
// Context

export interface DaxTable {
  name: string;
  columns: string[];
  measures: string[];
}

export interface DaxContext {
  catalog: FunctionInfo[];
  tables: DaxTable[];
}

export type CompletionKind = "function" | "keyword" | "table" | "column" | "measure" | "constant";

export interface CompletionEntry {
  label: string;
  kind: CompletionKind;
  insertText: string;
  detail: string;
  documentation: string;
  sortText: string;
}

export interface CompletionResult {
  items: CompletionEntry[];
  /** Number of characters before the cursor that the chosen item replaces. */
  replaceLength: number;
}

const NONE: CompletionResult = { items: [], replaceLength: 0 };

/** True when the cursor (end of `text`) is inside a string literal or a comment. */
export function insideStringOrComment(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === "//" || two === "--") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return true;
      i = nl + 1;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return true;
      i = end + 2;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= text.length) return true;
        if (text[i] === '"') {
          if (text[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "'") {
      i++;
      for (;;) {
        if (i >= text.length) return false; // an open table name still completes table names
        if (text[i] === "'") {
          if (text[i + 1] === "'") i += 2;
          else break;
        } else i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return false;
}

function matches(label: string, prefix: string): boolean {
  return prefix === "" || label.toLowerCase().startsWith(prefix.toLowerCase());
}

function functionEntry(f: FunctionInfo): CompletionEntry {
  return {
    label: f.name,
    kind: "function",
    insertText: f.name + "(",
    detail: f.signature + (f.implemented ? "" : "  (not implemented in BIForge yet)"),
    documentation: f.description,
    sortText: (f.implemented ? "1" : "9") + f.name,
  };
}

/** Table name written the way DAX wants it (quoted when needed). */
export function tableRef(name: string): string {
  return quoteTable(name);
}

function findTable(ctx: DaxContext, written: string): DaxTable | undefined {
  const name = written.startsWith("'") && written.endsWith("'") ? written.slice(1, -1).replace(/''/g, "'") : written;
  return ctx.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

/** Completions at the end of `textBefore`. */
export function completionsAt(textBefore: string, ctx: DaxContext): CompletionResult {
  if (insideStringOrComment(textBefore)) return NONE;

  // inside brackets: Table[col  or  [measure
  const open = textBefore.lastIndexOf("[");
  if (open >= 0 && !textBefore.slice(open).includes("]")) {
    const partial = textBefore.slice(open + 1);
    const before = textBefore.slice(0, open);
    const m = /('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
    const table = m ? findTable(ctx, m[1]) : undefined;
    const esc = (s: string) => s.replace(/]/g, "]]");
    if (table) {
      const items: CompletionEntry[] = [
        ...table.columns.filter((c) => matches(c, partial)).map((c) => ({ label: c, kind: "column" as const, insertText: esc(c) + "]", detail: `Column of ${table.name}`, documentation: "", sortText: "1" + c })),
        ...table.measures.filter((x) => matches(x, partial)).map((x) => ({ label: x, kind: "measure" as const, insertText: esc(x) + "]", detail: `Measure of ${table.name}`, documentation: "", sortText: "2" + x })),
      ];
      return { items, replaceLength: partial.length };
    }
    if (m) return NONE; // a name before "[" that is not a table
    const items = ctx.tables.flatMap((t) => t.measures.filter((x) => matches(x, partial)).map((x) => ({ label: x, kind: "measure" as const, insertText: esc(x) + "]", detail: `Measure of ${t.name}`, documentation: "", sortText: "1" + x })));
    return { items, replaceLength: partial.length };
  }

  // an open quote: table names
  const quote = textBefore.lastIndexOf("'");
  if (quote >= 0 && (textBefore.slice(quote).match(/'/g) ?? []).length % 2 === 1) {
    const partial = textBefore.slice(quote + 1);
    return {
      items: ctx.tables
        .filter((t) => matches(t.name, partial.replace(/''/g, "'")))
        .map((t) => ({ label: t.name, kind: "table" as const, insertText: t.name.replace(/'/g, "''") + "'", detail: "Table", documentation: "", sortText: "1" + t.name })),
      replaceLength: partial.length,
    };
  }

  const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(textBefore)?.[0] ?? "";
  // after a number, a closing bracket or parenthesis an operator is expected, not a name
  if (word === "" && /[\d)\]]$/.test(textBefore)) return NONE;

  const items: CompletionEntry[] = [];
  for (const f of ctx.catalog) if (matches(f.name, word)) items.push(functionEntry(f));
  for (const k of KEYWORDS) if (matches(k, word)) items.push({ label: k, kind: "keyword", insertText: k, detail: "Keyword", documentation: "", sortText: "3" + k });
  for (const k of ENUM_WORDS) if (word !== "" && matches(k, word)) items.push({ label: k, kind: "constant", insertText: k, detail: "Argument keyword", documentation: "", sortText: "4" + k });
  for (const t of ctx.tables) {
    if (matches(t.name, word)) items.push({ label: t.name, kind: "table", insertText: tableRef(t.name), detail: "Table", documentation: "", sortText: "0" + t.name });
  }
  if (word.length >= 1) {
    for (const t of ctx.tables) {
      for (const c of t.columns) {
        if (matches(c, word)) items.push({ label: `${t.name}[${c}]`, kind: "column", insertText: `${tableRef(t.name)}[${c.replace(/]/g, "]]")}]`, detail: `Column of ${t.name}`, documentation: "", sortText: "0" + c });
      }
      for (const m of t.measures) {
        if (matches(m, word)) items.push({ label: `[${m}]`, kind: "measure", insertText: `[${m.replace(/]/g, "]]")}]`, detail: `Measure of ${t.name}`, documentation: "", sortText: "0" + m });
      }
    }
  }
  return { items, replaceLength: word.length };
}

/**
 * Editors auto-close brackets and quotes. When a completion ends with the closing character and that character
 * already follows the cursor, the item must replace it instead of adding a second one. Returns how many
 * characters after the cursor to replace.
 */
export function consumeAfterCursor(insertText: string, nextChar: string | undefined): number {
  const last = insertText[insertText.length - 1];
  return (last === "]" || last === "'") && nextChar === last ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------
// Signature help

export interface SignatureInfo {
  label: string;
  documentation: string;
  parameters: string[];
  activeParameter: number;
  implemented: boolean;
}

/** Splits "NAME(a, b?, (c, d)+)" into its top-level parameters. */
export function signatureParameters(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const inner = signature.slice(open + 1, close);
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The call that encloses the end of `textBefore` and the index of the argument being typed. */
export function enclosingCall(textBefore: string): { name: string; argIndex: number } | null {
  const stack: { name: string; argIndex: number }[] = [];
  let i = 0;
  while (i < textBefore.length) {
    const c = textBefore[i];
    const two = textBefore.slice(i, i + 2);
    if (two === "//" || two === "--") {
      const nl = textBefore.indexOf("\n", i);
      i = nl < 0 ? textBefore.length : nl + 1;
    } else if (two === "/*") {
      const end = textBefore.indexOf("*/", i + 2);
      i = end < 0 ? textBefore.length : end + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < textBefore.length) {
        if (textBefore[i] === c) {
          if (textBefore[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "[") {
      i++;
      while (i < textBefore.length) {
        if (textBefore[i] === "]") {
          if (textBefore[i + 1] === "]") i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "(") {
      const m = /([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(textBefore.slice(0, i));
      stack.push({ name: m ? m[1] : "", argIndex: 0 });
      i++;
    } else if (c === ")") {
      stack.pop();
      i++;
    } else if (c === "," && stack.length > 0) {
      stack[stack.length - 1].argIndex++;
      i++;
    } else {
      i++;
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name !== "") return stack[k];
  return null;
}

export function signatureHelpAt(textBefore: string, catalog: FunctionInfo[]): SignatureInfo | null {
  const call = enclosingCall(textBefore);
  if (!call) return null;
  const f = catalog.find((x) => x.name.toLowerCase() === call.name.toLowerCase());
  if (!f) return null;
  const parameters = signatureParameters(f.signature);
  const repeating = parameters.length > 0 && /[*+]$/.test(parameters[parameters.length - 1]);
  const active = repeating ? Math.min(call.argIndex, parameters.length - 1) : call.argIndex;
  return { label: f.signature, documentation: f.description, parameters, activeParameter: active, implemented: f.implemented };
}

// ---------------------------------------------------------------------------------------------------------
// Diagnostics

export interface MarkerSpec {
  severity: "error" | "warning";
  message: string;
  start: number;
  end: number;
}

export function toMarkerSpecs(diags: EditorDiagnostic[], textLength: number): MarkerSpec[] {
  return diags.map((d) => {
    const start = Math.min(Math.max(d.start, 0), textLength);
    const end = Math.min(Math.max(d.end, start), textLength);
    return { severity: d.severity, message: d.message, start, end: end === start ? Math.min(start + 1, textLength) : end };
  });
}
