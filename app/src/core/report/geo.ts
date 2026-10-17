// Finds the place a location label stands for, from the bundled Natural Earth data (public domain, see
// assets/geo/NATURAL-EARTH.md). Offline: nothing is looked up online. Pure apart from the lazy load of the data.

export interface GeoFeature {
  type: "Feature";
  properties: { name: string; names: string[]; codes: string[]; centroid: [number, number]; country?: string; pop?: number };
  geometry: unknown;
}
export interface WorldData {
  source: string;
  countries: { type: "FeatureCollection"; features: GeoFeature[] };
  states: { type: "FeatureCollection"; features: GeoFeature[] };
  /** [name, longitude, latitude, country code, population, ascii name] */
  cities: [string, number, number, string, number, string][];
}

export type PlaceKind = "country" | "state" | "city";

export interface Place {
  kind: PlaceKind;
  /** The name of the region in the registered map ("world" for countries, "states" for US states); cities have none. */
  region: string | null;
  name: string;
  lon: number;
  lat: number;
}

/** Lower case, no accents, no punctuation, one space between words. */
export function normalizePlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Names people use that the data does not list.
const ALIASES: Record<string, string> = {
  uk: "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  "south korea": "South Korea",
  korea: "South Korea",
  russia: "Russia",
  czechia: "Czechia",
  "czech republic": "Czechia",
  holland: "Netherlands",
  "the netherlands": "Netherlands",
  "ivory coast": "Ivory Coast",
  "cote d ivoire": "Ivory Coast",
  burma: "Myanmar",
};

export class Gazetteer {
  private countries = new Map<string, Place>();
  private states = new Map<string, Place>();
  private cities = new Map<string, Place & { pop: number }>();

  constructor(readonly world: WorldData) {
    for (const f of world.countries.features) {
      const place: Place = { kind: "country", region: f.properties.name, name: f.properties.name, lon: f.properties.centroid[0], lat: f.properties.centroid[1] };
      for (const n of [...f.properties.names, ...f.properties.codes]) this.countries.set(normalizePlace(n), place);
    }
    for (const f of world.states.features) {
      const place: Place = { kind: "state", region: f.properties.name, name: f.properties.name, lon: f.properties.centroid[0], lat: f.properties.centroid[1] };
      for (const n of [...f.properties.names.flatMap((x) => x.split("|")), ...f.properties.codes]) {
        const key = normalizePlace(n);
        // two letter codes stand for the state only when written in capitals ("WA", not "wa")
        if (key.length > 2 || /^[A-Z]{2}$/.test(n)) this.states.set(key, place);
      }
    }
    for (const [name, lon, lat, , pop, ascii] of world.cities) {
      const place = { kind: "city" as const, region: null, name, lon, lat, pop };
      for (const n of [name, ascii].filter(Boolean)) {
        const key = normalizePlace(n);
        const prev = this.cities.get(key);
        // two places with one name (Portland): the larger one
        if (!prev || prev.pop < pop) this.cities.set(key, place);
      }
    }
  }

  /** The place of a label: a country, else a US state, else a city. Null when the data does not know it. */
  resolve(label: string, only?: PlaceKind[]): Place | null {
    const key = normalizePlace(label);
    if (!key) return null;
    const alias = ALIASES[key];
    const ok = (k: PlaceKind) => !only || only.includes(k);
    if (ok("country")) {
      const c = this.countries.get(key) ?? (alias ? this.countries.get(normalizePlace(alias)) : undefined);
      if (c) return c;
    }
    if (ok("state")) {
      const raw = label.trim();
      const s = key.length <= 2 && raw !== raw.toUpperCase() ? undefined : this.states.get(key);
      if (s) return s;
    }
    if (ok("city")) {
      const c = this.cities.get(key);
      if (c) return c;
    }
    return null;
  }
}

let current: Gazetteer | null = null;
let loading: Promise<Gazetteer> | null = null;

/** The gazetteer once loaded (map visuals are drawn only after loadGazetteer resolved). */
export const gazetteer = (): Gazetteer | null => current;

/** Loads the bundled map data on first use; later calls return the same instance. */
export function loadGazetteer(): Promise<Gazetteer> {
  loading ??= import("../../assets/geo/world.json").then((m) => (current = new Gazetteer((m.default ?? m) as unknown as WorldData)));
  return loading;
}
