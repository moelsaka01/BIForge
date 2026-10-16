import { useState } from "react";
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Tab, TabList } from "@fluentui/react-components";
import { itemState, RIBBON, type RibbonContext, type RibbonItem } from "../../core/queries/ribbon";

export interface RibbonProps {
  ctx: RibbonContext;
  onItem(item: RibbonItem): void;
  /** Ids of toggle buttons that are on (Query Settings, Formula Bar). */
  on?: Set<string>;
}

/** The editor's ribbon: tabs, groups and buttons from core/queries/ribbon.ts. Buttons that are not implemented stay visible but disabled. */
export function Ribbon({ ctx, onItem, on }: RibbonProps) {
  const [tab, setTab] = useState("home");
  const current = RIBBON.find((t) => t.id === tab) ?? RIBBON[0];

  const button = (item: RibbonItem) => {
    const st = itemState(item, ctx);
    const title = st.enabled ? (item.tip ?? item.label) : `${item.label} — ${st.reason}`;
    const pressed = on?.has(item.id);
    if (item.menu) {
      return (
        <Menu key={item.id}>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" disabled={!st.enabled} title={title}>
              {item.label} ▾
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {item.menu.map((m) => {
                const ms = itemState(m, ctx);
                return (
                  <MenuItem key={m.id} disabled={!ms.enabled} title={ms.enabled ? m.label : `${m.label} — ${ms.reason}`} onClick={() => onItem(m)}>
                    {m.label}
                    {m.notImplemented ? " (not implemented)" : ""}
                  </MenuItem>
                );
              })}
            </MenuList>
          </MenuPopover>
        </Menu>
      );
    }
    return (
      <Button key={item.id} size="small" appearance={pressed ? "primary" : "secondary"} disabled={!st.enabled} title={title} aria-pressed={pressed} onClick={() => onItem(item)}>
        {item.label}
        {item.notImplemented ? " ⚠" : ""}
      </Button>
    );
  };

  return (
    <div role="region" aria-label="Ribbon" style={{ borderBottom: "1px solid #d1d1d1", background: "#faf9f8" }}>
      <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(String(d.value))}>
        {RIBBON.map((t) => (
          <Tab key={t.id} value={t.id}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <div style={{ display: "flex", gap: 14, padding: "4px 8px 6px", flexWrap: "wrap" }}>
        {current.groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label} style={{ display: "grid", gap: 3, borderRight: "1px solid #e1dfdd", paddingRight: 12 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{g.items.map(button)}</div>
            <div style={{ fontSize: 11, color: "#605e5c", textAlign: "center" }}>{g.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
