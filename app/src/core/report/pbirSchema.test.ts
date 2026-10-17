// Saved reports are checked against Microsoft's published JSON schemas for the PBIR format (tests/pbir-schemas, copied
// from github.com/microsoft/json-schemas, MIT license), and every formatting object and property a report uses must be
// one the schemas of the visual type list, so that Power BI Desktop reads what BIForge writes.
import Ajv from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTAINER_OBJECTS, hasObject, isContainerProp, propKind } from "../format/capabilities";
import { buildRichReport, type RichReport } from "./richReport";
import type { J } from "./pbir";

const ROOT = "../tests/pbir-schemas"; // tests run from the app folder
const BASE = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/";

/** Which schema checks which file of the report folder (and the versions the files declare). */
const RULES: [RegExp, string][] = [
  [/^version\.json$/, "versionMetadata/1.0.0/schema.json"],
  [/^report\.json$/, "report/3.3.0/schema.json"],
  [/^pages\/pages\.json$/, "pagesMetadata/1.1.0/schema.json"],
  [/^pages\/[^/]+\/page\.json$/, "page/2.1.0/schema.json"],
  [/^pages\/[^/]+\/visuals\/[^/]+\/visual\.json$/, "visualContainer/2.13.0/schema.json"],
  [/^pages\/[^/]+\/visuals\/[^/]+\/mobile\.json$/, "visualContainerMobileState/2.8.0/schema.json"],
  [/^bookmarks\/bookmarks\.json$/, "bookmarksMetadata/1.0.0/schema.json"],
  [/^bookmarks\/[^/]+\.bookmark\.json$/, "bookmark/2.1.0/schema.json"],
  [/^reportExtensions\.json$/, "reportExtension/1.0.0/schema.json"],
];

/** Property names BIForge stores that no published schema names, and why. Anything else must be in the schemas. */
const KNOWN_EXTENSIONS: Record<string, string> = {
  "rowTotals.show": "matrix: the theme schema lists the grand totals' fonts and colors but no switch",
  "columnTotals.show": "matrix: same",
};

/** Annotation names BIForge writes (annotations are free-form in the schemas and ignored by Desktop). */
const KNOWN_ANNOTATIONS = [/^biforge\.bookmark\.[\w-]+$/, /^biforge\.relativeDate\.[\w-]+$/, /^biforge\.displayName$/];

let report: RichReport;
let ajv: Ajv;

beforeAll(async () => {
  const fsName = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsName)) as { readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean }; readFileSync(p: string, enc: string): string };
  ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (fs.statSync(p).isDirectory()) walk(p, `${rel}${name}/`);
      else if (name.endsWith(".json")) {
        const s = JSON.parse(fs.readFileSync(p, "utf8"));
        const id = `https://developer.microsoft.com/json-schemas/${rel}${name}`;
        s.$id = id;
        ajv.addSchema(s, id);
      }
    }
  };
  walk(`${ROOT}/fabric`, "fabric/");
  report = await buildRichReport();
}, 120000);

describe("saved reports match the published PBIR schemas", () => {
  it("the schemas are present", () => {
    for (const [, schema] of RULES.filter(([re]) => !re.test("reportExtensions.json") || true)) expect(ajv.getSchema(`${BASE}${schema}`), schema).toBeTruthy();
  });

  it("every file of a report that uses every visual type, filter, formatting object, bookmark and page type is valid", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const [key, doc] of Object.entries(report.files)) {
      const rule = RULES.find(([re]) => re.test(key));
      if (!rule) {
        problems.push(`no schema for ${key}`);
        continue;
      }
      const validate = ajv.getSchema(`${BASE}${rule[1]}`)!;
      checked++;
      if (!validate(doc)) problems.push(`${key}: ${validate.errors!.slice(0, 5).map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params).slice(0, 120)}`).join(" | ")}`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });

  it("formatting objects and properties are the ones the schemas list for the visual type", () => {
    const unknown = new Set<string>();
    for (const [key, doc] of Object.entries(report.files) as [string, J][]) {
      if (!/visual\.json$/.test(key) || !doc.visual?.visualType) continue;
      const type = doc.visual.visualType as string;
      const check = (bag: J | undefined, container: boolean) => {
        for (const [object, entries] of Object.entries(bag ?? {}) as [string, J[]][]) {
          for (const e of entries) {
            for (const prop of Object.keys(e.properties ?? {})) {
              const name = `${object}.${prop}`;
              const okShape = container ? CONTAINER_OBJECTS.has(object) || (object === "general" && isContainerProp(object, prop)) : !CONTAINER_OBJECTS.has(object);
              if (!okShape) unknown.add(`${type}: ${name} is stored in the wrong place`);
              else if (!hasObject(type, object) && !KNOWN_EXTENSIONS[name]) unknown.add(`${type}: object ${object} is not listed for this visual type`);
              else if (propKind(type, object, prop) === null && !KNOWN_EXTENSIONS[name]) unknown.add(`${type}: ${name} is not a property of the schema`);
            }
          }
        }
      };
      check(doc.visual.objects, false);
      check(doc.visual.visualContainerObjects, true);
    }
    expect([...unknown].sort()).toEqual([]);
  });

  it("annotations are only the documented BIForge ones", () => {
    const names = new Set<string>();
    for (const doc of Object.values(report.files) as J[]) for (const a of doc?.annotations ?? []) names.add(a.name);
    for (const n of names) expect(KNOWN_ANNOTATIONS.some((re) => re.test(n)), n).toBe(true);
  });

  it("the report covers what BIForge writes: sync group in the visual, general alt text, reference line instances, image source", () => {
    const visuals = Object.entries(report.files).filter(([k]) => /visual\.json$/.test(k)).map(([, v]) => v as J);
    expect(visuals.some((v) => v.visual.syncGroup?.groupName === "Country")).toBe(true);
    expect(visuals.some((v) => v.visual.visualContainerObjects?.general?.[0]?.properties?.altText)).toBe(true);
    expect(visuals.some((v) => v.visual.objects?.referenceLine?.[0]?.selector?.id === "average")).toBe(true);
    expect(visuals.some((v) => v.visual.objects?.image?.[0]?.properties?.sourceUrl)).toBe(true);
    expect(visuals.every((v) => v.syncGroup === undefined)).toBe(true);
  });
});
