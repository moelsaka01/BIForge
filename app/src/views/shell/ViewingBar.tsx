import { Button } from "@fluentui/react-components";
import type { ViewingInfo } from "../../core/session/session";
import { useDoc, useEnv } from "./ShellContext";

/** Replaces the ribbon while a shared report is open: who published it, which version, and the way out. */
export function ViewingBar({ viewing }: { viewing: ViewingInfo }) {
  const env = useEnv();
  const doc = useDoc();
  return (
    <section className="notice-bar viewing-bar" role="region" aria-label="Viewing mode" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "6px 12px" }}>
      <strong>Viewing mode</strong>
      <span>{viewing.reportName}</span>
      <span>version {viewing.version}</span>
      <span>
        published by {viewing.publisherName} (key {viewing.keyId})
      </span>
      <span>{viewing.access === "private" ? "private (encrypted)" : "public"}</span>
      <span>Read only: this copy cannot be changed or saved.</span>
      <details style={{ flex: "1 1 auto" }}>
        <summary>Data in this report</summary>
        <ul style={{ margin: "4px 0 0 18px" }}>
          {viewing.included.map((t) => (
            <li key={t.table}>{`${t.table}: ${t.columns.join(", ")}`}</li>
          ))}
        </ul>
      </details>
      {doc.viewChanged && (
        <Button size="small" onClick={() => void env.run("report.view.resetChanges")}>
          Reset view
        </Button>
      )}
      <Button size="small" onClick={() => void env.run("report.visuals.refresh")}>
        Refresh visuals
      </Button>
      <Button size="small" appearance="primary" onClick={() => void env.run("file.close")}>
        Close
      </Button>
    </section>
  );
}
