// Script visuals (R script visual, Python visual): the script text stored with the visual and the data handed to it. Pure.
import { labelOf } from "./chartData";
import type { Loaded } from "./dataLoader";
import type { Theme } from "./theme";
import { getFormat, type VisualModel } from "./visualDoc";

export interface ScriptSettings {
  language: "python" | "r";
  /** The script text (script > source). */
  source: string;
  /** What the script is called in the report (script > provider): Python or R. */
  provider: string;
}

export const DEFAULT_SCRIPTS = {
  python: "# The data of the visual is in `dataset`, a pandas DataFrame.\nimport matplotlib.pyplot as plt\n\ndataset.plot(kind=\"bar\", x=dataset.columns[0])\nplt.tight_layout()\n",
  r: "# The data of the visual is in `dataset`, a data.frame.\nbarplot(dataset[[ncol(dataset)]], names.arg = dataset[[1]])\n",
} as const;

export function scriptSettings(visual: VisualModel): ScriptSettings {
  const language = visual.visualType === "pythonVisual" ? "python" : "r";
  const src = getFormat(visual.json, "script", "source");
  const prov = getFormat(visual.json, "script", "provider");
  return { language, source: src && src.t === "string" ? src.v : "", provider: prov && prov.t === "string" ? prov.v : language === "python" ? "Python" : "R" };
}

const csvCell = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/** The data of the visual as the CSV text the script reads: a header with the column names, then the rows. */
export function datasetCsv(loaded: Extract<Loaded, { kind: "grouped" }>, theme?: Theme): string {
  void theme;
  const cols = loaded.query.columns.filter((c) => c.role === "Values" && c.kind !== "helper").sort((a, b) => a.order - b.order);
  const lines = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const row of loaded.rows) {
    lines.push(
      cols
        .map((c) => {
          const v = row[c.index];
          if (!v || v.kind === "blank") return "";
          return csvCell(v.num !== null && v.kind !== "datetime" ? String(v.num) : labelOf(v, c.format));
        })
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
