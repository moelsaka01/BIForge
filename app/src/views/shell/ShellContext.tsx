import { createContext, useContext, useSyncExternalStore } from "react";
import type { CommandRegistry } from "../../core/commands/registry";
import type { DaxApi } from "../../core/dax/types";
import type { TmdlPrinter } from "../../core/model/tmdlPrinter";
import type { Session } from "../../core/session/session";
import type { RibbonCtx, RibbonControl, RibbonMenuItem } from "../../core/shell/ribbon";
import { resolveArgs } from "../../core/shell/ribbon";
import type { EditorFactory } from "../../core/dax/editorTypes";
import type { FileUi } from "./files";

/** What every part of the frame needs: the session, the command registry and a way to dispatch with error display. */
export interface ShellEnv {
  session: Session;
  registry: CommandRegistry<Session>;
  dax: DaxApi;
  tmdl: TmdlPrinter;
  files: FileUi;
  /** Creates the code editor (Monaco in the app). */
  editorFactory: EditorFactory;
  /** Executes a command; a failure is shown in the frame's message bar. Resolves to whether it succeeded. */
  run(id: string, args?: unknown): Promise<boolean>;
  error: string | null;
  setError(message: string | null): void;
}

export const ShellEnvContext = createContext<ShellEnv | null>(null);

export function useEnv(): ShellEnv {
  const e = useContext(ShellEnvContext);
  if (!e) throw new Error("ShellEnvContext is missing.");
  return e;
}

export const useShellState = () => {
  const { session } = useEnv();
  return useSyncExternalStore(session.shell.subscribe, session.shell.getSnapshot);
};
export const useSettings = () => {
  const { session } = useEnv();
  return useSyncExternalStore(session.shell.settings.subscribe, session.shell.settings.getSnapshot);
};
export const useDoc = () => {
  const { session } = useEnv();
  return useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
};
export const useSession = () => {
  const { session } = useEnv();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
};

/** Dispatches a ribbon control (or a menu item of it) with the arguments its definition asks for. */
export function runControl(env: ShellEnv, c: RibbonControl | RibbonMenuItem, ctx: RibbonCtx, ui: Partial<Record<NonNullable<RibbonMenuItem["ui"]>, () => void>> = {}): void {
  if ("ui" in c && c.ui) return ui[c.ui]?.();
  if (!c.command) return;
  void env.run(c.command, resolveArgs(c.args, ctx));
}

/** Whether a control can be used now: it needs a command that is registered, enabled and passes its own condition. */
export function controlEnabled(env: ShellEnv, c: RibbonControl | RibbonMenuItem, ctx: RibbonCtx): boolean {
  if (!c.command) return false;
  if (!env.registry.isEnabled(c.command)) return false;
  const when = "when" in c ? c.when : undefined;
  return when ? when(ctx) : true;
}
