import { useEffect, useState } from "react";
import { Button, Checkbox, Input } from "@fluentui/react-components";
import { fieldLabel } from "../../core/report/fields";
import { syncGroupOf } from "../../core/report/reportOps";
import { visualType } from "../../core/report/visualTypes";
import { useReport } from "./reportContext";

/** Sync slicers pane: which pages a slicer is on and where it is shown. */
export function SyncSlicersPane() {
  const c = useReport();
  const page = c.pages.find((p) => p.name === c.snap.page) ?? c.pages[0];
  const slicer = page?.visuals.find((v) => v.name === c.snap.canvas.at(-1) && visualType(v.visualType)?.family === "slicer") ?? null;
  const current = slicer ? syncGroupOf(slicer.json) : null;
  const field = slicer?.roles.Values?.[0]?.field;
  const [group, setGroup] = useState("");
  const [rows, setRows] = useState<Record<string, { sync: boolean; visible: boolean }>>({});
  useEffect(() => {
    if (!slicer || !page) return;
    setGroup(current ?? (field ? fieldLabel(field) : ""));
    setRows(
      Object.fromEntries(
        c.pages.map((p) => {
          const mate = p.name === page.name ? slicer : p.visuals.find((v) => visualType(v.visualType)?.family === "slicer" && current !== null && syncGroupOf(v.json) === current);
          return [p.name, { sync: !!mate, visible: mate ? !mate.hidden : true }];
        }),
      ),
    );
  }, [slicer?.name, page?.name, current, c.pages]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!page || !slicer) return <div style={{ padding: 8, fontSize: 12 }} aria-label="Sync slicers pane">Select a slicer on the page to choose the pages it is synced with.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8, overflow: "auto" }} aria-label="Sync slicers pane">
      <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
        Group name
        <Input size="small" aria-label="Sync group name" value={group} onChange={(_, d) => setGroup(d.value)} />
      </label>
      <table style={{ fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Page</th>
            <th>Sync</th>
            <th>Visible</th>
          </tr>
        </thead>
        <tbody>
          {c.pages.filter((p) => !p.type).map((p) => (
            <tr key={p.name}>
              <td>{p.displayName}</td>
              <td style={{ textAlign: "center" }}>
                <Checkbox aria-label={`Sync on ${p.displayName}`} checked={rows[p.name]?.sync ?? false} disabled={p.name === page.name || c.readOnly} onChange={(_, d) => setRows({ ...rows, [p.name]: { ...(rows[p.name] ?? { visible: true }), sync: d.checked === true } })} />
              </td>
              <td style={{ textAlign: "center" }}>
                <Checkbox aria-label={`Visible on ${p.displayName}`} checked={rows[p.name]?.visible ?? true} disabled={p.name === page.name || !(rows[p.name]?.sync ?? false) || c.readOnly} onChange={(_, d) => setRows({ ...rows, [p.name]: { ...(rows[p.name] ?? { sync: true }), visible: d.checked === true } })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="small" appearance="primary" disabled={group.trim() === "" || c.readOnly} onClick={() => c.dispatch("report.slicer.setSync", { page: page.name, visual: slicer.name, group: group.trim(), pages: c.pages.map((p) => ({ page: p.name, sync: rows[p.name]?.sync ?? false, visible: rows[p.name]?.visible ?? true })) })}>
          Apply
        </Button>
        <Button size="small" disabled={current === null || c.readOnly} onClick={() => c.dispatch("report.slicer.setSync", { page: page.name, visual: slicer.name, group: null, pages: [] })}>
          Stop syncing
        </Button>
      </div>
    </div>
  );
}
