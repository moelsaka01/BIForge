import { describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import { migrateProject } from "./migrate";
import { COORDINATES_ANNOTATION, fromStored, storedIO, toStored } from "./storage";

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const vfile = (page: string, name: string) => `pages/${page}/visuals/${name}/visual.json`;
const item = (name: string, x: number, y: number, w: number, h: number, parent?: string, group = false): J => ({
  name,
  position: { x, y, z: 0, width: w, height: h },
  ...(group ? { visualGroup: { displayName: name, groupMode: "ScaleMode" } } : { visual: { visualType: "card" } }),
  ...(parent ? { parentGroupName: parent } : {}),
});
const project = (items: J[], report: J = {}): Project => ({ report: { files: { "report.json": report, ...Object.fromEntries(items.map((i) => [vfile("p1", i.name), i])) } } }) as unknown as Project;
const pos = (p: Project, name: string) => {
  const f = (p.report.files as Record<string, J>)[vfile("p1", name)].position;
  return { x: f.x, y: f.y };
};

describe("group members: relative positions on disk, page positions in memory", () => {
  // outer group at (500,300); inner group inside it at page (520,320); a card in the inner group at page (530,340); a card in the outer at (600,400)
  const memory = () => project([item("outer", 500, 300, 400, 300, undefined, true), item("inner", 520, 320, 200, 150, "outer", true), item("a", 530, 340, 50, 40, "inner"), item("b", 600, 400, 80, 60, "outer"), item("free", 10, 20, 30, 40)]);

  it("writes members relative to their own group (nested groups chain) and marks the report", () => {
    const stored = toStored(memory());
    expect(pos(stored, "outer")).toEqual({ x: 500, y: 300 });
    expect(pos(stored, "inner")).toEqual({ x: 20, y: 20 });
    expect(pos(stored, "a")).toEqual({ x: 10, y: 20 });
    expect(pos(stored, "b")).toEqual({ x: 100, y: 100 });
    expect(pos(stored, "free")).toEqual({ x: 10, y: 20 });
    expect((stored.report.files as J)["report.json"].annotations).toEqual([{ name: COORDINATES_ANNOTATION, value: "relative" }]);
  });

  it("reads them back to the same page positions and drops the marker; the original objects are not modified", () => {
    const m = memory();
    const before = structuredClone(m);
    const stored = toStored(m);
    expect(m).toEqual(before);
    const back = fromStored(stored);
    for (const n of ["outer", "inner", "a", "b", "free"]) expect(pos(back, n)).toEqual(pos(m, n));
    expect((back.report.files as J)["report.json"].annotations).toBeUndefined();
    expect(migrateProject(stored)).toEqual(back); // migrateProject does this on every load
  });

  it("an earlier BIForge file (page positions, no marker) is read as it is", () => {
    const old = memory();
    expect(fromStored(old)).toBe(old);
    expect(migrateProject(old)).toBe(old);
  });

  it("a Desktop file (relative positions, no marker) is recognised when a member does not fit its group at the page position", () => {
    const desktop = project([item("g", 500, 300, 400, 300, undefined, true), item("c", 100, 50, 80, 60, "g")]);
    const read = fromStored(desktop);
    expect(pos(read, "c")).toEqual({ x: 600, y: 350 });
  });

  it("a project without groups is returned untouched in both directions (no marker is added)", () => {
    const p = project([item("x", 1, 2, 3, 4), item("y", 5, 6, 7, 8)], { themeCollection: {} });
    expect(toStored(p)).toBe(p);
    expect(fromStored(p)).toBe(p);
  });

  it("keeps the other annotations of report.json and removes the marker when the last group is gone", () => {
    const withBookmark = project([item("g", 0, 0, 100, 100, undefined, true), item("c", 10, 10, 20, 20, "g")], { annotations: [{ name: "biforge.bookmark.b1", value: "{}" }] });
    const stored = toStored(withBookmark);
    expect((stored.report.files as J)["report.json"].annotations.map((a: J) => a.name).sort()).toEqual(["biforge.bookmark.b1", COORDINATES_ANNOTATION]);
    const noGroups = project([item("c", 10, 10, 20, 20)], { annotations: [{ name: COORDINATES_ANNOTATION, value: "relative" }] });
    expect((toStored(noGroups).report.files as J)["report.json"].annotations).toBeUndefined();
  });

  it("a group whose parent is missing or that points at itself does not loop or move", () => {
    const odd = project([item("a", 5, 5, 10, 10, "a"), item("b", 7, 7, 10, 10, "missing")]);
    const s = toStored(odd);
    expect(pos(s, "a")).toEqual({ x: 0, y: 0 }); // relative to itself: a malformed file stays finite
    expect(pos(s, "b")).toEqual({ x: 7, y: 7 });
  });

  it("the project IO wrapper writes relative positions for save and recovery, and nothing else changes", async () => {
    const saved: Project[] = [];
    const recovered: Project[] = [];
    const io = storedIO({
      newProject: async () => memory(),
      openProject: async () => memory(),
      saveProject: async (_r, p) => (saved.push(p), { files: [] } as never),
      writeRecovery: async (_r, p) => void recovered.push(p),
      readRecovery: async () => null,
      clearRecovery: async () => undefined,
    });
    await io.saveProject("r", memory());
    await io.writeRecovery("r", memory());
    expect(pos(saved[0], "a")).toEqual({ x: 10, y: 20 });
    expect(pos(recovered[0], "a")).toEqual({ x: 10, y: 20 });
    expect(pos(await io.openProject("x"), "a")).toEqual({ x: 530, y: 340 });
  });
});

describe("uploaded pictures: registered resources on disk, data addresses in memory", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const lit = (v: string) => ({ expr: { Literal: { Value: `'${v}'` } } });
  const imageVisual = (name: string, uri: string): J => ({
    name,
    position: { x: 0, y: 0, z: 0, width: 10, height: 10 },
    visual: { visualType: "image", objects: { image: [{ properties: { sourceType: lit("imageUrl"), sourceUrl: lit(uri), fit: lit("Fit") } }] } },
  });
  const mem = () => project([imageVisual("pic", `data:image/png;base64,${PNG}`), imageVisual("web", "https://example.com/a.png")]);

  it("writes the file, the resourcePackages entry and a ResourcePackageItem; web addresses stay as they are", () => {
    const stored = toStored(mem());
    const names = Object.keys(stored.report.images ?? {});
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^image[0-9a-f]{16}\.png$/);
    expect(stored.report.images![names[0]]).toBe(PNG);
    const props = (stored.report.files as J)[vfile("p1", "pic")].visual.objects.image[0].properties;
    expect(props.sourceUrl).toBeUndefined();
    expect(props.sourceType).toEqual(lit("imageFile"));
    expect(props.sourceFile).toEqual({ expr: { ResourcePackageItem: { PackageName: "RegisteredResources", PackageType: 1, ItemName: names[0] } } });
    expect(props.fit).toEqual(lit("Fit"));
    expect((stored.report.files as J)["report.json"].resourcePackages).toEqual([{ name: "RegisteredResources", type: "RegisteredResources", items: [{ name: names[0], path: names[0], type: "Image" }] }]);
    expect((stored.report.files as J)[vfile("p1", "web")].visual.objects.image[0].properties.sourceUrl).toEqual(lit("https://example.com/a.png"));
  });

  it("reads it back to the same data address, and the in-memory project has no files or package entries", () => {
    const m = mem();
    const back = migrateProject(toStored(m));
    expect((back.report.files as J)[vfile("p1", "pic")]).toEqual((m.report.files as J)[vfile("p1", "pic")]);
    expect(back.report.images).toBeUndefined();
    expect((back.report.files as J)["report.json"].resourcePackages).toBeUndefined();
  });

  it("the same picture twice is one file; a removed picture leaves no file behind; themes in the same package are kept", () => {
    const two = project([imageVisual("a", `data:image/png;base64,${PNG}`), imageVisual("b", `data:image/png;base64,${PNG}`)], {
      resourcePackages: [{ name: "RegisteredResources", type: "RegisteredResources", items: [{ name: "T.json", path: "T.json", type: "CustomTheme" }] }],
    });
    const stored = toStored(two);
    expect(Object.keys(stored.report.images ?? {})).toHaveLength(1);
    expect((stored.report.files as J)["report.json"].resourcePackages[0].items.map((i: J) => i.type).sort()).toEqual(["CustomTheme", "Image"]);
    const none = project([imageVisual("a", "https://example.com/x.png")]);
    expect(toStored(none)).toBe(none);
    const noPics = toStored(project([item("v", 0, 0, 5, 5)]));
    expect(noPics.report.images).toBeUndefined();
  });

  it("a stored file whose picture is missing is left alone; an earlier BIForge file with a data address is read as it is", () => {
    const stored = toStored(mem());
    const lost = { ...stored, report: { ...stored.report, images: {} } } as Project;
    expect((fromStored(lost).report.files as J)[vfile("p1", "pic")].visual.objects.image[0].properties.sourceFile).toBeDefined();
    const old = mem();
    expect(fromStored(old)).toBe(old);
  });

  it("groups and pictures convert together", () => {
    const both = project([item("g", 100, 100, 300, 300, undefined, true), { ...imageVisual("pic", `data:image/png;base64,${PNG}`), position: { x: 150, y: 160, z: 0, width: 10, height: 10 }, parentGroupName: "g" }]);
    const back = migrateProject(toStored(both));
    expect(back).toEqual(both);
  });
});
