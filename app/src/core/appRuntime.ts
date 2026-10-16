import { createRegistry } from "./commands/builtin";
import { Session } from "./session/session";
import { AutosaveController } from "./session/autosave";
import { tauriDialogs, tauriIO } from "./session/tauriIO";
import { tauriEngine } from "./data/tauriEngine";
import { tauriDax } from "./dax/tauriDax";
import { tauriM } from "./queries/tauriM";
import { tauriPublish } from "./publish/tauriPublish";
import { tauriTmdl, type TmdlPrinter } from "./model/tmdlPrinter";
import { ShellStore } from "./shell/shellStore";
import { tauriWindow } from "./shell/tauriWindow";
import { noWindow } from "./shell/windowApi";
import type { DaxApi } from "./dax/types";

export interface AppRuntime {
  session: Session;
  registry: ReturnType<typeof createRegistry>;
  autosave: AutosaveController;
  dax: DaxApi;
  tmdl: TmdlPrinter;
}

/** localStorage when the window allows it (it can throw in a locked-down webview). */
function windowStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Wires the real (Tauri-backed) services. Tests build their own Session with fakes instead. */
export function createAppRuntime(): AppRuntime {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const shell = new ShellStore(windowStorage(), inTauri ? tauriWindow : noWindow);
  const session = new Session(tauriIO, tauriDialogs, tauriEngine, tauriM, shell, inTauri ? tauriPublish : null);
  return { session, registry: createRegistry(session), autosave: new AutosaveController(session, 2000), dax: tauriDax, tmdl: tauriTmdl };
}
