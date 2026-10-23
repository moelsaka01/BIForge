import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // tests read the shared DAX fixture CSVs from tests/dax/fixtures, one level above the app
  server: { port: 1420, strictPort: true, fs: { allow: [".."] } },
  // the jsdom UI tests render whole panes and ECharts; under a loaded machine (CI, parallel files) 5 s is too tight
  test: {
    alias: [{ find: /^\.\/lazyViews$/, replacement: fileURLToPath(new URL("./src/views/shell/lazyViews.eager.tsx", import.meta.url)) }], testTimeout: 20000, setupFiles: ["./src/core/testing/setup.ts"] },
});
