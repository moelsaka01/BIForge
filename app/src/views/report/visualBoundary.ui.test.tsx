// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VisualBoundary } from "./VisualBoundary";

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new TypeError("Cannot read properties of undefined (reading '0')");
  return <div>drawn</div>;
}

import { afterEach } from "vitest";
afterEach(cleanup);
describe("VisualBoundary", () => {
  it("a visual that throws shows a message in its frame and the siblings still draw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <VisualBoundary><Boom fail /></VisualBoundary>
        <VisualBoundary><Boom fail={false} /></VisualBoundary>
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Cannot draw this visual: Cannot read properties of undefined");
    expect(screen.getByText("drawn")).toBeTruthy();
    spy.mockRestore();
  });
  it("a change of the visual gets another try", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = { v: 1 };
    const { rerender } = render(<VisualBoundary resetKey={a}><Boom fail /></VisualBoundary>);
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(<VisualBoundary resetKey={{ v: 2 }}><Boom fail={false} /></VisualBoundary>);
    expect(screen.getByText("drawn")).toBeTruthy();
    spy.mockRestore();
  });
});
