import { useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input } from "@fluentui/react-components";
import type { SourceKind } from "../importForm";
import { ImportDialog } from "../ImportDialog";
import { APP_NAME, APP_VERSION, NOT_YET_IMPLEMENTED, WORKING_FEATURES } from "../../core/info";
import { dirname, joinPath } from "../../core/session/session";
import type { DialogRequest } from "../../core/shell/shellStore";
import { useDoc, useEnv, useSettings, useShellState } from "./ShellContext";

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
    const ok = await env.run("file.new", { name: name.trim(), folder: joinPath(parent, name.trim()) });
    setBusy(false);
    // another question (unsaved changes) may have taken the dialog's place; only move on when this one is still showing
    if (ok && env.session.shell.getSnapshot().dialog?.kind === "newProject") {
      if (request.thenImport) env.session.shell.openDialog({ kind: "import", source: request.thenImport === true ? undefined : request.thenImport });
      else close();
    }
  };

  return (
    <Shell
      title="New blank report"
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

function ImportHost({ request }: { request: Extract<DialogRequest, { kind: "import" }> }) {
  const env = useEnv();
  const engine = env.session.engine;
  if (!engine) return null;
  const close = () => env.session.shell.closeDialog();
  return (
    <ImportDialog
      open
      initialKind={request.source as SourceKind | undefined}
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

function OptionsDialog() {
  const env = useEnv();
  const settings = useSettings();
  const kind = settings.shell;
  const layout = settings.layouts[kind];
  const close = () => env.session.shell.closeDialog();
  const radio = (name: string, value: string, label: string, checked: boolean, onChange: () => void) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
  return (
    <Shell title="Options and settings" label="Options" onClose={close} actions={<Button appearance="primary" onClick={close}>Close</Button>}>
      <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", borderRadius: 4 }}>
        <legend>Interface</legend>
        {radio("shell", "classic", "Classic: multi-line ribbon, panes side by side on the right", kind === "classic", () => void env.run("app.shell.set", { shell: "classic" }))}
        {radio("shell", "modern", "Modern: single-line ribbon, Data pane on the left, one pane switcher on the right", kind === "modern", () => void env.run("app.shell.set", { shell: "modern" }))}
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>Both open the same project; switching never changes it.</div>
      </fieldset>
      <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", borderRadius: 4 }}>
        <legend>Theme</legend>
        {radio("theme", "light", "Light", settings.theme === "light", () => settings.theme !== "light" && void env.run("app.theme.toggle"))}
        {radio("theme", "dark", "Dark", settings.theme === "dark", () => settings.theme !== "dark" && void env.run("app.theme.toggle"))}
      </fieldset>
      <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", borderRadius: 4 }}>
        <legend>Ribbon (this interface)</legend>
        {radio("ribbon", "multiline", "Multi-line", layout.ribbonMode === "multiline", () => void env.run("app.ribbon.mode", { mode: "multiline" }))}
        {radio("ribbon", "singleline", "Single line", layout.ribbonMode === "singleline", () => void env.run("app.ribbon.mode", { mode: "singleline" }))}
        <div style={{ marginTop: 6 }}>
          <Button size="small" onClick={() => void env.run("app.layout.reset")}>
            Reset panes and ribbon of this interface
          </Button>
        </div>
      </fieldset>
      <fieldset style={{ border: "1px solid var(--colorNeutralStroke2)", borderRadius: 4 }}>
        <legend>Preview features</legend>
        <div style={{ fontSize: 12 }}>On-object interaction: not yet implemented (neither interface has it).</div>
        <div style={{ fontSize: 12 }}>New Power Query experience: not yet implemented (one editor serves both interfaces).</div>
      </fieldset>
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

/** Draws the dialog the last command asked for. */
export function Dialogs() {
  const { dialog } = useShellState();
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
      return <OptionsDialog />;
    case "about":
      return <AboutDialog />;
    case "shortcuts":
      return <ShortcutsDialog />;
  }
}
