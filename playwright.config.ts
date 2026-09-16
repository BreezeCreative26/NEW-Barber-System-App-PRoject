import { defineConfig } from "@playwright/test";
import { cpus } from "node:os";
// Isolate runner-owned artifacts: overlapping invocations must never clean each
// other's .network/.trace files during context teardown. Workers inherit this ID.
const runId =
  (process.env.BARBERSHOP_TEST_RUN_ID ||= `${Date.now()}-${process.pid}`);
const runDir = `test-results/runs/${runId}`;
// Fast loop: `npm run test:area -- calendar` runs one file; `npm run test:e2e` is the full gate.
// Workers: browser tests are I/O-bound against the local worker, so 2x CPU is safe on this box.
const workers = Number(process.env.PW_WORKERS || Math.max(2, cpus().length * 2));
export default defineConfig({
  outputDir: `${runDir}/artifacts`,
  // Visual baselines live with the tests, one per screen (no platform suffix so the repo has one truth).
  snapshotPathTemplate: "tests/__screenshots__/{testFileName}/{arg}{ext}",
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 45_000,
  expect: { timeout: 7_000 },
  workers,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: `${runDir}/results.json` }]],
  // Tests run against whatever is on :3000 (PM2 `ollo`, or `npm run start`); nothing is started here.
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--no-sandbox"] },
  },
});
