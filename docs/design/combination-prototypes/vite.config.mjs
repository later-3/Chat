import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const root = new URL(".", import.meta.url).pathname;

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        host: resolve(root, "index.html"),
        basecamp: resolve(root, "references/basecamp/index.html"),
        linear: resolve(root, "references/linear/index.html"),
        things: resolve(root, "references/things/index.html"),
        hey: resolve(root, "references/hey/index.html"),
        agentFeed: resolve(root, "references/agent-feed/index.html"),
        heptabase: resolve(root, "references/heptabase/index.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx", "./references/*/src/main.jsx"],
    },
  },
  plugins: [react()],
});
