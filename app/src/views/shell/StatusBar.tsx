import type { Zoom } from "../../core/shell/shellStore";
import { useEnv } from "./ShellContext";

export interface StatusBarProps {
  text: string;
  /** Effective scale of the report page (shown as a percentage), or null when the view has no zoom. */
  scale: number | null;
  zoom: Zoom;
}

/** Bottom bar: where the user is (page, table) and the report zoom. */
export function StatusBar({ text, scale, zoom }: StatusBarProps) {
  const env = useEnv();
  const pct = scale === null ? null : Math.round(scale * 100);
  const set = (z: Zoom) => void env.run("view.zoom", { zoom: z });
  return (
    <footer className="statusbar" role="contentinfo">
      <span className="left" data-testid="status-text">
        {text}
      </span>
      {pct !== null && (
        <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" onClick={() => set(Math.max(0.2, Math.round(((scale ?? 1) - 0.1) * 10) / 10))}>
            −
          </button>
          <input type="range" aria-label="Zoom level" min={20} max={200} step={5} value={Math.min(200, Math.max(20, pct))} onChange={(e) => set(Number(e.target.value) / 100)} />
          <button type="button" aria-label="Zoom in" onClick={() => set(Math.min(2, Math.round(((scale ?? 1) + 0.1) * 10) / 10))}>
            +
          </button>
          <span style={{ width: 40, textAlign: "right" }} data-testid="zoom-percent">
            {pct}%
          </span>
          <button type="button" aria-label="Fit to page" title="Fit to page" aria-pressed={zoom === "fit"} onClick={() => set("fit")}>
            ⛶
          </button>
          <button type="button" aria-label="Fit to width" title="Fit to width" aria-pressed={zoom === "width"} onClick={() => set("width")}>
            ↔
          </button>
        </div>
      )}
    </footer>
  );
}
