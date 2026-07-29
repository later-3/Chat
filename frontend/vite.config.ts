import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const rawWebBase = process.env.VITE_WEB_BASE_PATH?.trim() || "/";
const webBase = `/${rawWebBase.replace(/^\/+|\/+$/g, "")}${rawWebBase === "/" ? "" : "/"}`;
const escapedWebBase = webBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default defineConfig({
  base: webBase,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      base: webBase,
      scope: webBase,
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        "icons/chat-icon.svg",
        "icons/chat-192.png",
        "icons/chat-512.png",
        "icons/chat-maskable-512.png",
      ],
      manifest: {
        id: webBase,
        name: "Chat · AI协作工作区",
        short_name: "Chat",
        description: "连续对话、工作流、项目、知识与人工介入统一协作空间",
        start_url: webBase,
        scope: webBase,
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
        background_color: "#f5f6f1",
        theme_color: "#233e32",
        lang: "zh-CN",
        orientation: "any",
        icons: [
          {
            src: "icons/chat-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/chat-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/chat-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // This page must always reach the network so a browser-managed Basic
        // Auth challenge can be shown after the cached PWA shell sees a 401.
        globIgnores: ["auth-refresh.html"],
        navigateFallback: `${webBase}index.html`,
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/chat-api(?:\/|$)/,
          new RegExp(`^${escapedWebBase}auth-refresh\\.html$`),
        ],
      },
      devOptions: {
        enabled: process.env.VITE_PWA_DEV === "true",
        navigateFallback: webBase,
        suppressWarnings: true,
        type: "module",
      },
    }),
  ],
  build: {
    // The manifest is consumed by the product quality gate. Feature chunks are
    // reviewed by bytes and entrypoint relationships, not by Vite's warning text.
    manifest: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.endsWith("/features/home/activity-rail.css")) {
            return "activity-rail";
          }
          if (id.endsWith("/authentication-required.css")) {
            return "authentication-required";
          }
          if (id.endsWith("/features/session/session-sidebar.css")) {
            return "session-sidebar";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5073,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_PROXY || "http://127.0.0.1:8030",
        changeOrigin: true,
      },
    },
  },
});
