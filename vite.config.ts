import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// NOTE: @vitejs/plugin-react-oxc (the recommended performance upgrade for Vite 8)
// is not yet compatible with Vite 8 — its peer dep caps at ^7.0.0 as of 0.4.3.
// When plugin-react-oxc ships a Vite-8-compatible release, swap this import
// to `import react from '@vitejs/plugin-react-oxc'` to silence the deprecation
// warning and pick up the oxc-based transform speedup.
export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
