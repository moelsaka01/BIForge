import type { ShellKind } from "../../core/shell/settings";
import type { ViewId } from "../../core/shell/shellStore";
import { RIBBON_ICONS } from "./icons";
import { useEnv, useShellState } from "./ShellContext";

const ITEMS: { id: ViewId; label: string; icon: keyof typeof RIBBON_ICONS; caption?: string }[] = [
  { id: "report", label: "Report view", icon: "newVisual" },
  { id: "data", label: "Table view", icon: "table" },
  { id: "model", label: "Model view", icon: "relationships" },
  { id: "dax", label: "DAX query view", icon: "code", caption: "DAX" },
  { id: "tmdl", label: "TMDL view", icon: "text", caption: "TMDL" },
];

/** The left strip that switches between Report, Table, Model, DAX query and TMDL views. */
export function ViewSwitcher({ variant }: { variant: ShellKind }) {
  const env = useEnv();
  const { view } = useShellState();
  return (
    <nav className={`viewbar ${variant}`} aria-label="Views">
      {ITEMS.map((it) => {
        const Icon = RIBBON_ICONS[it.icon];
        const cmd = `view.${it.id}`;
        return (
          <button key={it.id} type="button" className="vb-btn" aria-label={it.label} title={it.label} aria-current={view === it.id ? "page" : undefined} disabled={!env.registry.isEnabled(cmd)} onClick={() => void env.run(cmd)}>
            <Icon aria-hidden />
            {it.caption && <span>{it.caption}</span>}
          </button>
        );
      })}
    </nav>
  );
}
