import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The manifest is consumed by the product quality gate. Feature chunks are
    // reviewed by bytes and entrypoint relationships, not by Vite's warning text.
    manifest: true,
    chunkSizeWarningLimit: 500,
  },
  server: {
    host: "127.0.0.1",
    port: 5073,
    strictPort: true,
  },
});
