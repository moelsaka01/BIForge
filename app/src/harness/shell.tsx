// Development harness for the shells: the real frame (start screen, ribbons, panes, status bar) in a browser, with
// the real DAX engine and TMDL printer behind `cargo run -p biforge-engine --example report_harness`. Data views use
// an in-memory fake engine. Not part of the product build.
//   ?shell=modern  ?theme=dark  ?open=1 (open the demo project)  ?seed=1 (seed recent projects)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppView } from "../App";
import { createRegistry } from "../core/commands/builtin";
import type { AppRuntime } from "../core/appRuntime";
import { AutosaveController } from "../core/session/autosave";
import type { DaxApi, QueryOutcome } from "../core/dax/types";
import type { Project, TmdlDocument } from "../core/model/types";
import type { TmdlPrinter } from "../core/model/tmdlPrinter";
import { Session } from "../core/session/session";
import { ShellStore } from "../core/shell/shellStore";
import { FakeDialogs, FakeIO } from "../core/testing/fakes";
import { FakeEngine } from "../core/testing/fakeEngine";
import { buildDemo } from "./demo";

const q = new URLSearchParams(location.search);
const BASE = (q.get("server") ?? "http://127.0.0.1:1431").replace(/\/$/, "");

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const dax: DaxApi = {
  catalog: async () => [],
  check: async () => [],
  query: (documents: TmdlDocument[], query: string) => post("/dax", { documents, query }) as Promise<QueryOutcome>,
};
const tmdl: TmdlPrinter = { print: (documents) => post("/tmdl", { documents }), parse: () => Promise.reject(new Error("Parsing is not available in the browser harness.")) };

async function main() {
  const project = (await (await fetch(`${BASE}/project`)).json()) as Project;
  const io = new FakeIO();
  io.disk.set("C:/Demo/Retail", project);
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  if (q.get("shell") === "modern") storage.setItem("biforge.settings.v1", JSON.stringify({ shell: "modern", theme: q.get("theme") ?? "light" }));
  else if (q.get("theme")) storage.setItem("biforge.settings.v1", JSON.stringify({ theme: q.get("theme") }));
  const shell = new ShellStore(storage);
  if (q.has("seed")) {
    shell.settings.addRecent("C:/Demo/Retail/Retail.pbip", "Retail", Date.now() - 3600_000);
    shell.settings.addRecent("D:/Work/Sales analysis/Sales analysis.pbip", "Sales analysis", Date.now() - 20 * 24 * 3600_000);
  }
  const session = new Session(io, new FakeDialogs(), new FakeEngine(), null, shell);
  const registry = createRegistry(session);
  const rt: AppRuntime = { session, registry, autosave: new AutosaveController(session, 2000), dax, tmdl };
  if (q.has("open")) {
    const run = async (id: string, args?: unknown) => {
      const r = await registry.execute(id, args);
      if (!r.ok) throw new Error(r.message);
    };
    await run("file.open", { path: "C:/Demo/Retail/Retail.pbip" });
    if (!q.has("empty")) await buildDemo(session, run);
    session.store.markSaved(session.store.project!);
    if (q.get("view")) await run(`view.${q.get("view")}`);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppView rt={rt} />
    </StrictMode>,
  );
}
void main();
