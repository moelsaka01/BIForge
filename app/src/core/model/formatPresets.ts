// The Formatting group of Column tools and Measure tools: a format string chosen from a short list, or changed one step
// (currency, percent, thousands separator, one more or one less decimal place). Pure.
import { formatNumber } from "../report/numberFormat";

export const FORMAT_PRESETS: { id: string; label: string; format: string | null }[] = [
  { id: "general", label: "General", format: null },
  { id: "whole", label: "Whole number", format: "#,0" },
  { id: "decimal", label: "Decimal number", format: "#,0.00" },
  { id: "currency", label: "Currency", format: "$#,0.00" },
  { id: "percent", label: "Percentage", format: "0.00%" },
  { id: "scientific", label: "Scientific", format: "0.00E+00" },
];

export type FormatOp = "currency" | "percent" | "thousands" | "moreDecimals" | "fewerDecimals";

const CURRENCY = /^\\?\$/;
const decimalsOf = (f: string): number => {
  const m = /\.(0+)/.exec(f);
  return m ? m[1].length : 0;
};

/** One step of change to a format string (null: General). The result is always a format string formatNumber understands. */
export function applyFormatOp(current: string | null, op: FormatOp): string {
  const f = current ?? "";
  const percent = f.includes("%");
  const sci = /E\+/i.test(f);
  switch (op) {
    case "currency":
      // toggles: a currency format goes back to a plain decimal number
      return CURRENCY.test(f) ? f.replace(CURRENCY, "") : `$${f.replace(/%/g, "") || "#,0.00"}`;
    case "percent":
      return percent ? f.replace(/%/g, "") || "#,0.00" : `${f.replace(CURRENCY, "") || "0.00"}%`.replace("#,0.00%", "0.00%");
    case "thousands": {
      if (f === "") return "#,0.00";
      const body = f.replace(CURRENCY, "");
      const sign = f.slice(0, f.length - body.length);
      return sign + (/#,/.test(body) ? body.replace("#,", "") : /^0/.test(body) ? `#,${body}` : body);
    }
    case "moreDecimals":
    case "fewerDecimals": {
      if (sci) return f;
      const d = Math.max(0, Math.min(10, decimalsOf(f || "0") + (op === "moreDecimals" ? 1 : -1)));
      const base = f === "" ? "0" : f.replace(/\.0+/, "");
      const at = percent ? base.indexOf("%") : base.length;
      return base.slice(0, at) + (d > 0 ? `.${"0".repeat(d)}` : "") + base.slice(at);
    }
  }
}

/** A sample of what a format string looks like (used in the menus), or null when the string is not a number format. */
export function formatExample(format: string | null): string {
  return formatNumber(1234.5678, format);
}
