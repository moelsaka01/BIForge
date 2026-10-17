import { useEffect, useState } from "react";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Button, Input, Select, Switch, Tab, TabList } from "@fluentui/react-components";
import { fieldKey, fieldLabel, lit, type FieldRef, type Lit } from "../../core/report/fields";
import { analyticsCards, generalCards, visualCards, type CardContext, type CardDef, type PropDef } from "../../core/report/formatSchema";
import { listBookmarks } from "../../core/report/bookmarks";
import { readTextbox } from "../../core/report/staticVisuals";
import { litExpr, queryRefOf } from "../../core/report/pbir";
import { getFormat, getRawProp, type PageModel, type VisualModel } from "../../core/report/visualDoc";
import { visualType } from "../../core/report/visualTypes";
import { condFormatFromPbir } from "../../core/report/condFormat";
import { CondFormatDialog } from "./CondFormatDialog";
import { useReport, type Dispatch } from "./reportContext";

export interface FormatPaneProps {
  /** The Analytics tab of the Visualizations pane: reference lines and trend line instead of the format cards. */
  analytics?: boolean;
  bookmarks?: { id: string; name: string }[];
  page: PageModel;
  visual: VisualModel;
  pages: PageModel[];
  dispatch: Dispatch;
}

const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 };

/** Shown next to a setting no renderer of this visual reads yet: it is saved in the report, but the visual does not change. */
function NotDrawn({ def }: { def: PropDef }) {
  if (def.drawn !== false) return null;
  return (
    <span title="Saved in the report. BIForge does not draw this setting yet." aria-label="not drawn yet" style={{ fontSize: 10, opacity: 0.55, marginLeft: 4 }}>
      (not drawn yet)
    </span>
  );
}

function PropControl({ def, value, onChange }: { def: PropDef; value: Lit | null; onChange(v: Lit | null): void }) {
  const label = def.label;
  const id = `fmt-${def.key}`;
  const name = (
    <span>
      {label}
      <NotDrawn def={def} />
    </span>
  );
  switch (def.type) {
    case "bool": {
      const on = value?.t === "bool" ? value.v : (def.default as boolean | undefined) ?? false;
      return <Switch checked={on} label={{ children: name }} aria-label={label} onChange={(_, d) => onChange(lit.bool(d.checked))} />;
    }
    case "number":
      return (
        <label htmlFor={id} style={rowStyle}>
          {name}
          <Input
            id={id}
            aria-label={label}
            size="small"
            type="number"
            style={{ width: 90 }}
            min={def.min}
            max={def.max}
            placeholder={def.auto ?? (def.default !== undefined ? String(def.default) : "")}
            value={value?.t === "number" ? String(value.v) : ""}
            onChange={(_, d) => {
              if (d.value === "") return onChange(null);
              let n = Number(d.value);
              if (!Number.isFinite(n)) return;
              if (def.integer) n = Math.round(n);
              onChange(lit.num(Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n))));
            }}
          />
        </label>
      );
    case "text":
      return (
        <label htmlFor={id} style={rowStyle}>
          {name}
          <Input
            id={id}
            aria-label={label}
            size="small"
            style={{ width: 140 }}
            placeholder={def.auto}
            list={def.suggest ? `${id}-list` : undefined}
            value={value?.t === "string" ? value.v : ""}
            onChange={(_, d) => onChange(d.value === "" ? null : lit.str(d.value))}
          />
          {def.suggest && (
            <datalist id={`${id}-list`}>
              {def.suggest.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          )}
        </label>
      );
    case "color": {
      const v = value?.t === "string" ? value.v : "";
      return (
        <label htmlFor={id} style={rowStyle}>
          {name}
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input id={id} type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#888888"} onChange={(e) => onChange(lit.str(e.target.value))} aria-label={label} />
            <Button size="small" appearance="subtle" disabled={!v} onClick={() => onChange(null)} aria-label={`Reset ${label}`}>
              Reset
            </Button>
          </span>
        </label>
      );
    }
    case "enum": {
      const cur = value ? String(value.t === "string" || value.t === "number" ? value.v : "") : "";
      return (
        <label htmlFor={id} style={rowStyle}>
          {name}
          <Select
            id={id}
            aria-label={label}
            size="small"
            style={{ width: 150 }}
            value={cur || (def.default !== undefined ? String(def.default) : "")}
            onChange={(_, d) => onChange(d.value === "" ? null : def.numeric ? lit.num(Number(d.value)) : lit.str(d.value))}
          >
            {def.default === undefined && <option value="">{def.auto ?? "Automatic"}</option>}
            {def.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
      );
    }
  }
}

/** Content and style of a text box (the paragraphs are PBIR text runs, so a plain card cannot edit them). */
function TextboxEditor({ page, visual, dispatch }: { page: PageModel; visual: VisualModel; dispatch: Dispatch }) {
  const m = readTextbox(visual.json);
  const set = (patch: object) => dispatch("report.textbox.set", { page: page.name, visual: visual.name, patch });
  const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ ...row, flexDirection: "column", alignItems: "stretch" }}>
        Text
        <textarea aria-label="Text box content" rows={4} defaultValue={m.text} key={visual.name + m.text} onBlur={(e) => e.currentTarget.value !== m.text && set({ text: e.currentTarget.value })} style={{ font: "inherit", resize: "vertical" }} />
      </label>
      <label style={row}>
        Text size
        <Input size="small" type="number" style={{ width: 90 }} value={String(m.fontSize)} onChange={(_, d) => Number(d.value) >= 6 && Number(d.value) <= 120 && set({ fontSize: Number(d.value) })} />
      </label>
      <Switch checked={m.bold} label="Bold" onChange={(_, d) => set({ bold: d.checked })} />
      <Switch checked={m.italic} label="Italic" onChange={(_, d) => set({ italic: d.checked })} />
      <Switch checked={m.underline} label="Underline" onChange={(_, d) => set({ underline: d.checked })} />
      <label style={row}>
        Alignment
        <Select size="small" style={{ width: 150 }} aria-label="Text alignment" value={m.align} onChange={(_, d) => set({ align: d.value })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </Select>
      </label>
      <label style={row}>
        Text color
        <input type="color" aria-label="Text color" value={m.color && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : "#252423"} onChange={(e) => set({ color: e.target.value })} />
      </label>
    </div>
  );
}

/** The default data bars of a column: the structure of the report format (colors are fills, the two switches are literals). */
function dataBarsNode() {
  return {
    positiveColor: { solid: { color: litExpr(lit.str("#6aa9e9")) } },
    reverseDirection: litExpr(lit.bool(false)),
    hideText: litExpr(lit.bool(false)),
  };
}

export function FormatPane(p: FormatPaneProps) {
  const [tab, setTab] = useState<"visual" | "general">("visual");
  const [q, setQ] = useState("");
  const [cond, setCond] = useState<{ title: string; object: string; prop: string; selector?: string; allowFieldValue: boolean } | null>(null);
  const [colField, setColField] = useState(0);
  const rc = useReport();
  const focus = rc.snap.formatFocus && rc.snap.formatFocus.visual === p.visual.name ? rc.snap.formatFocus : null;
  const generalIds = generalCards(p.visual.visualType).map((x) => x.id);
  const [open, setOpen] = useState<string[] | null>(null);
  // On-object formatting asks for a card: show the tab that has it, open it and scroll to it
  useEffect(() => {
    if (!focus) return;
    const inVisual = visualCards(p.visual.visualType, undefined).some((x) => x.id === focus.card);
    setTab(inVisual ? "visual" : generalIds.includes(focus.card) ? "general" : "visual");
    setQ("");
    setOpen([focus.card]);
    const t = setTimeout(() => document.querySelector(`[data-card="${focus.card}"]`)?.scrollIntoView?.({ block: "nearest" }), 0);
    return () => clearTimeout(t);
  }, [focus?.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = visualType(p.visual.visualType);
  const needle = q.trim().toLowerCase();
  const ctx: CardContext = {
    pages: p.pages.filter((x) => !x.type).map((x) => ({ name: x.name, displayName: x.displayName })),
    tooltipPages: p.pages.filter((x) => x.type === "Tooltip").map((x) => ({ name: x.name, displayName: x.displayName })),
    bookmarks: listBookmarks(rc.project).map((b) => ({ id: b.id, name: b.name })),
  };
  const cards: CardDef[] = p.analytics ? analyticsCards(p.visual.visualType, ctx) : tab === "visual" ? visualCards(p.visual.visualType, ctx) : generalCards(p.visual.visualType, ctx);
  const shown = cards
    .map((c) => ({ ...c, props: c.label.toLowerCase().includes(needle) ? c.props : c.props.filter((x) => x.label.toLowerCase().includes(needle)) }))
    .filter((c) => needle === "" || c.props.length > 0);

  const set = (object: string, prop: string, value: Lit | null, selector?: string, fixed?: CardDef["fixed"]) =>
    p.dispatch("report.format.set", { page: p.page.name, visual: p.visual.name, object, prop, value, selector, fixed });
  const valueFields: FieldRef[] = Object.values(p.visual.roles)
    .flat()
    .map((x) => x.field)
    .filter((f) => f.kind !== "column");
  const tableFields: FieldRef[] = (p.visual.roles.Values ?? []).map((x) => x.field);
  const fam = type?.family;
  const colFieldDef = tableFields[Math.min(colField, tableFields.length - 1)];

  const condEntry = (title: string, object: string, prop: string, selector?: string, allowFieldValue = false) => {
    const node = getRawProp(p.visual.json, object, prop, selector);
    const has = !!node && condFormatFromPbir(node) !== null;
    return (
      <Button size="small" key={title} onClick={() => setCond({ title, object, prop, selector, allowFieldValue })} aria-label={title}>
        {title}
        {has ? " ✓" : "…"}
      </Button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, height: "100%", overflow: "auto" }} aria-label="Format pane">
      {!p.analytics && (
        <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="visual">Visual</Tab>
          <Tab value="general">General</Tab>
        </TabList>
      )}
      <Input size="small" placeholder="Search" aria-label="Search the Format pane" value={q} onChange={(_, d) => setQ(d.value)} />
      <Accordion
        multiple
        collapsible
        {...(open ? { openItems: open, onToggle: (_: unknown, d: { openItems: unknown[] }) => setOpen(d.openItems as string[]) } : { defaultOpenItems: [...(type?.family === "textbox" ? ["textContent"] : type?.family === "image" ? ["imageSource"] : []), ...shown.slice(0, 2).map((c) => c.id)] })}
        key={`${tab}-${p.visual.name}-${needle}-${open ? "c" : "u"}`}
      >
        {tab === "visual" && type?.family === "textbox" && needle === "" && (
          <AccordionItem value="textContent" data-card="textContent">
            <AccordionHeader size="small">Text</AccordionHeader>
            <AccordionPanel>
              <TextboxEditor page={p.page} visual={p.visual} dispatch={p.dispatch} />
            </AccordionPanel>
          </AccordionItem>
        )}
        {tab === "visual" && type?.family === "image" && needle === "" && (
          <AccordionItem value="imageSource" data-card="imageSource">
            <AccordionHeader size="small">Picture</AccordionHeader>
            <AccordionPanel>
              <Button size="small" onClick={() => p.dispatch("report.image.choose", { page: p.page.name, visual: p.visual.name })}>
                Choose a picture…
              </Button>
            </AccordionPanel>
          </AccordionItem>
        )}
        {shown.map((c) => (
          <AccordionItem key={c.id} value={c.id} data-card={c.id}>
            <AccordionHeader size="small">{c.label}</AccordionHeader>
            <AccordionPanel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {c.props.map((d, i) => {
                  const sel = c.instance ? `id:${c.instance}` : undefined;
                  return (
                    <div key={d.key} style={{ display: "contents" }}>
                      {d.group && d.group !== c.props[i - 1]?.group && <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, marginTop: 4 }}>{d.group}</div>}
                      <PropControl def={d} value={getFormat(p.visual.json, c.object, d.key, sel)} onChange={(v) => set(c.object, d.key, v, sel, c.fixed)} />
                    </div>
                  );
                })}
                {tab === "visual" && c.id === "dataPoint" && (
                  <>
                    {valueFields.map((f) => (
                      <PropControl
                        key={fieldKey(f)}
                        def={{ key: "fill", label: `Color: ${fieldLabel(f)}`, type: "color" }}
                        value={getFormat(p.visual.json, "dataPoint", "fill", fieldLabel(f))}
                        onChange={(v) => set("dataPoint", "fill", v, fieldLabel(f))}
                      />
                    ))}
                    {valueFields.length > 0 && condEntry("Column color by rules (fx)", "dataPoint", "fill")}
                  </>
                )}
                {tab === "visual" && c.id === "labels" && fam === "card" && valueFields.length > 0 && condEntry("Value color by rules (fx)", "labels", "color")}
                {tab === "visual" && (fam === "table" || fam === "matrix") && c.id === "values" && tableFields.length > 0 && colFieldDef && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid #ddd", paddingTop: 6 }}>
                    <Select size="small" aria-label="Column to format" value={String(Math.min(colField, tableFields.length - 1))} onChange={(_, d) => setColField(Number(d.value))}>
                      {tableFields.map((f, i) => (
                        <option key={fieldKey(f)} value={i}>
                          {fieldLabel(f)}
                        </option>
                      ))}
                    </Select>
                    <PropControl def={{ key: "backColor", label: "Background color", type: "color" }} value={getFormat(p.visual.json, "columnFormatting", "backColor", queryRefOf(colFieldDef))} onChange={(v) => set("columnFormatting", "backColor", v, queryRefOf(colFieldDef))} />
                    {condEntry("Background by rules (fx)", "values", "backColor", queryRefOf(colFieldDef), colFieldDef.kind === "measure")}
                    <PropControl def={{ key: "fontColor", label: "Font color", type: "color" }} value={getFormat(p.visual.json, "columnFormatting", "fontColor", queryRefOf(colFieldDef))} onChange={(v) => set("columnFormatting", "fontColor", v, queryRefOf(colFieldDef))} />
                    {condEntry("Font color by rules (fx)", "values", "fontColor", queryRefOf(colFieldDef), colFieldDef.kind === "measure")}
                    {colFieldDef.kind !== "column" && (
                      <Switch
                        checked={getRawProp(p.visual.json, "columnFormatting", "dataBars", queryRefOf(colFieldDef)) !== undefined}
                        label="Data bars"
                        onChange={(_, d) =>
                          p.dispatch("report.format.setRaw", {
                            page: p.page.name,
                            visual: p.visual.name,
                            object: "columnFormatting",
                            prop: "dataBars",
                            selector: queryRefOf(colFieldDef),
                            node: d.checked ? dataBarsNode() : null,
                          })
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            </AccordionPanel>
          </AccordionItem>
        ))}
        {tab === "general" && !needle && !p.analytics && (
          <AccordionItem value="position">
            <AccordionHeader size="small">Size and position</AccordionHeader>
            <AccordionPanel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {(["x", "y", "width", "height"] as const).map((k) => (
                  <label key={k} style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                    {k === "x" ? "Horizontal" : k === "y" ? "Vertical" : k === "width" ? "Width" : "Height"}
                    <Input
                      size="small"
                      type="number"
                      key={`${p.visual.name}-${k}-${p.visual.position[k]}`}
                      defaultValue={String(p.visual.position[k])}
                      onBlur={(e) => {
                        const n = Number(e.currentTarget.value);
                        if (Number.isFinite(n) && n !== p.visual.position[k]) p.dispatch("report.visual.setPosition", { page: p.page.name, visual: p.visual.name, position: { [k]: n } });
                      }}
                    />
                  </label>
                ))}
              </div>
            </AccordionPanel>
          </AccordionItem>
        )}
      </Accordion>
      {shown.length === 0 && <div style={{ fontSize: 12, opacity: 0.7 }}>{type?.deferred ? "Not yet implemented: this visual has no format settings." : "No matching settings."}</div>}
      {cond && (
        <CondFormatDialog
          open
          title={cond.title}
          fields={cond.object === "values" ? ([...tableFields.filter((f) => f.kind !== "column"), ...tableFields.filter((f) => f.kind === "column")] as FieldRef[]) : valueFields}
          current={getRawProp(p.visual.json, cond.object, cond.prop, cond.selector)}
          allowFieldValue={cond.allowFieldValue}
          onClose={() => setCond(null)}
          onApply={(node) => {
            p.dispatch("report.format.setRaw", { page: p.page.name, visual: p.visual.name, object: cond.object, prop: cond.prop, node, selector: cond.selector });
            setCond(null);
          }}
        />
      )}
    </div>
  );
}
