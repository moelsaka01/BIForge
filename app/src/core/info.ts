export const APP_NAME = "BIForge";

/** What the app can do today. Keep in step with docs/COVERAGE.md (Done-tested rows only). */
export const WORKING_FEATURES = [
  "projects (new, open, save, undo/redo, crash recovery)",
  "data import and refresh (CSV, Excel, JSON, Parquet, SQLite, PostgreSQL)",
  "Data view",
  "Model view with relationships",
  "DAX measures (editor with IntelliSense, evaluated over the imported data)",
] as const;

/** Major areas that are visibly missing. */
export const NOT_YET_IMPLEMENTED = ["DAX window, financial and parent-child functions", "report canvas and visuals", "Power Query", "ribbons and the Classic/Modern shells"] as const;

export const STATUS_NOTICE =
  `Early development. Working: ${WORKING_FEATURES.join("; ")}. ` +
  `Not yet implemented: ${NOT_YET_IMPLEMENTED.join(", ")}. This is a temporary host screen; see docs/COVERAGE.md.`;
