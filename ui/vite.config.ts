import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../backend/web/dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: {
    coverage: {
      // Components are covered by the Playwright suite and are unit-rendered with
      // renderToStaticMarkup (no jsdom), so handlers, effects and state are
      // unreachable here — counting them would measure the Playwright suite's job
      // and report a number no unit test can move. Coverage therefore scopes to the
      // logic layer (api clients, player, router, hooks, helpers). The .tsx unit
      // tests still run and still gate; they just don't score.
      exclude: [
        "src/**/*.tsx",
        "src/vite-env.d.ts",
        // Test-only React hook harness — test infrastructure, not product code,
        // so it must not score itself.
        "src/testHooks.ts",
        "**/*.test.*",
        "**/node_modules/**",
        "*.config.*",
      ],
      // Lines is the gate. The other metrics are reported but not enforced, so a
      // PR is never blocked by a branch/function ratio the target never named.
      thresholds: { lines: 80 },
    },
  },
});
