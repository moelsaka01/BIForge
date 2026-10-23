// Power Query parameters: a query whose M is a literal followed by `meta [IsParameterQuery=true, ...]`. This module writes and reads that
// text, so the Manage Parameters dialog never builds M by hand. No React and no engine here.
import { m_text } from "./mText";

export type ParameterType = "Any" | "Text" | "Number" | "WholeNumber" | "Currency" | "Date" | "DateTime" | "Time" | "Logical";

export const PARAMETER_TYPES: { type: ParameterType; label: string }[] = [
  { type: "Any", label: "Any" },
  { type: "Text", label: "Text" },
  { type: "Number", label: "Decimal Number" },
  { type: "WholeNumber", label: "Whole Number" },
  { type: "Currency", label: "Fixed Decimal Number" },
  { type: "Date", label: "Date" },
  { type: "DateTime", label: "Date/Time" },
  { type: "Time", label: "Time" },
  { type: "Logical", label: "True/False" },
];

export interface ParameterDef {
  description: string;
  required: boolean;
  type: ParameterType;
  /** Suggested values: any value (empty) or one of these. */
  list: string[];
  defaultValue: string;
  /** The current value, as the dialog shows it (2024-01-31, 12.5, true, text). */
  current: string;
}

const typeName = (t: ParameterType) => (t === "WholeNumber" ? "Number" : t);

/** The M literal of a value typed in the dialog; throws a message the dialog shows. */
export function parameterLiteral(type: ParameterType, value: string): string {
  const v = value.trim();
  switch (type) {
    case "Any":
    case "Text":
      return m_text(value);
    case "Number":
    case "Currency":
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) throw new Error(`"${value}" is not a number.`);
      return String(Number(v));
    case "WholeNumber":
      if (!/^[+-]?\d+$/.test(v)) throw new Error(`"${value}" is not a whole number.`);
      return String(Number(v));
    case "Logical":
      if (!/^(true|false)$/i.test(v)) throw new Error(`"${value}" is not true or false.`);
      return v.toLowerCase();
    case "Date": {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
      if (!m) throw new Error(`"${value}" is not a date (use yyyy-mm-dd).`);
      return `#date(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])})`;
    }
    case "DateTime": {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
      if (!m) throw new Error(`"${value}" is not a date and time (use yyyy-mm-dd hh:mm:ss).`);
      return `#datetime(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${Number(m[4])}, ${Number(m[5])}, ${Number(m[6] ?? 0)})`;
    }
    case "Time": {
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
      if (!m) throw new Error(`"${value}" is not a time (use hh:mm:ss).`);
      return `#time(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3] ?? 0)})`;
    }
  }
}

/** The M text of a parameter query. */
export function parameterText(d: ParameterDef): string {
  const lit = (v: string) => parameterLiteral(d.type, v);
  if (d.current.trim() === "" && d.type !== "Text" && d.type !== "Any") throw new Error("Enter the current value.");
  const meta = ["IsParameterQuery=true"];
  if (d.description.trim()) meta.push(`Description=${m_text(d.description.trim())}`);
  if (d.list.length) {
    meta.push(`List={${d.list.map(lit).join(", ")}}`);
    meta.push(`DefaultValue=${lit(d.defaultValue || d.list[0])}`);
  }
  meta.push(`Type=${m_text(typeName(d.type))}`);
  meta.push(`IsParameterQueryRequired=${d.required}`);
  return `${lit(d.current)} meta [${meta.join(", ")}]`;
}

/** Reads M written by `parameterText` (or Power Query). Returns null for any other text. */
export function parseParameter(text: string): ParameterDef | null {
  const m = /^\s*([\s\S]*?)\s+meta\s*\[([\s\S]*)\]\s*$/.exec(text);
  if (!m || !/IsParameterQuery\s*=\s*true/.test(m[2])) return null;
  const meta = m[2];
  const field = (name: string): string | null => {
    const r = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*("(?:[^"]|"")*"|\\{[^}]*\\}|[^,\\]]+)`).exec(meta);
    return r ? r[1].trim() : null;
  };
  const str = (s: string | null) => (s && s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : (s ?? ""));
  let type: ParameterType = ((): ParameterType => {
    switch (str(field("Type"))) {
      case "Text":
        return "Text";
      case "Number":
        return "Number";
      case "Currency":
        return "Currency";
      case "Date":
        return "Date";
      case "DateTime":
        return "DateTime";
      case "Time":
        return "Time";
      case "Logical":
        return "Logical";
      default:
        return "Any";
    }
  })();
  const value = (lit: string): string => {
    const s = lit.trim();
    if (s.startsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
    const d = /^#date\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
    if (d) return `${d[1].padStart(4, "0")}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
    const dt = /^#datetime\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
    if (dt) return `${dt[1].padStart(4, "0")}-${dt[2].padStart(2, "0")}-${dt[3].padStart(2, "0")} ${dt[4].padStart(2, "0")}:${dt[5].padStart(2, "0")}:${dt[6].padStart(2, "0")}`;
    const t = /^#time\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
    if (t) return `${t[1].padStart(2, "0")}:${t[2].padStart(2, "0")}:${t[3].padStart(2, "0")}`;
    return s;
  };
  const current = value(m[1]);
  if (type === "Number" && /^[+-]?\d+$/.test(current)) type = "WholeNumber";
  const listText = field("List");
  const list = listText ? [...listText.slice(1, -1).matchAll(/"(?:[^"]|"")*"|#[a-z]+\([^)]*\)|[^,\s]+/g)].map((x) => value(x[0])) : [];
  return {
    description: str(field("Description")),
    required: field("IsParameterQueryRequired") !== "false",
    type,
    list,
    defaultValue: field("DefaultValue") ? value(field("DefaultValue")!) : "",
    current,
  };
}

/** True when the M text is a parameter. */
export const isParameterText = (text: string): boolean => parseParameter(text) !== null;
