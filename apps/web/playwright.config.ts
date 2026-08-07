import { defineConfig, devices } from "@playwright/test";

/**
 * P1.2 PWA 真实浏览器验证。
 * 一律从生产构建产物启动 vite preview（不使用 dev server），
 * 并同时启动真实 API，保证 /api/healthz 在线投影来自真实服务。
 */
export default defineConfig({
  testDir: "./e2e",
  // 真实百炼闭环由独立配置显式运行；PWA回归不得误触发付费场景。
  testIgnore: "planning-execution-real.spec.ts",
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
      command:
        "PORT=43131 CHAT_PRODUCT_STORE_PATH=../../.test-artifacts/pwa/chat-product-store.v1.json pnpm --filter @chat/api start",
      url: "http://127.0.0.1:43131/api/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "CHAT_API_PROXY_URL=http://127.0.0.1:43131 pnpm --filter @chat/web build && CHAT_API_PROXY_URL=http://127.0.0.1:43131 pnpm --filter @chat/web exec vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
