import { invoke } from "@tauri-apps/api/core";
import type { TmdlDocument } from "./types";

/** Prints model documents as TMDL text (the Rust printer is the single implementation). */
export interface TmdlPrinter {
  print(documents: Record<string, TmdlDocument>): Promise<Record<string, string>>;
}

export const tauriTmdl: TmdlPrinter = {
  print: (documents) => invoke<Record<string, string>>("tmdl_print", { documents }),
};
