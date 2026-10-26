import { describe, expect, it } from "vitest";
import { candidatePairs } from "./detectRelationships";
import { addRelationship, listRelationships } from "./relationships";
import { fixtureProject } from "../report/testFixture";

describe("autodetect relationships", () => {
  it("finds key columns with the same name and type in two tables, with the one side by the table name", () => {
    const p = fixtureProject();
    const c = candidatePairs(p).map((x) => `${x.a.table}.${x.a.column}~${x.b.table}.${x.b.column}:${x.oneSide}`);
    expect(c).toContain("Sales.CustomerKey~Customer.CustomerKey:b");
    expect(c).toContain("Sales.ProductKey~Product.ProductKey:b");
    // not a key name (Channel, Quantity), not shared (SalesKey, PromotionKey)
    expect(c.some((x) => /Channel|Quantity|SalesKey|PromotionKey/.test(x))).toBe(false);
  });
  it("leaves out pairs that already have a relationship, in either direction", () => {
    const p = fixtureProject();
    addRelationship(p, { fromTable: "Customer", fromColumn: "CustomerKey", toTable: "Sales", toColumn: "CustomerKey" });
    const c = candidatePairs(p).map((x) => `${x.a.column}`);
    expect(c).toEqual(["ProductKey"]);
    expect(listRelationships(p)).toHaveLength(1);
  });
});
