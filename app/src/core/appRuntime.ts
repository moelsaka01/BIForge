import { createRegistry } from "./commands/builtin";
import { Session } from "./session/session";
import { AutosaveController } from "./session/autosave";
import { tauriDialogs, tauriIO } from "./session/tauriIO";

export interface AppRuntime {
  session: Session;
  registry: ReturnType<typeof createRegistry>;
  autosave: AutosaveController;
}

/** Wires the real (Tauri-backed) services. Tests build their own Session with fakes instead. */
export function createAppRuntime(): AppRuntime {
  const session = new Session(tauriIO, tauriDialogs);
  return { session, registry: createRegistry(session), autosave: new AutosaveController(session, 2000) };
}
