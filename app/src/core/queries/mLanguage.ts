// The M language for the editor: tokenizer (Monarch definition as plain data), completion list and helpers.
// Everything that is logic lives here; mMonaco.ts only adapts it to Monaco.
import functions from "./mFunctions.json";

export const M_LANGUAGE_ID = "biforge-m";

export const M_KEYWORDS = [
  "and", "as", "each", "else", "error", "false", "if", "in", "is", "let", "meta", "not", "null", "or", "otherwise", "section", "shared", "then", "true", "try", "type",
];

export const M_TYPES = ["any", "anynonnull", "binary", "date", "datetime", "datetimezone", "duration", "function", "list", "logical", "none", "null", "number", "record", "table", "text", "time", "nullable"];

export const SUPPORTED_FUNCTIONS: string[] = functions.supported.filter((n) => !n.startsWith("#"));
export const NOT_SUPPORTED_FUNCTIONS: string[] = functions.notSupported;

/** Monarch tokenizer. A plain object so tests can check it without Monaco. */
export const monarchLanguage = {
  defaultToken: "",
  keywords: M_KEYWORDS,
  typeKeywords: M_TYPES,
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/#"/, { token: "variable", next: "@quotedIdent" }],
      [/#(?:binary|date|datetime|datetimezone|duration|infinity|nan|sections|shared|table|time)\b/, "predefined"],
      [/"/, { token: "string", next: "@string" }],
      [/0[xX][0-9a-fA-F]+/, "number"],
      [/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/, "predefined"],
      [/[A-Za-z_][A-Za-z0-9_]*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } }],
      [/=>|<=|>=|<>|\.\.\.?|[=<>+\-*/&@!?,;]/, "operator"],
      [/[()[\]{}]/, "@brackets"],
      [/\s+/, "white"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
    string: [
      [/""/, "string.escape"],
      [/#\([^)]*\)/, "string.escape"],
      [/[^"#]+/, "string"],
      [/#/, "string"],
      [/"/, { token: "string", next: "@pop" }],
    ],
    quotedIdent: [
      [/""/, "variable"],
      [/[^"]+/, "variable"],
      [/"/, { token: "variable", next: "@pop" }],
    ],
  },
};

export interface MCompletion {
  label: string;
  kind: "function" | "keyword" | "column" | "query" | "step" | "constant";
  insertText: string;
  detail?: string;
}

export interface MContext {
  columns: string[];
  queries: string[];
  steps: string[];
}

const CONSTANTS = [
  "Order.Ascending", "Order.Descending", "JoinKind.Inner", "JoinKind.LeftOuter", "JoinKind.RightOuter", "JoinKind.FullOuter", "JoinKind.LeftAnti", "JoinKind.RightAnti",
  "GroupKind.Global", "MissingField.Error", "MissingField.Ignore", "MissingField.UseNull", "QuoteStyle.Csv", "QuoteStyle.None", "Int64.Type", "Currency.Type", "Percentage.Type",
];

/** M text to quote a name as a step/query identifier. */
export function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !M_KEYWORDS.includes(name) ? name : `#"${name.replace(/"/g, '""')}"`;
}

/** Completion items for the word being typed at the end of `before`. */
export function completionsAt(before: string, ctx: MContext): { items: MCompletion[]; replaceLength: number } {
  // inside a text literal nothing is offered
  const quotes = (before.replace(/""/g, "").match(/"/g) ?? []).length;
  if (quotes % 2 === 1) return { items: [], replaceLength: 0 };
  // a field reference [col
  const field = /\[([^\]\[]*)$/.exec(before);
  if (field) {
    return {
      items: ctx.columns.map((c) => ({ label: c, kind: "column" as const, insertText: c })),
      replaceLength: field[1].length,
    };
  }
  const word = /[A-Za-z_][A-Za-z0-9_.]*$|#"[^"]*$/.exec(before)?.[0] ?? "";
  const items: MCompletion[] = [
    ...ctx.steps.map((s) => ({ label: s, kind: "step" as const, insertText: quoteIdentifier(s) })),
    ...ctx.queries.map((q) => ({ label: q, kind: "query" as const, insertText: quoteIdentifier(q) })),
    ...SUPPORTED_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const, insertText: f })),
    ...NOT_SUPPORTED_FUNCTIONS.filter((f) => !f.startsWith("#")).map((f) => ({ label: f, kind: "function" as const, insertText: f, detail: "Not supported by BIForge yet" })),
    ...CONSTANTS.map((c) => ({ label: c, kind: "constant" as const, insertText: c })),
    ...M_KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const, insertText: k })),
  ];
  const w = word.replace(/^#"/, "").toLowerCase();
  return { items: items.filter((i) => i.label.toLowerCase().startsWith(w)), replaceLength: word.length };
}
