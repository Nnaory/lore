import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Unit / logic tests run in node, component tests in jsdom.
    // Individual test files can override with @vitest-environment jsdom.
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
