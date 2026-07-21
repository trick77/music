import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../backend/web/dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: {
    // Components render into a real DOM, so handlers, effects and state are
    // reachable from unit tests instead of being frozen at their initial markup
    // by a string renderer.
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      // json-summary feeds hack/coverage-gate.sh, lcov feeds
      // hack/patch-coverage.sh, and text-summary is for whoever reads the log.
      reporter: ["text-summary", "json-summary", "lcov"],
      // Both gates resolve coverage artifacts from the repo root, alongside the
      // backend's, so these reports land outside ui/.
      reportsDirectory: "../coverage/ui",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Entrypoint: mounts the app into the DOM and does nothing else, so
        // there is no behaviour here for a unit test to assert.
        "src/main.tsx",
        "src/vite-env.d.ts",
        // Test-only React hook harness — test infrastructure, not product code,
        // so it must not score itself.
        "src/testHooks.ts",
        // The vitest setup file, for the same reason. It also runs before the
        // instrumented modules load, so it never appears in the report at all —
        // leaving it included makes hack/patch-coverage.sh see a changed source
        // file with no coverage data and report a path-mapping bug that isn't one.
        "src/test-setup.ts",
        "**/*.test.*",
      ],
      // No thresholds block on purpose. The floor lives in hack/coverage-floors
      // and is enforced by hack/coverage-gate.sh, so there is exactly one
      // definition of it; a second one here would inevitably drift.
    },
  },
});
