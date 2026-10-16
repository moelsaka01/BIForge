// Test double for DaxApi. It does not evaluate DAX: tests program the answers.
import type { Cell, DaxApi, EditorDiagnostic, FunctionInfo, QueryOutcome, QueryResult } from "../dax/types";
import type { TmdlDocument } from "../model/types";

export const fn = (name: string, signature: string, implemented = true): FunctionInfo => ({
  name,
  category: "Test",
  signature,
  returnsTable: false,
  description: `${name} description`,
  implemented,
  minArgs: 0,
  maxArgs: null,
});

export const cell = (v: string, t: Cell["t"] = "int"): Cell => ({ t, v });

export const result = (columns: string[], rows: Cell[][]): QueryResult => ({ columns, rows, totalRows: rows.length, truncated: false });

export class FakeDax implements DaxApi {
  catalogFns: FunctionInfo[] = [fn("SUM", "SUM(column)"), fn("CALCULATE", "CALCULATE(expression, filter*)"), fn("XIRR", "XIRR(table, values, dates)", false)];
  /** Diagnostics by exact expression text. */
  diagnostics = new Map<string, EditorDiagnostic[]>();
  /** Answers by a substring of the query; the first match wins. */
  answers: { match: string; outcome: QueryOutcome | Error }[] = [];
  /** Computes an answer for a query; consulted before `answers`. */
  handler?: (query: string) => QueryOutcome | Error | undefined;
  calls: string[] = [];
  checkedDocuments: TmdlDocument[][] = [];

  async catalog(): Promise<FunctionInfo[]> {
    this.calls.push("catalog");
    return this.catalogFns;
  }
  async check(documents: TmdlDocument[], expression: string): Promise<EditorDiagnostic[]> {
    this.calls.push(`check:${expression}`);
    this.checkedDocuments.push(documents);
    return this.diagnostics.get(expression) ?? [];
  }
  async query(_documents: TmdlDocument[], query: string): Promise<QueryOutcome> {
    this.calls.push(`query:${query}`);
    const h = this.handler?.(query);
    if (h instanceof Error) throw h;
    if (h) return h;
    const a = this.answers.find((x) => query.includes(x.match));
    if (!a) throw new Error("no answer programmed");
    if (a.outcome instanceof Error) throw a.outcome;
    return a.outcome;
  }
}
