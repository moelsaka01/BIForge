import { useEffect, useMemo, useRef, useState } from "react";
import type { RibbonControl, RibbonCtx, RibbonTab } from "../../core/shell/ribbon";
import { resolveTheme, type ShellKind } from "../../core/shell/settings";
import { RIBBON_ICONS, UI_ICONS } from "./icons";
import { controlEnabled, runControl, useDoc, useEnv, useSession, useSettings, useShellState } from "./ShellContext";

/** Search over the commands of the current ribbon (what a user can click), run with the same arguments. */
function CommandSearch({ tabs, ctx, ui }: { tabs: RibbonTab[]; ctx: RibbonCtx; ui: Parameters<typeof runControl>[3] }) {
  const env = useEnv();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const seen = new Set<string>();
    const out: { control: RibbonControl; tab: string }[] = [];
    for (const t of tabs) {
      for (const g of t.groups) {
        for (const c of g.controls) {
          const key = `${c.command ?? c.id}:${JSON.stringify(typeof c.args === "function" ? null : c.args ?? null)}`;
          if (c.label.toLowerCase().includes(needle) && !c.readout && !seen.has(key)) {
            seen.add(key);
            out.push({ control: c, tab: t.label });
          }
        }
      }
    }
    return out.slice(0, 10);
  }, [q, tabs]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    const off = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", off);
    return () => window.removeEventListener("pointerdown", off);
  }, []);

  const pick = (h: { control: RibbonControl }) => {
    if (!controlEnabled(env, h.control, ctx) || h.control.menu) return;
    setOpen(false);
    setQ("");
    runControl(env, h.control, ctx, ui);
  };

  return (
    <div className="tb-search" ref={box} role="search">
      <UI_ICONS.search aria-hidden />
      <input
        type="search"
        aria-label="Search commands"
        placeholder="Search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((i) => Math.min(hits.length - 1, i + 1));
          else if (e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
          else if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
          else if (e.key === "Escape") {
            setOpen(false);
            setQ("");
          }
        }}
      />
      {open && q.trim() !== "" && (
        <div className="tb-results" role="listbox" aria-label="Matching commands">
          {hits.length === 0 && <div style={{ padding: "8px 10px", opacity: 0.7 }}>No command matches "{q}".</div>}
          {hits.map((h, i) => {
            const enabled = controlEnabled(env, h.control, ctx) && !h.control.menu;
            return (
              <button key={h.control.id + i} role="option" aria-selected={i === sel} disabled={!enabled} onClick={() => pick(h)}>
                {h.control.label}
                <small>{h.control.status ? "Not yet implemented" : h.control.menu ? "Use the ribbon" : h.tab}</small>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface TitleBarProps {
  variant: ShellKind;
  tabs: RibbonTab[];
  ctx: RibbonCtx;
  ui: Parameters<typeof runControl>[3];
}

export function TitleBar({ variant, tabs, ctx, ui }: TitleBarProps) {
  const env = useEnv();
  const doc = useDoc();
  const sess = useSession();
  const settings = useSettings();
  const dark = useShellState().systemDark;
  const resolved = resolveTheme(settings.theme, dark);
  const win = env.session.shell.window;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (win.available) void win.isMaximized().then(setMaximized);
  }, [win]);

  const project = doc.project;
  const status = !project ? "" : doc.isDirty ? "Unsaved changes" : sess.root ? "Saved" : "";
  const btn = (id: string, label: string, Icon: React.ComponentType<{ "aria-hidden"?: boolean }>) => (
    <button type="button" className="tb-btn" aria-label={label} title={label} disabled={!env.registry.isEnabled(id)} onClick={() => void env.run(id)}>
      <Icon aria-hidden />
    </button>
  );
  return (
    <header className={`titlebar ${variant}`} data-tauri-drag-region role="banner">
      {btn("file.save", "Save", SaveIcon)}
      {btn("edit.undo", env.registry.get("edit.undo")?.label ?? "Undo", UndoIcon)}
      {btn("edit.redo", env.registry.get("edit.redo")?.label ?? "Redo", RedoIcon)}
      <span className="tb-title" data-tauri-drag-region data-testid="doc-title">
        {project ? (
          <>
            <strong>{project.name}</strong> · {status}
          </>
        ) : (
          "BIForge"
        )}
      </span>
      <span className="tb-spacer" data-tauri-drag-region />
      <CommandSearch tabs={tabs} ctx={ctx} ui={ui} />
      <span className="tb-spacer" data-tauri-drag-region />
      <button type="button" className="tb-btn" aria-label="Options and settings" title="Options and settings" onClick={() => void env.run("app.options")}>
        <OptionsIcon aria-hidden />
      </button>
      <button type="button" className="tb-btn" aria-label={resolved === "dark" ? "Switch to the light theme" : "Switch to the dark theme"} title="Light or dark theme" onClick={() => void env.run("app.theme.toggle")}>
        {resolved === "dark" ? <UI_ICONS.sun aria-hidden /> : <UI_ICONS.moon aria-hidden />}
      </button>
      {win.available && (
        <>
          <button type="button" className="tb-btn winbtn" aria-label="Minimize" onClick={() => void win.minimize()}>
            <UI_ICONS.minimize aria-hidden />
          </button>
          <button
            type="button"
            className="tb-btn winbtn"
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={() => void win.toggleMaximize().then(() => win.isMaximized().then(setMaximized))}
          >
            {maximized ? <UI_ICONS.restore aria-hidden /> : <UI_ICONS.maximize aria-hidden />}
          </button>
          <button type="button" className="tb-btn winbtn close" aria-label="Close" onClick={() => void env.run("app.exit")}>
            <CloseIcon aria-hidden />
          </button>
        </>
      )}
    </header>
  );
}

const SaveIcon = RIBBON_ICONS.save;
const UndoIcon = RIBBON_ICONS.undo;
const RedoIcon = RIBBON_ICONS.redo;
const OptionsIcon = RIBBON_ICONS.options;
const CloseIcon = RIBBON_ICONS.close;
