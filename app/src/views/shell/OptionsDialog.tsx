import { useState } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input } from "@fluentui/react-components";
import { OPTION_PAGES, optionValue, type OptionDef, type OptionPage, type OptionValue } from "../../core/options/schema";
import { getModelCulture } from "../../core/model/ops";
import { personalizeOn } from "../../core/report/reportOps";
import { listPageNames } from "../../core/report/visualDoc";
import { useDoc, useEnv, useSettings, useShellState } from "./ShellContext";

const NOT_YET = "Not yet implemented";

/** The Options dialog: a page list (GLOBAL and CURRENT FILE) and the settings of the chosen page. */
export function OptionsDialog({ page }: { page?: string }) {
  const env = useEnv();
  const settings = useSettings();
  const doc = useDoc();
  useShellState();
  const kind = settings.shell;
  const layout = settings.layouts[kind];
  const [current, setCurrent] = useState(OPTION_PAGES.some((p) => p.id === page) ? (page as string) : OPTION_PAGES[0].id);
  const close = () => env.session.shell.closeDialog();
  const active = OPTION_PAGES.find((p) => p.id === current) as OptionPage;

  const valueOf = (def: OptionDef): OptionValue => {
    switch (def.id) {
      case "interface.shell":
        return settings.shell;
      case "interface.theme":
        return settings.theme;
      case "interface.ribbonMode":
        return layout.ribbonMode;
      case "model.culture":
        return (doc.project && getModelCulture(doc.project)) || (def.default as string);
      case "file.report.personalize":
        return doc.project ? listPageNames(doc.project).some((n) => personalizeOn(doc.project!, n)) : false;
      default:
        return optionValue(settings.options, def);
    }
  };
  const change = (def: OptionDef, value: OptionValue) => {
    switch (def.id) {
      case "interface.shell":
        return void env.run("app.shell.set", { shell: value });
      case "interface.theme":
        return void env.run("app.theme.set", { theme: value });
      case "interface.ribbonMode":
        return void env.run("app.ribbon.mode", { mode: value });
      case "model.culture":
        return void env.run("model.setCulture", { culture: value });
      case "file.report.personalize":
        return void env.run("report.personalize.set", { enabled: value === true });
      default:
        return void env.run("app.option.set", { id: def.id, value });
    }
  };

  const control = (def: OptionDef) => {
    const v = valueOf(def);
    const off = !def.implemented || (active.scope === "file" && !doc.project);
    const label = (
      <>
        {def.label}
        {!def.implemented && <span style={{ opacity: 0.65 }}> ({NOT_YET})</span>}
      </>
    );
    if (def.type === "info") return <div style={{ fontSize: 13 }}>{def.label}</div>;
    if (def.type === "bool") return <Checkbox label={label} checked={v === true} disabled={off} onChange={(_, d) => change(def, d.checked === true)} />;
    if (def.type === "enum") {
      return (
        <fieldset role="radiogroup" aria-label={def.label} style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: 4 }} disabled={off}>
          <legend style={{ padding: 0, marginBottom: 2 }}>{label}</legend>
          {def.choices!.length > 3 ? (
            <select aria-label={def.label} value={String(v)} disabled={off} onChange={(e) => change(def, e.target.value)}>
              {def.choices!.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            def.choices!.map((c) => (
              <label key={c.value} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="radio" name={def.id} value={c.value} checked={v === c.value} disabled={off} onChange={() => change(def, c.value)} />
                {c.label}
              </label>
            ))
          )}
        </fieldset>
      );
    }
    return (
      <label style={{ display: "grid", gap: 4 }}>
        <span>{label}</span>
        <Input
          aria-label={def.label}
          type={def.type === "number" ? "number" : "text"}
          style={{ maxWidth: 260 }}
          value={String(v)}
          disabled={off}
          min={def.min}
          max={def.max}
          onChange={(_, d) => {
            if (def.type === "number") {
              const num = Number(d.value);
              if (d.value !== "" && isFinite(num)) change(def, num);
            } else change(def, d.value);
          }}
        />
      </label>
    );
  };

  const nav = (scope: "global" | "file", title: string) => (
    <>
      <div style={{ fontWeight: 600, fontSize: 11, letterSpacing: 0.6, margin: "10px 0 4px", opacity: 0.7 }}>{title}</div>
      {OPTION_PAGES.filter((p) => p.scope === scope).map((p) => (
        <button key={p.id} type="button" role="tab" aria-selected={p.id === current} data-page={p.id} className="opt-page" onClick={() => setCurrent(p.id)}>
          {p.label}
        </button>
      ))}
    </>
  );

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface aria-label="Options" style={{ maxWidth: 880, width: "90vw" }}>
        <DialogBody>
          <DialogTitle>Options</DialogTitle>
          <DialogContent>
            <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, minHeight: 380, maxHeight: "62vh" }}>
              <div role="tablist" aria-label="Option pages" aria-orientation="vertical" style={{ overflowY: "auto", display: "flex", flexDirection: "column" }}>
                {nav("global", "GLOBAL")}
                {nav("file", "CURRENT FILE")}
              </div>
              <div role="tabpanel" aria-label={active.label} style={{ overflowY: "auto", display: "grid", alignContent: "start", gap: 12, paddingRight: 6 }}>
                <h3 style={{ margin: 0 }}>{active.scope === "global" ? "Global" : "Current file"}: {active.label}</h3>
                {active.scope === "file" && !doc.project && <div role="note">Open a project to change the settings of the current file.</div>}
                {active.settings.map((def) => (
                  <div key={def.id} data-option={def.id}>
                    {control(def)}
                    {def.note && <div style={{ fontSize: 12, opacity: 0.75, marginLeft: def.type === "bool" ? 28 : 0 }}>{def.note}</div>}
                  </div>
                ))}
                {active.id === "g.interface" && (
                  <div>
                    <Button size="small" onClick={() => void env.run("app.layout.reset")}>
                      Reset panes and ribbon of this interface
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={close}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
