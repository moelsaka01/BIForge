import { Button } from "@fluentui/react-components";
import { MOBILE_MIN_HEIGHT, MOBILE_WIDTH, visualDisplayName } from "../../core/report/reportOps";
import type { PageModel } from "../../core/report/visualDoc";
import { visualType } from "../../core/report/visualTypes";
import { useReport } from "./reportContext";

/** The page as the phone layout shows it: only the visuals that are part of it, at their phone positions, on a phone-wide page. */
export function mobilePageOf(page: PageModel): PageModel {
  const placed = page.visuals.filter((v) => v.mobile).map((v) => ({ ...v, position: v.mobile!, parent: undefined }));
  const bottom = Math.max(0, ...placed.map((v) => v.position.y + v.position.height));
  return { ...page, width: MOBILE_WIDTH, height: Math.max(MOBILE_MIN_HEIGHT, bottom + 60), visuals: placed, groups: [], displayName: `${page.displayName} (phone layout)` };
}

/** The list next to the phone canvas: visuals of the page that are on it or can be added, and the layout tools. */
export function MobileLayoutPane({ page }: { page: PageModel }) {
  const c = useReport();
  const label = (v: PageModel["visuals"][number]) => visualDisplayName(v.json) ?? visualType(v.visualType)?.label ?? v.visualType;
  const candidates = page.visuals.filter((v) => !v.hidden);
  const onPhone = candidates.filter((v) => v.mobile);
  const off = candidates.filter((v) => !v.mobile);
  return (
    <div role="region" aria-label="Phone layout" style={{ width: 220, flex: "none", padding: 8, display: "flex", flexDirection: "column", gap: 8, borderRight: "1px solid #ddd", overflow: "auto", fontSize: 12 }}>
      <div style={{ fontWeight: 600 }}>Phone layout</div>
      <div style={{ opacity: 0.7 }}>The phone layout is separate from the page. Add visuals to it, then move and resize them on the phone canvas.</div>
      <div style={{ display: "flex", gap: 4 }}>
        <Button size="small" appearance="primary" onClick={() => c.dispatch("report.mobile.auto", { page: page.name })} disabled={c.readOnly}>
          Auto-create layout
        </Button>
        <Button size="small" onClick={() => c.dispatch("view.mobileLayout")}>
          Back to the page
        </Button>
      </div>
      <div style={{ fontWeight: 600 }}>On the phone ({onPhone.length})</div>
      {onPhone.length === 0 && <div style={{ opacity: 0.7 }}>No visual yet.</div>}
      {onPhone.map((v) => (
        <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button aria-label={`Select ${label(v)} on the phone`} onClick={() => c.dispatch("report.canvas.select", { names: [v.name] })} style={{ flex: 1, textAlign: "left", border: "none", background: c.snap.canvas.includes(v.name) ? "#e8f1fb" : "transparent", color: "inherit", cursor: "pointer", padding: "3px 4px", font: "inherit" }}>
            {label(v)}
          </button>
          <Button size="small" appearance="subtle" aria-label={`Remove ${label(v)} from the phone layout`} onClick={() => c.dispatch("report.mobile.remove", { page: page.name, visuals: [v.name] })} disabled={c.readOnly}>
            ✕
          </Button>
        </div>
      ))}
      <div style={{ fontWeight: 600 }}>Not on the phone ({off.length})</div>
      {off.map((v) => (
        <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ flex: 1 }}>{label(v)}</span>
          <Button size="small" aria-label={`Add ${label(v)} to the phone layout`} onClick={() => c.dispatch("report.mobile.place", { page: page.name, visual: v.name })} disabled={c.readOnly}>
            Add
          </Button>
        </div>
      ))}
    </div>
  );
}
