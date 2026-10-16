// Number display: format strings of columns and measures (the common custom and named formats) and display units.
// Dates are shown as the engine prints them; date format strings are not interpreted here.
import { formatGeneralNumber } from "../../views/format";

/** Rounds half away from zero at `decimals` places, without binary representation surprises (1.005 -> 1.01). */
export function roundHalfAway(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const r = Number(Math.round(Number(`${Math.abs(x)}e${decimals}`)) + `e-${decimals}`);
  return Number.isNaN(r) ? x : sign * r;
}

const NAMED: Record<string, string> = {
  "general number": "General",
  general: "General",
  currency: "$#,0.00;($#,0.00)",
  fixed: "0.00",
  standard: "#,0.00",
  percent: "0.00%",
  scientific: "0.00E+00",
  "yes/no": "Yes/No",
  "true/false": "True/False",
  "on/off": "On/Off",
};

function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "\\") {
      cur += c + (fmt[++i] ?? "");
      continue;
    }
    if (c === '"') q = !q;
    if (c === ";" && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats one section of a custom format for a non-negative number. */
function applySection(section: string, abs: number): string {
  // tokens: literal text and the numeric run
  let prefix = "";
  let suffix = "";
  let run = "";
  let inRun = false;
  let ended = false;
  let percents = 0;
  for (let i = 0; i < section.length; i++) {
    let c = section[i];
    let literal = false;
    if (c === "\\") {
      c = section[++i] ?? "";
      literal = true;
    } else if (c === '"') {
      const end = section.indexOf('"', i + 1);
      const text = section.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? section.length : end;
      if (inRun) ended = true;
      if (!ended && !inRun) prefix += text;
      else suffix += text;
      continue;
    }
    if (c === "%" && !literal) percents++;
    const isNum = !literal && /[0#.,]/.test(c);
    const isExp = !literal && inRun && /^[eE][+-]/.test(section.slice(i, i + 2));
    if (isExp) {
      run += section.slice(i).match(/^[eE][+-][0#]+/)?.[0] ?? c;
      i += (section.slice(i).match(/^[eE][+-][0#]+/)?.[0] ?? c).length - 1;
      ended = true;
      continue;
    }
    if (isNum && !ended) {
      run += c;
      inRun = true;
    } else {
      if (inRun) ended = true;
      if (ended) suffix += c;
      else prefix += c;
    }
  }
  if (!run) return prefix + suffix;
  let x = abs * 100 ** percents;
  // scientific
  const sci = /^([0#,.]+)[eE]([+-])([0#]+)$/.exec(run);
  if (sci) {
    const dec = (sci[1].split(".")[1] ?? "").length;
    const expDigits = sci[3].length;
    if (x === 0) return `${prefix}${(0).toFixed(dec)}E${sci[2] === "+" ? "+" : "+"}${"0".repeat(expDigits)}${suffix}`;
    let e = Math.floor(Math.log10(x));
    let m = x / 10 ** e;
    m = roundHalfAway(m, dec);
    if (m >= 10) {
      m /= 10;
      e++;
    }
    const sign = e < 0 ? "-" : sci[2] === "+" ? "+" : "";
    return `${prefix}${m.toFixed(dec)}E${sign}${String(Math.abs(e)).padStart(expDigits, "0")}${suffix}`;
  }
  // trailing commas after the last digit placeholder scale by 1000 each
  const scale = run.match(/,+$/)?.[0].length ?? 0;
  run = run.slice(0, run.length - scale);
  x /= 1000 ** scale;
  const [intPat, decPat = ""] = run.split(".");
  const useGroup = /[0#],[0#]/.test(intPat);
  const minInt = (intPat.match(/0/g) ?? []).length;
  const minDec = (decPat.match(/0/g) ?? []).length;
  const maxDec = decPat.replace(/,/g, "").length;
  const r = roundHalfAway(x, maxDec);
  let [i, d = ""] = r.toFixed(maxDec).split(".");
  while (d.length > minDec && d.endsWith("0")) d = d.slice(0, -1);
  if (i.length < minInt) i = i.padStart(minInt, "0");
  if (minInt === 0 && i === "0" && (decPat !== "" || intPat.includes("#"))) i = d ? "" : intPat === "" ? "" : "0";
  if (useGroup) i = group(i);
  return `${prefix}${i}${d ? `.${d}` : ""}${suffix}`;
}

/** Formats a number with a column/measure format string; null or "General" gives the default display. */
export function formatNumber(x: number, fmt: string | null | undefined): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  let f = (fmt ?? "General").trim();
  const named = NAMED[f.toLowerCase()];
  if (named) f = named;
  if (f === "General" || f === "") return formatGeneralNumber(x);
  if (f === "Yes/No") return x !== 0 ? "Yes" : "No";
  if (f === "True/False") return x !== 0 ? "True" : "False";
  if (f === "On/Off") return x !== 0 ? "On" : "Off";
  const sections = splitSections(f);
  const abs = Math.abs(x);
  let section = sections[0];
  let sign = x < 0 ? "-" : "";
  if (x < 0 && sections.length > 1) {
    section = sections[1];
    sign = "";
  } else if (x === 0 && sections.length > 2) {
    section = sections[2];
  }
  const text = applySection(section, abs);
  // a value that rounds to zero loses its minus sign
  return sign && /[1-9]/.test(text) ? sign + text : text;
}

export type DisplayUnits = "auto" | "none" | "thousands" | "millions" | "billions" | "trillions";

const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "bn"],
  [1e6, "M"],
  [1e3, "K"],
];

/** Axis and label text with display units ("1.2M"); `decimals` is the maximum number of decimal places. */
export function formatCompact(x: number, units: DisplayUnits = "auto", decimals = 1, fmt?: string | null): string {
  if (!Number.isFinite(x)) return formatNumber(x, null);
  const fixed: Record<DisplayUnits, number | null> = { auto: null, none: 1, thousands: 1e3, millions: 1e6, billions: 1e9, trillions: 1e12 };
  let div = fixed[units];
  if (div === null) div = UNITS.find(([v]) => Math.abs(x) >= v)?.[0] ?? 1;
  const suffix = div === 1 ? "" : UNITS.find(([v]) => v === div)![1];
  const isPercent = !!fmt && /%/.test(fmt);
  if (isPercent) return formatNumber(x, fmt);
  const v = roundHalfAway(x / div, decimals);
  const s = v.toFixed(decimals).replace(/\.?0+$/, "");
  return (s === "-0" ? "0" : s) + suffix;
}
