import { describe, expect, it } from "vitest";
import { suggestFormula, type ExampleColumn } from "./examples";

const cols: ExampleColumn[] = [
  { name: "First", kind: "text" },
  { name: "Last", kind: "text" },
  { name: "Email", kind: "text" },
  { name: "Born", kind: "date" },
  { name: "Qty", kind: "number" },
];
const rows: (string | null)[][] = [
  ["ann", "Lee", "ann.lee@corp.com", "1990-03-05", "12"],
  ["BOB", "stone", "bob.stone@mail.org", "1985-11-30", "7"],
  ["cy", "Wu", "cy.wu@corp.com", "2001-07-14", "130"],
  [null, "Xi", "x@y.z", "1999-01-02", "5"],
];
const ex = (...pairs: [number, string][]) => new Map(pairs);

describe("Column From Examples", () => {
  it("finds simple case and character expressions from one or two examples", () => {
    expect(suggestFormula(cols, rows, ex([0, "ANN"]))?.formula).toBe("Text.Upper([First])");
    expect(suggestFormula(cols, rows, ex([0, "ANN"], [1, "BOB"]))?.values).toEqual(["ANN", "BOB", "CY", null]);
    expect(suggestFormula(cols, rows, ex([0, "A"], [1, "B"]))?.formula).toBe("Text.Upper(Text.Start([First], 1))");
    // proper case needs a row that tells it from upper / lower case
    expect(suggestFormula(cols, rows, ex([1, "Stone"]))?.formula).toBe("Text.Proper([Last])");
  });

  it("finds text before and after a delimiter", () => {
    expect(suggestFormula(cols, rows, ex([0, "corp.com"], [1, "mail.org"], [3, "y.z"]))?.formula).toBe('Text.AfterDelimiter([Email], "@")');
    expect(suggestFormula(cols, rows, ex([0, "ann.lee"], [1, "bob.stone"]))?.formula).toBe('Text.BeforeDelimiter([Email], "@")');
    expect(suggestFormula(cols, rows, ex([0, "com"], [3, "z"]))?.values).toEqual(["com", "org", "com", "z"]);
  });

  it("joins columns and literal text", () => {
    const s = suggestFormula(cols, rows, ex([0, "Lee, ann"], [1, "stone, BOB"]));
    expect(s?.formula).toBe('[Last] & ", " & [First]');
    expect(s?.values).toEqual(["Lee, ann", "stone, BOB", "Wu, cy", null]);
    expect(suggestFormula(cols, rows, ex([2, "cy Wu"]))?.formula).toBe('[First] & " " & [Last]');
  });

  it("reads parts of dates and numbers", () => {
    expect(suggestFormula(cols, rows, ex([0, "March"]))?.formula).toBe("Date.MonthName([Born])");
    expect(suggestFormula(cols, rows, ex([0, "1990"], [1, "1985"]))?.formula).toBe("Text.From(Date.Year([Born]))");
    expect(suggestFormula(cols, rows, ex([0, "Mon"]))?.formula).toContain("DayOfWeekName");
    expect(suggestFormula(cols, rows, ex([2, "130"]))?.formula).toBe("Text.From([Qty])");
    expect(suggestFormula(cols, rows, ex([1, "5"]))?.formula).toBe("Text.From(Text.Length([Last]))");
  });

  it("answers with a constant when every example is the same, and with nothing when no expression fits", () => {
    expect(suggestFormula(cols, rows, ex([0, "n/a"], [1, "n/a"]))?.formula).toBe('"n/a"');
    expect(suggestFormula(cols, rows, ex([0, "zzz"], [1, "qqq"]))).toBeNull();
    expect(suggestFormula(cols, rows, ex())).toBeNull();
    // contradicting examples have no common expression
    expect(suggestFormula(cols, rows, ex([0, "ANN"], [1, "bob"]))).toBeNull();
  });
});
