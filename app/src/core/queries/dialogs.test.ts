import { describe, expect, it } from "vitest";
import { csvQueryText, dialogFor, enterDataText, excelQueryText, typeLabelOf, valueTypeOf, type DialogContext, type DialogKind, type Values } from "./dialogs";
import { itemState, movedColumns, RIBBON, type RibbonContext, type RibbonItem } from "./ribbon";
import { completionsAt, monarchLanguage, quoteIdentifier, SUPPORTED_FUNCTIONS } from "./mLanguage";

const ctx: DialogContext = {
  columns: [
    { name: "Id", duckdbType: "BIGINT" },
    { name: "Name", duckdbType: "VARCHAR" },
    { name: "When", duckdbType: "DATE" },
    { name: "Ok", duckdbType: "BOOLEAN" },
    { name: "Amount", duckdbType: "DOUBLE" },
  ],
  selected: ["Name"],
  query: "Orders",
  queries: ["Cust"],
  queryColumns: { Cust: ["Id", "City"] },
  sheets: ["S1"],
};

function build(kind: DialogKind, v: Values, c: DialogContext = ctx) {
  const def = dialogFor(kind, c);
  // fields the test does not mention keep their defaults, like in the dialog
  const values: Values = {};
  for (const f of def.fields) {
    if (f.kind === "rows") values[f.key] = f.defaultRows ?? [];
    else if ("default" in f && f.default !== undefined) values[f.key] = f.default;
  }
  return def.build({ ...values, ...v });
}

const transformOf = (a: ReturnType<typeof build>) => ("transform" in a ? a.transform : (() => { throw new Error("not a transform"); })());

describe("column types", () => {
  it("map DuckDB types to the value kinds and the labels of the data type menu", () => {
    expect(valueTypeOf("BIGINT")).toBe("number");
    expect(valueTypeOf("DECIMAL(19,4)")).toBe("number");
    expect(valueTypeOf("DATE")).toBe("date");
    expect(valueTypeOf("TIMESTAMP")).toBe("date");
    expect(valueTypeOf("BOOLEAN")).toBe("logical");
    expect(valueTypeOf("VARCHAR")).toBe("text");
    expect(typeLabelOf("DOUBLE")).toBe("Decimal number");
    expect(typeLabelOf("DECIMAL(19,4)")).toBe("Fixed decimal number");
    expect(typeLabelOf("BIGINT")).toBe("Whole number");
    expect(typeLabelOf("VARCHAR")).toBe("Text");
  });
});

describe("dialog builders", () => {
  it("filter conditions are typed by the column and refuse values that do not fit", () => {
    const t = transformOf(build("filter", { conditions: [{ column: "Id", op: "gt", value: "5" }, { column: "Name", op: "contains", value: "an" }, { column: "When", op: "ge", value: "2024-03-05" }, { column: "Ok", op: "eq", value: "TRUE" }, { column: "Amount", op: "isNull" }], combine: "or" }));
    expect(t).toEqual({
      kind: "filterRows",
      combine: "or",
      conditions: [
        { column: "Id", op: "gt", value: "5", valueType: "number" },
        { column: "Name", op: "contains", value: "an", valueType: "text" },
        { column: "When", op: "ge", value: "2024-03-05", valueType: "date" },
        { column: "Ok", op: "eq", value: "TRUE", valueType: "logical" },
        { column: "Amount", op: "isNull" },
      ],
    });
    expect(() => build("filter", { conditions: [{ column: "Id", op: "eq", value: "x" }] })).toThrow('"x" is not a number');
    expect(() => build("filter", { conditions: [{ column: "When", op: "eq", value: "5/3/2024" }] })).toThrow("yyyy-mm-dd");
    expect(() => build("filter", { conditions: [{ column: "Ok", op: "eq", value: "maybe" }] })).toThrow("true or false");
    expect(() => build("filter", { conditions: [{ column: "Id", op: "eq", value: "" }] })).toThrow("needs a value");
    // text columns accept an empty text
    expect(transformOf(build("filter", { conditions: [{ column: "Name", op: "eq", value: "" }] }))).toMatchObject({ conditions: [{ value: "" }] });
  });

  it("row counts and ranges", () => {
    expect(transformOf(build("keepTop", { count: "5" }))).toEqual({ kind: "keepTopRows", count: 5 });
    expect(transformOf(build("removeBottom", { count: 2 }))).toEqual({ kind: "removeBottomRows", count: 2 });
    expect(transformOf(build("keepRange", { first: "3", count: "4" }))).toEqual({ kind: "keepRange", offset: 2, count: 4 });
    expect(() => build("keepTop", { count: "-1" })).toThrow("at least 0");
    expect(() => build("keepTop", { count: "x" })).toThrow();
    expect(() => build("keepRange", { first: "0", count: 1 })).toThrow("at least 1");
  });

  it("replace values picks the number type for number columns and checks the values", () => {
    expect(transformOf(build("replace", { columns: ["Name"], find: "a", replace: "b", entire: false }))).toEqual({ kind: "replaceValues", columns: ["Name"], find: "a", replace: "b", mode: "text" });
    expect(transformOf(build("replace", { columns: ["Name"], find: "a", replace: "b", entire: true }))).toMatchObject({ mode: "value" });
    expect(transformOf(build("replace", { columns: ["Id"], find: "1", replace: "2" }))).toEqual({ kind: "replaceValues", columns: ["Id"], find: 1, replace: 2, mode: "value", valueType: "number" });
    expect(transformOf(build("replace", { columns: ["Id"], findNull: true, replace: "0" }))).toMatchObject({ find: null, replace: 0 });
    expect(() => build("replace", { columns: ["Id"], find: "x", replace: "2" })).toThrow("must be numbers");
    expect(() => build("replace", { columns: [], find: "a", replace: "b" })).toThrow("at least one column");
    expect(() => build("replace", { columns: ["Name"], find: "", replace: "b" })).toThrow("Enter the value to find");
  });

  it("split, group, merge, append, pivot, conditional and custom", () => {
    expect(transformOf(build("split", { column: "Name", by: "delimiter", delimiter: " ", count: 2 }))).toEqual({ kind: "splitColumn", column: "Name", by: "delimiter", delimiter: " ", count: 2 });
    expect(transformOf(build("split", { column: "Name", by: "positions", list: "0, 3", count: 2 }))).toMatchObject({ by: "positions", positions: [0, 3] });
    expect(() => build("split", { column: "Name", by: "positions", list: "a", count: 2 })).toThrow("whole numbers");
    expect(transformOf(build("group", { keys: ["Name"], aggregates: [{ name: "Total", op: "sum", column: "Amount" }, { name: "N", op: "countRows", column: "" }] }))).toEqual({
      kind: "groupBy",
      keys: ["Name"],
      aggregates: [{ name: "Total", op: "sum", column: "Amount" }, { name: "N", op: "countRows" }],
    });
    expect(() => build("group", { keys: ["Name"], aggregates: [{ name: "Name", op: "countRows", column: "" }] })).toThrow("differ");
    expect(() => build("group", { keys: [], aggregates: [{ name: "T", op: "sum", column: "" }] })).toThrow("needs a column");
    const merge = transformOf(build("merge", { right: "Cust", leftKey: "Id", rightKey: "Id", joinKind: "inner", expand: true }));
    expect(merge).toEqual({ kind: "merge", right: "Cust", leftKeys: ["Id"], rightKeys: ["Id"], joinKind: "inner", newColumn: "Cust", expand: [{ name: "Id", newName: "Cust.Id" }, { name: "City", newName: "City" }] });
    expect(transformOf(build("append", { queries: ["Cust"] }))).toEqual({ kind: "append", queries: ["Cust"] });
    expect(() => build("append", { queries: [] })).toThrow("at least one");
    expect(transformOf(build("pivot", { attribute: "Name", value: "Amount", aggregate: "sum" }))).toMatchObject({ kind: "pivot", attributeIsText: true });
    expect(transformOf(build("pivot", { attribute: "Id", value: "Amount", aggregate: "sum" }))).toMatchObject({ attributeIsText: false });
    expect(() => build("pivot", { attribute: "Id", value: "Id" })).toThrow("different");
    const cond = transformOf(build("conditional", { name: "Size", clauses: [{ column: "Amount", op: "ge", value: "10", result: "big" }, { column: "Amount", op: "isNotNull", result: "1" }], otherwise: "none" }));
    expect(cond).toEqual({
      kind: "addConditionalColumn",
      name: "Size",
      clauses: [
        { condition: { column: "Amount", op: "ge", value: "10", valueType: "number" }, result: "big", resultType: "text" },
        { condition: { column: "Amount", op: "isNotNull" }, result: 1, resultType: "number" },
      ],
      elseValue: "none",
      elseType: "text",
    });
    expect(transformOf(build("conditional", { name: "X", clauses: [{ column: "Name", op: "eq", value: "a", result: "b" }], otherwise: "" }))).toMatchObject({ elseValue: null });
    expect(() => build("conditional", { name: "Id", clauses: [{ column: "Name", op: "eq", value: "a", result: "b" }] })).toThrow("already exists");
    expect(() => build("custom", { name: "Name", formula: "1" })).toThrow("already exists");
    expect(() => build("custom", { name: "New", formula: "  " })).toThrow("formula is required");
    expect(transformOf(build("custom", { name: "New", formula: "[Id] * 2" }))).toEqual({ kind: "addCustomColumn", name: "New", formula: "[Id] * 2" });
  });

  it("choose columns keeps the table order; rename, round and index check their input", () => {
    expect(transformOf(build("chooseColumns", { columns: ["Amount", "Id"] }))).toEqual({ kind: "keepColumns", columns: ["Id", "Amount"] });
    expect(() => build("chooseColumns", { columns: [] })).toThrow("at least one");
    expect(transformOf(build("rename", { column: "Name", to: "Title" }))).toEqual({ kind: "renameColumns", pairs: [["Name", "Title"]] });
    expect(() => build("rename", { column: "Name", to: "Id" })).toThrow("already exists");
    expect(transformOf(build("round", { columns: ["Amount"], digits: "2" }))).toEqual({ kind: "round", columns: ["Amount"], digits: 2 });
    expect(transformOf(build("indexCustom", { name: "N", start: 5, step: 5 }))).toEqual({ kind: "addIndexColumn", name: "N", start: 5, step: 5 });
    expect(transformOf(build("customStep", { name: "Mine", expr: "Source" }))).toEqual({ kind: "custom", name: "Mine", expr: "Source" });
  });

  it("new sources write the M Power Query writes", () => {
    const csv = build("newCsv", { path: "C:\\data\\Sales 2024.csv", delimiter: ";" });
    expect(csv).toEqual({ command: "query.add", args: { name: "Sales 2024", loaded: true, text: csvQueryText("C:\\data\\Sales 2024.csv", ";") } });
    expect(csvQueryText("C:\\a.csv", ",")).toBe(
      'let\n    Source = Csv.Document(File.Contents("C:\\a.csv"), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\n    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true])\nin\n    #"Promoted Headers"',
    );
    expect(excelQueryText("C:\\w.xlsx", "Data")).toContain('Source{[Item="Data",Kind="Sheet"]}[Data]');
    expect(build("newExcel", { path: "C:/w.xlsx", sheet: "S1" })).toMatchObject({ command: "query.add", args: { name: "S1" } });
    expect(build("newFolder", { folder: "C:/d", extension: "csv" })).toEqual({ command: "query.addFromFolder", args: { folder: "C:/d", extension: "csv", delimiter: "," } });
    expect(() => build("newCsv", { path: "" })).toThrow("required");
  });

  it("enter data builds a #table from typed lines", () => {
    expect(enterDataText("Name,Qty\nPen,3\nInk,")).toBe('let\n    Source = #table({"Name", "Qty"}, {{"Pen", "3"}, {"Ink", null}})\nin\n    Source');
    expect(enterDataText("A\tB\n1\t2")).toContain('{{"1", "2"}}');
    expect(() => enterDataText("")).toThrow("at least a row");
    expect(() => enterDataText("A,A\n1,2")).toThrow("different");
    expect(() => enterDataText("A\n1,2")).toThrow("more values");
    expect(() => enterDataText("A,\n1,2")).toThrow("needs a name");
    expect(enterDataText('A\nsay "hi"')).toContain('"say ""hi"""');
  });
});

const rc = (over: Partial<RibbonContext> = {}): RibbonContext => ({ columns: ctx.columns, selected: [], hasTable: true, hasQuery: true, dirty: false, ...over });
const all = (): RibbonItem[] => RIBBON.flatMap((t) => t.groups.flatMap((g) => g.items.flatMap((i) => [i, ...(i.menu ?? [])])));
const item = (id: string) => all().find((i) => i.id === id)!;

describe("ribbon", () => {
  it("item ids are unique and a transform item builds a transform from the selection", () => {
    // the data type menu is shared by two tabs: an id may repeat only for the very same item
    const byId = new Map<string, RibbonItem>();
    for (const i of all()) {
      if (byId.has(i.id)) expect(byId.get(i.id)).toBe(i);
      byId.set(i.id, i);
    }
    const remove = item("removeColumns.sel");
    expect(remove.action.type === "transform" && remove.action.build(rc({ selected: ["Id", "Name"] }))).toEqual({ kind: "removeColumns", columns: ["Id", "Name"] });
    const other = item("removeColumns.other");
    expect(other.action.type === "transform" && other.action.build(rc({ selected: ["Amount", "Id"] }))).toEqual({ kind: "keepColumns", columns: ["Id", "Amount"] });
    const blank = item("remove.blank");
    expect(blank.action.type === "transform" && blank.action.build(rc())).toEqual({ kind: "removeBlankRows", textColumns: ["Name"], otherColumns: ["Id", "When", "Ok", "Amount"] });
    expect(item("type.int64").action.type === "transform" && (item("type.int64").action as { build: (c: RibbonContext) => unknown }).build(rc({ selected: ["Name"] }))).toEqual({ kind: "changeType", changes: [{ column: "Name", type: "int64" }] });
  });

  it("Count Rows, Statistics, Keep Duplicates and the error buttons build their transforms", () => {
    const run = (id: string, selected: string[] = ["Amount"]) => {
      const a = item(id).action;
      if (a.type !== "transform") throw new Error(`${id} is not a transform`);
      return a.build(rc({ selected }));
    };
    expect(run("t.count")).toEqual({ kind: "countRows" });
    expect(run("t.stats.sum")).toEqual({ kind: "columnStatistic", column: "Amount", op: "sum" });
    expect(run("t.stats.countDistinct")).toEqual({ kind: "columnStatistic", column: "Amount", op: "countDistinct" });
    expect(run("a.stats.average", ["Id", "Amount"])).toEqual({ kind: "rowStatistic", columns: ["Id", "Amount"], op: "average", newName: "Average" });
    expect(run("keep.dups", ["Id", "Name"])).toEqual({ kind: "keepDuplicates", columns: ["Id", "Name"] });
    expect(run("keep.errors", [])).toEqual({ kind: "keepErrors", columns: [] });
    expect(run("remove.errors", ["Id"])).toEqual({ kind: "removeErrors", columns: ["Id"] });
    const detect = item("t.detect").action;
    expect(detect.type === "command" && detect.id === "query.detectTypes" && detect.argsFor?.(rc({ selected: ["Id", "Name"] }))).toEqual({ columns: ["Id", "Name"] });
    // Replace Errors: text for a text column, a number for a number column, null on request
    expect(transformOf(build("replaceErrors", { columns: ["Name"], value: "n/a" }))).toEqual({ kind: "replaceErrors", columns: ["Name"], value: "n/a", valueType: "text" });
    expect(transformOf(build("replaceErrors", { columns: ["Amount"], value: "0.5" }))).toEqual({ kind: "replaceErrors", columns: ["Amount"], value: 0.5, valueType: "number" });
    expect(() => build("replaceErrors", { columns: ["Amount"], value: "x" })).toThrow("must be a number");
    expect(transformOf(build("replaceErrors", { columns: ["Name"], asNull: true }))).toEqual({ kind: "replaceErrors", columns: ["Name"], value: null });
    expect(() => build("replaceErrors", { columns: [] })).toThrow("at least one");
  });

  it("parameter and group dialogs build commands and refuse bad input", () => {
    const baseCtx = ctx;
    const cmd = (kind: DialogKind, v: Record<string, unknown>, ctx: Partial<DialogContext> = {}) => {
      const a = build(kind, v, { ...baseCtx, ...ctx });
      if (!("command" in a)) throw new Error("not a command");
      return a;
    };
    expect(cmd("newParameter", { name: "Region", type: "Text", suggested: "list", list: "North\nSouth\n", required: true, current: "North", defaultValue: "South" })).toEqual({
      command: "query.setParameter",
      args: { name: "Region", def: { description: "", required: true, type: "Text", list: ["North", "South"], defaultValue: "South", current: "North" } },
    });
    expect(() => cmd("newParameter", { name: "", type: "Text", suggested: "any", current: "x" })).toThrow("Enter a name");
    expect(() => cmd("newParameter", { name: "Cust", type: "Text", suggested: "any", current: "x" })).toThrow("already exists");
    expect(() => cmd("newParameter", { name: "N", type: "WholeNumber", suggested: "any", current: "1.5" })).toThrow("whole number");
    expect(() => cmd("newParameter", { name: "N", type: "Text", suggested: "list", list: "", current: "x" })).toThrow("at least one");
    expect(() => cmd("newParameter", { name: "N", type: "Text", suggested: "list", list: "a", current: "b" })).toThrow("one of the suggested");
    // editing keeps the name and starts from the parameter's values
    const parameter = { name: "Top", def: { description: "d", required: false, type: "WholeNumber" as const, list: [], defaultValue: "", current: "5" } };
    const edit = dialogFor("editParameter", { ...baseCtx, parameter });
    expect(edit.fields.map((f) => ("default" in f ? f.default : undefined))).toEqual(["Top", "d", false, "WholeNumber", "any", "", "", "5"]);
    expect(() => dialogFor("editParameter", baseCtx)).toThrow("Select a parameter");
    expect(() => cmd("editParameter", { name: "Other", type: "WholeNumber", suggested: "any", current: "5" }, { parameter })).toThrow("Rename the parameter");
    expect(transformOf(build("parseJson", { fields: "name\n address.city \n" }))).toEqual({ kind: "parseJson", column: "Name", fields: ["name", "address.city"] });
    expect(() => build("parseJson", { fields: " " })).toThrow("at least one field");
    // groups
    expect(cmd("newGroup", { name: "Staging" }, { query: "Orders" })).toEqual({ command: "query.group.add", args: { name: "Staging", query: "Orders" } });
    expect(cmd("moveToGroup", { group: "Staging" }, { query: "Orders", groups: ["Staging"] })).toEqual({ command: "query.setGroup", args: { query: "Orders", group: "Staging" } });
    expect(() => dialogFor("moveToGroup", baseCtx)).toThrow("no groups");
    expect(cmd("renameGroup", { group: "A", name: "B" }, { groups: ["A"] })).toEqual({ command: "query.group.rename", args: { old: "A", to: "B" } });
    expect(cmd("deleteGroup", { group: "A" }, { groups: ["A"] })).toEqual({ command: "query.group.remove", args: { name: "A" } });
  });

  it("the new transforms: reverse, transpose, alternate rows, merge, extract, date and number functions", () => {
    const run = (id: string, selected: string[] = ["Name"]) => {
      const a = item(id).action;
      if (a.type !== "transform") throw new Error(`${id} is not a transform`);
      return a.build(rc({ selected }));
    };
    expect(run("t.reverse")).toEqual({ kind: "reverseRows" });
    expect(run("t.transpose")).toEqual({ kind: "transpose" });
    expect(run("t.ext.length")).toMatchObject({ kind: "transformColumn", columns: ["Name"], function: "Text.Length", valueType: "int64" });
    expect(run("t.date.monthname", ["Day"])).toMatchObject({ function: "Date.MonthName", valueType: "text" });
    expect(run("t.sci.sqrt", ["Amount"])).toMatchObject({ function: "Number.Sqrt" });
    // every Extract / Date / Number menu entry is a real, allowed library function
    for (const i of all().filter((x) => /^t\.(ext|date|time|std|sci)\./.test(x.id))) {
      const a = i.action;
      if (a.type === "transform") expect((a.build(rc({ selected: ["X"] })) as { function: string }).function).toMatch(/^(Text|Number|Date|DateTime|Time)\.[A-Za-z0-9]+$/);
    }
    expect(transformOf(build("removeAlt", { first: "1", remove: "2", keep: "3" }))).toEqual({ kind: "removeAlternateRows", offset: 0, remove: 2, keep: 3 });
    expect(() => build("removeAlt", { first: "0", remove: 1, keep: 1 })).toThrow("at least 1");
    expect(transformOf(build("mergeColumns", { columns: ["Id", "Name"], separator: "custom", custom: " - ", name: "Both" }))).toEqual({ kind: "mergeColumns", columns: ["Id", "Name"], delimiter: " - ", newName: "Both" });
    expect(() => build("mergeColumns", { columns: ["Id"], separator: ",", name: "x" })).toThrow("at least two");
    expect(() => build("mergeColumns", { columns: ["Id", "Name"], separator: ",", name: " " })).toThrow("name");
    expect(transformOf(build("extractFirst", { count: "3" }))).toMatchObject({ function: "Text.Start", args: [3] });
    expect(transformOf(build("extractRange", { start: "2", count: "4" }))).toMatchObject({ function: "Text.Middle", args: [2, 4] });
    expect(transformOf(build("extractBetween", { start: "[", end: "]" }))).toMatchObject({ function: "Text.BetweenDelimiters", args: ["[", "]"] });
    expect(() => build("extractBefore", { delimiter: "" })).toThrow("delimiter");
  });

  it("availability depends on the selection and column types, with a reason", () => {
    expect(itemState(item("removeColumns.sel"), rc())).toEqual({ enabled: false, reason: "Select a column first." });
    expect(itemState(item("removeColumns.sel"), rc({ selected: ["Id"] })).enabled).toBe(true);
    expect(itemState(item("splitColumn"), rc({ selected: ["Id", "Name"] }))).toEqual({ enabled: false, reason: "Select a single column." });
    expect(itemState(item("format.upper"), rc({ selected: ["Id"] })).reason).toBe("Select a text column.");
    expect(itemState(item("format.upper"), rc({ selected: ["Name"] })).enabled).toBe(true);
    expect(itemState(item("t.round.round"), rc({ selected: ["Name"] })).reason).toBe("Select a number column.");
    const buildOf = (id: string) => {
      const a = item(id).action;
      if (a.type !== "transform") throw new Error(`${id} is not a transform`);
      return a.build(rc({ selected: ["Amount"] }));
    };
    expect(itemState(item("t.round.up"), rc({ selected: ["Amount"] })).enabled).toBe(true);
    expect(buildOf("t.round.up")).toMatchObject({ function: "Number.RoundUp", columns: ["Amount"] });
    expect(buildOf("t.round.down")).toMatchObject({ function: "Number.RoundDown" });
    expect(buildOf("t.info.sign")).toMatchObject({ function: "Number.Sign" });
    expect(itemState(item("t.round"), rc({ selected: ["Amount"] })).enabled).toBe(true);
    expect(itemState(item("promote"), rc({ hasTable: false })).reason).toContain("not a table");
    expect(itemState(item("promote"), rc({ hasQuery: false })).reason).toBe("Select a query first.");
    expect(itemState(item("closeApply"), rc({ hasQuery: false })).enabled).toBe(true);
    expect(itemState(item("t.transpose"), rc({ selected: ["Id"] })).enabled).toBe(true);
    expect(itemState(item("t.duration"), rc({ selected: ["Id"] }))).toEqual({ enabled: false, reason: "Not implemented in BIForge yet." });
    // a menu button is available when one of its entries is
    expect(itemState(item("dataType"), rc()).enabled).toBe(false);
    expect(itemState(item("dataType"), rc({ selected: ["Id"] })).enabled).toBe(true);
    const todo = all().filter((i) => i.notImplemented);
    expect(todo.length).toBeGreaterThan(0);
    expect(todo.every((i) => !itemState(i, rc({ selected: ["Id"] })).enabled)).toBe(true);
  });
});

describe("M language", () => {
  it("the tokenizer is valid and lists keywords and function names", () => {
    expect(monarchLanguage.keywords).toContain("each");
    for (const r of Object.values(monarchLanguage.tokenizer).flat()) {
      const re = Array.isArray(r) ? r[0] : r;
      expect(re instanceof RegExp).toBe(true);
    }
    expect(SUPPORTED_FUNCTIONS).toContain("Table.SelectRows");
    expect(SUPPORTED_FUNCTIONS).toContain("Table.Transpose");
    expect(SUPPORTED_FUNCTIONS).not.toContain("Table.Profile");
  });

  it("completions: functions, steps, queries, columns inside [ ], nothing inside text", () => {
    const c = { columns: ["Sales Amount", "Id"], queries: ["Cust"], steps: ["Source", "Changed Type"] };
    const f = completionsAt("let x = Table.Sel", c);
    expect(f.items.map((i) => i.label)).toContain("Table.SelectRows");
    expect(f.replaceLength).toBe("Table.Sel".length);
    const s = completionsAt("Table.RemoveColumns(Cha", c);
    expect(s.items.find((i) => i.label === "Changed Type")!.insertText).toBe('#"Changed Type"');
    expect(completionsAt("each [Sal", c).items.map((i) => i.label)).toEqual(["Sales Amount", "Id"]);
    expect(completionsAt('x = "Table.Sel', c).items).toEqual([]);
    expect(completionsAt("x = Cu", c).items.map((i) => i.label)).toContain("Cust");
    expect(quoteIdentifier("Source")).toBe("Source");
    expect(quoteIdentifier("a b")).toBe('#"a b"');
    expect(quoteIdentifier("let")).toBe('#"let"');
  });
});

describe("Standard math, Format prefix and suffix, Move, and the new-column variants", () => {
  const amount: DialogContext = { ...ctx, selected: ["Amount"] };
  const run = (id: string, selected: string[]) => {
    const a = item(id).action;
    if (a.type !== "transform") throw new Error(`${id} is not a transform`);
    return a.build(rc({ selected }));
  };
  it("every Standard operation opens a dialog that builds an arithmetic step, or a new column formula", () => {
    for (const op of ["add", "multiply", "subtract", "divide", "integerDivide", "modulo", "percentage", "percentOf"] as const) {
      expect(item(`t.std.${op}`).action).toEqual({ type: "dialog", dialog: `arith.${op}` });
      expect(item(`a.std.${op}`).action).toEqual({ type: "dialog", dialog: `arithNew.${op}` });
    }
    expect(transformOf(build("arith.add", { operand: "5" }, amount))).toEqual({ kind: "arithmetic", columns: ["Amount"], op: "add", operand: 5 });
    expect(transformOf(build("arith.power", { operand: 3 }, amount))).toMatchObject({ op: "power", operand: 3 });
    expect(() => build("arith.divide", { operand: 0 }, amount)).toThrow("divide by zero");
    expect(() => build("arith.add", { operand: "" }, amount)).toThrow("must be a number");
    expect(transformOf(build("arithNew.multiply", { operand: 2 }, amount))).toEqual({ kind: "addCustomColumn", name: "Multiplication", formula: "[Amount] * 2", valueType: "number" });
    expect(transformOf(build("arithNew.modulo", { operand: -3 }, amount))).toMatchObject({ formula: "Number.Mod([Amount], (-3))" });
    expect(transformOf(build("arithNew.add", { operand: 1 }, { ...amount, columns: [...ctx.columns, { name: "Addition", duckdbType: "DOUBLE" }] }))).toMatchObject({ name: "Addition 2" });
  });
  it("Format has capitalize, prefix and suffix; Scientific has the inverse trigonometry, factorial and power", () => {
    expect(run("format.proper", ["Name"])).toMatchObject({ kind: "transformColumn", function: "Text.Proper" });
    expect(transformOf(build("addPrefix", { text: "ID-" }))).toEqual({ kind: "textAffix", columns: ["Name"], prefix: "ID-" });
    expect(transformOf(build("addSuffix", { text: "!" }))).toEqual({ kind: "textAffix", columns: ["Name"], suffix: "!" });
    expect(() => build("addPrefix", { text: "" })).toThrow("required");
    expect(run("t.sci.asin", ["Amount"])).toMatchObject({ function: "Number.Asin" });
    expect(run("t.sci.factorial", ["Amount"])).toMatchObject({ function: "Number.Factorial" });
    expect(item("t.sci.power").action).toEqual({ type: "dialog", dialog: "arith.power" });
    expect(run("a.trig.atan", ["Amount"])).toMatchObject({ kind: "addCustomColumn", formula: "Number.Atan([Amount])", name: "Arctangent" });
    expect(run("a.info.sign", ["Amount"])).toMatchObject({ formula: "Number.Sign([Amount])" });
  });
  it("Move puts the selected columns at the beginning, one place left or right, or at the end", () => {
    const names = ["Id", "Name", "When", "Ok", "Amount"];
    expect(movedColumns(names, ["When", "Amount"], "beginning")).toEqual(["When", "Amount", "Id", "Name", "Ok"]);
    expect(movedColumns(names, ["Name", "Ok"], "end")).toEqual(["Id", "When", "Amount", "Name", "Ok"]);
    expect(movedColumns(names, ["Name", "Ok"], "left")).toEqual(["Name", "Id", "Ok", "When", "Amount"]);
    expect(movedColumns(names, ["Name", "Ok"], "right")).toEqual(["Id", "When", "Name", "Amount", "Ok"]);
    expect(movedColumns(names, ["Id"], "left")).toEqual(names);
    expect(run("t.move.end", ["Id"])).toEqual({ kind: "reorderColumns", columns: ["Name", "When", "Ok", "Amount", "Id"] });
  });
});
