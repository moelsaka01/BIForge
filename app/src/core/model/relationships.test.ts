import { beforeEach, describe, expect, it } from "vitest";
import { sampleProject } from "../testing/fakes";
import { addRelationship, deleteRelationship, listRelationships, updateRelationship, removeRelationshipsOnColumns } from "./relationships";
import { ModelError } from "./ops";
import type { Project } from "./types";
import { printableTmdlShape } from "../testing/shape";

const mk = () => {
  let n = 0;
  return () => `id-${++n}`;
};

function withTables(): Project {
  const p = sampleProject();
  p.model.tmdl["relationships.tmdl"].nodes = [];
  return p;
}

let nid = mk();
beforeEach(() => {
  nid = mk();
});

describe("relationships", () => {
  it("lists relationships with TMDL defaults", () => {
    const rels = listRelationships(sampleProject());
    expect(rels[0]).toMatchObject({ fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product Info", toColumn: "ProductKey" });
    expect(rels[0]).toMatchObject({ fromCardinality: "many", toCardinality: "one", crossFilter: "single", isActive: true });
  });

  it("adds a relationship with defaults omitted from TMDL", () => {
    const p = withTables();
    const r = addRelationship(p, { fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product Info", toColumn: "ProductKey" }, nid);
    expect(r).toEqual({ id: "id-1", createdInactive: false });
    const n = p.model.tmdl["relationships.tmdl"].nodes[0];
    expect(n.props.map((x) => x.key)).toEqual(["fromColumn", "toColumn"]);
    expect(printableTmdlShape(n)).toContain("'Product Info'.ProductKey");
    expect(listRelationships(p)).toHaveLength(1);
  });

  it("creates the relationships file when the model has none, and removes it when emptied", () => {
    const p = withTables();
    delete p.model.tmdl["relationships.tmdl"];
    const { id } = addRelationship(p, { fromTable: "Sales", fromColumn: "DateKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    expect(Object.keys(p.model.tmdl)).toContain("relationships.tmdl");
    deleteRelationship(p, id);
    expect(Object.keys(p.model.tmdl)).not.toContain("relationships.tmdl");
  });

  it("rejects unknown columns, same-table and duplicate relationships (either direction)", () => {
    const p = withTables();
    expect(() => addRelationship(p, { fromTable: "Sales", fromColumn: "Nope", toTable: "Calendar", toColumn: "DateKey" })).toThrow(/Nope/);
    expect(() => addRelationship(p, { fromTable: "Sales", fromColumn: "DateKey", toTable: "Sales", toColumn: "ProductKey" })).toThrow(
      /two different tables/,
    );
    addRelationship(p, { fromTable: "Sales", fromColumn: "DateKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    expect(() => addRelationship(p, { fromTable: "Calendar", fromColumn: "DateKey", toTable: "Sales", toColumn: "DateKey" })).toThrow(ModelError);
  });

  it("creates a second path between the same tables as inactive", () => {
    const p = withTables();
    p.model.tmdl["tables/Sales.tmdl"].nodes[0].children.push({
      description: [],
      kind: "column",
      name: "ShipDate",
      default: null,
      props: [],
      children: [],
    });
    addRelationship(p, { fromTable: "Sales", fromColumn: "DateKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    const r = addRelationship(p, { fromTable: "Sales", fromColumn: "ShipDate", toTable: "Calendar", toColumn: "DateKey" }, nid);
    expect(r.createdInactive).toBe(true);
    expect(listRelationships(p)[1].isActive).toBe(false);
    expect(p.model.tmdl["relationships.tmdl"].nodes[1].props.find((x) => x.key === "isActive")).toEqual({
      key: "isActive",
      value: { Text: "false" },
    });
  });

  it("refuses to activate a relationship that would be ambiguous, allows it after deactivating the other", () => {
    const p = withTables();
    const a = addRelationship(p, { fromTable: "Sales", fromColumn: "DateKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    const b = addRelationship(p, { fromTable: "Sales", fromColumn: "ProductKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    expect(b.createdInactive).toBe(true);
    expect(() => updateRelationship(p, b.id, { isActive: true })).toThrow(/Deactivate/);
    updateRelationship(p, a.id, { isActive: false });
    updateRelationship(p, b.id, { isActive: true });
    expect(listRelationships(p).map((r) => r.isActive)).toEqual([false, true]);
  });

  it("indirect cycles also count as ambiguous", () => {
    const p = withTables();
    addRelationship(p, { fromTable: "Sales", fromColumn: "DateKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    addRelationship(p, { fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product Info", toColumn: "ProductKey" }, nid);
    const c = addRelationship(p, { fromTable: "Product Info", fromColumn: "ProductKey", toTable: "Calendar", toColumn: "DateKey" }, nid);
    expect(c.createdInactive).toBe(true);
  });

  it("updates cardinality and cross-filter direction; one-to-one is forced bidirectional", () => {
    const p = withTables();
    const { id } = addRelationship(p, { fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product Info", toColumn: "ProductKey" }, nid);
    updateRelationship(p, id, { crossFilter: "both" });
    expect(listRelationships(p)[0].crossFilter).toBe("both");
    updateRelationship(p, id, { crossFilter: "single" });
    updateRelationship(p, id, { fromCardinality: "one" });
    expect(listRelationships(p)[0]).toMatchObject({ fromCardinality: "one", toCardinality: "one", crossFilter: "both" });
    updateRelationship(p, id, { fromCardinality: "many", toCardinality: "many" });
    expect(listRelationships(p)[0]).toMatchObject({ fromCardinality: "many", toCardinality: "many", crossFilter: "single" });
    const keys = p.model.tmdl["relationships.tmdl"].nodes[0].props.map((x) => x.key);
    expect(keys).toEqual(["toCardinality", "fromColumn", "toColumn"]);
  });

  it("delete and unknown ids", () => {
    const p = sampleProject();
    const before = listRelationships(p).length;
    deleteRelationship(p, listRelationships(p)[0].id);
    expect(listRelationships(p)).toHaveLength(before - 1);
    expect(() => deleteRelationship(p, "zzz")).toThrow(/does not exist/);
    expect(() => updateRelationship(p, "zzz", { isActive: false })).toThrow(/does not exist/);
  });

  it("removes relationships that use vanished columns", () => {
    const p = sampleProject();
    expect(removeRelationshipsOnColumns(p, "Sales", ["ProductKey"])).toHaveLength(1);
    expect(listRelationships(p)).toHaveLength(1);
    expect(removeRelationshipsOnColumns(p, "Sales", [])).toEqual([]);
  });
});
