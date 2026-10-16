import { describe, expect, it } from "vitest";
import { APP_NAME, NOT_YET_IMPLEMENTED, STATUS_NOTICE, WORKING_FEATURES } from "./info";

describe("app info", () => {
  it("names the app", () => {
    expect(APP_NAME).toBe("BIForge");
  });

  it("states what works and what does not, without claiming nothing works", () => {
    expect(STATUS_NOTICE).not.toMatch(/no features are implemented/i);
    for (const f of WORKING_FEATURES) expect(STATUS_NOTICE).toContain(f);
    for (const f of NOT_YET_IMPLEMENTED) expect(STATUS_NOTICE).toContain(f);
    expect(STATUS_NOTICE).toMatch(/data import/i);
    expect(STATUS_NOTICE).toMatch(/Not yet implemented:.*Power Query web/);
  });
});
