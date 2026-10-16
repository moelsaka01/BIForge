// Test support: the whole app frame over fakes (in-memory disk, fake engine, programmable DAX).
import { AppView } from "../../App";
import { createRegistry } from "../../core/commands/builtin";
import type { EditorFactory } from "../../core/dax/editorTypes";
import type { AppRuntime } from "../../core/appRuntime";
import type { TmdlPrinter } from "../../core/model/tmdlPrinter";
import { fixtureProject } from "../../core/report/testFixture";
import { AutosaveController } from "../../core/session/autosave";
import { Session } from "../../core/session/session";
import type { KeyValueStorage } from "../../core/shell/settings";
import { ShellStore } from "../../core/shell/shellStore";
import type { WindowApi } from "../../core/shell/windowApi";
import { FakeDax, result } from "../../core/testing/fakeDax";
import { FakeEngine } from "../../core/testing/fakeEngine";
import { FakeM } from "../../core/testing/fakeM";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import type { FileUi } from "./files";

/** Monaco cannot run in jsdom: the DAX editor falls back to its plain text box. */
const noEditor: EditorFactory = () => Promise.reject(new Error("no code editor in tests"));

export const ROOT = "C:/work/Fixture";
export const PBIP = `${ROOT}/Fixture.pbip`;

export class MemoryStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

export function fakeWindow() {
  const calls: string[] = [];
  const handlers: (() => void | Promise<void>)[] = [];
  const win: WindowApi = {
    available: true,
    minimize: async () => void calls.push("minimize"),
    toggleMaximize: async () => void calls.push("toggleMaximize"),
    isMaximized: async () => false,
    destroy: async () => void calls.push("destroy"),
    onCloseRequested: async (h) => {
      handlers.push(h);
      return () => undefined;
    },
  };
  return { win, calls, requestClose: () => Promise.all(handlers.map((h) => h())) };
}

export function makeApp(opts: { storage?: MemoryStorage; withProjectOnDisk?: boolean } = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  const w = fakeWindow();
  const shell = new ShellStore(storage, w.win);
  const io = new FakeIO();
  if (opts.withProjectOnDisk !== false) io.disk.set(ROOT, fixtureProject());
  const dialogs = new FakeDialogs();
  const engine = new FakeEngine();
  const session = new Session(io, dialogs, engine, new FakeM(), shell);
  const registry = createRegistry(session);
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["x"], [])], elapsedMs: 1 });
  const tmdl: TmdlPrinter = { print: async (docs) => Object.fromEntries(Object.keys(docs).map((k) => [k, `printed ${k}`])) };
  const files: FileUi & { saved: { name: string; text: string }[]; next: string | null } = {
    saved: [],
    next: null,
    pickText: async () => files.next,
    save: (name, text) => void files.saved.push({ name, text }),
  };
  const rt: AppRuntime = { session, registry, autosave: new AutosaveController(session, 1000), dax, tmdl };
  return { rt, session, registry, shell, io, dialogs, engine, dax, storage, files, win: w, element: <AppView rt={rt} files={files} editorFactory={noEditor} /> };
}
