import { Input, Select, Switch } from "@fluentui/react-components";
import { lit } from "../../core/report/fields";
import { getGroupFormat, type GroupModel, type PageModel } from "../../core/report/visualDoc";
import { descendantNames } from "../../core/report/groups";
import { useReport } from "./reportContext";

const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 };

/** What a selected group offers: its name and layout, and the group's own formatting (background, lock aspect, alt text). */
export function GroupPane({ page, group }: { page: PageModel; group: GroupModel }) {
  const c = useReport();
  const members = descendantNames(page, group.name).length;
  const fmt = (object: string, prop: string, value: ReturnType<typeof lit.bool> | ReturnType<typeof lit.str> | ReturnType<typeof lit.num> | null) =>
    c.dispatch("report.group.format", { page: page.name, group: group.name, object, prop, value });
  const bgColor = getGroupFormat(group.json, "background", "color");
  const bgShow = getGroupFormat(group.json, "background", "show");
  const bgAlpha = getGroupFormat(group.json, "background", "transparency");
  const lock = getGroupFormat(group.json, "lockAspect", "show");
  const alt = getGroupFormat(group.json, "general", "altText");
  const disabled = c.readOnly;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8 }} aria-label="Group pane">
      <div style={{ fontWeight: 600 }}>Group: {group.displayName}</div>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{members} {members === 1 ? "item" : "items"} in this group. Click a member on the canvas to select it.</div>
      <label style={row}>
        Name
        <Input
          size="small"
          aria-label="Group name"
          defaultValue={group.displayName}
          key={group.name + group.displayName}
          disabled={disabled}
          onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== group.displayName && c.dispatch("report.group.rename", { page: page.name, group: group.name, name: e.currentTarget.value })}
        />
      </label>
      <label style={row}>
        Layout
        <Select size="small" aria-label="Group layout" value={group.mode} disabled={disabled} onChange={(_, d) => c.dispatch("report.group.setMode", { page: page.name, group: group.name, mode: d.value })}>
          <option value="ScaleMode">Scale members with the group</option>
          <option value="ScrollMode">Keep member sizes</option>
        </Select>
      </label>
      <Switch checked={bgShow?.t === "bool" ? bgShow.v : false} label="Background" disabled={disabled} onChange={(_, d) => fmt("background", "show", lit.bool(d.checked))} />
      <label style={row}>
        Background color
        <input type="color" aria-label="Background color" disabled={disabled} value={bgColor?.t === "string" && /^#[0-9a-f]{6}$/i.test(bgColor.v) ? bgColor.v : "#ffffff"} onChange={(e) => fmt("background", "color", lit.str(e.target.value))} />
      </label>
      <label style={row}>
        Background transparency (%)
        <Input size="small" type="number" aria-label="Background transparency" style={{ width: 80 }} disabled={disabled} value={bgAlpha?.t === "number" ? String(bgAlpha.v) : ""} min={0} max={100} onChange={(_, d) => (d.value === "" ? fmt("background", "transparency", null) : fmt("background", "transparency", lit.num(Math.min(100, Math.max(0, Number(d.value))))))} />
      </label>
      <Switch checked={lock?.t === "bool" ? lock.v : false} label="Lock aspect" disabled={disabled} onChange={(_, d) => fmt("lockAspect", "show", lit.bool(d.checked))} />
      <label style={row}>
        Alt text
        <Input size="small" aria-label="Alt text" disabled={disabled} defaultValue={alt?.t === "string" ? alt.v : ""} key={`${group.name}-${alt?.t === "string" ? alt.v : ""}`} onBlur={(e) => fmt("general", "altText", e.currentTarget.value === "" ? null : lit.str(e.currentTarget.value))} />
      </label>
    </div>
  );
}
