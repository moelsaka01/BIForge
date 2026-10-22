// Maps the JSON of a project onto a Yjs document and back, so that people who edit the same report at the same time
// get a conflict-free merge instead of one overwriting the other.
//
//  * An object becomes a Y.Map: two people who change different properties both keep their change; the same property
//    changed by both is decided by Yjs (one of the two wins, the same one for everybody).
//  * An array whose items all carry a unique key (a TMDL node: kind + name; a property: key; a PBIR item: name or id)
//    becomes a keyed list (a Y.Map of items plus a Y.Array that holds the order): items added by different people
//    all arrive, an item deleted by one person is gone for all, edits of different items merge.
//  * Any other array, string, number or boolean is a single value: the last write wins as a whole.
//
// `syncProject` turns the difference between two versions of the project into the smallest set of Yjs changes, so
// only what the person changed travels to the others.

import * as Y from "yjs";
import type { Project } from "../model/types";

const KIND = "\u0001kind";
const ORDER = "order";
const ITEMS = "items";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Obj)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Obj)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]));
}

/** The key that identifies an item of an array, or null when the item has none. */
function itemKey(o: unknown): string | null {
  if (!isObj(o)) return null;
  if (typeof o.key === "string") return `key:${o.key}`;
  if (typeof o.kind === "string" && (typeof o.name === "string" || o.name === null)) return `${o.kind}:${o.name ?? ""}`;
  if (typeof o.name === "string") return `name:${o.name}`;
  if (typeof o.id === "string") return `id:${o.id}`;
  return null;
}

/** The keys of an array when every item has a distinct key; null otherwise. */
function keysOf(arr: Json[]): string[] | null {
  if (arr.length === 0) return null;
  // a list of distinct strings (page order, for one) is keyed by the strings themselves, so two people adding a page at
  // the same time both keep theirs
  if (arr.every((x) => typeof x === "string")) {
    const strs = arr as string[];
    return new Set(strs).size === strs.length ? strs.map((x) => `s:${x}`) : null;
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    const k = itemKey(it);
    if (k === null || seen.has(k)) return null;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

function encode(v: Json): unknown {
  if (isObj(v)) {
    const m = new Y.Map<unknown>();
    for (const [k, c] of Object.entries(v)) if (c !== undefined) m.set(k, encode(c));
    return m;
  }
  if (Array.isArray(v)) {
    const keys = keysOf(v);
    if (keys) {
      const m = new Y.Map<unknown>();
      const order = new Y.Array<string>();
      order.push(keys);
      const items = new Y.Map<unknown>();
      v.forEach((it, i) => items.set(keys[i], encode(it)));
      m.set(KIND, "list");
      m.set(ORDER, order);
      m.set(ITEMS, items);
      return m;
    }
    return structuredClone(v);
  }
  return v;
}

function isList(x: unknown): boolean {
  return x instanceof Y.Map && x.get(KIND) === "list";
}

export function decode(v: unknown): Json {
  if (v instanceof Y.Map) {
    if (isList(v)) {
      const items = v.get(ITEMS) as Y.Map<unknown>;
      const order = (v.get(ORDER) as Y.Array<string>).toArray();
      const seen = new Set<string>();
      const out: Json[] = [];
      for (const k of order) {
        if (seen.has(k) || !items.has(k)) continue; // duplicate entries come from two people adding the same key
        seen.add(k);
        out.push(decode(items.get(k)));
      }
      // an item whose order entry was lost to a concurrent delete/insert is kept, at the end, in a stable order
      for (const k of [...items.keys()].sort()) if (!seen.has(k)) out.push(decode(items.get(k)));
      return out;
    }
    const o: Obj = {};
    for (const [k, c] of v.entries()) o[k] = decode(c);
    return o;
  }
  return v === undefined ? null : (structuredClone(v) as Json);
}

function applyObject(m: Y.Map<unknown>, oldO: Obj, newO: Obj): void {
  for (const k of Object.keys(oldO)) if (oldO[k] !== undefined && newO[k] === undefined) m.delete(k);
  for (const k of Object.keys(newO)) {
    if (newO[k] === undefined) continue;
    setValue(m, k, oldO[k] as Json | undefined, newO[k]);
  }
}

function setValue(parent: Y.Map<unknown>, key: string, oldV: Json | undefined, newV: Json): void {
  if (oldV !== undefined && deepEqual(oldV, newV)) return;
  const existing = parent.get(key);
  if (isObj(newV) && isObj(oldV) && existing instanceof Y.Map && !isList(existing)) {
    applyObject(existing, oldV, newV);
    return;
  }
  if (Array.isArray(newV) && Array.isArray(oldV) && isList(existing) && keysOf(newV)) {
    applyList(existing as Y.Map<unknown>, oldV, newV);
    return;
  }
  parent.set(key, encode(newV));
}

function applyList(list: Y.Map<unknown>, oldA: Json[], newA: Json[]): void {
  const items = list.get(ITEMS) as Y.Map<unknown>;
  const order = list.get(ORDER) as Y.Array<string>;
  const oldKeys = keysOf(oldA) ?? [];
  const newKeys = keysOf(newA)!;
  const oldByKey = new Map(oldKeys.map((k, i) => [k, oldA[i]]));
  const newSet = new Set(newKeys);
  // removed items
  for (const k of oldKeys) {
    if (newSet.has(k)) continue;
    items.delete(k);
    const idx = order.toArray().indexOf(k);
    if (idx >= 0) order.delete(idx, 1);
  }
  // changed and added items
  newKeys.forEach((k, i) => {
    if (oldByKey.has(k)) setValue(items, k, oldByKey.get(k), newA[i]);
    else items.set(k, encode(newA[i]));
  });
  // order: add the new keys where they belong; rewrite the list when the surviving items were reordered
  const cur = order.toArray();
  const retained = newKeys.filter((k) => cur.includes(k));
  const sameOrder = retained.length === cur.filter((k) => newSet.has(k)).length && retained.every((k, i) => cur.filter((c) => newSet.has(c))[i] === k);
  if (!sameOrder) {
    order.delete(0, order.length);
    order.push(newKeys);
    return;
  }
  const have = new Set(cur);
  newKeys.forEach((k, i) => {
    if (!have.has(k)) {
      order.insert(Math.min(i, order.length), [k]);
      have.add(k);
    }
  });
}

/** The part of a project that people edit together: the model and the report. Where it is stored is each person's own. */
export interface Shared {
  model: unknown;
  report: unknown;
}

export const ROOT = "project";
export const LOCAL = "local-edit";
export const REMOTE = "remote";
export const SEED = "seed";

export function shared(p: Project): Obj {
  return { model: p.model as unknown as Json, report: p.report as unknown as Json };
}

/** Writes the difference between two versions of a project into the document (one transaction). */
export function syncProject(doc: Y.Doc, prev: Project, next: Project, origin: string = LOCAL): void {
  const root = doc.getMap(ROOT);
  doc.transact(() => applyObject(root, shared(prev), shared(next)), origin);
}

/** Fills an empty document with a whole project. */
export function seedProject(doc: Y.Doc, project: Project): void {
  syncProject(doc, { model: {}, report: {} } as unknown as Project, project, SEED);
}

/** The project the document describes, on top of the person's own project (which keeps its location). */
export function projectOf(doc: Y.Doc, own: Project): Project {
  const d = decode(doc.getMap(ROOT)) as Obj;
  return { ...own, model: (d.model ?? own.model) as Project["model"], report: (d.report ?? own.report) as Project["report"] };
}
