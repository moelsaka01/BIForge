import { describe, expect, it } from "vitest";
import { buildSpec, defaultTableName, emptyForm } from "./importForm";
import { partitionM } from "../core/model/partitionM";
import type { ColumnInfo } from "../core/data/types";

describe("SQL Server source", () => {
  const form = { ...emptyForm("sqlserver"), host: "srv01\SQLEXPRESS", database: "Shop", pgTable: "Orders" };

  it("the form defaults to dbo, no port and Windows authentication, and builds a sqlserver source", () => {
    expect(form.schema).toBe("dbo");
    expect(form.port).toBe("");
    expect(buildSpec(form)).toEqual({ spec: { kind: "sqlserver", server: "srv01\SQLEXPRESS", port: null, database: "Shop", user: null, schema: "dbo", table: "Orders" } });
    const withUser = buildSpec({ ...form, user: "sa", port: "1434" });
    expect(withUser).toEqual({ spec: expect.objectContaining({ user: "sa", port: 1434 }) });
    expect(defaultTableName((buildSpec(form) as { spec: never }).spec)).toBe("Orders");
  });

  it("rejects missing server, database, table and a bad port", () => {
    expect(buildSpec({ ...form, host: "" })).toEqual({ error: "Server and database are required." });
    expect(buildSpec({ ...form, database: " " })).toEqual({ error: "Server and database are required." });
    expect(buildSpec({ ...form, pgTable: "" })).toEqual({ error: "Choose a table." });
    expect(buildSpec({ ...form, port: "99999" })).toEqual({ error: "Port must be a number between 1 and 65535." });
  });

  it("writes the M that Power BI Desktop can refresh: Sql.Database(server, database) and the table by schema and name", () => {
    const cols: ColumnInfo[] = [{ name: "Id", duckdbType: "BIGINT", biType: "int64" }];
    const m = partitionM({ kind: "sqlserver", server: "srv01", port: 1434, database: "Shop", schema: "dbo", table: "Orders" }, cols);
    expect(m).toContain('Sql.Database("srv01,1434", "Shop")');
    expect(m).toContain('Source{[Schema="dbo", Item="Orders"]}[Data]');
    expect(m).not.toMatch(/password|secret/i);
  });
});
