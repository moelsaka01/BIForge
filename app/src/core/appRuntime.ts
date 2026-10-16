import { createRegistry } from "./commands/builtin";
import { Session } from "./session/session";
import { AutosaveController } from "./session/autosave";
import { tauriDialogs, tauriIO } from "./session/tauriIO";
import { tauriEngine } from "./data/tauriEngine";
import { tauriDax } from "./dax/tauriDax";
import { tauriM } from "./queries/tauriM";
import type { DaxApi } from "./dax/types";

export interface AppRuntime {
  session: Session;
  registry: ReturnType<typeof createRegistry>;
  autosave: AutosaveController;
  dax: DaxApi;
}

/** Wires the real (Tauri-backed) services. Tests build their own Session with fakes instead. */
export function createAppRuntime(): AppRuntime {
  const session = new Session(tauriIO, tauriDialogs, tauriEngine, tauriM);
  return { session, registry: createRegistry(session), autosave: new AutosaveController(session, 2000), dax: tauriDax };
}
