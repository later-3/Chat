import { defineConfig, devices } from "@playwright/test";

/**
 * P1.2 PWA 真实浏览器验证。
 * 一律从生产构建产物启动 vite preview（不使用 dev server），
 * 并同时启动真实 API，保证 /api/healthz 在线投影来自真实服务。
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "PORT=3000 pnpm --filter @chat/api start",
      url: "http://localhost:3000/api/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command:
        "pnpm --filter @chat/web build && pnpm --filter @chat/web exec vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
