import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Select, Textarea } from "@fluentui/react-components";
import type { Project } from "../core/model/types";
import type { TableView } from "../core/model/ops";
import { getTableSource } from "../core/model/tables";
import { calculatedColumns, calculatedTables, COLUMN_CATEGORIES, getProperty, listHierarchies, PROPS, SUMMARIZE_BY, type PropKey, type Target } from "../core/model/modeling";

const TYPE_NAMES: Record<string, string> = { int64: "Whole number", double: "Decimal number", decimal: "Fixed decimal number", dateTime: "Date/time", string: "Text", boolean: "True/false", binary: "Binary" };

/** Format strings people pick from (Power BI Desktop's Format list), as format string and label. */
export const FORMAT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "General" },
  { value: "#,0", label: "Whole number (1,234)" },
  { value: "#,0.00", label: "Decimal number (1,234.56)" },
  { value: "\\$#,0.00;(\\$#,0.00);\\$#,0.00", label: "Currency ($1,234.56)" },
  { value: "0%", label: "Percentage (12%)" },
  { value: "0.00%", label: "Percentage, 2 decimals (12.34%)" },
  { value: "General Date", label: "Date and time" },
  { value: "Short Date", label: "Short date" },
  { value: "Long Date", label: "Long date" },
  { value: "0.00E+00", label: "Scientific" },
];

const LABELS: Record<PropKey, string> = {
  description: "Description",
  isHidden: "Hidden",
  formatString: "Format",
  summarizeBy: "Summarize by",
  sortByColumn: "Sort by column",
  dataCategory: "Data category",
  displayFolder: "Display folder",
  isKey: "Is key",
};

export interface ModelPropertiesProps {
  project: Project;
  tables: TableView[];
  sel: { kind: "table"; table: string } | { kind: "column"; table: string; column: string } | { kind: "measure"; table: string; name: string };
  run(id: string, args?: unknown): Promise<boolean>;
}

const targetOf = (sel: ModelPropertiesProps["sel"]): Target => sel;

function TextEditor({ label, value, onCommit, multiline }: { label: string; value: string; onCommit(v: string): void; multiline?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  return multiline ? (
    <Textarea aria-label={label} value={v} rows={2} onChange={(_, d) => setV(d.value)} onBlur={commit} />
  ) : (
    <Input aria-label={label} value={v} onChange={(_, d) => setV(d.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

/** The editable properties of the selected table, column or measure (Model view's Properties pane). */
export function ModelProperties({ project, tables, sel, run }: ModelPropertiesProps) {
  const table = tables.find((t) => t.name === sel.table);
  const target = targetOf(sel);
  const set = (key: PropKey, value: string | boolean | null) => void run("model.setProperty", { target, key, value });
  const row = (label: string, body: React.ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 6, padding: "3px 0", fontSize: 13, alignItems: "center" }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{body}</span>
    </div>
  );
  const editors = PROPS.filter((s) => s.on.includes(sel.kind)).map((s) => {
    const label = LABELS[s.key];
    const cur = getProperty(project, target, s.key);
    if (s.kind === "flag") return <div key={s.key}>{row(label, <Checkbox aria-label={label} checked={cur === true} onChange={(_, d) => set(s.key, !!d.checked)} />)}</div>;
    if (s.key === "formatString") {
      const known = FORMAT_PRESETS.some((f) => f.value === cur);
      return (
        <div key={s.key}>
          {row(
            label,
            <Select aria-label={label} value={known ? String(cur) : "__custom"} onChange={(_, d) => d.value !== "__custom" && set(s.key, d.value)}>
              {FORMAT_PRESETS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
              {!known && <option value="__custom">Custom: {String(cur)}</option>}
            </Select>,
          )}
          {row("Format string", <TextEditor label="Format string" value={String(cur)} onCommit={(v) => set(s.key, v)} />)}
        </div>
      );
    }
    if (s.kind === "enum") {
      const values = s.key === "summarizeBy" ? SUMMARIZE_BY : sel.kind === "table" ? ["Time"] : COLUMN_CATEGORIES;
      return (
        <div key={s.key}>
          {row(
            label,
            <Select aria-label={label} value={String(cur)} onChange={(_, d) => set(s.key, d.value || null)}>
              <option value="">{s.key === "summarizeBy" ? "Default" : "None"}</option>
              {values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>,
          )}
        </div>
      );
    }
    if (s.kind === "column") {
      const others = (table?.columns ?? []).filter((c) => c.name !== (sel.kind === "column" ? sel.column : ""));
      return (
        <div key={s.key}>
          {row(
            label,
            <Select aria-label={label} value={String(cur)} onChange={(_, d) => set(s.key, d.value || null)}>
              <option value="">None</option>
              {others.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>,
          )}
        </div>
      );
    }
    return <div key={s.key}>{row(label, <TextEditor label={label} value={String(cur)} onCommit={(v) => set(s.key, v)} multiline={s.key === "description"} />)}</div>;
  });

  if (sel.kind === "table") {
    const calc = calculatedTables(project).find((c) => c.name === sel.table);
    const hierarchies = listHierarchies(project, sel.table);
    return (
      <section aria-label="Table properties" data-testid="table-properties">
        <strong>Table</strong>
        {row("Name", sel.table)}
        {row("Columns", String(table?.columns.length ?? 0))}
        {row("Measures", String(table?.measures.length ?? 0))}
        {row("Source", calc ? "calculated (DAX)" : (getTableSource(project, sel.table)?.kind ?? "none (model table)"))}
        {calc && row("Expression", <code>{calc.expression}</code>)}
        {editors}
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {calc && <Button size="small" onClick={() => void run("model.editCalculatedDialog", { kind: "table", table: sel.table })}>Edit expression</Button>}
          <Button size="small" onClick={() => void run("model.newHierarchyDialog", { table: sel.table })}>New hierarchy</Button>
        </div>
        {hierarchies.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <strong>Hierarchies</strong>
            <ul aria-label="Hierarchies" style={{ paddingLeft: 16, margin: "4px 0" }}>
              {hierarchies.map((h) => (
                <li key={h.name}>
                  {h.name}: {h.levels.map((l) => l.column).join(" > ")}{" "}
                  <Button size="small" appearance="subtle" aria-label={`Delete hierarchy ${h.name}`} onClick={() => void run("model.removeHierarchy", { table: sel.table, name: h.name })}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }
  if (sel.kind === "column") {
    const c = table?.columns.find((x) => x.name === sel.column);
    const calc = calculatedColumns(project, sel.table).find((x) => x.name === sel.column);
    return (
      <section aria-label="Column properties" data-testid="column-properties">
        <strong>Column</strong>
        {row("Name", sel.column)}
        {row("Table", sel.table)}
        {row("Data type", c?.dataType ? (TYPE_NAMES[c.dataType] ?? c.dataType) : "Not set")}
        {calc && row("Formula", <code>{calc.expression}</code>)}
        {editors}
        {calc && (
          <Button size="small" style={{ marginTop: 6 }} onClick={() => void run("model.editCalculatedDialog", { kind: "column", table: sel.table, column: sel.column })}>
            Edit formula
          </Button>
        )}
      </section>
    );
  }
  const m = table?.measures.find((x) => x.name === sel.name);
  return (
    <section aria-label="Measure properties" data-testid="measure-properties">
      <strong>Measure</strong>
      {row("Name", sel.name)}
      {row("Table", sel.table)}
      {row("Expression", m?.expression ?? "")}
      {editors}
    </section>
  );
}
