import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Button, Input, Select } from "@fluentui/react-components";
import { lit } from "../../core/report/fields";
import { DISPLAY_OPTIONS, PAGE_SIZES, displayOptionOf, readCanvasBackground, readVerticalAlignment, readWallpaper, sizePresetOf, type PageLayer } from "../../core/report/pageFormat";
import type { PageModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 };

const DISPLAY_LABELS: Record<(typeof DISPLAY_OPTIONS)[number], string> = { FitToPage: "Fit to page", FitToWidth: "Fit to width", ActualSize: "Actual size" };

function Layer({ page, object, title }: { page: PageModel; object: "background" | "outspace"; title: string }) {
  const c = useReport();
  const layer: PageLayer = object === "background" ? readCanvasBackground(page.json) : readWallpaper(page.json);
  const set = (prop: string, value: ReturnType<typeof lit.str> | null) => c.dispatch("report.page.format", { page: page.name, object, prop, value });
  const l = (s: string) => `${title}: ${s}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={row}>
        <label htmlFor={`pf-${object}-color`}>Color</label>
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input id={`pf-${object}-color`} type="color" aria-label={l("color")} value={layer.color && /^#[0-9a-f]{6}$/i.test(layer.color) ? layer.color : "#ffffff"} onChange={(e) => set("color", lit.str(e.target.value))} />
          <Button size="small" appearance="subtle" disabled={!layer.color} aria-label={l("reset color")} onClick={() => set("color", null)}>
            Reset
          </Button>
        </span>
      </div>
      <div style={row}>
        <label htmlFor={`pf-${object}-tr`}>Transparency (%)</label>
        <Input id={`pf-${object}-tr`} size="small" type="number" aria-label={l("transparency")} style={{ width: 80 }} value={String(layer.transparency)} onChange={(_, d) => {
          const n = Number(d.value);
          if (Number.isFinite(n)) set("transparency", n === 0 ? null : lit.num(Math.min(100, Math.max(0, n))));
        }} />
      </div>
      <div style={row}>
        <span>Picture{layer.image ? `: ${layer.image.name}` : ""}</span>
        <span style={{ display: "flex", gap: 4 }}>
          <Button size="small" aria-label={l("choose picture")} onClick={() => c.dispatch("report.page.chooseImage", { page: page.name, object })}>
            Browse…
          </Button>
          <Button size="small" appearance="subtle" disabled={!layer.image} aria-label={l("remove picture")} onClick={() => c.dispatch("report.page.setImage", { page: page.name, object, uri: null })}>
            Remove
          </Button>
        </span>
      </div>
      {layer.image && (
        <div style={row}>
          <label htmlFor={`pf-${object}-fit`}>Image fit</label>
          <Select id={`pf-${object}-fit`} size="small" aria-label={l("image fit")} style={{ width: 120 }} value={layer.image.fit} onChange={(_, d) => c.dispatch("report.page.setImage", { page: page.name, object, fit: d.value })}>
            <option value="Normal">Normal</option>
            <option value="Fit">Fit</option>
            <option value="Fill">Fill</option>
          </Select>
        </div>
      )}
    </div>
  );
}

/** Format page: shown in place of the Format visual cards while no visual is selected. */
export function PageFormatPane({ page }: { page: PageModel }) {
  const c = useReport();
  const preset = sizePresetOf(page.width, page.height);
  const setSize = (w: number, h: number) => c.dispatch("report.page.setSize", { page: page.name, width: w, height: h });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, height: "100%", overflow: "auto" }} aria-label="Format page">
      <Accordion multiple collapsible defaultOpenItems={["size", "view", "align", "bg", "wall"]}>
        <AccordionItem value="size">
          <AccordionHeader size="small">Page size</AccordionHeader>
          <AccordionPanel>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={row}>
                <label htmlFor="pf-size">Type</label>
                <Select id="pf-size" size="small" aria-label="Page size type" style={{ width: 130 }} value={preset} onChange={(_, d) => {
                  const s = PAGE_SIZES.find((x) => x.id === d.value);
                  if (s) setSize(s.width, s.height);
                }}>
                  {PAGE_SIZES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                  <option value="Custom">Custom</option>
                </Select>
              </div>
              {(["width", "height"] as const).map((k) => (
                <div key={k} style={row}>
                  <label htmlFor={`pf-${k}`}>{k === "width" ? "Width" : "Height"} (px)</label>
                  <Input id={`pf-${k}`} size="small" type="number" aria-label={`Page ${k}`} style={{ width: 90 }} value={String(page[k])} onChange={(_, d) => {
                    const n = Number(d.value);
                    if (Number.isFinite(n) && n !== page[k]) setSize(k === "width" ? n : page.width, k === "height" ? n : page.height);
                  }} />
                </div>
              ))}
            </div>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="view">
          <AccordionHeader size="small">Page view</AccordionHeader>
          <AccordionPanel>
            <div style={row}>
              <label htmlFor="pf-view">View</label>
              <Select id="pf-view" size="small" aria-label="Page view" style={{ width: 130 }} value={displayOptionOf(page.json)} onChange={(_, d) => c.dispatch("report.page.setDisplay", { page: page.name, option: d.value })}>
                {DISPLAY_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {DISPLAY_LABELS[o]}
                  </option>
                ))}
              </Select>
            </div>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="align">
          <AccordionHeader size="small">Page alignment</AccordionHeader>
          <AccordionPanel>
            <div style={row}>
              <label htmlFor="pf-align">Vertical alignment</label>
              <Select id="pf-align" size="small" aria-label="Page vertical alignment" style={{ width: 130 }} value={readVerticalAlignment(page.json)} onChange={(_, d) => c.dispatch("report.page.format", { page: page.name, object: "displayArea", prop: "verticalAlignment", value: lit.str(d.value) })}>
                <option value="Top">Top</option>
                <option value="Middle">Middle</option>
              </Select>
            </div>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="bg">
          <AccordionHeader size="small">Canvas background</AccordionHeader>
          <AccordionPanel>
            <Layer page={page} object="background" title="Canvas background" />
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="wall">
          <AccordionHeader size="small">Wallpaper</AccordionHeader>
          <AccordionPanel>
            <Layer page={page} object="outspace" title="Wallpaper" />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
