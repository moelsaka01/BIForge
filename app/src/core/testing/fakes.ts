// Test helpers only: an in-memory ProjectIO and a hand-written sample project.
import type { Dialogs, ProjectIO } from "../session/session";
import type { Project, SaveReport, TmdlNode } from "../model/types";

const node = (kind: string, name: string | null, extra: Partial<TmdlNode> = {}): TmdlNode => ({
  description: [],
  kind,
  name,
  default: null,
  props: [],
  children: [],
  ...extra,
});

const text = (key: string, v: string) => ({ key, value: { Text: v } });

export function sampleProject(name = "Retail"): Project {
  return {
    name,
    pbip: { version: "1.0" },
    report_dir: `${name}.Report`,
    model_dir: `${name}.SemanticModel`,
    model: {
      pbism: { version: "4.0" },
      platform: null,
      tmdl: {
        "database.tmdl": { nodes: [node("database", name, { props: [text("compatibilityLevel", "1600")] })] },
        "model.tmdl": {
          nodes: [node("model", "Model", { props: [text("culture", "en-US")] }), node("ref table", "Sales"), node("ref table", "Product Info")],
        },
        "relationships.tmdl": {
          nodes: [
            node("relationship", "r1", { props: [text("fromColumn", "Sales.ProductKey"), text("toColumn", "'Product Info'.ProductKey")] }),
            node("relationship", "r2", { props: [text("fromColumn", "Sales.DateKey"), text("toColumn", "Calendar.DateKey")] }),
          ],
        },
        "tables/Sales.tmdl": {
          nodes: [
            node("table", "Sales", {
              children: [
                node("column", "ProductKey", { props: [text("dataType", "int64")] }),
                node("column", "DateKey", { props: [text("dataType", "int64")] }),
                node("measure", "Total", { default: { text: "SUM(Sales[Amount])", verbatim: false } }),
              ],
            }),
          ],
        },
        "tables/Product Info.tmdl": {
          nodes: [node("table", "Product Info", { children: [node("column", "ProductKey", { props: [text("dataType", "int64")] })] })],
        },
        "tables/Calendar.tmdl": { nodes: [node("table", "Calendar", { children: [node("column", "DateKey")] })] },
      },
    },
    report: { pbir: {}, platform: null, files: { "version.json": { version: "2.0.0" } } },
  };
}

export class FakeIO implements ProjectIO {
  disk = new Map<string, Project>(); // root -> saved project
  recovery = new Map<string, Project>();
  calls: string[] = [];
  failSave = false;
  failRecoveryWrite = false;
  failRecoveryRead = false;

  async newProject(root: string, name: string): Promise<Project> {
    this.calls.push(`new:${root}:${name}`);
    const p = sampleProject(name);
    this.disk.set(root, structuredClone(p));
    return p;
  }
  async openProject(pbipPath: string): Promise<Project> {
    this.calls.push(`open:${pbipPath}`);
    const root = pbipPath.replace(/[\\/][^\\/]*$/, "");
    const p = this.disk.get(root);
    if (!p) throw new Error(`cannot access ${pbipPath}`);
    return structuredClone(p);
  }
  async saveProject(root: string, project: Project): Promise<SaveReport> {
    this.calls.push(`save:${root}`);
    if (this.failSave) throw new Error("disk full");
    this.disk.set(root, structuredClone(project));
    return { written: ["a.tmdl"], deleted: [] };
  }
  async writeRecovery(root: string, project: Project): Promise<void> {
    this.calls.push(`writeRecovery:${root}`);
    if (this.failRecoveryWrite) throw new Error("recovery write failed");
    this.recovery.set(root, structuredClone(project));
  }
  async readRecovery(root: string): Promise<Project | null> {
    if (this.failRecoveryRead) throw new Error("recovery file is damaged");
    return this.recovery.get(root) ?? null;
  }
  async clearRecovery(root: string): Promise<void> {
    this.calls.push(`clearRecovery:${root}`);
    this.recovery.delete(root);
  }
}

export class FakeDialogs implements Dialogs {
  pbip: string | null = null;
  folder: string | null = null;
  async pickPbip() {
    return this.pbip;
  }
  async pickFolder() {
    return this.folder;
  }
}
