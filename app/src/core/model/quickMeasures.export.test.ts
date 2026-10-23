// Writes tests/model/quick-measure-cases.json for the Rust engine test (crates/engine/tests/quick_measures.rs).
import { it } from "vitest";
import { quickExpression } from "./quickMeasures";
import { CASES } from "./quickMeasures.test";

it("writes the quick measure cases", async () => {
  const fsName = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsName)) as { mkdirSync(p: string, o: object): void; writeFileSync(p: string, d: string): void };
  fs.mkdirSync("../tests/model", { recursive: true });
  fs.writeFileSync("../tests/model/quick-measure-cases.json", JSON.stringify({ cases: CASES.map((c) => ({ id: c.id, group: c.group, expression: quickExpression(c.spec) })) }, null, 1) + "\n");
});
