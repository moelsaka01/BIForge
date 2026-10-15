import type { EngineApi, RowPage, SortSpec } from "../core/data/types";

export const PAGE_SIZE = 200;

/** Fetches fixed-size pages on demand and keeps them; call `reset` when the table or sort changes. */
export class PageCache {
  private pages = new Map<number, (string | null)[][]>();
  private pending = new Set<number>();
  private generation = 0;
  total = 0;
  error: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private engine: EngineApi,
    private table: string,
    private sort: SortSpec | null,
    readonly pageSize = PAGE_SIZE,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** undefined = not loaded yet */
  row(i: number): (string | null)[] | undefined {
    return this.pages.get(Math.floor(i / this.pageSize))?.[i % this.pageSize];
  }

  /** Starts loading the pages covering [first, end). Safe to call repeatedly. */
  ensure(first: number, end: number): void {
    if (end <= first) return;
    const a = Math.floor(first / this.pageSize);
    const b = Math.floor((end - 1) / this.pageSize);
    for (let p = a; p <= b; p++) {
      if (this.pages.has(p) || this.pending.has(p)) continue;
      this.pending.add(p);
      const gen = this.generation;
      this.engine
        .fetchPage(this.table, p * this.pageSize, this.pageSize, this.sort)
        .then((page: RowPage) => {
          if (gen !== this.generation) return;
          this.total = page.total;
          this.pages.set(p, page.rows);
          this.pending.delete(p);
          this.emit();
        })
        .catch((e) => {
          if (gen !== this.generation) return;
          this.pending.delete(p);
          this.error = e instanceof Error ? e.message : String(e);
          this.emit();
        });
    }
  }

  reset(sort: SortSpec | null): void {
    this.generation++;
    this.pages.clear();
    this.pending.clear();
    this.error = null;
    this.sort = sort;
    this.emit();
  }
}
