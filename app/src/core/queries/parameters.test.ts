import { describe, expect, it } from "vitest";
import { isParameterText, parameterLiteral, parameterText, parseParameter, type ParameterDef } from "./parameters";

const def = (over: Partial<ParameterDef> = {}): ParameterDef => ({ description: "", required: true, type: "Text", list: [], defaultValue: "", current: "x", ...over });

describe("parameters", () => {
  it("writes the M Power Query writes for a parameter and reads it back", () => {
    expect(parameterText(def())).toBe('"x" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]');
    expect(parameterText(def({ type: "Number", current: "12.5", required: false }))).toBe('12.5 meta [IsParameterQuery=true, Type="Number", IsParameterQueryRequired=false]');
    expect(parameterText(def({ type: "WholeNumber", current: "7", description: "How many" }))).toBe('7 meta [IsParameterQuery=true, Description="How many", Type="Number", IsParameterQueryRequired=true]');
    expect(parameterText(def({ type: "Date", current: "2024-01-31" }))).toBe('#date(2024, 1, 31) meta [IsParameterQuery=true, Type="Date", IsParameterQueryRequired=true]');
    expect(parameterText(def({ type: "Logical", current: "TRUE" }))).toContain("true meta [");
    expect(parameterText(def({ list: ["a", "b"], defaultValue: "b", current: "a" }))).toBe('"a" meta [IsParameterQuery=true, List={"a", "b"}, DefaultValue="b", Type="Text", IsParameterQueryRequired=true]');
    for (const d of [
      def(),
      def({ type: "Number", current: "12.5", required: false }),
      def({ type: "WholeNumber", current: "7", description: "How many" }),
      def({ type: "Date", current: "2024-01-31" }),
      def({ type: "DateTime", current: "2024-01-31 08:30:00" }),
      def({ type: "Time", current: "08:30:00" }),
      def({ type: "Logical", current: "false" }),
      def({ list: ["a", "b c"], defaultValue: "b c", current: "a", description: 'say "hi"' }),
      def({ current: 'quote " inside' }),
    ]) {
      expect(parseParameter(parameterText(d))).toEqual(d);
    }
  });

  it("recognizes parameters only", () => {
    expect(isParameterText('"x" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]')).toBe(true);
    expect(isParameterText("let\n    Source = 1\nin\n    Source")).toBe(false);
    expect(isParameterText('"x" meta [Other=true]')).toBe(false);
    // a Power Query parameter has more fields than BIForge writes; unknown ones are ignored
    const p = parseParameter('42 meta [IsParameterQuery=true, Type="Number", IsParameterQueryRequired=true, IsParameterQueryRequiredFoo=1]');
    expect(p).toMatchObject({ type: "WholeNumber", current: "42", required: true });
  });

  it("rejects values that do not fit the type", () => {
    expect(() => parameterLiteral("Number", "abc")).toThrow("not a number");
    expect(() => parameterLiteral("WholeNumber", "1.5")).toThrow("whole number");
    expect(() => parameterLiteral("Date", "31/01/2024")).toThrow("yyyy-mm-dd");
    expect(() => parameterLiteral("Logical", "yes")).toThrow("true or false");
    expect(() => parameterText(def({ type: "Number", current: "" }))).toThrow("current value");
    expect(parameterLiteral("Text", "")).toBe('""');
  });
});
