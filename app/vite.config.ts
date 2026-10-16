import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // tests read the shared DAX fixture CSVs from tests/dax/fixtures, one level above the app
  server: { port: 1420, strictPort: true, fs: { allow: [".."] } },
});
