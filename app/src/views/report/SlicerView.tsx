import { useMemo, useState } from "react";
import { Button, Checkbox, Input, Popover, PopoverSurface, PopoverTrigger, Radio } from "@fluentui/react-components";
import { type Value } from "../../core/report/cells";
import { labelOf, valueToLit } from "../../core/report/chartData";
import type { Loaded } from "../../core/report/dataLoader";
import { litEqual, type Lit } from "../../core/report/fields";
import type { Cond, RelUnit } from "../../core/report/filters";
import type { Theme } from "../../core/report/theme";

import { cssFont } from "../../core/format/styles";
import type { SlicerMode, SlicerSettings } from "../../core/report/slicerSettings";
export type { SlicerMode };

export interface SlicerViewProps {
  loaded: Extract<Loaded, { kind: "slicer" }>;
  mode: SlicerMode;
  cond: Cond | null;
  singleSelect: boolean;
  selectAll: boolean;
  search: boolean;
  isDate: boolean;
  /** Look of the header and the values; absent: the defaults. */
  look?: SlicerSettings;
  /** Field name, the header text when none is set. */
  fieldName?: string;
  theme: Theme;
  width: number;
  height: number;
  onChange(cond: Cond | null): void;
}

const inList = (cond: Cond | null) => (cond && (cond.kind === "in" || cond.kind === "notIn") ? cond : null);

function isSelected(cond: Cond | null, l: Lit): boolean {
  const c = inList(cond);
  if (!c) return false;
  const has = c.values.some((v) => litEqual(v, l));
  return c.kind === "in" ? has : !has;
}

/** The new selection after toggling `l` in a list slicer. */
export function toggleItem(cond: Cond | null, l: Lit, all: Lit[], single: boolean): Cond | null {
  const c = inList(cond);
  if (single) return c && c.kind === "in" && c.values.length === 1 && litEqual(c.values[0], l) ? null : { kind: "in", values: [l] };
  if (!c) return { kind: "in", values: [l] };
  if (c.kind === "in") {
    const has = c.values.some((v) => litEqual(v, l));
    const values = has ? c.values.filter((v) => !litEqual(v, l)) : [...c.values, l];
    return values.length ? { kind: "in", values } : null;
  }
  // "all selected except ..."
  const has = c.values.some((v) => litEqual(v, l));
  const values = has ? c.values.filter((v) => !litEqual(v, l)) : [...c.values, l];
  return values.length >= all.length ? null : { kind: "notIn", values };
}

function summary(cond: Cond | null, items: { label: string; lit: Lit }[]): string {
  const c = inList(cond);
  if (!c) return "All";
  if (c.kind === "notIn") return c.values.length ? `All except ${c.values.length}` : "All";
  if (c.values.length === 1) return items.find((i) => litEqual(i.lit, c.values[0]))?.label ?? "1 selected";
  return `${c.values.length} selected`;
}

export function SlicerView(p: SlicerViewProps) {
  const { theme } = p;
  const items = useMemo(() => p.loaded.values.map((v: Value) => ({ label: labelOf(v), lit: valueToLit(v) })), [p.loaded.values]);
  const [q, setQ] = useState("");
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) : items;
  const all = items.map((i) => i.lit);
  const fontOf = p.look ? cssFont(p.look.items.font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize + 2, color: theme.foreground }) : { color: theme.foreground, fontSize: theme.textClasses.label.fontSize + 2 };
  const box = { width: p.width, height: p.height, boxSizing: "border-box" as const, padding: 6 + (p.look?.items.padding ?? 0), ...fontOf, background: p.look?.items.background, display: "flex", flexDirection: "column" as const, gap: 4, overflow: "hidden" };
  const header = p.look?.header.show ? (
    <div data-testid="slicer-header" style={{ ...cssFont(p.look.header.font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize + 2, color: theme.foreground }), background: p.look.header.background, fontWeight: 600 }}>
      {p.look.header.text || p.fieldName || ""}
    </div>
  ) : null;

  if (p.mode === "Between" || p.mode === "Before" || p.mode === "After") return <RangeSlicer {...p} box={box} header={header} />;
  if (p.mode === "Relative") return <RelativeSlicer {...p} box={box} header={header} />;

  const list = (
    <div role="listbox" aria-label="Values" aria-multiselectable={!p.singleSelect} style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
      {p.selectAll && !p.singleSelect && !q && (
        <Checkbox
          label="Select all"
          checked={p.cond?.kind === "notIn" && p.cond.values.length === 0 ? true : p.cond?.kind === "notIn" || p.cond?.kind === "in" ? "mixed" : false}
          onChange={() => p.onChange(p.cond?.kind === "notIn" && p.cond.values.length === 0 ? null : { kind: "notIn", values: [] })}
        />
      )}
      {shown.map((it) =>
        p.singleSelect ? (
          <div key={it.label} role="option" aria-selected={isSelected(p.cond, it.lit)}>
            <Radio checked={isSelected(p.cond, it.lit)} label={it.label} value={it.label} onClick={() => p.onChange(toggleItem(p.cond, it.lit, all, true))} onChange={() => undefined} />
          </div>
        ) : (
          <div key={it.label} role="option" aria-selected={isSelected(p.cond, it.lit)}>
            <Checkbox checked={isSelected(p.cond, it.lit)} label={it.label} onChange={() => p.onChange(toggleItem(p.cond, it.lit, all, false))} />
          </div>
        ),
      )}
      {shown.length === 0 && <div style={{ color: theme.muted, padding: 4 }}>No values</div>}
    </div>
  );
  const searchBox = (p.search || items.length > 8) && <Input size="small" placeholder="Search" aria-label="Search values" value={q} onChange={(_, d) => setQ(d.value)} />;

  if (p.mode === "Dropdown") {
    return (
      <div style={box}>
        {header}
        <Popover positioning="below-start" trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <Button size="small" appearance="outline" style={{ justifyContent: "space-between" }} aria-label="Open the list of values">
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{summary(p.cond, items)}</span> ▾
            </Button>
          </PopoverTrigger>
          <PopoverSurface style={{ maxHeight: 280, width: Math.max(180, p.width - 12), display: "flex", flexDirection: "column", gap: 4 }}>
            {searchBox}
            {list}
          </PopoverSurface>
        </Popover>
      </div>
    );
  }
  if (p.mode === "Tile") {
    return (
      <div style={{ ...box, flexDirection: "row", flexWrap: "wrap", alignContent: "flex-start", overflow: "auto" }} role="listbox" aria-label="Values">
        {header}
        {shown.map((it) => {
          const on = isSelected(p.cond, it.lit);
          return (
            <Button key={it.label} size="small" appearance={on ? "primary" : "outline"} role="option" aria-selected={on} onClick={() => p.onChange(toggleItem(p.cond, it.lit, all, p.singleSelect))}>
              {it.label}
            </Button>
          );
        })}
      </div>
    );
  }
  return (
    <div style={box}>
      {header}
      {searchBox}
      {list}
      {p.cond && (
        <Button size="small" appearance="subtle" onClick={() => p.onChange(null)}>
          Clear selection
        </Button>
      )}
    </div>
  );
}

// ---- ranges --------------------------------------------------------------------------------------------

function RangeSlicer(p: SlicerViewProps & { box: React.CSSProperties; header: React.ReactNode }) {
  const r = p.loaded.range;
  const min = r?.min.num ?? 0;
  const max = r?.max.num ?? 0;
  const date = p.isDate;
  const toLit = (n: number): Lit => (date ? { t: "date", v: new Date(n).toISOString().slice(0, 10) } : { t: "number", v: n });
  const fromLit = (l: Lit | undefined, dflt: number): number => (l ? (l.t === "number" ? l.v : l.t === "date" ? Date.parse(l.v.slice(0, 10) + "T00:00:00Z") : dflt) : dflt);
  const cond = p.cond;
  const lo = cond?.kind === "between" ? fromLit(cond.lo, min) : cond?.kind === "cmp" && (cond.op === "ge" || cond.op === "gt") ? fromLit(cond.value, min) : min;
  const hi = cond?.kind === "between" ? fromLit(cond.hi, max) : cond?.kind === "cmp" && (cond.op === "le" || cond.op === "lt") ? fromLit(cond.value, max) : max;
  const step = date ? 86400000 : max - min > 100 ? 1 : (max - min) / 100 || 1;
  const text = (n: number) => (date ? new Date(n).toISOString().slice(0, 10) : String(Math.round(n * 1e6) / 1e6));
  const parse = (s: string, dflt: number) => {
    if (!s) return dflt;
    const n = date ? Date.parse(`${s}T00:00:00Z`) : Number(s);
    return Number.isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
  };
  const commit = (a: number, b: number) => {
    if (p.mode === "Before") return p.onChange(b >= max ? null : { kind: "cmp", op: "le", value: toLit(b) });
    if (p.mode === "After") return p.onChange(a <= min ? null : { kind: "cmp", op: "ge", value: toLit(a) });
    p.onChange(a <= min && b >= max ? null : { kind: "between", lo: toLit(Math.min(a, b)), hi: toLit(Math.max(a, b)) });
  };
  if (!r) return <div style={p.box}>{p.header}No values</div>;
  const inputType = date ? "date" : "number";
  const showLo = p.mode !== "Before";
  const showHi = p.mode !== "After";
  return (
    <div style={p.box} data-testid="range-slicer">
      {p.header}
      <div style={{ display: "flex", gap: 6 }}>
        {showLo && <input aria-label={p.mode === "After" ? "After" : "From"} type={inputType} value={text(lo)} min={text(min)} max={text(max)} step={date ? 1 : step} onChange={(e) => commit(parse(e.target.value, lo), hi)} style={{ flex: 1, minWidth: 0 }} />}
        {showHi && <input aria-label={p.mode === "Before" ? "Before" : "To"} type={inputType} value={text(hi)} min={text(min)} max={text(max)} step={date ? 1 : step} onChange={(e) => commit(lo, parse(e.target.value, hi))} style={{ flex: 1, minWidth: 0 }} />}
      </div>
      {showLo && <input aria-label="Lower bound" type="range" min={min} max={max} step={step} value={lo} onChange={(e) => commit(Math.min(Number(e.target.value), hi), hi)} />}
      {showHi && <input aria-label="Upper bound" type="range" min={min} max={max} step={step} value={hi} onChange={(e) => commit(lo, Math.max(Number(e.target.value), lo))} />}
      {cond && (
        <Button size="small" appearance="subtle" onClick={() => p.onChange(null)}>
          Clear
        </Button>
      )}
    </div>
  );
}

function RelativeSlicer(p: SlicerViewProps & { box: React.CSSProperties; header: React.ReactNode }) {
  const c = p.cond?.kind === "relativeDate" ? p.cond : null;
  const [op, setOp] = useState<"last" | "this" | "next">(c?.op ?? "last");
  const [n, setN] = useState(c?.n ?? 7);
  const [unit, setUnit] = useState<RelUnit>(c?.unit ?? "days");
  const [today, setToday] = useState(c?.includeToday ?? false);
  const apply = (o = op, k = n, u = unit, t = today) => p.onChange({ kind: "relativeDate", op: o, n: k, unit: u, includeToday: t });
  return (
    <div style={p.box} data-testid="relative-slicer">
      {p.header}
      <select aria-label="Period" value={op} onChange={(e) => (setOp(e.target.value as typeof op), apply(e.target.value as typeof op))}>
        <option value="last">Last</option>
        <option value="this">This</option>
        <option value="next">Next</option>
      </select>
      {op !== "this" && <input aria-label="Number of units" type="number" min={1} value={n} onChange={(e) => (setN(Math.max(1, Number(e.target.value) || 1)), apply(op, Math.max(1, Number(e.target.value) || 1)))} />}
      <select aria-label="Unit" value={unit} onChange={(e) => (setUnit(e.target.value as RelUnit), apply(op, n, e.target.value as RelUnit))}>
        <option value="days">Days</option>
        <option value="weeks">Weeks (calendar)</option>
        <option value="months">Months (calendar)</option>
        <option value="years">Years (calendar)</option>
      </select>
      <Checkbox label="Include today" checked={today} onChange={(_, d) => (setToday(!!d.checked), apply(op, n, unit, !!d.checked))} />
      {p.cond && (
        <Button size="small" appearance="subtle" onClick={() => p.onChange(null)}>
          Clear
        </Button>
      )}
    </div>
  );
}



// ---- text slicer -----------------------------------------------------------------------------------------

export interface TextSlicerViewProps {
  cond: Cond | null;
  look?: SlicerSettings;
  fieldName?: string;
  theme: Theme;
  width: number;
  height: number;
  onChange(cond: Cond | null): void;
}

type TextOpChoice = "contains" | "startsWith" | "notContains" | "notStartsWith";
const TEXT_CHOICES: { v: TextOpChoice; label: string }[] = [
  { v: "contains", label: "contains" },
  { v: "startsWith", label: "starts with" },
  { v: "notContains", label: "does not contain" },
  { v: "notStartsWith", label: "does not start with" },
];

/** Text slicer: a box to type in; the visuals show the rows whose value matches the text (contains, starts with, ...). Enter or Apply sets it. */
export function TextSlicerView(p: TextSlicerViewProps) {
  const { theme } = p;
  const cur = p.cond?.kind === "text" ? p.cond : null;
  const [op, setOp] = useState<TextOpChoice>(cur?.op ?? "contains");
  const [text, setText] = useState(cur?.value ?? "");
  const apply = (o = op, t = text) => p.onChange(t.trim() === "" ? null : { kind: "text", op: o, value: t.trim() });
  const fontOf = p.look ? cssFont(p.look.items.font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize + 2, color: theme.foreground }) : { color: theme.foreground, fontSize: theme.textClasses.label.fontSize + 2 };
  return (
    <div data-testid="text-slicer" style={{ width: p.width, height: p.height, boxSizing: "border-box", padding: 6, ...fontOf, background: p.look?.items.background, display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>
      {p.look?.header.show && <div style={{ fontWeight: 600 }}>{p.look.header.text || p.fieldName || ""}</div>}
      <div style={{ display: "flex", gap: 4 }}>
        <select aria-label="Match" value={op} onChange={(e) => (setOp(e.target.value as TextOpChoice), apply(e.target.value as TextOpChoice))} style={{ maxWidth: "45%" }}>
          {TEXT_CHOICES.map((c) => (
            <option key={c.v} value={c.v}>
              {c.label}
            </option>
          ))}
        </select>
        <Input size="small" style={{ flex: 1, minWidth: 0 }} aria-label={`Text to match in ${p.fieldName ?? "the field"}`} placeholder="Type text" value={text} onChange={(_, d) => setText(d.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
        <Button size="small" appearance="primary" onClick={() => apply()}>
          Apply
        </Button>
        {p.cond && (
          <Button size="small" appearance="subtle" aria-label="Clear the text" onClick={() => (setText(""), p.onChange(null))}>
            ✕
          </Button>
        )}
      </div>
    </div>
  );
}
