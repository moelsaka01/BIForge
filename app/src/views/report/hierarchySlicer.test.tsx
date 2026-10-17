// @vitest-environment jsdom
// The hierarchy slicer: a slicer with several fields shows their combinations as a tree; branches select as shortest prefixes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { decodeCell } from "../../core/report/cells";
import { filtersToDax, filterFromPbir, filterToPbir, isNeutral, tuplesDax, type FilterDef, type TuplesCond } from "../../core/report/filters";
import { column, lit } from "../../core/report/fields";
import { buildHierarchyQuery } from "../../core/report/queryBuilder";
import { DEFAULT_THEME } from "../../core/report/theme";
import { HierarchySlicerView, asTuples, branchState, buildTree, toggleBranch } from "./HierarchySlicerView";

afterEach(cleanup);

const Cat = column("Product", "Category");
const Sub = column("Product", "Subcategory");
const Item = column("Product", "Product");
const fields = [Cat, Sub, Item];
const data: [string, string, string][] = [
  ["Bikes", "Road", "R1"],
  ["Bikes", "Road", "R2"],
  ["Bikes", "Mountain", "M1"],
  ["Clothing", "Shirts", "S1"],
  ["Clothing", "Socks", "K1"],
];
const rows = data.map((r) => r.map((t) => decodeCell({ t: "text", v: t })));
const tree = buildTree(rows, 3);
const path = (...p: string[]) => p.map(lit.str);
const node = (...p: string[]) => {
  let list = tree;
  let n = list[0];
  for (let i = 0; i < p.length; i++) {
    n = list.find((x) => x.label === p[i])!;
    list = n.children;
  }
  return n;
};

describe("tree and selection", () => {
  it("groups the combinations into levels in the order they come", () => {
    expect(tree.map((n) => n.label)).toEqual(["Bikes", "Clothing"]);
    expect(node("Bikes").children.map((c) => c.label)).toEqual(["Road", "Mountain"]);
    expect(node("Bikes", "Road").children.map((c) => c.label)).toEqual(["R1", "R2"]);
    expect(node("Bikes", "Road", "R1").path).toEqual(path("Bikes", "Road", "R1"));
  });

  it("selecting a branch stores its shortest prefix; selecting every leaf of a branch folds into the branch", () => {
    let c = toggleBranch(null, fields, tree, node("Bikes", "Road"));
    expect(c).toEqual({ kind: "tuples", fields, rows: [path("Bikes", "Road")] });
    c = toggleBranch(c, fields, tree, node("Bikes", "Mountain"));
    expect(c!.rows).toEqual([path("Bikes")]); // both subcategories: the whole Bikes branch
    c = toggleBranch(c, fields, tree, node("Clothing", "Socks", "K1"));
    expect(c!.rows).toEqual([path("Bikes"), path("Clothing", "Socks")]);
  });

  it("states: wholly, partly and not selected; clicking a selected branch removes it; everything or nothing means no filter", () => {
    const c = toggleBranch(null, fields, tree, node("Bikes", "Road", "R1"))!;
    expect(c.rows).toEqual([path("Bikes", "Road", "R1")]);
    expect(branchState(c, node("Bikes", "Road", "R1"))).toBe(true);
    expect(branchState(c, node("Bikes", "Road"))).toBe("mixed");
    expect(branchState(c, node("Bikes"))).toBe("mixed");
    expect(branchState(c, node("Clothing"))).toBe(false);
    expect(branchState(null, node("Bikes"))).toBe(false);
    // removing the only leaf clears the filter
    expect(toggleBranch(c, fields, tree, node("Bikes", "Road", "R1"))).toBeNull();
    // selecting everything clears it too
    let all: TuplesCond | null = null;
    all = toggleBranch(all, fields, tree, node("Bikes"));
    all = toggleBranch(all, fields, tree, node("Clothing"));
    expect(all).toBeNull();
    // a branch covered by a selected ancestor can be partly removed: the ancestor is replaced by its other children
    const bikes = toggleBranch(null, fields, tree, node("Bikes"))!;
    const less = toggleBranch(bikes, fields, tree, node("Bikes", "Road", "R2"))!;
    expect(less.rows).toEqual([path("Bikes", "Road", "R1"), path("Bikes", "Mountain")]);
  });
});

describe("as a filter", () => {
  const sel: TuplesCond = { kind: "tuples", fields, rows: [path("Bikes"), path("Clothing", "Socks"), path("Clothing", "Shirts", "S1")] };
  const def: FilterDef = { name: "slicer", field: Cat, cond: sel };

  it("is one FILTER over all level columns: an OR of ANDs, shorter rows leave deeper levels free", () => {
    expect(tuplesDax(sel)).toBe(
      'FILTER(ALL(Product[Category], Product[Subcategory], Product[Product]), (Product[Category] = "Bikes") || (Product[Category] = "Clothing" && Product[Subcategory] = "Socks") || (Product[Category] = "Clothing" && Product[Subcategory] = "Shirts" && Product[Product] = "S1"))',
    );
    expect(filtersToDax([def]).args).toEqual([tuplesDax(sel)]);
    expect(filtersToDax([{ ...def, cond: { ...sel, rows: [] } }]).args).toEqual([]);
    expect(isNeutral({ ...sel, rows: [] })).toBe(true);
    expect(tuplesDax({ ...sel, rows: [[lit.null(), ...path("x")]] })).toContain("ISBLANK(Product[Category])");
  });

  it("is written to PBIR as one In per row length joined with Or, and read back", () => {
    const j = filterToPbir(def);
    expect(j.type).toBe("Categorical");
    const cond = j.filter.Where[0].Condition;
    expect(JSON.stringify(cond).match(/"In"/g)).toHaveLength(3);
    expect(cond.Or).toBeTruthy();
    const back = filterFromPbir(j)!;
    expect(back.cond.kind).toBe("tuples");
    const c = back.cond as TuplesCond;
    expect(c.fields).toEqual(fields);
    expect(c.rows).toEqual([path("Bikes"), path("Clothing", "Socks"), path("Clothing", "Shirts", "S1")]);
  });

  it("the query for the tree asks for the level columns, ordered, under the filters of other slicers", () => {
    const q = buildHierarchyQuery(fields, [{ name: "x", field: column("Customer", "Country"), cond: { kind: "in", values: [lit.str("France")] } }]);
    expect(q.dax).toBe('EVALUATE SUMMARIZECOLUMNS(Product[Category], Product[Subcategory], Product[Product], FILTER(ALL(Customer[Country]), Customer[Country] IN {"France"}))\nORDER BY Product[Category], Product[Subcategory], Product[Product]');
  });
});

describe("one level selected", () => {
  it("is stored as an ordinary list of the first field and still shows as selected branches", () => {
    const j = filterToPbir({ name: "slicer", field: Cat, cond: { kind: "tuples", fields, rows: [path("Bikes"), path("Clothing")] } });
    const back = filterFromPbir(j)!;
    expect(back.cond).toEqual({ kind: "in", values: path("Bikes", "Clothing") });
    expect(asTuples(back.cond, fields)).toEqual({ kind: "tuples", fields, rows: [path("Bikes"), path("Clothing")] });
    expect(asTuples(null, fields)).toBeNull();
  });
});

describe("HierarchySlicerView", () => {
  const view = (cond: TuplesCond | null = null) => {
    const onChange = vi.fn();
    render(<HierarchySlicerView fields={fields} rows={rows} cond={cond} theme={DEFAULT_THEME} width={260} height={300} search={false} onChange={onChange} />);
    return { onChange, tree: screen.getByRole("tree", { name: "Hierarchy values" }) };
  };

  it("shows the top level; Expand opens a branch; a checkbox selects the branch", () => {
    const { onChange, tree: t } = view();
    expect(within(t).getAllByRole("treeitem").map((x) => x.getAttribute("aria-level"))).toEqual(["1", "1"]);
    expect(within(t).queryByText("Road")).toBeNull();
    fireEvent.click(within(t).getByRole("button", { name: "Expand Bikes" }));
    expect(within(t).getByText("Road")).toBeTruthy();
    fireEvent.click(within(t).getByRole("checkbox", { name: "Road" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "tuples", fields, rows: [path("Bikes", "Road")] });
    fireEvent.click(within(t).getByRole("button", { name: "Collapse Bikes" }));
    expect(within(t).queryByText("Road")).toBeNull();
  });

  it("draws selected branches checked and their ancestors mixed; Clear selection resets", () => {
    const { onChange, tree: t } = view({ kind: "tuples", fields, rows: [path("Bikes", "Road")] });
    expect((within(t).getByRole("checkbox", { name: "Bikes" }) as HTMLInputElement).checked).toBe(false);
    const bikes = within(t).getByRole("checkbox", { name: "Bikes" }) as HTMLInputElement;
    expect(bikes.getAttribute("aria-checked") === "mixed" || bikes.indeterminate).toBe(true);
    fireEvent.click(within(t).getByRole("button", { name: "Expand Bikes" }));
    expect((within(t).getByRole("checkbox", { name: "Road" }) as HTMLInputElement).checked).toBe(true);
    expect((within(t).getByRole("checkbox", { name: "Mountain" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("search keeps matching branches open", () => {
    const onChange = vi.fn();
    render(<HierarchySlicerView fields={fields} rows={rows} cond={null} theme={DEFAULT_THEME} width={260} height={300} search onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Search values"), { target: { value: "sock" } });
    const t = screen.getByRole("tree", { name: "Hierarchy values" });
    expect(within(t).getByText("Clothing")).toBeTruthy();
    expect(within(t).getByText("Socks")).toBeTruthy();
    expect(within(t).queryByText("Bikes")).toBeNull();
  });
});
