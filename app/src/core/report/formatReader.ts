// Reads formatting settings of a visual with the fallback chain: the visual's own setting, the report theme's
// visual styles, then the built-in default.
import { getFormat, getRawProp } from "./visualDoc";
import { themeStyle, type Theme } from "./theme";
import type { J } from "./pbir";

export class FormatReader {
  constructor(
    readonly json: J,
    readonly theme: Theme,
    readonly visualType: string,
  ) {}

  private lookup(object: string, prop: string, selector?: string): string | number | boolean | null {
    const own = getFormat(this.json, object, prop, selector);
    if (own && own.t !== "null") return own.v;
    if (selector !== undefined) {
      // a series-specific entry falls back to the visual-wide one
      const all = getFormat(this.json, object, prop);
      if (all && all.t !== "null") return all.v;
    }
    return themeStyle(this.theme, this.visualType, object, prop);
  }

  bool(object: string, prop: string, dflt: boolean, selector?: string): boolean {
    const v = this.lookup(object, prop, selector);
    return typeof v === "boolean" ? v : dflt;
  }

  num(object: string, prop: string, dflt: number, selector?: string): number {
    const v = this.lookup(object, prop, selector);
    return typeof v === "number" && Number.isFinite(v) ? v : dflt;
  }

  str(object: string, prop: string, dflt: string, selector?: string): string {
    const v = this.lookup(object, prop, selector);
    return typeof v === "string" ? v : dflt;
  }

  /** A color or undefined when the setting is absent (so the caller can pick a data color instead). */
  color(object: string, prop: string, selector?: string): string | undefined {
    const v = this.lookup(object, prop, selector);
    return typeof v === "string" && /^#|^rgb|^[a-z]+$/i.test(v) ? v : undefined;
  }

  has(object: string, prop: string, selector?: string): boolean {
    return getFormat(this.json, object, prop, selector) !== null;
  }

  raw(object: string, prop: string, selector?: string): J | undefined {
    return getRawProp(this.json, object, prop, selector);
  }
}
