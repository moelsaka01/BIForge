import type { Project, TmdlDocument } from "../model/types";
import { listTables } from "../model/ops";
import type { DaxContext } from "./language";
import type { FunctionInfo } from "./types";

/** What IntelliSense knows about the project: its tables, columns and measures. */
export function buildContext(catalog: FunctionInfo[], project: Project): DaxContext {
  return {
    catalog,
    tables: listTables(project).map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name), measures: t.measures.map((m) => m.name) })),
  };
}

/** The TMDL documents the engine builds its model from (the document store is the source of truth, unsaved edits included). */
export function modelDocuments(project: Project): TmdlDocument[] {
  return Object.values(project.model.tmdl);
}
