import { describe, expect, it } from "vitest";
import { APP_NAME, NOT_YET_IMPLEMENTED, WORKING_FEATURES } from "./info";

describe("app info (shown in the About dialog)", () => {
  it("names the app", () => {
    expect(APP_NAME).toBe("BIForge");
  });

  it("lists what works and what does not, without claiming nothing works", () => {
    expect(WORKING_FEATURES.length).toBeGreaterThan(3);
    expect(NOT_YET_IMPLEMENTED.length).toBeGreaterThan(0);
    expect(WORKING_FEATURES.join(" ")).toMatch(/data import/i);
    expect(NOT_YET_IMPLEMENTED.join(" ")).toMatch(/Power Query web/);
  });
});
