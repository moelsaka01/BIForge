// Solid test pictures for the picture properties of the render audit (a "Zz" placeholder or an empty picture draws nothing).
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
export function solidPng(r, g, b, size = 400) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export const RED = "data:image/png;base64," + solidPng(220, 30, 30).toString("base64");
export const BLUE = "data:image/png;base64," + solidPng(30, 30, 220).toString("base64");

const URL_PROPS = new Set(["url", "imageUrl", "sourceUrl"]);
const DATA_PROPS = new Set(["imageData"]);
const lit = (v) => ({ expr: { Literal: { Value: `'${v}'` } } });
const isLit = (p) => p?.expr?.Literal !== undefined;

/** Every picture property holding a placeholder gets a real picture (URL: red, image data: blue); when the property under test chooses the source, both are filled in. */
export function pictures(json, c) {
  for (const list of Object.values(json.visual?.objects ?? {})) {
    for (const e of list) {
      for (const [k, p] of Object.entries(e.properties ?? {})) {
        if (isLit(p) && URL_PROPS.has(k)) e.properties[k] = lit(RED);
        if (isLit(p) && DATA_PROPS.has(k)) e.properties[k] = lit(BLUE);
      }
    }
  }
  if (/^(sourceType|type|imageSource)$/.test(c.prop)) {
    for (const e of json.visual?.objects?.[c.object] ?? []) {
      const names = Object.keys(e.properties ?? {});
      const urlName = c.object === "fillCustom" ? "imageUrl" : c.object === "centerBackground" ? "imageUrl" : "url";
      if (!names.includes(urlName)) e.properties[urlName] = lit(RED);
      if (!names.includes("imageData")) e.properties.imageData = lit(BLUE);
    }
  }
  return json;
}
