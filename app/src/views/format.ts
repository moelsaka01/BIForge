import type { BiType } from "../core/data/types";

/**
 * Formats a number the way Power BI shows a column with the default "General" format: up to 15 significant
 * digits, no trailing zeros or trailing ".0", no thousands separators, and scientific notation ("1.5E+15",
 * "1E-07") only when the exponent is 15 or more, or below -5.
 */
export function formatGeneralNumber(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (x === 0) return "0";
  const [mantissa, e] = x.toExponential(14).split("e");
  const exp = Number(e);
  if (exp >= 15 || exp < -5) {
    const m = trimZeros(mantissa);
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${m}E${exp < 0 ? "-" : "+"}${digits}`;
  }
  // 15 significant digits in plain notation; round through toPrecision so that 0.1 + 0.2 shows "0.3"
  const rounded = Number(x.toPrecision(15));
  return trimZeros(rounded.toFixed(Math.max(0, 14 - exp)));
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  const t = s.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
}

/** Text shown in a grid cell. The engine sends every value as text (or null for BLANK). */
export function formatCell(value: string | null | undefined, type: BiType): string {
  if (value === null || value === undefined) return "";
  if (type === "double" || type === "decimal") {
    const n = Number(value);
    return value.trim() === "" || Number.isNaN(n) ? value : formatGeneralNumber(n);
  }
  return value;
}
