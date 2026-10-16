// jsdom has no canvas and no ResizeObserver; ECharts measures text with a canvas context. These stubs keep
// UI tests quiet and deterministic (a character is 6 px wide).
export function installDomStubs(): void {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (kind: string) => unknown };
  proto.getContext = () => ({
    measureText: (t: string) => ({ width: t.length * 6 }),
    font: "",
    fillRect() {},
    clearRect() {},
    save() {},
    restore() {},
    scale() {},
    setTransform() {},
    beginPath() {},
    closePath() {},
    clip() {},
    rect() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    translate() {},
    fillText() {},
    strokeText() {},
    drawImage() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}
