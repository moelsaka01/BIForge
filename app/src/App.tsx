import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { resolveTheme } from "./core/shell/settings";
import { applyInterfaceZoom, shouldCheckForUpdates } from "./core/shell/interfaceOptions";
import { createAppRuntime, type AppRuntime } from "./core/appRuntime";
import { ClassicShell } from "./shells/classic/ClassicShell";
import { ModernShell } from "./shells/modern/ModernShell";
import { createMonacoEditor } from "./core/dax/monaco";
import type { EditorFactory } from "./core/dax/editorTypes";
import { browserFiles, type FileUi } from "./views/shell/files";
import { ShellEnvContext, type ShellEnv } from "./views/shell/ShellContext";
import "./views/shell/shell.css";

/**
 * The app: wires the runtime, the light/dark theme and the shell the user chose. The start screen, ribbons, panes and
 * views live in views/shell and shells/*; they only dispatch registered commands.
 */
export function AppView({ rt, files = browserFiles, editorFactory = createMonacoEditor }: { rt: AppRuntime; files?: FileUi; editorFactory?: EditorFactory }) {
  const { session, registry } = rt;
  const settings = useSyncExternalStore(session.shell.settings.subscribe, session.shell.settings.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const shellState = useSyncExternalStore(session.shell.subscribe, session.shell.getSnapshot);

  // "Use system setting" follows the Windows light/dark mode and changes with it
  useEffect(() => {
    const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (!mq) return;
    const sync = () => session.shell.setSystemDark(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [session]);

  // a biforge:// link or .biforge file the app was started with opens the "open shared report" confirmation
  useEffect(() => {
    void registry.execute("package.startup");
  }, [registry]);

  // a link or file opened while BIForge is running arrives from the second start (single instance) as an event
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        const un = await mod.listen<string>("biforge-open", (e) => void registry.execute("package.openArg", { arg: e.payload }));
        if (gone) un();
        else off = un;
      } catch {
        /* not inside the app window (browser tests) */
      }
    })();
    return () => {
      gone = true;
      off?.();
    };
  }, [registry]);

  // Options > Interface > Size of the interface
  useEffect(() => applyInterfaceZoom(document.documentElement, settings.options), [settings.options]);

  // a quiet check for a newer version a few seconds after start (switch it off in About)
  useEffect(() => {
    if (!shouldCheckForUpdates(settings.options)) return;
    const t = setTimeout(() => void registry.execute("app.update.check", { silent: true }), 6000);
    return () => clearTimeout(t);
    // only at start: later changes of the option apply to the next start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry]);

  const run = useCallback(
    async (id: string, args?: unknown) => {
      const r = await registry.execute(id, args);
      setError(r.ok ? null : r.message);
      return r.ok;
    },
    [registry],
  );
  const env: ShellEnv = useMemo(() => ({ session, registry, dax: rt.dax, tmdl: rt.tmdl, files, editorFactory, run, error, setError }), [session, registry, rt.dax, rt.tmdl, files, editorFactory, run, error]);

  return (
    <FluentProvider theme={resolveTheme(settings.theme, shellState.systemDark) === "dark" ? webDarkTheme : webLightTheme} style={{ background: "transparent" }}>
      <ShellEnvContext.Provider value={env}>{settings.shell === "modern" ? <ModernShell /> : <ClassicShell />}</ShellEnvContext.Provider>
    </FluentProvider>
  );
}

export function App() {
  const rt = useMemo(createAppRuntime, []);
  return <AppView rt={rt} />;
}
