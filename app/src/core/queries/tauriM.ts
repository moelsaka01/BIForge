import { invoke } from "@tauri-apps/api/core";
import type { RowPage, TableInfo } from "../data/types";
import type { Applied, MApi, MDiagnostic, ParsedQuery, StepEdit, StepResult, Transform } from "./types";

/** MApi backed by the Rust M engine through Tauri commands. */
export const tauriM: MApi = {
  parseQuery: (text) => invoke<ParsedQuery>("m_parse_query", { text }),
  check: (text) => invoke<MDiagnostic[]>("m_check", { text }),
  applyTransform: (text, after, transform: Transform) => invoke<Applied>("m_apply_transform", { text, after, transform }),
  editStep: (text, edit: StepEdit) => invoke<string>("m_edit_step", { text, edit }),
  dependencies: (queries) => invoke<Record<string, string[]>>("m_dependencies", { queries }),
  folderQuery: (folder, extension, delimiter) => invoke<string>("m_folder_query", { folder, extension, delimiter }),
  analyze: (queries, query) => invoke<StepResult[]>("m_analyze", { queries, query }),
  preview: (queries, query, step, limit) => invoke<RowPage>("m_preview", { queries, query, step, limit }),
  load: (queries, query, table) => invoke<TableInfo>("m_load", { queries, query, table }),
  queryKinds: (queries) => invoke<Record<string, string>>("m_query_kinds", { queries }),
};
