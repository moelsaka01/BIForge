import { useEffect, useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input } from "@fluentui/react-components";
import type { ConnectorId } from "../importForm";
import { ImportDialog } from "../ImportDialog";
import { APP_NAME, APP_VERSION, NOT_YET_IMPLEMENTED, WORKING_FEATURES } from "../../core/info";
import { dirname, joinPath } from "../../core/session/session";
import type { DialogRequest } from "../../core/shell/shellStore";
import { OptionsDialog } from "./OptionsDialog";
import { DataSourcesDialog } from "./DataSourcesDialog";
import { GuideDialog, OpenPackageDialog, PublishDialog } from "./PublishDialog";
import { resolveTheme } from "../../core/report/theme";
import { themeToJson } from "../../core/report/theme";
import { useDoc, useEnv, useSession, useSettings, useShellState } from "./ShellContext";

const INVALID_NAME = /[\\/:*?"<>|]/;

/** Why a project name cannot be used, or null. */
export function projectNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (INVALID_NAME.test(n)) return 'A name cannot contain \\ / : * ? " < > |';
  if (n.endsWith(".") || n.endsWith(" ")) return "A name cannot end with a dot or a space.";
  if (n.length > 80) return "The name is too long (80 characters at most).";
  return null;
}

function Shell({ title, onClose, children, actions, label }: { title: string; onClose(): void; children: React.ReactNode; actions: React.ReactNode; label?: string }) {
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label={label ?? title}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</DialogContent>
          <DialogActions>{actions}</DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function NewProjectDialog({ request }: { request: Extract<DialogRequest, { kind: "newProject" }> }) {
  const env = useEnv();
  const settings = useSettings();
  const lastParent = settings.recent[0] ? dirname(dirname(settings.recent[0].path)) : "";
  const [name, setName] = useState("");
  const [parent, setParent] = useState(lastParent === settings.recent[0]?.path ? "" : lastParent);
  const [busy, setBusy] = useState(false);
  const problem = name.trim() === "" ? null : projectNameProblem(name);
  const ready = name.trim() !== "" && !problem && parent !== "";
  const close = () => env.session.shell.closeDialog();

  const create = async () => {
    setBusy(true);
    const ok = await env.run(request.sample ? "file.newSample.run" : "file.new", { name: name.trim(), folder: joinPath(parent, name.trim()) });
    setBusy(false);
    // another question (unsaved changes) may have taken the dialog's place; only move on when this one is still showing
    if (ok && env.session.shell.getSnapshot().dialog?.kind === "newProject") {
      if (request.thenImport) env.session.shell.openDialog({ kind: "import", source: request.thenImport === true ? undefined : request.thenImport });
      else close();
    }
  };

  return (
    <Shell
      title={request.sample ? "Learn with sample data" : "New blank report"}
      label="New project"
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button appearance="primary" disabled={!ready || busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <label style={{ display: "grid", gap: 4 }}>
        Project name
        <Input aria-label="Project name" value={name} onChange={(_, d) => setName(d.value)} autoFocus />
      </label>
      {problem && (
        <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)", fontSize: 12 }}>
          {problem}
        </div>
      )}
      <div style={{ display: "grid", gap: 4 }}>
        Location
        <div style={{ display: "flex", gap: 6 }}>
          <Input aria-label="Location" readOnly value={parent} placeholder="Choose the folder to create the project in" style={{ flex: 1 }} />
          <Button
            onClick={async () => {
              const f = await env.session.dialogs.pickFolder();
              if (f) setParent(f);
            }}
          >
            Browse…
          </Button>
        </div>
      </div>
      {ready && (
        <div style={{ fontSize: 12, opacity: 0.75 }} data-testid="project-path">
          The project is created in {joinPath(parent, name.trim())}
        </div>
      )}
    </Shell>
  );
}

function SaveAsDialog({ request }: { request: Extract<DialogRequest, { kind: "saveAs" }> }) {
  const env = useEnv();
  const doc = useDoc();
  const sess = useSession();
  const copy = request.copy === true;
  const [name, setName] = useState(doc.project?.name ?? "");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = name.trim() === "" ? null : projectNameProblem(name);
  const target = parent && name.trim() ? joinPath(parent, name.trim()) : "";
  const ready = name.trim() !== "" && !problem && parent !== "";
  const close = () => env.session.shell.closeDialog();
  return (
    <Shell
      title={copy ? "Save a copy" : "Save as"}
      label={copy ? "Save a copy" : "Save as"}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              const ok = await env.run("file.saveAs.run", { name: name.trim(), folder: target, copy });
              setBusy(false);
              if (ok) close();
            }}
          >
            {copy ? "Save a copy" : "Save"}
          </Button>
        </>
      }
    >
      <label style={{ display: "grid", gap: 4 }}>
        Project name
        <Input aria-label="Project name" value={name} onChange={(_, d) => setName(d.value)} autoFocus />
      </label>
      {problem && (
        <div role="alert" style={{ color: "var(--colorPaletteRedForeground1)", fontSize: 12 }}>
          {problem}
        </div>
      )}
      <div style={{ display: "grid", gap: 4 }}>
        Save in
        <div style={{ display: "flex", gap: 6 }}>
          <Input aria-label="Location" readOnly value={parent} placeholder="Choose the folder to create the project folder in" style={{ flex: 1 }} />
          <Button
            onClick={async () => {
              const f = await env.session.dialogs.pickFolder();
              if (f) setParent(f);
            }}
          >
            Browse…
          </Button>
        </div>
      </div>
      {ready && (
        <div style={{ fontSize: 12, opacity: 0.75 }} data-testid="project-path">
          The project and its data are written to {target}
          {copy ? ". The open project stays where it is." : ", and you continue working there."}
        </div>
      )}
      {sess.root && <div style={{ fontSize: 12, opacity: 0.75 }}>Now in {sess.root}.</div>}
    </Shell>
  );
}

function ExportDialog() {
  const env = useEnv();
  const doc = useDoc();
  const close = () => env.session.shell.closeDialog();
  return (
    <Shell title="Export" onClose={close} actions={<Button appearance="primary" onClick={close}>Close</Button>}>
      <Button
        onClick={() => {
          if (doc.project) {
            const t = resolveTheme(doc.project);
            env.files.save(`${t.name}.json`, JSON.stringify(themeToJson(t), null, 2));
          }
          close();
        }}
      >
        Report theme (JSON)…
      </Button>
      <Button onClick={() => env.session.shell.openDialog({ kind: "saveAs", copy: true })}>Project copy (PBIP folder with its data)…</Button>
      <div style={{ fontSize: 12, opacity: 0.75 }}>Not available yet: PDF, PNG, Power BI template (.pbit), visual data to CSV or Excel.</div>
    </Shell>
  );
}

function ImportMenuDialog() {
  const env = useEnv();
  const close = () => env.session.shell.closeDialog();
  return (
    <Shell title="Import" onClose={close} actions={<Button appearance="primary" onClick={close}>Close</Button>}>
      <Button
        onClick={async () => {
          const text = await env.files.pickText(".json,application/json");
          if (text === null) return;
          if (await env.run("report.theme.apply", { json: text })) close();
        }}
      >
        Report theme (JSON)…
      </Button>
      <Button onClick={() => void env.run("data.getData")}>Data from a file or database…</Button>
      <div style={{ fontSize: 12, opacity: 0.75 }}>Not available yet: Power BI template (.pbit), Power BI file (.pbix).</div>
    </Shell>
  );
}

function ImportHost({ request }: { request: Extract<DialogRequest, { kind: "import" }> }) {
  const env = useEnv();
  const engine = env.session.engine;
  if (!engine) return null;
  const close = () => env.session.shell.closeDialog();
  return (
    <ImportDialog
      open
      initialKind={request.source as ConnectorId | undefined}
      engine={engine}
      dialogs={env.session.dialogs}
      onClose={close}
      onSubmit={async (name, spec) => {
        const r = await env.registry.execute("data.import", { name, spec });
        if (r.ok) env.session.shell.selectTable(name);
        return r.ok ? null : r.message;
      }}
    />
  );
}

function NewTableDialog() {
  const env = useEnv();
  const [name, setName] = useState("");
  const close = () => env.session.shell.closeDialog();
  return (
    <Shell
      title="New table"
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={name.trim() === ""}
            onClick={async () => {
              if (await env.run("model.addTable", { name: name.trim() })) close();
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <label style={{ display: "grid", gap: 4 }}>
        Table name
        <Input aria-label="Table name" value={name} onChange={(_, d) => setName(d.value)} autoFocus />
      </label>
      <div style={{ fontSize: 12, opacity: 0.75 }}>Creates an empty table. Its columns and data come from an import or a query.</div>
    </Shell>
  );
}

function UnsavedDialog({ request }: { request: Extract<DialogRequest, { kind: "unsaved" }> }) {
  const env = useEnv();
  const doc = useDoc();
  const close = () => env.session.shell.closeDialog();
  const resume = async () => {
    close();
    await env.run(request.resume.id, request.resume.args);
  };
  return (
    <Shell
      title="Save your changes?"
      label="Unsaved changes"
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button onClick={() => void resume()}>Don't save</Button>
          <Button
            appearance="primary"
            onClick={async () => {
              if (await env.run("file.save")) await resume();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div>{doc.project ? `"${doc.project.name}" has changes that are not saved.` : "There are changes that are not saved."}</div>
    </Shell>
  );
}

function AboutDialog() {
  const env = useEnv();
  const close = () => env.session.shell.closeDialog();
  return (
    <Shell title={`About ${APP_NAME}`} label="About" onClose={close} actions={<Button appearance="primary" onClick={close}>Close</Button>}>
      <div>
        {APP_NAME} {APP_VERSION}: an open-source (Apache-2.0) desktop app for building semantic models and reports. Early development. It is not made by or affiliated with Microsoft.
      </div>
      <div>
        <strong>Working today</strong>
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          {WORKING_FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
      <div>
        <strong>Not yet implemented</strong>
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          {NOT_YET_IMPLEMENTED.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
      <div style={{ fontSize: 12, opacity: 0.75 }}>The full list, with what is tested, is in docs/COVERAGE.md.</div>
    </Shell>
  );
}

function ShortcutsDialog() {
  const env = useEnv();
  const close = () => env.session.shell.closeDialog();
  const rows = env.registry
    .all()
    .filter((c) => c.shortcut)
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <Shell title="Keyboard shortcuts" onClose={close} actions={<Button appearance="primary" onClick={close}>Close</Button>}>
      <table aria-label="Shortcuts" style={{ borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td style={{ padding: "2px 16px 2px 0" }}>{c.label}</td>
              <td>
                <kbd>{c.shortcut}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 12, opacity: 0.75 }}>Press Alt to show the ribbon key tips.</div>
    </Shell>
  );
}

/**
 * Fluent hides everything outside an open modal dialog from assistive technology (aria-hidden on #root) and removes it
 * when the dialog unmounts. Found in the real window: when a dialog is closed in the same commit that swaps the whole
 * document (opening a shared report), the attribute stayed and the entire app was hidden from screen readers and
 * from role queries. When no dialog is open, clear what a dialog left behind.
 */
function useClearStaleModalHiding(noDialog: boolean) {
  useEffect(() => {
    if (!noDialog) return;
    const id = window.setTimeout(() => {
      if (document.querySelector("[role=dialog]")) return;
      const root = document.getElementById("root");
      if (root?.getAttribute("aria-hidden") === "true") root.removeAttribute("aria-hidden");
      root?.removeAttribute("inert");
    }, 100);
    return () => window.clearTimeout(id);
  }, [noDialog]);
}

/** Draws the dialog the last command asked for. */
export function Dialogs() {
  const { dialog } = useShellState();
  useClearStaleModalHiding(dialog === null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "newProject":
      return <NewProjectDialog request={dialog} />;
    case "import":
      return <ImportHost request={dialog} />;
    case "newTable":
      return <NewTableDialog />;
    case "unsaved":
      return <UnsavedDialog request={dialog} />;
    case "options":
      return <OptionsDialog page={dialog.page} />;
    case "saveAs":
      return <SaveAsDialog request={dialog} />;
    case "exportMenu":
      return <ExportDialog />;
    case "importMenu":
      return <ImportMenuDialog />;
    case "about":
      return <AboutDialog />;
    case "shortcuts":
      return <ShortcutsDialog />;
    case "publish":
      return <PublishDialog />;
    case "openPackage":
      return <OpenPackageDialog request={dialog} />;
    case "guide":
      return <GuideDialog guideId={dialog.guideId} />;
    case "dataSources":
      return <DataSourcesDialog />;
  }
}
