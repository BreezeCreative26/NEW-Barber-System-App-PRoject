import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/fixtures.test.ts"], environment: "node" },
});
