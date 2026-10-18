// @vitest-environment jsdom
// The Get data dialog: connector list, forms per connector, the navigator (list, preview, multi-select), custom SQL, secrets.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../core/testing/domStubs";
import { FakeEngine, col } from "../core/testing/fakeEngine";
import type { SourceSpec } from "../core/data/types";
import { ImportDialog } from "./ImportDialog";
import type { ConnectorId } from "./importForm";

installDomStubs();
afterEach(cleanup);

function setup(kind: ConnectorId, engine = new FakeEngine(), extra: { onBlank?: () => Promise<string | null>; scriptHomes?: { python: string; r: string } } = {}) {
  const submitted: { name: string; spec: SourceSpec; password: string }[] = [];
  let closed = false;
  render(
    <ImportDialog
      open
      initialKind={kind}
      engine={engine}
      dialogs={{ pickPbip: async () => null, pickFolder: async () => null, pickFile: async () => "C:\\data\\shop.xml" }}
      onSubmit={async (name, spec, password) => {
        submitted.push({ name, spec, password });
        return null;
      }}
      onClose={() => (closed = true)}
      {...extra}
    />,
  );
  return { engine, submitted, closed: () => closed, dlg: () => screen.getByRole("dialog", { name: "Import data" }) };
}
const type = (dlg: HTMLElement, label: string, value: string) => fireEvent.change(within(dlg).getByLabelText(label), { target: { value } });

describe("Get data dialog", () => {
  it("offers the connectors in File, Database and Online groups and no cloud ones", () => {
    const { dlg } = setup("csv");
    const select = within(dlg()).getByLabelText("Source type") as HTMLSelectElement;
    const groups = [...select.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)] as const);
    expect(groups.map((g) => g[0])).toEqual(["File", "Database", "Online and other"]);
    const all = groups.flatMap((g) => g[1]).join("|");
    for (const t of ["MySQL database", "SQL Server database", "Oracle database", "ODBC (any other database)", "Access database", "XML", "PDF", "Web", "OData feed"]) expect(all).toContain(t);
    expect(all).not.toMatch(/dataverse|sharepoint online|fabric|onelake|salesforce/i);
  });

  it("MySQL: lists tables, previews the clicked one, imports every ticked table under its own name; the password goes to the credential store only", async () => {
    const e = new FakeEngine();
    e.choices.set("mysql", ["customers", "orders", "products"]);
    e.previews.set("orders", { columns: [col("id", "int64"), col("total", "double")], rows: [["1", "9.5"], ["2", null]], total: 2 });
    const { dlg, submitted, closed } = setup("mysql", e);
    type(dlg(), "Database", "shop");
    type(dlg(), "User", "root");
    type(dlg(), "Password", "pw1");
    expect((within(dlg()).getByLabelText("Port") as HTMLInputElement).value).toBe("3306");
    fireEvent.click(within(dlg()).getByRole("button", { name: "List tables" }));
    const nav = await within(dlg()).findByRole("group", { name: "Navigator" });
    expect(within(nav).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["customers", "orders", "products"]);
    expect(e.calls).toContain("cred:mysql:3"); // the secret reached the credential store before listing
    fireEvent.click(within(nav).getByRole("button", { name: "orders" }));
    await waitFor(() => expect(within(nav).getByLabelText("Preview").textContent).toContain("9.5"));
    expect(e.calls).toContain("preview:mysql:20");

    fireEvent.click(within(nav).getByRole("checkbox", { name: "Select orders" }));
    fireEvent.click(within(nav).getByRole("checkbox", { name: "Select products" }));
    expect((within(dlg()).getByLabelText("Table name") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import 2 tables" }));
    await waitFor(() => expect(closed()).toBe(true));
    expect(submitted.map((s) => s.name)).toEqual(["orders", "products"]);
    expect(submitted[0].spec).toEqual({ kind: "mysql", host: "localhost", port: 3306, database: "shop", user: "root", table: "orders" });
    expect(JSON.stringify(submitted.map((s) => s.spec))).not.toContain("pw1");
  });

  it("asks for at least one ticked table, and a custom SQL statement replaces the table", async () => {
    const e = new FakeEngine();
    e.choices.set("postgres", ["a", "b"]);
    const { dlg, submitted } = setup("postgres", e);
    type(dlg(), "Database", "d");
    type(dlg(), "User", "u");
    fireEvent.click(within(dlg()).getByRole("button", { name: "List tables" }));
    await within(dlg()).findByRole("group", { name: "Navigator" });
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    expect((await within(dlg()).findByRole("alert")).textContent).toBe("Tick at least one table.");
    fireEvent.click(within(dlg()).getByText("Advanced options: SQL statement"));
    type(dlg(), "SQL statement", "SELECT id FROM t");
    type(dlg(), "Table name", "Ids");
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ name: "Ids", spec: { kind: "postgres", query: "SELECT id FROM t" } });
  });

  it("an ODBC flavor offers only matching installed drivers and says so when there is none", async () => {
    const e = new FakeEngine();
    e.drivers = ["SQL Server", "Oracle in OraClient19Home1", "Microsoft Access Driver (*.mdb, *.accdb)"];
    const { dlg } = setup("oracle", e);
    const select = (await within(dlg()).findByLabelText("ODBC driver")) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(["Oracle in OraClient19Home1"]));
    cleanup();
    const none = setup("teradata", new FakeEngine());
    expect((await within(none.dlg()).findByRole("note")).textContent).toMatch(/No matching ODBC driver/);
  });

  it("generic ODBC takes a connection string without a password and uses the stored password", async () => {
    const e = new FakeEngine();
    e.choices.set("odbc", ["dbo.Sales"]);
    const { dlg, submitted } = setup("odbc", e);
    type(dlg(), "Connection string", "DSN=warehouse");
    type(dlg(), "User", "bi");
    type(dlg(), "Password", "pw");
    fireEvent.click(within(dlg()).getByRole("button", { name: "List tables" }));
    const nav = await within(dlg()).findByRole("group", { name: "Navigator" });
    expect((within(nav).getByRole("checkbox", { name: "Select dbo.Sales" }) as HTMLInputElement).checked).toBe(true); // a single table is ticked for you
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(submitted, within(dlg()).queryByRole("alert")?.textContent ?? "no alert").toHaveLength(1));
    expect(submitted[0].name).toBe("Sales");
    expect(submitted[0].spec).toMatchObject({ kind: "odbc", connection: "DSN=warehouse", user: "bi", table: "dbo.Sales" });
    expect(e.calls).toContain("cred:odbc:2");
    type(dlg(), "Connection string", "DSN=w;PWD=x");
  });

  it("Web: a page address lists its tables; XML and PDF list the tables of the picked file", async () => {
    const e = new FakeEngine();
    e.choices.set("web", ["Sales", "Table 2"]);
    e.choices.set("xml", ["item", "person"]);
    const w = setup("web", e);
    type(w.dlg(), "Web address", "https://example.com/p");
    fireEvent.click(within(w.dlg()).getByRole("button", { name: "Show tables" }));
    await within(w.dlg()).findByRole("group", { name: "Navigator" });
    fireEvent.click(within(w.dlg()).getByRole("checkbox", { name: "Select Sales" }));
    fireEvent.click(within(w.dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(w.submitted).toHaveLength(1));
    expect(w.submitted[0].spec).toEqual({ kind: "web", url: "https://example.com/p", format: null, table: "Sales", user: null });
    cleanup();

    const x = setup("xml", e);
    fireEvent.click(within(x.dlg()).getByRole("button", { name: "Browse…" }));
    const nav = await within(x.dlg()).findByRole("group", { name: "Navigator" }); // listed right after the file is picked
    expect(within(nav).getAllByRole("listitem")).toHaveLength(2);
    cleanup();

    const bad = setup("web", e);
    type(bad.dlg(), "Web address", "ftp://x");
    fireEvent.click(within(bad.dlg()).getByRole("button", { name: "Show tables" }));
    expect((await within(bad.dlg()).findByRole("alert")).textContent).toMatch(/http:\/\/ or https:\/\//);
  });

  it("Enter data: type a table in the grid, add a column and a row, and import it with the chosen types", async () => {
    const { dlg, submitted, closed } = setup("inline");
    const grid = within(dlg()).getByRole("group", { name: "Enter data" });
    fireEvent.change(within(grid).getByLabelText("Name of column 1"), { target: { value: "Item" } });
    fireEvent.change(within(grid).getByLabelText("Name of column 2"), { target: { value: "Qty" } });
    fireEvent.change(within(grid).getByLabelText("Type of column 2"), { target: { value: "whole" } });
    fireEvent.click(within(grid).getByRole("button", { name: "Add column" }));
    fireEvent.change(within(grid).getByLabelText("Name of column 3"), { target: { value: "Day" } });
    fireEvent.change(within(grid).getByLabelText("Type of column 3"), { target: { value: "date" } });
    fireEvent.click(within(grid).getByRole("button", { name: "Add row" }));
    expect(within(grid).getAllByLabelText(/^Row \d+, column 1$/)).toHaveLength(4);
    fireEvent.change(within(grid).getByLabelText("Row 1, column 1"), { target: { value: "Pen" } });
    fireEvent.change(within(grid).getByLabelText("Row 1, column 2"), { target: { value: "3" } });
    fireEvent.change(within(grid).getByLabelText("Row 1, column 3"), { target: { value: "2024-05-06" } });
    fireEvent.change(within(grid).getByLabelText("Row 4, column 1"), { target: { value: "Ink" } });
    fireEvent.click(within(grid).getByRole("button", { name: "Remove row 2" }));
    type(dlg(), "Table name", "Items");
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(closed()).toBe(true));
    expect(submitted[0].name).toBe("Items");
    expect(submitted[0].spec).toEqual({
      kind: "inline",
      columns: [{ name: "Item", type: "text" }, { name: "Qty", type: "whole" }, { name: "Day", type: "date" }],
      rows: [["Pen", "3", "2024-05-06"], ["Ink", null, null]],
    });
  });

  it("Basic authentication for a web address shows the password field only when a user is entered", () => {
    const { dlg } = setup("odata");
    expect(within(dlg()).queryByLabelText("Password")).toBeNull();
    type(dlg(), "User", "ann");
    expect(within(dlg()).getByLabelText("Password")).toBeTruthy();
  });

  it("OLE DB: a connection string without a password, a table from the navigator, the password in the credential store", async () => {
    const e = new FakeEngine();
    e.choices.set("oledb", ["Parts", "Order Details"]);
    const { dlg, submitted } = setup("oledb", e);
    type(dlg(), "OLE DB connection string", "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\\shop.accdb");
    expect(within(dlg()).queryByLabelText("Password")).toBeNull();
    type(dlg(), "User", "ann");
    type(dlg(), "Password", "pw9");
    fireEvent.click(within(dlg()).getByRole("button", { name: "List tables" }));
    const nav = await within(dlg()).findByRole("group", { name: "Navigator" });
    fireEvent.click(within(nav).getByRole("checkbox", { name: "Select Order Details" }));
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0].spec).toMatchObject({ kind: "oledb", user: "ann", table: "Order Details" });
    expect(JSON.stringify(submitted[0].spec)).not.toContain("pw9");
    expect(e.calls).toContain("cred:oledb:3");
  });

  it("Analysis Services: server, model and a DAX query or a table", async () => {
    const e = new FakeEngine();
    const { dlg, submitted } = setup("analysisServices", e);
    type(dlg(), "Server", "localhost:51234");
    type(dlg(), "Database", "Model");
    type(dlg(), "DAX or MDX query", "EVALUATE 'Sales'");
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0].spec).toMatchObject({ kind: "analysisServices", server: "localhost:51234", database: "Model", query: "EVALUATE 'Sales'" });
  });

  it("a Python or R script runs only after the user confirmed it, with the interpreter folder from the options", async () => {
    const e = new FakeEngine();
    e.choices.set("script", ["df", "other"]);
    const { dlg, submitted } = setup("python", e, { scriptHomes: { python: "C:\\Python312", r: "" } });
    expect(within(dlg()).getByText(/runs your own Python 3 with pandas/i)).toBeTruthy();
    type(dlg(), "Script", "import pandas as pd\ndf = pd.DataFrame({'a': [1]})");
    expect((within(dlg()).getByLabelText("Interpreter folder") as HTMLInputElement).value).toBe("C:\\Python312");
    const list = within(dlg()).getByRole("button", { name: "Run the script and list its tables" }) as HTMLButtonElement;
    expect(list.disabled).toBe(true); // not before the box is ticked
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(within(dlg()).getByRole("alert").textContent).toMatch(/Tick the box/));
    expect(submitted).toEqual([]);
    fireEvent.click(within(dlg()).getByRole("checkbox", { name: /runs on my computer/ }));
    expect(list.disabled).toBe(false);
    fireEvent.click(list);
    const nav = await within(dlg()).findByRole("group", { name: "Navigator" });
    fireEvent.click(within(nav).getByRole("checkbox", { name: "Select df" }));
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0].spec).toMatchObject({ kind: "script", language: "python", table: "df" });
  });

  it("Blank query creates an empty query in Power Query instead of importing a source", async () => {
    let blanks = 0;
    const { dlg, submitted, closed } = setup("blank", new FakeEngine(), { onBlank: async () => {
      blanks += 1;
      return null;
    } });
    expect(within(dlg()).getByText(/no data source/i)).toBeTruthy();
    fireEvent.click(within(dlg()).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(closed()).toBe(true));
    expect(blanks).toBe(1);
    expect(submitted).toEqual([]);
  });
});
