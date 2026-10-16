import { invoke } from "@tauri-apps/api/core";
import type { TmdlDocument } from "./types";

/** Prints model documents as TMDL text (the Rust printer is the single implementation). */
export interface TmdlPrinter {
  print(documents: Record<string, TmdlDocument>): Promise<Record<string, string>>;
  /** Parses TMDL text; rejects with a message naming the line that is wrong. */
  parse(text: string): Promise<TmdlDocument>;
}

export const tauriTmdl: TmdlPrinter = {
  print: (documents) => invoke<Record<string, string>>("tmdl_print", { documents }),
  parse: (text) => invoke<TmdlDocument>("tmdl_parse", { text }),
};
