// Mirrors the serde JSON of biforge_model::project::Project and biforge_model::tmdl.

export interface Expr {
  text: string;
  verbatim: boolean;
}

export type PropValue = "Flag" | { Text: string } | { Expr: Expr };

export interface Prop {
  key: string;
  value: PropValue;
}

export interface TmdlNode {
  description: string[];
  kind: string;
  name: string | null;
  default: Expr | null;
  props: Prop[];
  children: TmdlNode[];
}

export interface TmdlDocument {
  nodes: TmdlNode[];
}

export interface Project {
  name: string;
  pbip: unknown;
  report_dir: string;
  model_dir: string;
  model: {
    pbism: unknown;
    platform: unknown | null;
    tmdl: Record<string, TmdlDocument>;
  };
  report: {
    pbir: unknown;
    platform: unknown | null;
    files: Record<string, unknown>;
    /** Custom themes (StaticResources/RegisteredResources), keyed by file name. */
    static_resources?: Record<string, unknown>;
    /** Uploaded pictures (StaticResources/RegisteredResources), file name to base64 content. Only on disk and in the Rust model: in memory a picture is a data: address in the visual. */
    images?: Record<string, string>;
  };
}

export interface SaveReport {
  written: string[];
  deleted: string[];
}
