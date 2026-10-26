// @vitest-environment jsdom
// File > Export: the current report page as a PNG picture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomStubs } from "../../core/testing/domStubs";
import { PBIP, makeApp } from "./testApp";

vi.mock("html-to-image", () => ({ toBlob: async () => new Blob(["png-bytes"], { type: "image/png" }) }));
installDomStubs();
afterEach(cleanup);

describe("Export the current page as a picture", () => {
  it("hands a PNG named after the page to the user; outside the Report view it says so", async () => {
    const a = makeApp();
    render(a.element);
    await act(async () => void (await a.registry.execute("file.open", { path: PBIP })));
    await waitFor(() => expect(document.querySelector("[data-page]")).toBeTruthy());
    await act(async () => a.shell.openDialog({ kind: "exportMenu" }));
    fireEvent.click(await screen.findByRole("button", { name: /Current page as a picture/ }));
    await waitFor(() => expect(a.files.saved.length).toBe(1));
    expect(a.files.saved[0].name).toMatch(/\.png$/);
    expect(a.files.saved[0].text).toBe("blob:image/png:9");
    // not in the Report view
    await act(async () => a.shell.setView("data"));
    await act(async () => a.shell.openDialog({ kind: "exportMenu" }));
    fireEvent.click(await screen.findByRole("button", { name: /Current page as a picture/ }));
    await waitFor(() => expect(a.session.getSnapshot().lastMessage).toMatch(/Open the Report view/));
    expect(a.files.saved.length).toBe(1);
  });
});
