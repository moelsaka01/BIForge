import { useEffect, useMemo, useState } from "react";
import { Button, Textarea } from "@fluentui/react-components";
import type { Loaded } from "../../core/report/dataLoader";
import { datasetCsv, DEFAULT_SCRIPTS, scriptSettings } from "../../core/report/scriptVisual";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

/**
 * R script visual / Python visual. The script is part of the report, so it never runs by itself: the person presses Run
 * (or Run again after a change). It runs with their own Python or R and sees the data of the visual as `dataset`.
 */
export function ScriptVisualView({ page, visual, loaded, width, height }: { page: PageModel; visual: VisualModel; loaded: Extract<Loaded, { kind: "grouped" }>; width: number; height: number }) {
  const c = useReport();
  const s = useMemo(() => scriptSettings(visual), [visual]);
  const run = c.snap.scripts?.[visual.name];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.source);
  useEffect(() => setDraft(s.source), [s.source]);
  const label = s.provider; // script > provider: what the script is called
  const save = (source: string) => c.dispatch("report.format.set", { page: page.name, visual: visual.name, object: "script", prop: "source", value: { t: "string", v: source } });
  const start = () =>
    c.dispatch("report.script.run", { visual: visual.name, language: s.language, code: s.source || DEFAULT_SCRIPTS[s.language], csv: datasetCsv(loaded, c.theme), width: Math.round(width), height: Math.round(height - 34) });
  const hasScript = s.source.trim() !== "";
  return (
    <div data-testid="script-visual" style={{ width, height, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 4, padding: 4, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {!c.readOnly && (
          <Button size="small" aria-label={`Edit the ${label} script`} onClick={() => setEditing(!editing)}>
            {editing ? "Close editor" : "Edit script"}
          </Button>
        )}
        <Button size="small" appearance="primary" aria-label={`Run the ${label} script`} disabled={run?.status === "running" || (!hasScript && c.readOnly)} onClick={start}>
          {run?.status === "running" ? "Running…" : run?.image ? "Run again" : "Run script"}
        </Button>
        <span style={{ fontSize: 11, opacity: 0.7 }}>Runs your own {label} on this computer with the data of the visual as `dataset`.</span>
      </div>
      {editing && !c.readOnly && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Textarea aria-label={`${label} script`} resize="vertical" rows={7} value={draft || (hasScript ? "" : DEFAULT_SCRIPTS[s.language])} onChange={(_, d) => setDraft(d.value)} style={{ fontFamily: "Consolas, monospace", fontSize: 12 }} />
          <div style={{ display: "flex", gap: 4 }}>
            <Button size="small" appearance="primary" onClick={() => save(draft || DEFAULT_SCRIPTS[s.language])}>
              Save script
            </Button>
          </div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {run?.status === "error" && (
          <div role="alert" data-testid="script-error" style={{ color: "#c50f1f", fontSize: 12, padding: 6, overflow: "auto", maxHeight: "100%" }}>
            {run.error}
          </div>
        )}
        {run?.image && run.status !== "error" && <img data-testid="script-plot" alt={`${label} plot`} src={run.image} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
        {!run && (
          <div style={{ fontSize: 12, opacity: 0.7, padding: 8 }} data-testid="script-idle">
            {hasScript ? "The script has not run in this window. Press Run script." : "No script yet. Press Edit script to write one."}
          </div>
        )}
      </div>
    </div>
  );
}
