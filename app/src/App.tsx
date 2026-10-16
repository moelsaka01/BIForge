import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
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
    <FluentProvider theme={settings.theme === "dark" ? webDarkTheme : webLightTheme} style={{ background: "transparent" }}>
      <ShellEnvContext.Provider value={env}>{settings.shell === "modern" ? <ModernShell /> : <ClassicShell />}</ShellEnvContext.Provider>
    </FluentProvider>
  );
}

export function App() {
  const rt = useMemo(createAppRuntime, []);
  return <AppView rt={rt} />;
}
