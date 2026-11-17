// Builds the web page into ./dist (served by src/server/http.ts). `pnpm dev:ui` serves it with hot reload and proxies the API.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { WEB } from "../shared/constants.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": `http://${WEB.host}:${WEB.port}` } },
});
