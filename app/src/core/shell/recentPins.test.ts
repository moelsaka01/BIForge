import { describe, expect, it } from "vitest";
import { SettingsStore } from "./settings";

describe("pinned recent projects", () => {
  it("are kept when the project is opened again and do not count against the limit of the list", () => {
    const s = new SettingsStore();
    s.setOption("interface.recentCount", 2);
    s.addRecent("D:/a.pbip", "a", 1);
    s.pinRecent("D:/a.pbip", true);
    s.addRecent("D:/b.pbip", "b", 2);
    s.addRecent("D:/c.pbip", "c", 3);
    s.addRecent("D:/d.pbip", "d", 4);
    // the limit is 2 entries counting the pinned one: only the newest unpinned entry stays
    expect(s.getSnapshot().recent.map((r) => r.name)).toEqual(["d", "a"]);
    expect(s.getSnapshot().recent.filter((r) => r.pinned).map((r) => r.name)).toEqual(["a"]);
    expect(s.getSnapshot().recent.length).toBe(2);
    s.addRecent("D:/A.pbip", "a", 5);
    expect(s.getSnapshot().recent.find((r) => r.name === "a")?.pinned).toBe(true);
  });
  it("an entry that is not pinned stays unpinned, and unpinning removes the mark", () => {
    const s = new SettingsStore();
    s.addRecent("D:/a.pbip", "a", 1);
    s.pinRecent("D:/a.pbip", false);
    expect(s.getSnapshot().recent[0].pinned).toBeUndefined();
    s.pinRecent("D:/a.pbip", true);
    s.pinRecent("D:/a.pbip", false);
    expect(s.getSnapshot().recent[0]).toEqual({ path: "D:/a.pbip", name: "a", openedAt: 1 });
  });
});
