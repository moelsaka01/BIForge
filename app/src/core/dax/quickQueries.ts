// Quick queries: DAX query text generated from a table, a column or a measure of the model (the Data pane's right-click menu).

export type QuickTarget = { kind: "table"; table: string } | { kind: "column"; table: string; name: string } | { kind: "measure"; table: string; name: string };
export interface QuickQuery {
  id: string;
  label: string;
  text: string;
}

const tbl = (t: string) => `'${t.replace(/'/g, "''")}'`;
const col = (t: string, c: string) => `${tbl(t)}[${c.replace(/]/g, "]]")}]`;
const str = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The queries offered for a field, in menu order. */
export function quickQueries(target: QuickTarget): QuickQuery[] {
  switch (target.kind) {
    case "table": {
      const t = tbl(target.table);
      return [
        { id: "show", label: "Show data", text: `EVALUATE\n${t}` },
        { id: "top100", label: "Show first 100 rows", text: `EVALUATE\nTOPN(100, ${t})` },
        { id: "rows", label: "Count rows", text: `EVALUATE\nROW(${str("Rows")}, COUNTROWS(${t}))` },
      ];
    }
    case "column": {
      const c = col(target.table, target.name);
      return [
        { id: "distinct", label: "Show distinct values", text: `EVALUATE\nDISTINCT(${c})\nORDER BY ${c}` },
        {
          id: "stats",
          label: "Count, distinct and blank values",
          text: `EVALUATE\nROW(${str("Rows")}, COUNTROWS(${tbl(target.table)}), ${str("Distinct")}, DISTINCTCOUNT(${c}), ${str("Blank")}, COUNTBLANK(${c}))`,
        },
      ];
    }
    case "measure": {
      const m = `[${target.name.replace(/]/g, "]]")}]`;
      return [{ id: "value", label: "Show the value", text: `EVALUATE\nROW(${str(target.name)}, ${m})` }];
    }
  }
}
