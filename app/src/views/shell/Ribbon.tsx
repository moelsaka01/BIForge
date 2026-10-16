import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger } from "@fluentui/react-components";
import { STATUS_TEXT, type RibbonCtx, type RibbonControl, type RibbonGroup, type RibbonTab } from "../../core/shell/ribbon";
import type { RibbonMode, ShellKind } from "../../core/shell/settings";
import { RIBBON_ICONS, UI_ICONS } from "./icons";
import { controlEnabled, runControl, useEnv } from "./ShellContext";

export interface RibbonProps {
  variant: ShellKind;
  mode: RibbonMode;
  collapsed: boolean;
  tabs: RibbonTab[];
  active: string;
  ctx: RibbonCtx;
  onTab(id: string): void;
  onToggleCollapsed(): void;
  /** Handlers for controls that need the window (file pickers, downloads). */
  ui: Parameters<typeof runControl>[3];
}

type Keytips = { mode: "off" } | { mode: "tabs"; buf: string } | { mode: "controls"; tab: string; buf: string };

const controlsOf = (tab: RibbonTab | undefined) => tab?.groups.flatMap((g) => g.controls) ?? [];

/** Alt shows the keytips of the tabs; a tab's keytip then shows those of its controls. */
function useKeytips(tabs: RibbonTab[], active: string, onTab: (id: string) => void, activate: (c: RibbonControl) => void, backstage: () => void): Keytips {
  const [state, setState] = useState<Keytips>({ mode: "off" });
  const ref = useRef({ tabs, active, onTab, activate, backstage, state });
  ref.current = { tabs, active, onTab, activate, backstage, state };
  useEffect(() => {
    let altAlone = false;
    const down = (e: KeyboardEvent) => {
      const r = ref.current;
      if (e.key === "Alt") {
        altAlone = !e.repeat || altAlone;
        return;
      }
      altAlone = false;
      if (r.state.mode === "off") return;
      if (e.key === "Escape") {
        e.preventDefault();
        setState({ mode: "off" });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !/[a-z0-9]/i.test(e.key)) return;
      e.preventDefault();
      const buf = (r.state.buf + e.key).toUpperCase();
      if (r.state.mode === "tabs") {
        const hit = r.tabs.find((t) => t.keytip === buf);
        if (hit) {
          if (hit.backstage) {
            setState({ mode: "off" });
            r.backstage();
          } else {
            r.onTab(hit.id);
            setState({ mode: "controls", tab: hit.id, buf: "" });
          }
        } else if (r.tabs.some((t) => t.keytip.startsWith(buf))) setState({ mode: "tabs", buf });
        else setState({ mode: "off" });
        return;
      }
      const tab = r.tabs.find((t) => t.id === (r.state as { tab: string }).tab);
      const list = controlsOf(tab);
      const hit = list.find((c) => c.keytip === buf);
      if (hit) {
        setState({ mode: "off" });
        r.activate(hit);
      } else if (!list.some((c) => c.keytip?.startsWith(buf))) setState({ mode: "off" });
      else setState({ mode: "controls", tab: tab!.id, buf });
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      if (altAlone) {
        e.preventDefault();
        setState((s) => (s.mode === "off" ? { mode: "tabs", buf: "" } : { mode: "off" }));
      }
      altAlone = false;
    };
    const click = () => setState((s) => (s.mode === "off" ? s : { mode: "off" }));
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", click, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", click, true);
    };
  }, []);
  return state;
}

function Btn({ control, ctx, layout, labels, tip, ui }: { control: RibbonControl; ctx: RibbonCtx; layout: "large" | "small" | "compact"; labels: boolean; tip?: string; ui: RibbonProps["ui"] }) {
  const env = useEnv();
  const Icon = RIBBON_ICONS[control.icon];
  const enabled = controlEnabled(env, control, ctx);
  const checked = control.checked?.(ctx) ?? false;
  const unavailable = control.status ? STATUS_TEXT[control.status] : null;
  const title = unavailable ? `${control.label} - ${unavailable}` : control.label;
  const body = (
    <>
      <Icon aria-hidden />
      {(layout !== "compact" || labels) && <span>{control.label}</span>}
      {layout === "compact" && !labels && <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{control.label}</span>}
      {tip && <span className="keytip" aria-hidden>{tip}</span>}
    </>
  );
  const common = { className: `rb-btn ${layout}`, title, "data-control": control.id, "aria-pressed": control.checked ? checked : undefined, "aria-disabled": !enabled || undefined } as const;
  if (control.readout) {
    return (
      <label className="rb-field">
        {control.label}
        <input readOnly disabled value={control.readout(ctx)} aria-label={control.label} title={unavailable ?? undefined} />
      </label>
    );
  }
  if (control.menu) {
    return (
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <button type="button" {...common} aria-haspopup="menu" disabled={!enabled}>
            {body}
          </button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {control.menu.map((m, i) => (
              <Fragment key={`${m.label}${i}`}>
                {m.separatorBefore && <MenuDivider />}
                <MenuItem
                  disabled={m.status !== undefined || (m.command !== undefined && !env.registry.isEnabled(m.command))}
                  title={m.status ? STATUS_TEXT[m.status] : undefined}
                  onClick={() => runControl(env, m, ctx, ui)}
                >
                  {m.checked?.(ctx) ? "✓ " : ""}
                  {m.label}
                  {m.status ? ` (${m.status === "todo" ? "not implemented" : "deferred"})` : ""}
                </MenuItem>
              </Fragment>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }
  return (
    <button type="button" {...common} disabled={!enabled} onClick={() => runControl(env, control, ctx, ui)}>
      {body}
    </button>
  );
}

function Group({ group, ctx, mode, labels, tips, ui }: { group: RibbonGroup; ctx: RibbonCtx; mode: RibbonMode; labels: boolean; tips: Keytips; ui: RibbonProps["ui"]; tab: string }) {
  const tipOf = (c: RibbonControl) => (tips.mode === "controls" && c.keytip && c.keytip.startsWith(tips.buf) ? c.keytip : undefined);
  if (mode === "singleline") {
    return (
      <div className="rb-group" role="group" aria-label={group.label} style={{ padding: "0 4px" }}>
        <div className="rb-controls" style={{ alignItems: "center" }}>
          {group.controls.map((c) => (
            <Btn key={c.id} control={c} ctx={ctx} layout="compact" labels={labels && c.size === "large" && !!c.command} tip={tipOf(c)} ui={ui} />
          ))}
        </div>
      </div>
    );
  }
  // multi-line: large buttons side by side; runs of small ones stack three to a column
  const cols: RibbonControl[][] = [];
  for (const c of group.controls) {
    const last = cols[cols.length - 1];
    if (c.size === "small" && last && last[0].size === "small" && last.length < 3) last.push(c);
    else cols.push([c]);
  }
  return (
    <div className="rb-group" role="group" aria-label={group.label}>
      <div className="rb-controls">
        {cols.map((col, i) => (
          <div key={i} className="col">
            {col.map((c) => (
              <Btn key={c.id} control={c} ctx={ctx} layout={c.size === "small" ? "small" : "large"} labels tip={tipOf(c)} ui={ui} />
            ))}
          </div>
        ))}
      </div>
      <div className="rb-glabel">{group.label}</div>
    </div>
  );
}

export function Ribbon(p: RibbonProps) {
  const env = useEnv();
  const [peek, setPeek] = useState(false);
  const [wide, setWide] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeTab = useMemo(() => p.tabs.find((t) => t.id === p.active && !t.backstage) ?? p.tabs.find((t) => !t.backstage), [p.tabs, p.active]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 1500));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tips = useKeytips(
    p.tabs,
    activeTab?.id ?? "",
    (id) => p.onTab(id),
    (c) => runControl(env, c, p.ctx, p.ui),
    () => void env.run("app.showStart"),
  );

  const showBody = !p.collapsed || peek;
  const body = activeTab && (
    <div className="rb-body" role="toolbar" aria-label={`${activeTab.label} commands`} onClick={() => p.collapsed && setPeek(false)}>
      {activeTab.groups.map((g) => (
        <Group key={g.id} group={g} ctx={p.ctx} mode={p.mode} labels={wide} tips={tips} ui={p.ui} tab={activeTab.id} />
      ))}
    </div>
  );

  return (
    <div className={`ribbon ${p.mode} ${p.variant}`} ref={rootRef} data-testid="ribbon" aria-label="Ribbon">
      <div className="rb-tabs" role="tablist" aria-label="Ribbon tabs">
        {p.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className={`rb-tab${t.contextual ? " contextual" : ""}${t.backstage ? " file" : ""}`}
            aria-selected={!t.backstage && activeTab?.id === t.id}
            data-tab={t.id}
            onClick={() => {
              if (t.backstage) return void env.run("app.showStart");
              p.onTab(t.id);
              if (p.collapsed) setPeek(true);
            }}
          >
            {t.label}
            {tips.mode === "tabs" && t.keytip.startsWith(tips.buf) && <span className="keytip">{t.keytip}</span>}
          </button>
        ))}
        <button type="button" className="tb-btn rb-collapse" aria-label={p.collapsed ? "Expand the ribbon" : "Collapse the ribbon"} title={p.collapsed ? "Expand the ribbon" : "Collapse the ribbon"} onClick={() => { setPeek(false); p.onToggleCollapsed(); }} style={{ color: "inherit" }}>
          {p.collapsed ? <UI_ICONS.down /> : <UI_ICONS.up />}
        </button>
      </div>
      {showBody && !p.collapsed && body}
      {p.collapsed && peek && <div className="rb-peek">{body}</div>}
    </div>
  );
}
