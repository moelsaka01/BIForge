// The forms of the modeling features (new column, calculated table, hierarchy, ...) as data, like the Power Query dialogs:
// fields to show and a builder that turns the values into a command. No React here, so every form's output is tested.
import type { DialogDef } from "../queries/dialogs";
import type { TableView } from "./ops";
import { QUICK_MEASURES, quickExpression, quickName, splitColumn, type QuickKind } from "./quickMeasures";

export type ModelDialogId = "newColumn" | "editColumn" | "newCalculatedTable" | "editCalculatedTable" | "newHierarchy" | "quickMeasure" | "whatIf" | "calculationGroup" | "fieldParameter";

export interface ModelDialogCtx {
  tables: TableView[];
  /** The table the dialog was opened for (the table selected in a view). */
  table: string | null;
  /** editColumn: the calculated column to edit and its formula. */
  column?: { name: string; expression: string } | null;
  /** editCalculatedTable: the table and its expression. */
  calculated?: { name: string; expression: string } | null;
}

/** "Name = formula" as typed in Power BI Desktop's formula bar: the leading name is dropped. */
function stripName(name: string, expression: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return expression.replace(new RegExp(`^'?${esc}'?\\s*=\\s*`, "i"), "");
}

const tableOptions = (c: ModelDialogCtx) => c.tables.map((t) => ({ value: t.name, label: t.name }));

const ref = (t: string, c: string) => (/^[A-Za-z_]w*$/.test(t) ? `${t}[${c}]` : `'${t.replace(/'/g, "''")}'[${c}]`);

export function modelDialogFor(id: ModelDialogId, c: ModelDialogCtx): DialogDef {
  switch (id) {
    case "newColumn":
    case "editColumn": {
      const editing = id === "editColumn";
      if (!c.tables.length) throw new Error("The model has no tables yet.");
      if (editing && !c.column) throw new Error("Select a calculated column first.");
      const table = c.table && c.tables.some((t) => t.name === c.table) ? c.table : c.tables[0].name;
      return {
        title: editing ? "Edit calculated column" : "New calculated column",
        submitLabel: editing ? "Save" : "Create",
        fields: [
          { kind: "select", key: "table", label: "Table", options: tableOptions(c), default: table },
          { kind: "text", key: "name", label: "Column name", default: editing ? c.column!.name : "Column" },
          { kind: "textarea", key: "expression", label: "DAX formula (evaluated for each row)", rows: 5, default: editing ? c.column!.expression : "", placeholder: "Sales[Quantity] * Sales[UnitPrice]" },
        ],
        build: (v) => {
          const name = String(v.name ?? "").trim();
          const expression = String(v.expression ?? "").trim();
          if (!name) throw new Error("Enter a name for the column.");
          if (!expression) throw new Error("Enter the DAX formula of the column.");
          // "Name = formula" as typed in Power BI Desktop's formula bar is accepted too
          const body = stripName(name, expression);
          return { command: editing ? "model.editCalculatedColumn" : "model.addCalculatedColumn", args: { table: String(v.table), name, expression: body } };
        },
      };
    }
    case "newCalculatedTable":
    case "editCalculatedTable": {
      const editing = id === "editCalculatedTable";
      if (editing && !c.calculated) throw new Error("Select a calculated table first.");
      return {
        title: editing ? "Edit calculated table" : "New calculated table",
        submitLabel: editing ? "Save" : "Create",
        fields: [
          { kind: "text", key: "name", label: "Table name", default: editing ? c.calculated!.name : "Table" },
          { kind: "textarea", key: "expression", label: "DAX table expression", rows: 6, default: editing ? c.calculated!.expression : "", placeholder: "CALENDAR(DATE(2024, 1, 1), DATE(2024, 12, 31))" },
        ],
        build: (v) => {
          const name = String(v.name ?? "").trim();
          const expression = String(v.expression ?? "").trim();
          if (!name) throw new Error("Enter a name for the table.");
          if (editing && name !== c.calculated!.name) throw new Error("Rename the table in the Model view; this form changes its expression.");
          if (!expression) throw new Error("Enter the DAX expression of the table.");
          return { command: "model.setCalculatedTable", args: { name, expression: stripName(name, expression) } };
        },
      };
    }
    case "fieldParameter": {
      const fields = c.tables.flatMap((t) => [...t.columns.map((x) => ({ value: `${t.name}\u0001${x.name}`, label: `${t.name}[${x.name}]` })), ...t.measures.map((m) => ({ value: `${t.name}\u0001${m.name}`, label: `${t.name}[${m.name}] (measure)` }))]);
      if (!fields.length) throw new Error("The model has no fields yet.");
      return {
        title: "Field parameter",
        submitLabel: "Create",
        fields: [
          { kind: "text", key: "name", label: "Name", default: "Parameter" },
          { kind: "multi", key: "fields", label: "Fields (in the order they are listed)", options: fields, default: [] },
        ],
        build: (v) => {
          const name = String(v.name ?? "").trim();
          if (!name) throw new Error("Enter a name for the parameter.");
          const picked = ((v.fields as string[]) ?? []).map((x) => x.split("\u0001"));
          if (!picked.length) throw new Error("Choose at least one field.");
          return { command: "model.addFieldParameter", args: { name, fields: picked.map(([table, field]) => ({ label: field, table, name: field })) } };
        },
      };
    }
    case "calculationGroup":
      return {
        title: "Calculation group",
        submitLabel: "Create",
        fields: [
          { kind: "text", key: "name", label: "Calculation group name", default: "Calculation group" },
          { kind: "text", key: "column", label: "Column name", default: "Name" },
          {
            kind: "rows",
            key: "items",
            label: "Calculation items (SELECTEDMEASURE() stands for the measure being evaluated)",
            addLabel: "Add calculation item",
            min: 1,
            fields: [
              { kind: "text", key: "name", label: "Item name" },
              { kind: "textarea", key: "expression", label: "DAX expression", rows: 2, placeholder: "SELECTEDMEASURE() * 2" },
            ],
          },
        ],
        build: (v) => {
          const items = ((v.items as { name?: string; expression?: string }[]) ?? []).map((r) => ({ name: String(r.name ?? "").trim(), expression: String(r.expression ?? "").trim() }));
          if (!items.length || items.some((i) => !i.name)) throw new Error("Give every calculation item a name.");
          if (items.some((i) => !i.expression)) throw new Error("Enter the DAX expression of every calculation item.");
          return { command: "model.setCalculationGroup", args: { name: String(v.name ?? "").trim(), column: String(v.column ?? "").trim() || "Name", items } };
        },
      };
    case "whatIf":
      return {
        title: "What-if parameter",
        submitLabel: "Create",
        fields: [
          { kind: "text", key: "name", label: "Name", default: "Parameter" },
          { kind: "select", key: "type", label: "Data type", options: [{ value: "int", label: "Whole number" }, { value: "dec", label: "Decimal number" }], default: "int" },
          { kind: "number", key: "min", label: "Minimum", default: 0 },
          { kind: "number", key: "max", label: "Maximum", default: 100 },
          { kind: "number", key: "step", label: "Increment", default: 1 },
          { kind: "number", key: "default", label: "Default" },
        ],
        build: (v) => {
          const name = String(v.name ?? "").trim();
          if (!name) throw new Error("Enter a name for the parameter.");
          const [min, max, step] = [Number(v.min), Number(v.max), Number(v.step)];
          if (![min, max, step].every(Number.isFinite)) throw new Error("Minimum, maximum and increment must be numbers.");
          if (step <= 0) throw new Error("The increment must be above zero.");
          if (max < min) throw new Error("The maximum must not be below the minimum.");
          if (v.type === "int" && ![min, max, step].every(Number.isInteger)) throw new Error("A whole number parameter needs whole minimum, maximum and increment.");
          if ((max - min) / step > 100000) throw new Error("The range has more than 100,000 values; use a larger increment.");
          const def = v.default === "" || v.default === undefined || v.default === null ? min : Number(v.default);
          if (!Number.isFinite(def) || def < min || def > max) throw new Error("The default must be between the minimum and the maximum.");
          return { command: "model.addWhatIf", args: { name, min, max, step, default: def } };
        },
      };
    case "quickMeasure": {
      if (!c.tables.length) throw new Error("The model has no tables yet.");
      const numeric = c.tables.flatMap((t) => t.columns.filter((x) => ["int64", "double", "decimal"].includes(x.dataType ?? "")).map((x) => ({ value: ref(t.name, x.name), label: `${t.name}[${x.name}]` })));
      const measures = c.tables.flatMap((t) => t.measures.map((m) => ({ value: `[${m.name}]`, label: `[${m.name}] (measure)` })));
      const anyCol = c.tables.flatMap((t) => t.columns.map((x) => ({ value: ref(t.name, x.name), label: `${t.name}[${x.name}]` })));
      const dates = c.tables.flatMap((t) => t.columns.filter((x) => x.dataType === "dateTime").map((x) => ({ value: ref(t.name, x.name), label: `${t.name}[${x.name}]` })));
      const base = [...numeric, ...measures];
      if (!base.length) throw new Error("There is no number column or measure to calculate on.");
      return {
        title: "Quick measure",
        submitLabel: "Create",
        fields: [
          { kind: "select", key: "kind", label: "Calculation", options: QUICK_MEASURES.map((d) => ({ value: d.kind, label: `${d.group}: ${d.label}` })), default: QUICK_MEASURES[0].kind },
          { kind: "select", key: "base", label: "Base value (column or measure)", options: [...base, ...anyCol.filter((x) => !numeric.some((n) => n.value === x.value))], default: base[0].value },
          { kind: "select", key: "category", label: "Category (for per-category calculations and running totals)", options: [{ value: "", label: "(none)" }, ...anyCol], default: "" },
          { kind: "select", key: "date", label: "Date (for time calculations)", options: [{ value: "", label: "(none)" }, ...dates], default: dates[0]?.value ?? "" },
          { kind: "number", key: "periods", label: "Periods (rolling average)", default: 3, min: 1 },
        ],
        build: (v) => {
          const spec = { kind: String(v.kind) as QuickKind, base: String(v.base ?? ""), category: String(v.category ?? "") || undefined, date: String(v.date ?? "") || undefined, periods: Number(v.periods) || undefined };
          const expression = quickExpression(spec);
          const host = splitColumn(spec.base)?.table ?? c.table ?? c.tables[0].name;
          return { command: "model.addMeasure", args: { table: host, name: quickName(spec), expression } };
        },
      };
    }
    case "newHierarchy": {
      const t = c.tables.find((x) => x.name === c.table);
      if (!t) throw new Error("Select a table first.");
      if (t.columns.length < 2) throw new Error(`Table "${t.name}" needs at least two columns for a hierarchy.`);
      return {
        title: `New hierarchy in ${t.name}`,
        submitLabel: "Create",
        fields: [
          { kind: "text", key: "name", label: "Hierarchy name", default: `${t.name} hierarchy` },
          { kind: "textarea", key: "levels", label: "Levels, top to bottom (one column per line)", rows: 5, default: "", placeholder: t.columns.slice(0, 3).map((x) => x.name).join("\n") },
        ],
        build: (v) => {
          const levels = String(v.levels ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          const known = new Map(t.columns.map((x) => [x.name.toLowerCase(), x.name]));
          const missing = levels.find((l) => !known.has(l.toLowerCase()));
          if (missing) throw new Error(`Table "${t.name}" has no column "${missing}".`);
          if (levels.length < 2) throw new Error("A hierarchy needs at least two levels.");
          return { command: "model.addHierarchy", args: { table: t.name, name: String(v.name ?? ""), columns: levels.map((l) => known.get(l.toLowerCase())!) } };
        },
      };
    }
  }
}
