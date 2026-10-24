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

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/;

/** A date or date/time the engine sent as ISO text, written the way the culture writes it (5/6/2024, 6.5.2024, ...). */
export function formatDate(value: string, culture: string): string {
  const m = ISO.exec(value.trim());
  if (!m) return value;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? 0 : Number(x)));
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  try {
    const date = new Intl.DateTimeFormat(culture, { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" }).format(at);
    if (m[4] === undefined) return date;
    return `${date} ${new Intl.DateTimeFormat(culture, { timeZone: "UTC", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(at)}`;
  } catch {
    return value; // a culture name the platform does not know
  }
}

/** Text shown in a grid cell. The engine sends every value as text (or null for BLANK). With a culture, dates follow it. */
export function formatCell(value: string | null | undefined, type: BiType, culture?: string): string {
  if (value === null || value === undefined) return "";
  if (type === "dateTime" && culture) return formatDate(value, culture);
  if (type === "double" || type === "decimal") {
    const n = Number(value);
    return value.trim() === "" || Number.isNaN(n) ? value : formatGeneralNumber(n);
  }
  return value;
}
