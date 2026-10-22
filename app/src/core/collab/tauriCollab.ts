import { invoke } from "@tauri-apps/api/core";
import type { CollabApi } from "./types";

function toB64(b: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < b.length; i += step) s += String.fromCharCode(...b.subarray(i, i + step));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const tauriCollab: CollabApi = {
  async call(ctx, op, args, blob) {
    const r = await invoke<{ meta: unknown; blob: string }>("collab_call", { ctx, op, args, blob: blob && blob.length ? toB64(blob) : null });
    return { meta: r.meta, blob: r.blob ? fromB64(r.blob) : new Uint8Array(0) };
  },
};
