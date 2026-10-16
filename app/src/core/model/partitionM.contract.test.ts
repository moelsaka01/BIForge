// The M text that partitionM writes for the DAX fixture CSVs is kept in tests/m/*.m. The Rust test
// crates/engine/tests/m_partitions.rs evaluates the same files with BIForge's M engine and compares the result
// with the engine's own import, so the two generators can not drift apart. When partitionM changes on purpose,
// replace the files with the text this test prints.
import { describe, expect, it } from "vitest";
import { partitionM } from "./partitionM";
import type { BiType, ColumnInfo } from "../data/types";
import sales from "../../../../tests/m/partition_Sales.m?raw";
import customer from "../../../../tests/m/partition_Customer.m?raw";
import date from "../../../../tests/m/partition_Date.m?raw";

const col = (name: string, biType: BiType, duckdbType: string): ColumnInfo => ({ name, biType, duckdbType });
const I = (n: string) => col(n, "int64", "BIGINT");
const T = (n: string) => col(n, "string", "VARCHAR");
const D = (n: string) => col(n, "dateTime", "DATE");
const F = (n: string) => col(n, "double", "DOUBLE");

const cases: [string, ColumnInfo[], string][] = [
  ["Sales", [I("SalesKey"), D("OrderDate"), D("ShipDate"), I("CustomerKey"), I("ProductKey"), I("PromotionKey"), I("Quantity"), F("UnitPrice"), F("Discount"), T("Channel")], sales],
  ["Customer", [I("CustomerKey"), T("Customer"), T("City"), T("Country"), T("Segment"), D("BirthDate")], customer],
  ["Date", [D("Date"), I("Year"), T("Quarter"), I("MonthNumber"), T("Month"), I("YearMonth"), I("DayOfWeek"), col("IsWeekend", "boolean", "BOOLEAN")], date],
];

describe("partitionM contract with the Rust M engine", () => {
  for (const [name, cols, expected] of cases) {
    it(`${name}.csv`, () => {
      expect(partitionM({ kind: "csv", path: `{{FIXTURES}}/${name}.csv` }, cols)).toBe(expected.replace(/\r\n/g, "\n"));
    });
  }
});
