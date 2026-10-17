// Get data connectors: the form builds the source, and partitionM writes the M text Power BI Desktop refreshes.
// The M text of every connector is kept in tests/m/connectors/*.m; crates/engine/tests/m_partitions.rs parses each file with
// BIForge's M parser, so a syntax error in a generator fails there. To accept a deliberate change run
// UPDATE_SNAPSHOTS=1 npx vitest run src/views/connectors.test.ts
import { describe, expect, it } from "vitest";
import { partitionM } from "../core/model/partitionM";
import type { ColumnInfo, SourceSpec } from "../core/data/types";
import { CONNECTORS, buildSpec, defaultTableName, emptyForm, odbcConnection, type ImportForm } from "./importForm";

const I = (n: string): ColumnInfo => ({ name: n, biType: "int64", duckdbType: "BIGINT" });
const T = (n: string): ColumnInfo => ({ name: n, biType: "string", duckdbType: "VARCHAR" });
const cols = [I("Id"), T("Name")];
const nestedCols = [I("id"), T("addr.city"), T("addr.geo.lat"), T("tags")];

const spec = (r: ReturnType<typeof buildSpec>): SourceSpec => {
  if (!("spec" in r)) throw new Error(r.error);
  return r.spec;
};
const form = (patch: Partial<ImportForm>): ImportForm => ({ ...emptyForm(patch.kind), ...patch });

const cases: [string, SourceSpec][] = [
  ["mysql_table", { kind: "mysql", host: "db.local", port: 3307, database: "shop", user: "u", table: "orders" }],
  ["mysql_query", { kind: "mysql", host: "db.local", database: "shop", user: "u", table: "", query: "SELECT id, name FROM people;" }],
  ["sqlserver_query", { kind: "sqlserver", server: "srv", database: "Shop", table: "", query: 'SELECT "Id" FROM dbo.T' }],
  ["postgres_query", { kind: "postgres", host: "h", database: "d", user: "u", table: "", query: "SELECT 1 AS Id" }],
  ["access_table", { kind: "odbc", flavor: "access", connection: "Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=C:\\data\\shop.accdb;", table: "People" }],
  ["access_query", { kind: "odbc", flavor: "access", connection: "Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=C:\\data\\shop.accdb;", query: "SELECT Id, Name FROM People" }],
  ["oracle_table", { kind: "odbc", flavor: "oracle", connection: "Driver={Oracle};Dbq=ora:1521/orcl;", table: "HR.EMP", server: "ora:1521/orcl" }],
  ["oracle_query", { kind: "odbc", flavor: "oracle", connection: "Driver={Oracle};Dbq=ora:1521/orcl;", query: "SELECT * FROM HR.EMP", server: "ora:1521/orcl" }],
  ["db2_table", { kind: "odbc", flavor: "db2", connection: "Driver={IBM DB2};Hostname=db2host;", table: "APP.ORDERS", server: "db2host:50000", database: "SAMPLE" }],
  ["teradata_table", { kind: "odbc", flavor: "teradata", connection: "Driver={Teradata};DBCName=td;", table: "dbc.Tables", server: "td" }],
  ["redshift_table", { kind: "odbc", flavor: "redshift", connection: "Driver={Amazon Redshift};Server=rs;", table: "sales", server: "rs:5439", database: "dev" }],
  ["hana_generic", { kind: "odbc", flavor: "saphana", connection: "Driver={HDBODBC};ServerNode=hana:30015;", table: "SYSTEM.T", server: "hana:30015" }],
  ["odbc_generic", { kind: "odbc", flavor: "odbc", connection: "DSN=warehouse", table: "dbo.Sales" }],
  ["xml_table", { kind: "xml", path: "C:\\data\\shop.xml", table: "item" }],
  ["pdf_table", { kind: "pdf", path: "C:\\data\\report.pdf", table: "Table002 (Page 3)" }],
  ["fixed_width", { kind: "fixedWidth", path: "C:\\data\\fw.txt", widths: [4, 10, 3], header: true }],
  ["web_html_caption", { kind: "web", url: "https://example.com/p", format: "html", table: "Sales" }],
  ["web_html_numbered", { kind: "web", url: "https://example.com/p", format: null, table: "Table 3" }],
  ["web_json", { kind: "web", url: "https://example.com/api?x=1", format: "json", table: "rows" }],
  ["web_csv", { kind: "web", url: "https://example.com/d.csv", format: "csv" }],
  ["web_xml", { kind: "web", url: "https://example.com/d.xml", format: "xml", table: "item" }],
  ["inline_table", { kind: "inline", columns: [{ name: "Name", type: "text" }, { name: "Qty", type: "whole" }, { name: "Price", type: "decimal" }, { name: "Ok", type: "logical" }, { name: "Day", type: "date" }, { name: "At", type: "datetime" }], rows: [["a \"q\"", "2", "1,5", "yes", "2024-01-02", "2024-01-02 03:04"], [null, null, null, null, null, null]] }],
  ["json_nested", { kind: "json", path: "C:/data/nested.json" }],
  ["odata_entity", { kind: "odata", url: "https://svc.example.com/odata", entity: "Products" }],
];

describe("partition M written for each connector", () => {
  const out: Record<string, string> = {};
  for (const [name, s] of cases) {
    it(name, async () => {
      const m = partitionM(s, name === "json_nested" ? nestedCols : cols);
      out[name] = m;
      expect(m.startsWith("let\n")).toBe(true);
      expect(m).not.toMatch(/password|pwd=|secret/i);
      // snapshot file used by the Rust parser test
      const fsName = "node:fs";
      const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: string): string; writeFileSync(p: string, d: string): void; mkdirSync(p: string, o: object): void; existsSync(p: string): boolean };
      const dir = "../tests/m/connectors";
      const file = `${dir}/${name}.m`;
      if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.UPDATE_SNAPSHOTS) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, m);
      }
      expect(fs.existsSync(file), `${file} missing: run with UPDATE_SNAPSHOTS=1`).toBe(true);
      expect(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe(m);
    });
  }

  it("uses the connector functions Power BI Desktop has", () => {
    const m = (n: string) => partitionM(cases.find((c) => c[0] === n)![1], cols);
    expect(m("mysql_table")).toContain('MySQL.Database("db.local:3307", "shop")');
    expect(m("mysql_table")).toContain('Source{[Schema="shop", Item="orders"]}[Data]');
    expect(m("mysql_query")).toContain('MySQL.Database("db.local:3306", "shop", [Query="SELECT id, name FROM people"])');
    expect(m("sqlserver_query")).toContain('Sql.Database("srv", "Shop", [Query="SELECT ""Id"" FROM dbo.T"])');
    expect(m("sqlserver_query")).not.toContain("Item=");
    expect(m("access_table")).toContain('Access.Database(File.Contents("C:\\data\\shop.accdb"), [CreateNavigationProperties=true])');
    expect(m("access_query")).toContain("Odbc.Query(");
    expect(m("oracle_table")).toContain('Oracle.Database("ora:1521/orcl")');
    expect(m("oracle_table")).toContain('Source{[Schema="HR", Item="EMP"]}[Data]');
    expect(m("oracle_query")).toContain('Oracle.Database("ora:1521/orcl", [Query="SELECT * FROM HR.EMP"])');
    expect(m("db2_table")).toContain('DB2.Database("db2host:50000", "SAMPLE")');
    expect(m("teradata_table")).toContain('Teradata.Database("td")');
    expect(m("redshift_table")).toContain('AmazonRedshift.Database("rs:5439", "dev")');
    expect(m("hana_generic")).toContain('Odbc.Query("Driver={HDBODBC};ServerNode=hana:30015;", "SELECT * FROM SYSTEM.T")');
    expect(m("pdf_table")).toContain('Source{[Id="Table002"]}[Data]');
    expect(m("web_html_numbered")).toContain('Source{[Id="Table 2"]}[Data]'); // Power Query counts from 0
    expect(m("web_json")).toContain('Source["rows"]');
    expect(m("odata_entity")).toContain('OData.Feed("https://svc.example.com/odata", null, [Implementation="2.0"])');
    expect(m("inline_table")).toContain('#table(type table [#"Name" = text, #"Qty" = Int64.Type, #"Price" = number, #"Ok" = logical, #"Day" = date, #"At" = datetime], {{"a ""q""", 2, 1.5, true, #date(2024, 1, 2), #datetime(2024, 1, 2, 3, 4, 0)}, {null, null, null, null, null, null}})');
    // nested JSON: the records that the import expanded are expanded in M too, level by level
    const nested = partitionM({ kind: "json", path: "x.json" }, nestedCols);
    expect(nested).toContain('Table.ExpandRecordColumn(#"Converted to Table", "addr", {"city", "geo"}, {"addr.city", "addr.geo"})');
    expect(nested).toContain('Table.ExpandRecordColumn(#"Expanded addr", "addr.geo", {"lat"}, {"addr.geo.lat"})');
    expect(nested.indexOf("Expanded addr")).toBeLessThan(nested.indexOf("Changed Type"));
    expect(partitionM({ kind: "json", path: "x.json" }, cols)).not.toContain("ExpandRecordColumn");
    expect(m("fixed_width")).toContain("Splitter.SplitTextByPositions({0, 4, 14})");
  });
});

describe("Get data form", () => {
  it("lists every connector once, grouped, with no cloud entries", () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CONNECTORS.map((c) => c.label).join("|")).not.toMatch(/sharepoint online|dataverse|fabric|onelake|salesforce|dynamics/i);
    for (const c of ["mysql", "oracle", "odbc", "access", "xml", "pdf", "web", "odata", "sqlserver", "fixedWidth"]) expect(ids).toContain(c);
  });

  it("builds a MySQL source with port 3306 and optional SQL, never holding the password", () => {
    const f = form({ kind: "mysql", database: "shop", user: "u", pgTable: "orders" });
    expect(spec(buildSpec(f))).toEqual({ kind: "mysql", host: "localhost", port: 3306, database: "shop", user: "u", table: "orders" });
    expect(spec(buildSpec({ ...f, pgTable: "", query: " SELECT 1 " }))).toMatchObject({ table: "", query: "SELECT 1" });
    expect(buildSpec({ ...f, pgTable: "" })).toEqual({ error: "Choose a table." });
    expect(buildSpec({ ...f, user: "" })).toEqual({ error: "Server, database and user are required." });
  });

  it("SQL Server: the certificate is trusted only when the box is ticked", () => {
    const f = form({ kind: "sqlserver", host: "s", database: "d", pgTable: "t" });
    expect(spec(buildSpec(f))).not.toHaveProperty("trustCertificate");
    expect(spec(buildSpec({ ...f, trustCert: true }))).toMatchObject({ trustCertificate: true });
  });

  it("builds ODBC connection strings per flavor and refuses a password in them", () => {
    expect(odbcConnection(form({ kind: "oracle", driver: "Oracle in Home", host: "ora:1521/orcl" }))).toBe("Driver={Oracle in Home};Dbq=ora:1521/orcl;");
    expect(odbcConnection(form({ kind: "db2", driver: "IBM", host: "h", database: "S" }))).toBe("Driver={IBM};Hostname=h;Port=50000;Database=S;Protocol=TCPIP;");
    expect(odbcConnection(form({ kind: "redshift", driver: "RS", host: "c", database: "dev" }))).toBe("Driver={RS};Server=c;Port=5439;Database=dev;");
    expect(odbcConnection(form({ kind: "access", driver: "Access", path: "C:\\a.accdb" }))).toBe("Driver={Access};Dbq=C:\\a.accdb;");
    const s = spec(buildSpec(form({ kind: "oracle", driver: "O", host: "ora/orcl", user: "scott", pgTable: "HR.EMP" })));
    expect(s).toMatchObject({ kind: "odbc", flavor: "oracle", user: "scott", table: "HR.EMP", server: "ora/orcl" });
    expect(JSON.stringify(s)).not.toMatch(/password/i);
    expect(buildSpec(form({ kind: "odbc", connection: "DSN=x;PWD=secret", pgTable: "t" }))).toEqual({ error: "Do not put the password in the connection string: use the Password field." });
    expect(buildSpec(form({ kind: "odbc", pgTable: "t" }))).toEqual({ error: "Enter a connection string or choose a driver." });
    expect(buildSpec(form({ kind: "oracle", driver: "O", host: "", pgTable: "t" }))).toEqual({ error: "Server is required." });
    expect(buildSpec(form({ kind: "access", driver: "A", path: "" }))).toEqual({ error: "Choose an Access database file." });
  });

  it("validates web addresses, OData entities and fixed widths", () => {
    expect(buildSpec(form({ kind: "web", url: "ftp://x" }))).toEqual({ error: "Enter an http:// or https:// web address." });
    expect(spec(buildSpec(form({ kind: "web", url: "https://a.b/c", format: "json" }), "rows"))).toEqual({ kind: "web", url: "https://a.b/c", format: "json", table: "rows", user: null });
    expect(buildSpec(form({ kind: "odata", url: "https://svc/odata" }), "")).toEqual({ error: "Choose an entity set." });
    expect(spec(buildSpec(form({ kind: "fixedWidth", path: "a.txt", widths: "4, 10 3" })))).toMatchObject({ widths: [4, 10, 3] });
    expect(buildSpec(form({ kind: "fixedWidth", path: "a.txt", widths: "4, x" }))).toMatchObject({ error: expect.stringContaining("column widths") });
    expect(buildSpec(form({ kind: "pdf" }))).toEqual({ error: "Choose a file." });
  });

  it("Enter data: builds a typed grid source and refuses empty or duplicate column names and an empty grid", () => {
    const f = form({ kind: "inline", inlineColumns: [{ name: "A", type: "whole" }, { name: "B", type: "text" }], inlineRows: [["1", "x"], ["", ""], ["2", ""]] });
    expect(spec(buildSpec(f))).toEqual({ kind: "inline", columns: [{ name: "A", type: "whole" }, { name: "B", type: "text" }], rows: [["1", "x"], ["2", null]] });
    expect(buildSpec({ ...f, inlineRows: [["", ""]] })).toEqual({ error: "Type at least one row." });
    expect(buildSpec({ ...f, inlineColumns: [{ name: "A", type: "text" }, { name: "a", type: "text" }] })).toEqual({ error: "Column names must be different." });
    expect(buildSpec({ ...f, inlineColumns: [{ name: " ", type: "text" }, { name: "b", type: "text" }] })).toEqual({ error: "Every column needs a name." });
  });

  it("names the table from the source", () => {
    expect(defaultTableName({ kind: "odbc", flavor: "oracle", connection: "x", table: "HR.EMP" })).toBe("EMP");
    expect(defaultTableName({ kind: "odata", url: "u", entity: "Products" })).toBe("Products");
    expect(defaultTableName({ kind: "web", url: "https://www.example.com/p", table: null })).toBe("example.com");
    expect(defaultTableName({ kind: "pdf", path: "C:\\r.pdf", table: "Table002 (Page 3)" })).toBe("Table002");
    expect(defaultTableName({ kind: "pdf", path: "C:\\r.pdf" })).toBe("r");
    expect(defaultTableName({ kind: "mysql", host: "h", database: "d", user: "u", table: "" , query: "SELECT 1" })).toBe("Query");
  });
});
