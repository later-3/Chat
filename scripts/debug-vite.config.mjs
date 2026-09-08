import frontendConfig from "../frontend/vite.config.ts";
import { debugRoot, ports } from "./debug-environment.mjs";
import { join } from "node:path";

// Reuse the real React/plugins/proxy config; keep cache and dotenv away from normal Vite.
export default {
  ...frontendConfig,
  cacheDir: join(debugRoot, "vite"),
  envDir: join(debugRoot, "empty-env"),
  server: { ...frontendConfig.server, port: ports.frontend, strictPort: true },
};
