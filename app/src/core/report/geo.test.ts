import { beforeAll, describe, expect, it } from "vitest";
import { Gazetteer, loadGazetteer, normalizePlace } from "./geo";

let g: Gazetteer;
beforeAll(async () => {
  g = await loadGazetteer();
});

describe("gazetteer (Natural Earth data, offline)", () => {
  it("normalizes accents, case and punctuation", () => {
    expect(normalizePlace("  Ōsaka ")).toBe("osaka");
    expect(normalizePlace("U.S.A.")).toBe("u s a");
  });

  it("finds countries by name, long name, ISO code and common alias", () => {
    for (const label of ["France", "france", "FR", "FRA", "French Republic"]) expect(g.resolve(label)?.region, label).toBe("France");
    expect(g.resolve("United States")?.region).toBe("United States of America");
    expect(g.resolve("USA")?.region).toBe("United States of America");
    expect(g.resolve("UK")?.region).toBe("United Kingdom");
    expect(g.resolve("Czech Republic")?.kind).toBe("country");
  });

  it("finds US states by name and by capital-letter code, and cities by name (the larger one when a name repeats)", () => {
    expect(g.resolve("Washington", ["state"])).toMatchObject({ kind: "state", region: "Washington" });
    expect(g.resolve("WA", ["state"])?.region).toBe("Washington");
    expect(g.resolve("wa", ["state"])).toBeNull(); // a lower case two letter word is not a code
    const seattle = g.resolve("Seattle")!;
    expect(seattle).toMatchObject({ kind: "city", region: null });
    expect(seattle.lon).toBeCloseTo(-122.34, 1);
    expect(seattle.lat).toBeCloseTo(47.57, 1);
    expect(g.resolve("Portland")!.lon).toBeCloseTo(-122.68, 1); // Oregon, not the Australian one
    expect(g.resolve("Osaka")?.name).toBe("Ōsaka"); // the ASCII spelling works
  });

  it("returns null for what the data does not know, and the kinds can be restricted", () => {
    expect(g.resolve("Unknownville")).toBeNull();
    expect(g.resolve("")).toBeNull();
    expect(g.resolve("Seattle", ["country", "state"])).toBeNull();
    expect(g.resolve("France", ["city"])).toBeNull();
  });

  it("every country has an outline and a centroid inside the world", () => {
    for (const f of g.world.countries.features) {
      const [x, y] = f.properties.centroid;
      expect(Math.abs(x) <= 180 && Math.abs(y) <= 90, f.properties.name).toBe(true);
      expect(f.geometry).toBeTruthy();
    }
  });
});
