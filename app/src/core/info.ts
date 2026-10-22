export const APP_NAME = "BIForge";
export const APP_VERSION = "0.1.0";

/** What the app can do today. Keep in step with docs/COVERAGE.md (Done-tested rows only). Shown in the About dialog. */
export const WORKING_FEATURES = [
  "start screen, Classic and Modern interfaces, projects (new, open, save, undo/redo, crash recovery)",
  "data import and refresh (CSV, Excel, JSON, Parquet, SQLite, PostgreSQL)",
  "Table view and Model view with relationships",
  "DAX measures and a DAX query view (editor with IntelliSense, evaluated over the imported data)",
  "report canvas with the first set of visuals, filters, bookmarks and themes",
  "Power Query editor (CSV, Excel, JSON, Parquet, folder and SQLite sources)",
  "TMDL view (read-only)",
] as const;

/** Major areas that are visibly missing. */
export const NOT_YET_IMPLEMENTED = [
  "DAX window, financial and parent-child functions",
  "report visuals beyond the first set, text boxes, shapes and images",
  "Power Query web and database sources and some transforms",
  "on-object formatting, Save as, sample data, export, and every cloud feature",
] as const;
