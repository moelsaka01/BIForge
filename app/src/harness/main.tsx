// Development harness: the report views against the real DAX engine served by
// `cargo run -p biforge-engine --example report_harness` (see that file). Not part of the product build.
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { createRegistry } from "../core/commands/builtin";
import type { DaxApi, QueryOutcome } from "../core/dax/types";
import type { Project, TmdlDocument } from "../core/model/types";
import { Session } from "../core/session/session";
import { FakeDialogs, FakeIO } from "../core/testing/fakes";
import { ReportView } from "../views/report/ReportView";
import { DataPane } from "../views/DataPane";
import { buildDemo } from "./demo";

const BASE = (new URLSearchParams(location.search).get("server") ?? "http://127.0.0.1:1431").replace(/\/$/, "");

const httpDax: DaxApi = {
  catalog: async () => [],
  check: async () => [],
  query: async (documents: TmdlDocument[], query: string): Promise<QueryOutcome> => {
    const r = await fetch(`${BASE}/dax`, { method: "POST", body: JSON.stringify({ documents, query }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    return j as QueryOutcome;
  },
};

function Harness({ session, run, dax }: { session: Session; run: (id: string, a?: unknown) => Promise<void>; dax: DaxApi }) {
  const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
  const [sel, setSel] = useState<string | null>(null);
  void sel;
  if (!doc.project) return null;
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ width: 230, borderRight: "1px solid #ddd", overflow: "auto" }}>
        <DataPane project={doc.project} dataTables={[]} selected={null} canImport={false} onSelect={() => undefined} onRefresh={() => undefined} onRefreshAll={() => undefined} onImport={() => undefined} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ReportView project={doc.project} runtime={session.report} dax={dax} dispatch={(id, a) => void run(id, a).catch((e) => console.error(e))} dataEpoch={0} onSelectVisual={(_p, v) => setSel(v)} />
      </div>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { session, run } = useMemo(() => {
    const session = new Session(new FakeIO(), new FakeDialogs());
    const registry = createRegistry(session);
    const run = async (id: string, args?: unknown) => {
      const r = await registry.execute(id, args);
      if (!r.ok) throw new Error(r.message);
    };
    return { session, run };
  }, []);
  useEffect(() => {
    (async () => {
      const project = (await (await fetch(`${BASE}/project`)).json()) as Project;
      session.store.load(project);
      if (!new URLSearchParams(location.search).has("empty")) await buildDemo(session, run);
      else session.report.goToPage("page1");
      session.store.markSaved(session.store.project!);
      setReady(true);
    })().catch((e) => setError(String(e)));
  }, [session, run]);
  if (error) return <pre style={{ color: "#c00" }}>{error}</pre>;
  if (!ready) return <p>Loading…</p>;
  return <Harness session={session} run={run} dax={httpDax} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FluentProvider theme={webLightTheme}>
      <App />
    </FluentProvider>
  </StrictMode>,
);
