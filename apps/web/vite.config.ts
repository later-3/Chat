import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // 测试环境必须使用React development构建，否则@testing-library的act不可用。
  define: mode === "test" ? { "process.env.NODE_ENV": '"development"' } : {},
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
  },
}));
