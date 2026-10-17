// Development harness: the Power Query editor against the real M engine served by
// `cargo run -p biforge-engine --example pq_harness` (see that file). Not part of the product build.
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Button, FluentProvider, webLightTheme } from "@fluentui/react-components";
import { createRegistry } from "../core/commands/builtin";
import type { EngineApi, SourceSpec } from "../core/data/types";
import { Session } from "../core/session/session";
import { FakeIO } from "../core/testing/fakes";
import type { Dialogs } from "../core/session/session";
import type { MApi } from "../core/queries/types";
import { PowerQueryEditor } from "../views/pq/PowerQueryEditor";

const BASE = (new URLSearchParams(location.search).get("server") ?? "http://127.0.0.1:1432").replace(/\/$/, "");

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

const unsupported = () => Promise.reject(new Error("Not available in the harness."));

const httpEngine: EngineApi = {
  openStore: () => post("/engine/open", {}),
  copyStore: unsupported,
  importSource: (table, spec) => post("/engine/import", { table, spec }),
  tableInfo: (table) => post("/engine/tableInfo", { table }),
  dropTable: (table) => post("/engine/drop", { table }),
  fetchPage: unsupported,
  suggestRelationship: unsupported,
  excelSheets: () => Promise.resolve(["Sheet1"]),
  sqliteTables: unsupported,
  postgresTables: unsupported,
  sqlserverTables: unsupported,
  sourceChoices: unsupported,
  sourcePreview: unsupported,
  odbcDrivers: () => Promise.resolve([]),
  setCredential: unsupported,
};

const httpM: MApi = {
  parseQuery: (text) => post("/m/parse", { text }),
  check: (text) => post("/m/check", { text }),
  applyTransform: (text, after, transform) => post("/m/applyTransform", { text, after, transform }),
  editStep: (text, edit) => post("/m/editStep", { text, edit }),
  dependencies: (queries) => post("/m/dependencies", { queries }),
  folderQuery: (folder, extension, delimiter) => post("/m/folderQuery", { folder, extension, delimiter }),
  analyze: (queries, query) => post("/m/analyze", { queries, query }),
  preview: (queries, query, step, limit) => post("/m/preview", { queries, query, step, limit }),
  load: (queries, query, table) => post("/m/load", { queries, query, table }),
  queryKinds: (queries) => post("/m/queryKinds", { queries }),
};

function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState("");
  const { session, registry } = useMemo(() => {
    const dialogs: Dialogs = {
      pickPbip: async () => null,
      pickFolder: async () => null,
      pickFile: async (_n, _e) => `${fixtures}/Customer.csv`,
    };
    const session = new Session(new FakeIO(), dialogs, httpEngine, httpM);
    return { session, registry: createRegistry(session) };
    // the fixtures path only matters for the file picker, read lazily below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtures]);
  const q = useSyncExternalStore(session.queries.subscribe, session.queries.getSnapshot);
  const sess = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    (async () => {
      const info = (await (await fetch(`${BASE}/info`)).json()) as { fixtures: string };
      setFixtures(info.fixtures);
    })().catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!fixtures || ready) return;
    (async () => {
      await session.newProject("C:/harness", "Harness");
      for (const t of ["Sales", "Customer", "Date"]) {
        const spec: SourceSpec = { kind: "csv", path: `${fixtures}/${t}.csv` };
        await session.importTable(t, spec);
      }
      session.openQueryEditor("Sales");
      setReady(true);
    })().catch((e) => setError(String(e)));
  }, [fixtures, ready, session]);

  if (error) return <pre style={{ color: "#c00" }}>{error}</pre>;
  if (!ready) return <p>Loading…</p>;
  return (
    <div style={{ padding: 16 }}>
      <Button onClick={() => session.openQueryEditor()}>Transform data</Button>
      <p>{sess.lastMessage}</p>
      <p>Tables with data: {sess.dataTables.join(", ")}</p>
      <PowerQueryEditor session={session} registry={registry} />
      <p style={{ display: "none" }}>{q.version}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FluentProvider theme={webLightTheme}>
      <App />
    </FluentProvider>
  </StrictMode>,
);
