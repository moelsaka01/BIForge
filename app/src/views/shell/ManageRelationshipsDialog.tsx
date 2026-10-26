import { useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Select } from "@fluentui/react-components";
import { listRelationships } from "../../core/model/relationships";
import { useEnv } from "./ShellContext";

const cardText = (from: string, to: string) => `${from === "many" ? "*" : "1"}:${to === "many" ? "*" : "1"}`;

/** Manage relationships: every relationship of the model in one grid, with its cross-filter direction and activity, plus New and Autodetect. */
export function ManageRelationshipsDialog() {
  const env = useEnv();
  const close = () => env.session.shell.closeDialog();
  useSyncExternalStore(env.session.store.subscribe, env.session.store.getSnapshot);
  const project = env.session.store.project;
  const rels = project ? listRelationships(project) : [];
  const [note, setNote] = useState<string | null>(null);
  const run = async (id: string, args?: unknown) => {
    const r = await env.registry.execute(id, args);
    if (!r.ok) setNote(r.message);
    return r.ok;
  };
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface aria-label="Manage relationships" style={{ maxWidth: 820, width: "90vw" }}>
        <DialogBody>
          <DialogTitle>Manage relationships</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th>Active</th>
                  <th>From (table[column])</th>
                  <th>To (table[column])</th>
                  <th>Cardinality</th>
                  <th>Cross-filter</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rels.map((r) => (
                  <tr key={r.id} data-relationship={r.id}>
                    <td>
                      <Checkbox aria-label={`Active: ${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}]`} checked={r.isActive} onChange={(_, d) => void run("model.updateRelationship", { id: r.id, patch: { isActive: !!d.checked } })} />
                    </td>
                    <td>{r.fromTable}[{r.fromColumn}]</td>
                    <td>{r.toTable}[{r.toColumn}]</td>
                    <td>{cardText(r.fromCardinality, r.toCardinality)}</td>
                    <td>
                      <Select
                        size="small"
                        aria-label={`Cross-filter: ${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}]`}
                        value={r.crossFilter}
                        disabled={r.fromCardinality === "one" && r.toCardinality === "one"}
                        onChange={(_, d) => void run("model.updateRelationship", { id: r.id, patch: { crossFilter: d.value as "single" | "both" } })}
                      >
                        <option value="single">Single</option>
                        <option value="both">Both</option>
                      </Select>
                    </td>
                    <td>
                      <Button size="small" appearance="subtle" aria-label={`Delete: ${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}]`} onClick={() => void run("model.deleteRelationship", { id: r.id })}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
                {rels.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ opacity: 0.7, padding: 6 }}>
                      The model has no relationships yet. Create one, or let BIForge look for columns that carry the same key.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {note && <div role="status">{note}</div>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => void run("model.newRelationshipDialog")}>New…</Button>
            <Button onClick={async () => void (await run("model.autodetectRelationships"))}>Autodetect</Button>
            <Button appearance="primary" onClick={close}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
