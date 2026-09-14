import { defineConfig } from "@playwright/test";
// Isolate runner-owned artifacts: overlapping invocations must never clean each
// other's .network/.trace files during context teardown. Workers inherit this ID.
const runId =
  (process.env.BARBERSHOP_TEST_RUN_ID ||= `${Date.now()}-${process.pid}`);
const runDir = `test-results/runs/${runId}`;
export default defineConfig({
  outputDir: `${runDir}/artifacts`,
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 45_000,
  expect: { timeout: 7_000 },
  workers: 2,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: `${runDir}/results.json` }]],
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--no-sandbox"] },
  },
});
