import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      // 新版本只提示，用户确认后才激活；不得在用户编辑时强制重载。
      registerType: "prompt",
      // 注册代码由 src/components/PwaUpdatePrompt.tsx 通过 virtual:pwa-register/react 显式引入。
      injectRegister: null,
      includeAssets: ["icons/icon.svg", "icons/favicon-32.png", "icons/apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "Chat",
        short_name: "Chat",
        description: "以对话为入口、由用户持续看护、能够长期推进工作的 AI 协作产品。",
        lang: "zh-CN",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#FFFFFF",
        background_color: "#1D1D1F",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 离线时同源页面导航回退到预缓存外壳；/api 永不进入回退，也不配置任何 runtime cache。
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      // 开发模式不启用 Service Worker，避免缓存污染日常开发与组件测试。
      devOptions: { enabled: false },
    }),
  ],
  // 测试环境必须使用React development构建，否则@testing-library的act不可用。
  define: mode === "test" ? { "process.env.NODE_ENV": '"development"' } : {},
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  preview: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    // e2e/ 是 Playwright 真实浏览器场景，由 test:e2e:pwa 运行，不进 vitest
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
}));
