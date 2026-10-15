import { describe, expect, it } from "vitest";
import { APP_NAME, STATUS_NOTICE } from "./info";

describe("app info", () => {
  it("names the app and states early-development status honestly", () => {
    expect(APP_NAME).toBe("BIForge");
    expect(STATUS_NOTICE).toMatch(/no features are implemented/i);
  });
});
