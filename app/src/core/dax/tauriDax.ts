import { invoke } from "@tauri-apps/api/core";
import type { DaxApi, EditorDiagnostic, FunctionInfo, QueryOutcome } from "./types";
import type { TmdlDocument } from "../model/types";

/** DaxApi backed by the Rust DAX engine through Tauri commands. */
export const tauriDax: DaxApi = {
  catalog: () => invoke<FunctionInfo[]>("dax_catalog"),
  check: (documents: TmdlDocument[], expression: string) => invoke<EditorDiagnostic[]>("dax_check", { documents, expression }),
  query: (documents: TmdlDocument[], query: string) => invoke<QueryOutcome>("dax_query", { documents, query }),
};
