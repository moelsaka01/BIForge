import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { HELP_LINKS } from "../info";
import { allControls, ribbonFor } from "../shell/ribbon";

describe("Help links", () => {
  it("Documentation (F1), Report an issue and Submit an idea open the project's pages in the default browser", async () => {
    const io = new FakeIO();
    const s = new Session(io, new FakeDialogs());
    const reg = createRegistry(s);
    expect(reg.byShortcut("F1")?.id).toBe("help.documentation");
    for (const id of ["help.documentation", "help.reportIssue", "help.submitIdea"]) expect((await reg.execute(id)).ok).toBe(true);
    expect(io.opened).toEqual([HELP_LINKS.documentation, HELP_LINKS.reportIssue, HELP_LINKS.submitIdea]);
    for (const u of io.opened) expect(u).toMatch(/^https:\/\/github\.com\/moelsaka01\/BIForge\//);
  });

  it("the Help tab of the ribbon has the buttons", () => {
    const ids = allControls(ribbonFor("classic", "report")).filter((x) => x.tab === "help").map((x) => (x.control as { command?: string }).command);
    expect(ids).toEqual(expect.arrayContaining(["help.documentation", "help.reportIssue", "help.submitIdea"]));
  });
});
