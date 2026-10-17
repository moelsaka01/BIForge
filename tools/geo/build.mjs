// Our own helper: makes the compact map data of the app from Natural Earth files (public domain, naturalearthdata.com).
//   node tools/geo/build.mjs <dir with ne_110m_admin_0_countries.geojson, ne_110m_admin_1_states_provinces.geojson,
//                             ne_50m_populated_places_simple.geojson>
// Writes app/src/assets/geo/world.json: country and US state outlines with the names a report can use for them
// (rounded to two decimals, no other properties) and the 50m populated places as [name, lon, lat, country code, population, ascii name].
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node build.mjs <natural earth folder>");
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const round = (n) => Math.round(n * 100) / 100;

function simplifyRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [round(x), round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length >= 4 ? out : null;
}

function simplify(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const out = [];
  for (const poly of polys) {
    const rings = poly.map(simplifyRing).filter(Boolean);
    if (rings.length) out.push(rings);
  }
  return out.length === 1 ? { type: "Polygon", coordinates: out[0] } : { type: "MultiPolygon", coordinates: out };
}

/** Centroid of the largest ring (shoelace formula): good enough to place a bubble on a country. */
function centroid(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = { area: -1, x: 0, y: 0 };
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    }
    a /= 2;
    if (Math.abs(a) > best.area) best = { area: Math.abs(a), x: a ? cx / (6 * a) : ring[0][0], y: a ? cy / (6 * a) : ring[0][1] };
  }
  return [round(best.x), round(best.y)];
}

const countries = read("ne_110m_admin_0_countries.geojson").features.map((f) => {
  const p = f.properties;
  const names = [p.NAME, p.NAME_LONG, p.ABBREV, p.FORMAL_EN, p.NAME_ALT, p.BRK_NAME].filter(Boolean);
  const codes = [p.ISO_A2_EH && p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : p.ISO_A2, p.ISO_A3_EH && p.ISO_A3_EH !== "-99" ? p.ISO_A3_EH : p.ADM0_A3].filter((c) => c && c !== "-99");
  return { type: "Feature", properties: { name: p.NAME, names: [...new Set(names)], codes: [...new Set(codes)], pop: p.POP_EST, centroid: centroid(f.geometry) }, geometry: simplify(f.geometry) };
});

const states = read("ne_110m_admin_1_states_provinces.geojson").features.map((f) => {
  const p = f.properties;
  return { type: "Feature", properties: { name: p.name, names: [...new Set([p.name, p.name_alt, p.name_local].filter(Boolean))], codes: [p.postal, p.iso_3166_2, p.abbrev].filter(Boolean), country: p.iso_a2, centroid: centroid(f.geometry) }, geometry: simplify(f.geometry) };
});

const cities = read("ne_50m_populated_places_simple.geojson").features.map((f) => {
  const p = f.properties;
  return [p.name, round(p.longitude), round(p.latitude), p.iso_a2 === "-99" ? "" : p.iso_a2, p.pop_max ?? 0, p.nameascii && p.nameascii !== p.name ? p.nameascii : ""];
});

const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "app", "src", "assets", "geo", "world.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ source: "Natural Earth 110m (public domain), simplified for BIForge", countries: { type: "FeatureCollection", features: countries }, states: { type: "FeatureCollection", features: states }, cities }));
console.log(`${countries.length} countries, ${states.length} states, ${cities.length} places, ${(fs.statSync(out).size / 1024).toFixed(0)} KB -> ${out}`);
