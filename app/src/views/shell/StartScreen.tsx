import { useMemo, useState } from "react";
import type { ShellKind } from "../../core/shell/settings";
import { RIBBON_ICONS, UI_ICONS } from "./icons";
import { useDoc, useEnv, useSettings, useShellState } from "./ShellContext";

export type RecentFilter = "all" | "week" | "older";
const DAY = 24 * 3600 * 1000;

/** Tips shown in the Recommended carousel. Plain text about what this app does today. */
export const TIPS: { title: string; text: string }[] = [
  { title: "Bring in data", text: "Get data loads CSV, Excel, JSON, Parquet, SQLite and PostgreSQL tables into the project's local data store. Refresh reloads them." },
  { title: "Build a report", text: "Pick a visual type in the Visualizations pane, then tick fields in the Data pane. Click a data point to cross-filter the other visuals." },
  { title: "Write a measure", text: "New measure opens the DAX editor with completions and error checking. Evaluate it, also split by a column, before you add it to the model." },
  { title: "Shape data with Power Query", text: "Transform data opens the query editor: applied steps, a preview of each step, and the M code behind them." },
  { title: "Open it elsewhere", text: "Projects are PBIP folders (TMDL model, PBIR report), so the same files can be opened in Power BI Desktop." },
];

function formatWhen(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

interface NavItem {
  id: string;
  label: string;
  icon: keyof typeof RIBBON_ICONS;
  command?: string;
  indent?: boolean;
}

function navItems(hasDoc: boolean): { top: NavItem[]; bottom: NavItem[] } {
  const top: NavItem[] = [
    { id: "home", label: "Home", icon: "home" },
    { id: "new", label: "New", icon: "newVisual", command: "file.newBlank" },
    { id: "open", label: "Open", icon: "open", command: "file.open" },
    { id: "openShared", label: "Open shared report", icon: "open", command: "package.open" },
    { id: "host", label: "Host and collaborate", icon: "export", command: "host.open" },
    { id: "joinServer", label: "Join a server", icon: "open", command: "server.join" },
  ];
  // the File menu of the original: New, Open, Save, Save as, Get data, Import, Export, Options and settings, About, Exit
  if (hasDoc) {
    top.push(
      { id: "save", label: "Save", icon: "save", command: "file.save", indent: true },
      { id: "saveAs", label: "Save as", icon: "save", command: "file.saveAs", indent: true },
      { id: "getData", label: "Get data", icon: "database", command: "data.getData", indent: true },
      { id: "import", label: "Import", icon: "import", command: "file.importMenu", indent: true },
      { id: "export", label: "Export", icon: "export", command: "file.exportMenu", indent: true },
      { id: "publish", label: "Publish & Share", icon: "export", command: "publish.open", indent: true },
      { id: "close", label: "Close project", icon: "close", command: "file.close", indent: true },
    );
  }
  const bottom: NavItem[] = [
    { id: "options", label: "Options and settings", icon: "options", command: "app.options" },
    { id: "about", label: "About", icon: "about", command: "app.about" },
    { id: "exit", label: "Exit", icon: "close", command: "app.exit" },
  ];
  return { top, bottom };
}

/** The start screen. With a project open it is the File backstage (same page, plus the document commands). */
export function StartScreen({ variant }: { variant: ShellKind }) {
  const env = useEnv();
  const doc = useDoc();
  const settings = useSettings();
  const hasDoc = doc.project !== null;
  const [newOpen, setNewOpen] = useState(true);
  const [recoOpen, setRecoOpen] = useState(true);
  const [tip, setTip] = useState(0);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<RecentFilter>("all");
  const nav = navItems(hasDoc);
  const showReco = settings.options["interface.showRecommended"] !== false;

  const recent = useMemo(() => {
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    // pinned entries first, each group in the order of the list
    const ordered = [...settings.recent.filter((r) => r.pinned), ...settings.recent.filter((r) => !r.pinned)];
    return ordered.filter((r) => {
      if (needle && !r.name.toLowerCase().includes(needle) && !r.path.toLowerCase().includes(needle)) return false;
      if (filter === "week") return now - r.openedAt <= 7 * DAY;
      if (filter === "older") return now - r.openedAt > 7 * DAY;
      return true;
    });
  }, [settings.recent, q, filter]);

  const navBtn = (it: NavItem) => {
    const Icon = RIBBON_ICONS[it.icon];
    const enabled = it.command ? env.registry.isEnabled(it.command) : it.id === "home";
    return (
      <button
        key={it.id}
        type="button"
        className={`sn-item${it.indent ? " indent" : ""}`}
        aria-current={it.id === "home" ? "page" : undefined}
        disabled={!enabled}
        onClick={() => it.command && void env.run(it.command)}
      >
        {!it.indent && <Icon aria-hidden />}
        {it.label}
      </button>
    );
  };

  const card = (id: string, label: string, icon: keyof typeof RIBBON_ICONS, command: string, args?: unknown) => {
    const Icon = RIBBON_ICONS[icon];
    return (
      <button key={id} type="button" className="card" data-card={id} disabled={!env.registry.isEnabled(command)} title={label} onClick={() => void env.run(command, args)}>
        <Icon aria-hidden />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <div className="start" data-testid="start-screen">
      <nav className={`start-nav ${variant}`} aria-label="Start">
        {hasDoc && (
          <button type="button" className="sn-item" aria-label="Back to the report" title="Back to the report" onClick={() => void env.run("app.backToDocument")} style={{ height: 44 }}>
            <UI_ICONS.back aria-hidden />
          </button>
        )}
        {nav.top.map(navBtn)}
        <div className="sn-grow" />
        <div className="sn-sep" />
        {nav.bottom.map(navBtn)}
      </nav>
      <main className="start-main">
        {env.error && (
          <div className="notice-bar error" role="alert" style={{ margin: "0 0 8px" }}>
            {env.error}
            <button type="button" className="link-btn" onClick={() => env.setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        <h2>
          <button type="button" aria-label={newOpen ? "Collapse" : "Expand"} aria-expanded={newOpen} onClick={() => setNewOpen(!newOpen)}>
            {newOpen ? <UI_ICONS.down aria-hidden /> : <UI_ICONS.up aria-hidden />}
          </button>
          Select a data source or start with a blank report
        </h2>
        {newOpen && (
          <div className="cards" role="group" aria-label="New">
            {card("blank", "Blank report", "newVisual", "file.newBlank")}
            {card("excel", "Excel workbook", "excel", "data.getData", { source: "excel" })}
            {card("sql", "SQL Server", "sql", "data.getData", { source: "sqlserver" })}
            {card("sample", "Learn with sample data", "text", "file.newSample")}
            {card("other", "Get data from other sources", "database", "data.getData")}
          </div>
        )}

        {showReco && (
          <h2 style={{ marginTop: 26 }}>
            <button type="button" aria-label={recoOpen ? "Collapse recommended" : "Expand recommended"} aria-expanded={recoOpen} onClick={() => setRecoOpen(!recoOpen)}>
              {recoOpen ? <UI_ICONS.down aria-hidden /> : <UI_ICONS.up aria-hidden />}
            </button>
            Recommended
          </h2>
        )}
        {recoOpen && showReco && (
          <div className="reco" aria-label="Recommended">
            <div className="reco-nav">
              <button type="button" className="tb-btn" style={{ color: "inherit" }} aria-label="Previous tip" disabled={tip === 0} onClick={() => setTip(tip - 1)}>
                <UI_ICONS.back aria-hidden />
              </button>
              <button type="button" className="tb-btn" style={{ color: "inherit" }} aria-label="Next tip" disabled={tip >= TIPS.length - 2} onClick={() => setTip(tip + 1)}>
                <UI_ICONS.back aria-hidden style={{ transform: "rotate(180deg)" }} />
              </button>
            </div>
            {TIPS.slice(tip, tip + 2).map((t) => (
              <article key={t.title} className="reco-card">
                <small style={{ opacity: 0.7 }}>Getting started</small>
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </article>
            ))}
          </div>
        )}

        <div className="start-tabs" role="tablist" aria-label="Projects">
          <button type="button" role="tab" className="pill" aria-selected>
            <RIBBON_ICONS.recent aria-hidden width={18} height={18} /> Recent
          </button>
          <div className="start-filters">
            <input type="search" aria-label="Filter by keyword" placeholder="Filter by keyword" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as RecentFilter)}>
              <option value="all">Filter: all</option>
              <option value="week">Opened in the last 7 days</option>
              <option value="older">Opened earlier</option>
            </select>
          </div>
        </div>

        {recent.length === 0 ? (
          <div className="empty-note" role="status">
            {settings.recent.length === 0 ? "No recent projects yet. Create a blank report or open a project." : "No recent project matches the filter."}
          </div>
        ) : (
          <table className="recent-table" aria-label="Recent projects">
            <thead>
              <tr>
                <th style={{ width: "26%" }}>Name</th>
                <th>Location</th>
                <th style={{ width: 190 }}>Opened</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.path} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && void env.run("file.open", { path: r.path })}>
                  <td>
                    <button type="button" className="link-btn" title={`Open ${r.name}`} onClick={() => void env.run("file.open", { path: r.path })}>
                      {r.pinned ? "📌 " : ""}
                      {r.name}
                    </button>
                  </td>
                  <td title={r.path}>{r.path}</td>
                  <td>{formatWhen(r.openedAt)}</td>
                  <td>
                    <button type="button" className="link-btn" aria-label={`${r.pinned ? "Unpin" : "Pin"} ${r.name}`} aria-pressed={!!r.pinned} onClick={() => void env.run("app.recent.pin", { path: r.path, pinned: !r.pinned })}>
                      {r.pinned ? "Unpin" : "Pin"}
                    </button>{" "}
                    <button type="button" className="link-btn" aria-label={`Remove ${r.name} from the list`} onClick={() => void env.run("app.recent.remove", { path: r.path })}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
