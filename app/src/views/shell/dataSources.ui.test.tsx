// @vitest-environment jsdom
// Data source settings: the sources of the project, stored passwords, and changing where tables read from.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../../core/testing/domStubs";
import { col } from "../../core/testing/fakeEngine";
import { listDataSources, sourceIdentity, withLocation } from "../../core/data/dataSources";
import { getPrivacyLevel, getTableSource } from "../../core/model/tables";
import type { SourceSpec } from "../../core/data/types";
import { PBIP, makeApp } from "./testApp";

installDomStubs();
afterEach(cleanup);

const mysql = (table: string, host = "db1"): SourceSpec => ({ kind: "mysql", host, port: 3306, database: "shop", user: "root", table });

async function setup() {
  const a = makeApp();
  for (const t of ["orders", "items", "csvdata"]) a.engine.sources.set(t, { columns: [col("id", "int64")], rows: [["1"]] });
  a.engine.sources.set("C:\\data\\a.csv", { columns: [col("id", "int64")], rows: [["1"]] });
  render(a.element);
  await act(async () => void (await a.registry.execute("file.open", { path: PBIP })));
  for (const [name, spec] of [["Orders", mysql("orders")], ["Items", mysql("items")], ["Csv", { kind: "csv", path: "C:\\data\\a.csv" } as SourceSpec]] as const) {
    await act(async () => void (await a.registry.execute("data.import", { name, spec })));
  }
  await act(async () => void (await a.registry.execute("data.sourceSettings")));
  // a plain DOM query: role queries over the whole app tree are slow under load
  const dlg = await waitFor(() => {
    const e = document.querySelector('[aria-label="Data source settings"]') as HTMLElement | null;
    if (!e) throw new Error("the dialog is not open");
    return e;
  });
  return { a, dlg };
}

describe("Data source settings", () => {
  it("one row per place with the tables that use it; a source with a user shows whether a password is stored", async () => {
    const { dlg } = await setup();
    const db = within(dlg).getByRole("region", { name: /Data source MySQL database: db1:3306 \/ shop/ });
    expect(db.textContent).toContain("Used by: Orders, Items");
    await waitFor(() => expect(db.textContent).toContain("no password is stored"), { timeout: 15000 });
    const file = within(dlg).getByRole("region", { name: /Data source Text\/CSV file: C:\\data\\a.csv/ });
    expect(file.textContent).toContain("needs no stored password");
    expect(within(file).queryByRole("button", { name: "Edit permissions" })).toBeNull();
  });

  it("saves a password to the credential store and clears it; the project never holds it", async () => {
    const { a, dlg } = await setup();
    const db = within(dlg).getByRole("region", { name: /Data source MySQL/ });
    fireEvent.click(within(db).getByText("Edit permissions"));
    const perms = within(db).getByRole("group", { name: "Permissions" });
    fireEvent.change(within(perms).getByLabelText("New password"), { target: { value: "s3cret" } });
    fireEvent.click(within(perms).getByText("Save password"));
    await waitFor(() => expect(db.textContent).toContain("a password is stored in Windows Credential Manager"), { timeout: 15000 });
    expect(a.engine.calls).toContain("cred:mysql:6");
    expect(JSON.stringify(a.session.store.project)).not.toContain("s3cret");
    fireEvent.click(within(perms).getByText("Clear permissions"));
    await waitFor(() => expect(db.textContent).toContain("no password is stored"), { timeout: 15000 });
    expect(a.engine.calls).toContain("clear:mysql");
  });

  it("Change source points every table of the source at the new server and refreshes them; a bad value changes nothing", async () => {
    const { a, dlg } = await setup();
    const db = within(dlg).getByRole("region", { name: /Data source MySQL/ });
    fireEvent.click(within(db).getByText("Change source…"));
    const form = within(db).getByRole("group", { name: "Change source" });
    fireEvent.change(within(form).getByLabelText("Port"), { target: { value: "99999" } });
    fireEvent.click(within(form).getByText("Change and refresh"));
    await waitFor(() => expect(db.textContent, db.textContent ?? "").toContain("Port must be a number between 1 and 65535."), { timeout: 15000 });
    expect(getTableSource(a.session.store.project!, "Orders")).toMatchObject({ host: "db1" });
    const importsBefore = a.engine.calls.filter((c) => c.startsWith("import:")).length;

    fireEvent.change(within(form).getByLabelText("Port"), { target: { value: "3307" } });
    fireEvent.change(within(form).getByLabelText("Server"), { target: { value: "db2" } });
    fireEvent.click(within(form).getByText("Change and refresh"));
    // a plain DOM query: role queries over the whole tree are slow under load
    await waitFor(() => expect(dlg.querySelector('[aria-label="Result"]')?.textContent ?? "").toContain("The source was changed"), { timeout: 20000 });
    expect(a.engine.calls.filter((c) => c.startsWith("import:")).length).toBe(importsBefore + 2);
    for (const t of ["Orders", "Items"]) expect(getTableSource(a.session.store.project!, t)).toMatchObject({ host: "db2", port: 3307, database: "shop", table: t.toLowerCase() });
    // the generated partition follows
    expect(JSON.stringify(a.session.store.project!.model)).toContain("MySQL.Database(\\\"db2:3307\\\"");
    expect(getTableSource(a.session.store.project!, "Csv")).toMatchObject({ path: "C:\\data\\a.csv" });
  });
});

describe("data source model", () => {
  it("identity ignores table, sheet and query but not the place or user", () => {
    expect(sourceIdentity(mysql("a"))).toBe(sourceIdentity({ ...mysql("b"), query: "SELECT 1" } as SourceSpec));
    expect(sourceIdentity(mysql("a"))).not.toBe(sourceIdentity(mysql("a", "other")));
    expect(sourceIdentity({ kind: "excel", path: "C:\\A.xlsx", sheet: "S1" })).toBe(sourceIdentity({ kind: "excel", path: "c:\\a.xlsx", sheet: "S2" }));
  });

  it("withLocation validates and keeps the rest of the source", () => {
    expect(withLocation({ kind: "web", url: "https://a/b", table: "T", format: "json" }, { url: "https://c/d", user: "" })).toEqual({ kind: "web", url: "https://c/d", table: "T", format: "json", user: null });
    expect(withLocation({ kind: "web", url: "https://a/b" }, { url: "ftp://x" })).toEqual({ error: "Enter an http:// or https:// web address." });
    expect(withLocation({ kind: "csv", path: "a.csv", delimiter: ";" }, { path: "b.csv" })).toEqual({ kind: "csv", path: "b.csv", delimiter: ";" });
    expect(withLocation({ kind: "csv", path: "a.csv" }, { path: " " })).toEqual({ error: "The file path is required." });
    expect(withLocation({ kind: "odbc", flavor: "odbc", connection: "DSN=a", table: "t" }, { connection: "DSN=b;PWD=x" })).toEqual({ error: "Do not put the password in the connection string." });
    expect(withLocation({ kind: "sqlserver", server: "s", database: "d", table: "t", trustCertificate: true }, { host: "s2", database: "d2", port: "", user: "" })).toEqual({ kind: "sqlserver", server: "s2", port: null, database: "d2", user: null, table: "t", trustCertificate: true });
    expect(listDataSources({ model: { tmdl: {} } } as never)).toEqual([]);
  });
});

describe("Privacy level of a data source", () => {
  it("is recorded for every table of the source, shown in the dialog, kept across a refresh, and undoable", async () => {
    const { a, dlg } = await setup();
    const label = (name: RegExp) => within(dlg).getByRole("region", { name });
    const db = label(/Data source MySQL database: db1:3306 \/ shop/);
    const select = within(db).getByLabelText(/Privacy level of/) as HTMLSelectElement;
    expect(select.value).toBe("none");
    expect(db.textContent).toMatch(/changes nothing when data loads/);
    await act(async () => {
      fireEvent.change(select, { target: { value: "private" } });
    });
    await waitFor(() => expect(getPrivacyLevel(a.session.store.project!, "Orders")).toBe("private"));
    expect(getPrivacyLevel(a.session.store.project!, "Items")).toBe("private");
    expect(getPrivacyLevel(a.session.store.project!, "Csv")).toBe("none"); // another source
    expect(listDataSources(a.session.store.project!).find((s) => s.kind === "mysql")?.privacy).toBe("private");
    // a refresh rebuilds the table's partition but keeps the level
    await act(async () => void (await a.registry.execute("data.refreshTable", { name: "Orders" })));
    expect(getPrivacyLevel(a.session.store.project!, "Orders")).toBe("private");
    // an unknown level is refused, and undo restores the earlier state
    expect((await a.registry.execute("data.source.setPrivacy", { id: sourceIdentity(mysql("orders")), level: "secret" })).ok).toBe(false);
    await act(async () => {
      expect((await a.registry.execute("data.source.setPrivacy", { id: sourceIdentity(mysql("orders")), level: "public" })).ok).toBe(true);
    });
    expect(getPrivacyLevel(a.session.store.project!, "Items")).toBe("public");
    await act(async () => void a.session.store.undo());
    expect(getPrivacyLevel(a.session.store.project!, "Items")).toBe("private");
  });
});

describe("Home ribbon", () => {
  it("SQL Server and Enter data open Get data on that source, and Data source settings opens the settings", async () => {
    const a = makeApp();
    render(a.element);
    await act(async () => void (await a.registry.execute("file.open", { path: PBIP })));
    const ribbon = within(await waitFor(() => document.querySelector('[data-testid="ribbon"]') as HTMLElement));
    for (const [button, kind] of [["SQL Server", "sqlserver"], ["Enter data", "inline"]] as const) {
      fireEvent.click(ribbon.getByText(button));
      const dlg = await waitFor(() => {
        const e = document.querySelector('[aria-label="Import data"]') as HTMLElement | null;
        if (!e) throw new Error("no dialog");
        return e;
      });
      expect((within(dlg).getByLabelText("Source type") as HTMLSelectElement).value).toBe(kind);
      fireEvent.click(within(dlg).getByText("Cancel"));
      await waitFor(() => expect(document.querySelector('[aria-label="Import data"]')).toBeNull(), { timeout: 15000 });
    }
    fireEvent.click(ribbon.getByText("Data source settings"));
    await waitFor(() => expect(document.querySelector('[aria-label="Data source settings"]')).not.toBeNull(), { timeout: 15000 });
  });
});
