import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../.test-artifacts/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "../.test-artifacts/playwright-report" }]]
    : "line",
  use: {
    baseURL: "http://127.0.0.1:5074",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: [
    {
      command: ".venv/bin/python -m uvicorn backend.app.e2e:app --host 127.0.0.1 --port 8031",
      cwd: "..",
      port: 8031,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        "VITE_PWA_DEV=true VITE_API_BASE_URL=http://127.0.0.1:8031 VITE_AG_UI_URL=http://127.0.0.1:8031/api/agent npm run dev -- --host 127.0.0.1 --port 5074 --strictPort",
      cwd: ".",
      port: 5074,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
