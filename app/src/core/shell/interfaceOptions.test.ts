// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyInterfaceZoom, interfaceZoom, shouldCheckForUpdates } from "./interfaceOptions";

describe("interface options", () => {
  it("the size of the interface is a percent from 50 to 200; anything else is 100", () => {
    expect(interfaceZoom({})).toBe(100);
    expect(interfaceZoom({ "interface.zoom": 125 })).toBe(125);
    expect(interfaceZoom({ "interface.zoom": 10 })).toBe(50);
    expect(interfaceZoom({ "interface.zoom": 999 })).toBe(200);
    expect(interfaceZoom({ "interface.zoom": "big" })).toBe(100);
  });
  it("the document is scaled by the option, and 100 takes the scaling off again", () => {
    const el = document.createElement("div");
    applyInterfaceZoom(el, { "interface.zoom": 150 });
    expect(el.style.getPropertyValue("zoom")).toBe("1.5");
    applyInterfaceZoom(el, { "interface.zoom": 100 });
    expect(el.style.getPropertyValue("zoom")).toBe("");
  });
  it("the quiet check for a new release is on unless switched off", () => {
    expect(shouldCheckForUpdates({})).toBe(true);
    expect(shouldCheckForUpdates({ "updates.checkAtStart": false })).toBe(false);
    expect(shouldCheckForUpdates({ "updates.checkAtStart": true })).toBe(true);
  });
});
