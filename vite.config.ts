import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Two builds of the same workspace:
 *  - default:    web/dist, served by the CodeR server and talking to its HTTP API;
 *  - standalone: web/dist-standalone, one bundle where the application itself
 *                runs in the browser (demo pull requests, scripted council).
 */
export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  return {
    root: "web",
    base: standalone ? "./" : "/",
    plugins: [react()],
    define: { __STANDALONE__: JSON.stringify(standalone) },
    server: {
      port: 5173,
      proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 4317}`, changeOrigin: false } },
    },
    build: {
      outDir: standalone ? "dist-standalone" : "dist",
      emptyOutDir: true,
      target: "es2022",
      chunkSizeWarningLimit: 8000,
      // The standalone build becomes a single self-contained HTML file: no chunks, no asset files.
      ...(standalone
        ? { assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false, rolldownOptions: { output: { codeSplitting: false } } }
        : {}),
    },
  };
});
