// How group members are stored on disk. Desktop stores the position of a group member relative to its group (the layout
// service converts both ways); BIForge works with page positions in memory. `toStored` converts when a project is written
// (save, recovery file, package), `fromStored` when it is read (called by migrateProject).
//
// A written project that has groups carries the annotation biforge.coordinates = "relative" in report.json. A project
// without the annotation is either one written by an earlier BIForge (page positions) or a file from Desktop (relative):
// it is read as page positions when every member lies inside its group's box, and as relative positions otherwise. A
// Desktop file whose relative positions happen to fit inside the box at the page position is therefore misread; that is
// a limit of files without the annotation, and the reason the annotation exists.
import type { Project } from "../model/types";
import type { ProjectIO } from "../session/session";
import { decodeLit, encodeLit } from "./pbir";

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const COORDINATES_ANNOTATION = "biforge.coordinates";

const VISUAL_FILE = /^(pages\/[^/]+)\/visuals\/[^/]+\/visual\.json$/;

interface Entry {
  key: string;
  json: J;
}

function pageEntries(files: Record<string, J>): Map<string, Map<string, Entry>> {
  const pages = new Map<string, Map<string, Entry>>();
  for (const key of Object.keys(files)) {
    const m = VISUAL_FILE.exec(key);
    const json = files[key];
    if (!m || !json || typeof json.name !== "string" || !json.position) continue;
    if (!pages.has(m[1])) pages.set(m[1], new Map());
    pages.get(m[1])!.set(json.name, { key, json });
  }
  return pages;
}

const hasGroups = (entries: Map<string, Entry>) => [...entries.values()].some((e) => e.json.parentGroupName && entries.has(e.json.parentGroupName));

/** Position of every item in one coordinate system, resolved through the chain of groups (cycles stop the chain). */
function resolve(entries: Map<string, Entry>, toAbsolute: boolean): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const visit = (name: string, seen: Set<string>): { x: number; y: number } => {
    const hit = out.get(name);
    if (hit) return hit;
    const e = entries.get(name)!;
    const own = { x: e.json.position.x ?? 0, y: e.json.position.y ?? 0 };
    const parent = e.json.parentGroupName;
    let res = own;
    if (toAbsolute && parent && entries.has(parent) && !seen.has(parent)) {
      const p = visit(parent, new Set([...seen, name]));
      res = { x: own.x + p.x, y: own.y + p.y };
    }
    out.set(name, res);
    return res;
  };
  for (const n of entries.keys()) visit(n, new Set());
  return out;
}

const annotations = (report: J): J[] => (Array.isArray(report?.annotations) ? report.annotations : []);
const marker = (report: J): string | undefined => annotations(report).find((a: J) => a?.name === COORDINATES_ANNOTATION)?.value;

function withMarker(report: J, value: string | null): J {
  const rest = annotations(report).filter((a: J) => a?.name !== COORDINATES_ANNOTATION);
  const next = { ...report };
  const list = value === null ? rest : [...rest, { name: COORDINATES_ANNOTATION, value }];
  if (list.length > 0) next.annotations = list;
  else delete next.annotations;
  return next;
}

/** Page positions (memory) to relative positions (disk). The same object when no page has a group. */
function groupsToStored(p: Project): Project {
  const files = p.report?.files as Record<string, J> | undefined;
  if (!files) return p;
  const pages = pageEntries(files);
  let any = false;
  const out: Record<string, J> = { ...files };
  for (const entries of pages.values()) {
    if (!hasGroups(entries)) continue;
    any = true;
    const abs = resolve(entries, false); // memory holds page positions already
    for (const e of entries.values()) {
      const parent = e.json.parentGroupName;
      if (!parent || !entries.has(parent)) continue;
      const a = abs.get(e.json.name)!;
      const pa = abs.get(parent)!;
      out[e.key] = { ...e.json, position: { ...e.json.position, x: a.x - pa.x, y: a.y - pa.y } };
    }
  }
  const hadMarker = marker(files["report.json"]) !== undefined;
  if (!any && !hadMarker) return p;
  if (any) out["report.json"] = withMarker(files["report.json"] ?? {}, "relative");
  else out["report.json"] = withMarker(files["report.json"], null);
  return { ...p, report: { ...p.report, files: out } } as Project;
}

/** Relative positions (disk) to page positions (memory). The same object when nothing needs to change. */
function groupsFromStored(p: Project): Project {
  const files = p.report?.files as Record<string, J> | undefined;
  if (!files) return p;
  const mark = marker(files["report.json"]);
  const pages = pageEntries(files);
  const out: Record<string, J> = { ...files };
  let changed = false;
  for (const entries of pages.values()) {
    if (!hasGroups(entries)) continue;
    const relative = mark === "relative" || (mark === undefined && !membersFit(entries));
    if (!relative) continue;
    const abs = resolve(entries, true);
    for (const e of entries.values()) {
      const parent = e.json.parentGroupName;
      if (!parent || !entries.has(parent)) continue;
      const a = abs.get(e.json.name)!;
      out[e.key] = { ...e.json, position: { ...e.json.position, x: a.x, y: a.y } };
      changed = true;
    }
  }
  if (mark !== undefined) {
    out["report.json"] = withMarker(files["report.json"], null);
    changed = true;
  }
  return changed ? ({ ...p, report: { ...p.report, files: out } } as Project) : p;
}

/** True when every member's box, read as a page position, lies inside the box of its group. */
function membersFit(entries: Map<string, Entry>): boolean {
  const eps = 1;
  for (const e of entries.values()) {
    const parent = e.json.parentGroupName && entries.get(e.json.parentGroupName);
    if (!parent) continue;
    const c = e.json.position;
    const g = parent.json.position;
    if (c.x < g.x - eps || c.y < g.y - eps || c.x + (c.width ?? 0) > g.x + (g.width ?? 0) + eps || c.y + (c.height ?? 0) > g.y + (g.height ?? 0) + eps) return false;
  }
  return true;
}

// ---- uploaded pictures ----------------------------------------------------------------------------------------
// In memory a picture is a data: address in image.sourceUrl (so that it can be shown without a file system). On disk it is
// a registered resource like in Desktop: the file under StaticResources/RegisteredResources, an entry of type Image in
// report.json resourcePackages, and image.sourceFile = ResourcePackageItem (PackageType 1 = RegisteredResources).

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" };
const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
const REGISTERED = "RegisteredResources";
const DATA_URI = /^data:([a-z+/]+);base64,(.*)$/s;

/** A short stable name for the picture: the same picture always gets the same file. */
function hashName(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const imageEntries = (visual: J): J[] => (Array.isArray(visual?.visual?.objects?.image) ? visual.visual.objects.image : []);
const litOf = (prop: J): string | null => {
  const v = prop?.expr?.Literal?.Value;
  if (typeof v !== "string") return null;
  const l = decodeLit(v);
  return l && l.t === "string" ? l.v : null;
};
const strLit = (v: string): J => ({ expr: { Literal: { Value: encodeLit({ t: "string", v }) } } });

function picturesToStored(p: Project): Project {
  const files = p.report?.files as Record<string, J> | undefined;
  if (!files) return p;
  const out: Record<string, J> = {};
  const images: Record<string, string> = {};
  for (const key of Object.keys(files)) {
    const f = files[key];
    if (!VISUAL_FILE.test(key) || imageEntries(f).length === 0) continue;
    let copy: J = null;
    imageEntries(f).forEach((entry: J, i: number) => {
      const uri = litOf(entry?.properties?.sourceUrl);
      const m = uri ? DATA_URI.exec(uri) : null;
      if (!m || !MIME_EXT[m[1]]) return;
      copy ??= structuredClone(f);
      const name = `image${hashName(m[2])}.${MIME_EXT[m[1]]}`;
      images[name] = m[2];
      const props = copy.visual.objects.image[i].properties;
      delete props.sourceUrl;
      props.sourceType = strLit("imageFile");
      props.sourceFile = { expr: { ResourcePackageItem: { PackageName: REGISTERED, PackageType: 1, ItemName: name } } };
    });
    if (copy) out[key] = copy;
  }
  const had = Object.keys(p.report.images ?? {}).length > 0;
  const names = Object.keys(images);
  if (names.length === 0 && !had && !hasImageItems(files["report.json"])) return p;
  const report = structuredClone(files["report.json"] ?? {});
  const pkgs: J[] = (report.resourcePackages ??= []);
  let pkg = pkgs.find((x) => x.type === REGISTERED);
  if (!pkg && names.length > 0) pkgs.push((pkg = { name: REGISTERED, type: REGISTERED, items: [] }));
  if (pkg) {
    pkg.items = (pkg.items ?? []).filter((i: J) => i.type !== "Image");
    for (const n of names.sort()) pkg.items.push({ name: n, path: n, type: "Image" });
  }
  report.resourcePackages = pkgs.filter((x) => (x.items ?? []).length > 0);
  if (report.resourcePackages.length === 0) delete report.resourcePackages;
  return { ...p, report: { ...p.report, files: { ...files, ...out, "report.json": report }, images } } as Project;
}

const hasImageItems = (report: J): boolean => (report?.resourcePackages ?? []).some((x: J) => (x.items ?? []).some((i: J) => i.type === "Image"));

function picturesFromStored(p: Project): Project {
  const files = p.report?.files as Record<string, J> | undefined;
  if (!files) return p;
  const images = p.report.images ?? {};
  const out: Record<string, J> = {};
  for (const key of Object.keys(files)) {
    const f = files[key];
    if (!VISUAL_FILE.test(key) || imageEntries(f).length === 0) continue;
    let copy: J = null;
    imageEntries(f).forEach((entry: J, i: number) => {
      const item = entry?.properties?.sourceFile?.expr?.ResourcePackageItem;
      const data = item && typeof item.ItemName === "string" ? images[item.ItemName] : undefined;
      if (data === undefined) return;
      const ext = item.ItemName.slice(item.ItemName.lastIndexOf(".") + 1).toLowerCase();
      copy ??= structuredClone(f);
      const props = copy.visual.objects.image[i].properties;
      delete props.sourceFile;
      props.sourceType = strLit("imageUrl");
      props.sourceUrl = strLit(`data:${EXT_MIME[ext] ?? "application/octet-stream"};base64,${data}`);
    });
    if (copy) out[key] = copy;
  }
  if (Object.keys(out).length === 0 && Object.keys(images).length === 0) return p;
  const report = structuredClone(files["report.json"] ?? {});
  for (const pkg of report.resourcePackages ?? []) pkg.items = (pkg.items ?? []).filter((i: J) => i.type !== "Image");
  if (report.resourcePackages) report.resourcePackages = report.resourcePackages.filter((x: J) => (x.items ?? []).length > 0);
  if (report.resourcePackages && report.resourcePackages.length === 0) delete report.resourcePackages;
  const rest = { ...p.report } as J;
  delete rest.images;
  return { ...p, report: { ...rest, files: { ...files, ...out, "report.json": report } } } as Project;
}

/** Memory to disk: group members relative to their group, pictures as registered resources. The same object when nothing needs to change. */
export function toStored(p: Project): Project {
  return picturesToStored(groupsToStored(p));
}

/** Disk to memory: the reverse of toStored. */
export function fromStored(p: Project): Project {
  return groupsFromStored(picturesFromStored(p));
}

/** Wraps a ProjectIO so that everything written to disk uses relative positions for group members. Reading is handled by migrateProject. */
export function storedIO(io: ProjectIO): ProjectIO {
  return {
    ...io,
    saveProject: (root, project) => io.saveProject(root, toStored(project)),
    writeRecovery: (root, project) => io.writeRecovery(root, toStored(project)),
  };
}
