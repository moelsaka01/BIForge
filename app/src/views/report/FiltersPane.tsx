import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Input, Select } from "@fluentui/react-components";
import type { Value } from "../../core/report/cells";
import { labelOf, valueToLit } from "../../core/report/chartData";
import { column, fieldKey, fieldLabel, litEqual, litText, measure, type FieldRef, type Lit } from "../../core/report/fields";
import { fieldForRole } from "../../core/report/fieldRouting";
import { readFilters, type RelUnit, type CmpOp, type Cond, type FilterDef, type SimpleCond, type TextOp } from "../../core/report/filters";
import { isDateField, isNumericColumn } from "../../core/report/modelInfo";
import type { FilterScope } from "../../core/report/reportOps";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";
import { fieldFromDrag } from "./VisualizationsPane";

let seq = 0;
const newFilterName = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

type Mode = "basic" | "advanced" | "topN" | "relative";

function modeOf(c: Cond): Mode {
  return c.kind === "in" || c.kind === "notIn" ? "basic" : c.kind === "topN" ? "topN" : c.kind === "relativeDate" ? "relative" : "advanced";
}

const TEXT_OPS: { v: TextOp | CmpOp | "blank" | "notBlank"; label: string }[] = [
  { v: "contains", label: "contains" },
  { v: "notContains", label: "does not contain" },
  { v: "startsWith", label: "starts with" },
  { v: "notStartsWith", label: "does not start with" },
  { v: "eq", label: "is" },
  { v: "ne", label: "is not" },
  { v: "blank", label: "is blank" },
  { v: "notBlank", label: "is not blank" },
];
const NUM_OPS: { v: CmpOp | "blank" | "notBlank"; label: string }[] = [
  { v: "lt", label: "is less than" },
  { v: "le", label: "is less than or equal to" },
  { v: "gt", label: "is greater than" },
  { v: "ge", label: "is greater than or equal to" },
  { v: "eq", label: "is" },
  { v: "ne", label: "is not" },
  { v: "blank", label: "is blank" },
  { v: "notBlank", label: "is not blank" },
];

interface Row {
  op: string;
  text: string;
}

function rowToCond(r: Row, kind: "text" | "number" | "date"): SimpleCond | null {
  if (r.op === "blank" || r.op === "notBlank") return { kind: r.op };
  if (r.text.trim() === "") return null;
  if (["contains", "notContains", "startsWith", "notStartsWith"].includes(r.op)) return { kind: "text", op: r.op as TextOp, value: r.text };
  const value: Lit | null = kind === "number" ? (Number.isFinite(Number(r.text)) ? { t: "number", v: Number(r.text) } : null) : kind === "date" ? (/^\d{4}-\d{2}-\d{2}$/.test(r.text) ? { t: "date", v: r.text } : null) : { t: "string", v: r.text };
  return value ? { kind: "cmp", op: r.op as CmpOp, value } : null;
}

function condToRow(c: SimpleCond | undefined, dflt: string): Row {
  if (!c) return { op: dflt, text: "" };
  if (c.kind === "blank" || c.kind === "notBlank") return { op: c.kind, text: "" };
  if (c.kind === "text") return { op: c.op, text: c.value };
  if (c.kind === "cmp") return { op: c.op, text: c.value.t === "string" ? c.value.v : c.value.t === "date" ? c.value.v.slice(0, 10) : litText(c.value) };
  return { op: dflt, text: "" };
}

function FilterCard({ def, scope, visualFields }: { def: FilterDef; scope: FilterScope; visualFields: FieldRef[] }) {
  const c = useReport();
  const { field } = def;
  const dateCol = isDateField(c.model, field);
  const numericCol = isNumericColumn(c.model, field);
  const kind: "text" | "number" | "date" = dateCol ? "date" : numericCol || field.kind !== "column" ? "number" : "text";
  const [mode, setMode] = useState<Mode>(modeOf(def.cond));
  const [values, setValues] = useState<Value[] | null>(null);
  const [q, setQ] = useState("");
  const adv = def.cond.kind === "compound" ? def.cond : null;
  const [r1, setR1] = useState<Row>(() => condToRow(adv ? adv.a : def.cond.kind === "cmp" || def.cond.kind === "text" || def.cond.kind === "blank" || def.cond.kind === "notBlank" ? def.cond : undefined, kind === "text" ? "contains" : "gt"));
  const [r2, setR2] = useState<Row>(() => condToRow(adv?.b, kind === "text" ? "contains" : "lt"));
  const [join, setJoin] = useState<"and" | "or">(adv?.op ?? "and");
  const [top, setTop] = useState({ dir: (def.cond.kind === "topN" ? def.cond.dir : "top") as "top" | "bottom", n: def.cond.kind === "topN" ? def.cond.n : 5, by: def.cond.kind === "topN" ? def.cond.by : (visualFields.find((f) => f.kind !== "column") ?? null) });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [rel, setRel] = useState({ op: (def.cond.kind === "relativeDate" ? def.cond.op : "last") as "last" | "this" | "next", n: def.cond.kind === "relativeDate" ? def.cond.n : 7, unit: (def.cond.kind === "relativeDate" ? def.cond.unit : "days") as RelUnit, today: def.cond.kind === "relativeDate" ? def.cond.includeToday : true });
  // a locked filter cannot be changed by readers of the report (view mode)
  const locked = c.readOnly && !!def.locked;

  const write = (cond: Cond) => c.dispatch("report.filter.upsert", { scope, filter: { ...def, cond } });
  const flag = (patch: Partial<Pick<FilterDef, "hidden" | "locked">>) => c.dispatch("report.filter.upsert", { scope, filter: { ...def, ...patch } });
  const remove = () => c.dispatch("report.filter.remove", { scope, name: def.name });

  useEffect(() => {
    if (mode !== "basic" || field.kind !== "column") return;
    let off = false;
    void c.data.distinct(c.project, field, c.snap.epoch, c.model).then((v) => !off && setValues(v)).catch(() => !off && setValues([]));
    return () => {
      off = true;
    };
  }, [mode, field, c.data, c.project, c.model, c.snap.epoch]);

  const items = useMemo(() => (values ?? []).map((v) => ({ label: labelOf(v), lit: valueToLit(v) })), [values]);
  const cond = def.cond;
  const selected = (l: Lit) => (cond.kind === "in" ? cond.values.some((v) => litEqual(v, l)) : cond.kind === "notIn" ? !cond.values.some((v) => litEqual(v, l)) : false);
  const toggle = (l: Lit) => {
    if (cond.kind === "in") {
      const has = cond.values.some((v) => litEqual(v, l));
      const next = has ? cond.values.filter((v) => !litEqual(v, l)) : [...cond.values, l];
      write({ kind: "in", values: next });
    } else if (cond.kind === "notIn") {
      const has = cond.values.some((v) => litEqual(v, l));
      write({ kind: "notIn", values: has ? cond.values.filter((v) => !litEqual(v, l)) : [...cond.values, l] });
    } else write({ kind: "in", values: [l] });
  };
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) : items;

  const applyAdvanced = () => {
    const a = rowToCond(r1, kind);
    const b = rowToCond(r2, kind);
    if (!a) return setError("Enter a value for the first condition.");
    if (r2.text.trim() !== "" || r2.op === "blank" || r2.op === "notBlank") {
      if (!b) return setError("The second condition is not valid.");
      setError(null);
      return write({ kind: "compound", op: join, a, b });
    }
    setError(null);
    write(a);
  };
  const applyTop = () => {
    if (!top.by) return setError("Choose the value to rank by.");
    if (!(top.n >= 1)) return setError("Show at least 1 item.");
    setError(null);
    write({ kind: "topN", n: Math.floor(top.n), dir: top.dir, by: top.by });
  };

  const applyRel = () => {
    if (rel.op !== "this" && !(rel.n >= 0)) return setError("Enter how many units.");
    setError(null);
    write({ kind: "relativeDate", op: rel.op, n: Math.floor(rel.n), unit: rel.unit, includeToday: rel.today });
  };

  const modes: { v: Mode; label: string; show: boolean }[] = [
    { v: "basic", label: "Basic filtering", show: field.kind === "column" },
    { v: "advanced", label: "Advanced filtering", show: true },
    { v: "topN", label: "Top N", show: field.kind === "column" },
    { v: "relative", label: "Relative date", show: dateCol },
  ];
  const ops = kind === "text" ? TEXT_OPS : NUM_OPS;
  const rowUi = (r: Row, set: (r: Row) => void, label: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Select size="small" aria-label={`${label} condition`} value={r.op} onChange={(_, d) => set({ ...r, op: d.value })}>
        {ops.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </Select>
      {r.op !== "blank" && r.op !== "notBlank" && <Input size="small" aria-label={`${label} value`} type={kind === "date" ? "date" : kind === "number" ? "number" : "text"} value={r.text} onChange={(_, d) => set({ ...r, text: d.value })} />}
    </div>
  );

  const summary = cond.kind === "in" ? (cond.values.length ? cond.values.map(litText).join(", ") : "All") : cond.kind === "notIn" ? (cond.values.length ? `All except ${cond.values.map(litText).join(", ")}` : "All") : cond.kind === "topN" ? `${cond.dir === "top" ? "Top" : "Bottom"} ${cond.n} by ${fieldLabel(cond.by)}` : cond.kind === "relativeDate" ? `${cond.op} ${cond.n} ${cond.unit}` : "Advanced";

  return (
    <section aria-label={`Filter on ${fieldLabel(field)}`} data-filter={def.name} style={{ border: "1px solid #ccc", borderRadius: 4, padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <strong style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{fieldLabel(field)}</strong>
        <Button size="small" appearance="subtle" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} filter on ${fieldLabel(field)}`} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </Button>
        <Button size="small" appearance="subtle" aria-pressed={!!def.locked} aria-label={`Lock filter on ${fieldLabel(field)}`} title="Lock: readers of the report cannot change it" disabled={locked} onClick={() => flag({ locked: !def.locked })}>
          {def.locked ? "🔒" : "🔓"}
        </Button>
        <Button size="small" appearance="subtle" aria-pressed={!!def.hidden} aria-label={`Hide filter on ${fieldLabel(field)}`} title="Hide: readers of the report do not see it" disabled={locked} onClick={() => flag({ hidden: !def.hidden })}>
          {def.hidden ? "◌" : "◉"}
        </Button>
        <Button size="small" appearance="subtle" disabled={locked} aria-label={`Clear filter on ${fieldLabel(field)}`} onClick={() => write({ kind: "in", values: [] })}>
          Clear
        </Button>
        <Button size="small" appearance="subtle" disabled={locked} aria-label={`Remove filter on ${fieldLabel(field)}`} onClick={remove}>
          ✕
        </Button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.75 }}>
        {summary}
        {def.locked ? " (locked)" : ""}
        {def.hidden ? " (hidden)" : ""}
      </div>
      <fieldset disabled={locked} style={{ border: "none", padding: 0, margin: 0, minWidth: 0, display: open ? "flex" : "none", flexDirection: "column", gap: 4 }}>
      <Select size="small" aria-label={`Filter type for ${fieldLabel(field)}`} value={mode} onChange={(_, d) => (setMode(d.value as Mode), setError(null))}>
        {modes.filter((m) => m.show).map((m) => (
          <option key={m.v} value={m.v}>
            {m.label}
          </option>
        ))}
      </Select>
      {mode === "basic" && (
        <>
          <Select size="small" aria-label="Include or exclude" value={cond.kind === "notIn" ? "exclude" : "include"} onChange={(_, d) => write({ kind: d.value === "exclude" ? "notIn" : "in", values: cond.kind === "in" || cond.kind === "notIn" ? cond.values : [] })}>
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </Select>
          <Input size="small" placeholder="Search" aria-label="Search values" value={q} onChange={(_, d) => setQ(d.value)} />
          <div style={{ maxHeight: 160, overflow: "auto" }}>
            {values === null && <span style={{ fontSize: 11 }}>Loading…</span>}
            {shown.map((it) => (
              <div key={it.label}>
                <Checkbox size="medium" checked={selected(it.lit)} label={it.label} onChange={() => toggle(it.lit)} />
              </div>
            ))}
          </div>
        </>
      )}
      {mode === "advanced" && (
        <>
          <span style={{ fontSize: 11 }}>Show items when the value</span>
          {rowUi(r1, setR1, "First")}
          <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
            <label>
              <input type="radio" checked={join === "and"} onChange={() => setJoin("and")} /> And
            </label>
            <label>
              <input type="radio" checked={join === "or"} onChange={() => setJoin("or")} /> Or
            </label>
          </div>
          {rowUi(r2, setR2, "Second")}
          <Button size="small" appearance="primary" onClick={applyAdvanced}>
            Apply filter
          </Button>
        </>
      )}
      {mode === "topN" && (
        <>
          <div style={{ display: "flex", gap: 4 }}>
            <Select size="small" aria-label="Top or bottom" value={top.dir} onChange={(_, d) => setTop({ ...top, dir: d.value as "top" | "bottom" })}>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </Select>
            <Input size="small" aria-label="Number of items" type="number" style={{ width: 70 }} value={String(top.n)} onChange={(_, d) => setTop({ ...top, n: Number(d.value) })} />
          </div>
          <Select size="small" aria-label="By value" value={top.by ? fieldKey(top.by) : ""} onChange={(_, d) => setTop({ ...top, by: c.model.tables().length ? (visualFields.concat(allValueFields(c)).find((f) => fieldKey(f) === d.value) ?? null) : null })}>
            <option value="">By value…</option>
            {visualFields.concat(allValueFields(c)).filter((f, i, a) => a.findIndex((g) => fieldKey(g) === fieldKey(f)) === i && f.kind !== "column").map((f) => (
              <option key={fieldKey(f)} value={fieldKey(f)}>
                {fieldLabel(f)}
              </option>
            ))}
          </Select>
          <Button size="small" appearance="primary" onClick={applyTop}>
            Apply filter
          </Button>
        </>
      )}
      {mode === "relative" && (
        <>
          <div style={{ display: "flex", gap: 4 }}>
            <Select size="small" aria-label="Relative date: when" value={rel.op} onChange={(_, d) => setRel({ ...rel, op: d.value as typeof rel.op })}>
              <option value="last">Is in the last</option>
              <option value="this">Is in this</option>
              <option value="next">Is in the next</option>
            </Select>
            {rel.op !== "this" && <Input size="small" aria-label="Relative date: number" type="number" style={{ width: 64 }} value={String(rel.n)} onChange={(_, d) => setRel({ ...rel, n: Number(d.value) })} />}
            <Select size="small" aria-label="Relative date: unit" value={rel.unit} onChange={(_, d) => setRel({ ...rel, unit: d.value as RelUnit })}>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
              <option value="years">years</option>
            </Select>
          </div>
          {rel.op !== "this" && <Checkbox size="medium" checked={rel.today} label="Include today" onChange={(_, d) => setRel({ ...rel, today: !!d.checked })} />}
          <Button size="small" appearance="primary" onClick={applyRel}>
            Apply filter
          </Button>
        </>
      )}
      {error && (
        <div role="alert" style={{ color: "#c50f1f", fontSize: 11 }}>
          {error}
        </div>
      )}
      </fieldset>
    </section>
  );
}

function allValueFields(c: ReturnType<typeof useReport>): FieldRef[] {
  return c.model.tables().flatMap((t) => c.model.measures(t).map((m) => measure(t, m)));
}

function Section({ title, scope, defs, hint, visualFields, page, needle = "" }: { title: string; scope: FilterScope; defs: FilterDef[]; hint: string; visualFields: FieldRef[]; page: PageModel; needle?: string }) {
  const c = useReport();
  // readers of the report do not see hidden filters; the search narrows the list by field name
  const listed = defs.filter((d) => !(c.readOnly && d.hidden) && fieldLabel(d.field).toLowerCase().includes(needle.toLowerCase()));
  const add = (f: FieldRef) => {
    const asFilter = f.kind === "agg" ? column(f.table, f.name) : f;
    c.dispatch("report.filter.upsert", { scope, filter: { name: newFilterName(), field: asFilter, cond: { kind: "in", values: [] } } });
  };
  const options = c.model.tables().flatMap((t) => [...c.model.columns(t).map((n) => column(t, n)), ...c.model.measures(t).map((n) => measure(t, n))]);
  return (
    <div role="group" aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
      {listed.map((d) => (
        <FilterCard key={d.name} def={d} scope={scope} visualFields={visualFields} />
      ))}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = fieldFromDrag(e.dataTransfer);
          if (f) add(fieldForRole(c.model, "column", f) as FieldRef);
        }}
        style={{ border: "1px dashed #aaa", borderRadius: 4, padding: 4, fontSize: 11, display: "flex", flexDirection: "column", gap: 3 }}
      >
        <span style={{ opacity: 0.7 }}>{hint}</span>
        <Select size="small" aria-label={`Add a field to ${title}`} value="" onChange={(_, d) => {
          const f = options.find((o) => fieldKey(o) === d.value);
          if (f) add(f);
        }}>
          <option value="">Add field…</option>
          {options.map((f) => (
            <option key={fieldKey(f)} value={fieldKey(f)}>
              {f.table}: {f.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

export function FiltersPane({ page, visual }: { page: PageModel; visual: VisualModel | null }) {
  const c = useReport();
  const reportDefs = useMemo(() => readFilters(c.project.report.files["report.json"] as never).defs, [c.project]);
  const [needle, setNeedle] = useState("");
  const vfields = visual ? Object.values(visual.roles).flat().map((x) => x.field) : [];
  const clearAll = () => {
    const scopes: { scope: FilterScope; defs: FilterDef[] }[] = [
      ...(visual && visual.visualType !== "slicer" ? [{ scope: { level: "visual", page: page.name, visual: visual.name } as FilterScope, defs: visual.filters.defs.filter((d) => d.name !== "slicer") }] : []),
      { scope: { level: "page", page: page.name }, defs: page.filters.defs.filter((d) => !d.name.startsWith("dt_")) },
      { scope: { level: "report" }, defs: reportDefs },
    ];
    for (const s of scopes) for (const d of s.defs) if (!(d.locked && c.readOnly)) c.dispatch("report.filter.upsert", { scope: s.scope, filter: { ...d, cond: { kind: "in", values: [] } } });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 8, height: "100%", overflow: "auto" }} aria-label="Filters pane">
      <div style={{ display: "flex", gap: 4 }}>
        <Input size="small" style={{ flex: 1 }} placeholder="Search filters" aria-label="Search filters" value={needle} onChange={(_, d) => setNeedle(d.value)} />
        {!c.readOnly && (
          <Button size="small" aria-label="Clear all filters" onClick={() => clearAll()}>
            Clear all
          </Button>
        )}
      </div>
      {visual && visual.visualType !== "slicer" && <Section title="Filters on this visual" scope={{ level: "visual", page: page.name, visual: visual.name }} defs={visual.filters.defs.filter((d) => d.name !== "slicer")} hint="Drag fields here or pick one below" visualFields={vfields} page={page} needle={needle} />}
      <Section title="Filters on this page" scope={{ level: "page", page: page.name }} defs={page.filters.defs.filter((d) => !d.name.startsWith("dt_"))} hint="Filters here apply to every visual on this page" visualFields={vfields} page={page} needle={needle} />
      <Section title="Filters on all pages" scope={{ level: "report" }} defs={reportDefs} hint="Filters here apply to every page" visualFields={vfields} page={page} needle={needle} />
      {page.type === "Drillthrough" && <div style={{ fontSize: 11, opacity: 0.7 }}>Drillthrough fields of this page are set in the page's context menu.</div>}
    </div>
  );
}
