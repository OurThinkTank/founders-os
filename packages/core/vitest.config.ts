import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Include both src/__tests__ and any co-located *.test.ts files
    include: ["src/**/*.test.ts"],
    // Clean module registry between test files so mocks don't bleed
    isolate: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
    },
  },
});
