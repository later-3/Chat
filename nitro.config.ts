import { defineConfig } from "nitro";

/**
 * `serverDir`告诉Nitro服务端源码放在哪里。设置为`src`后，Nitro默认扫描
 * `src/routes`和`src/api`中的HTTP路由文件。
 *
 * `workflow/nitro`在构建时转换`"use workflow"`和`"use step"`函数，
 * 并把Workflow Runtime所需的内部HTTP路由注册到Nitro。
 */
export default defineConfig({
  serverDir: "src",
  modules: ["workflow/nitro"],
  // Keep native SQLite and ONNX assets external to the server bundle while
  // tracing the exact runtime files into `.output`.
  traceDeps: ["mem0ai", "pg", "better-sqlite3", "fastembed*", "onnxruntime-node*"],
  // index.html必须经过Web认证中间件；其余版本化前端资源保持公开，
  // 登录页和PWA安装无需先下载完整应用包。
  publicAssets: [{
    dir: "frontend/dist",
    baseURL: "/",
    maxAge: 0,
    // Nitro把不以`*`开头的ignore解释为相对项目根目录的路径；这里必须使用glob。
    ignore: ["**/index.html", "**/*.test.mjs"],
  }],
  serverAssets: [
    { baseName: "frontend", dir: "frontend/dist", pattern: "index.html" },
    // Workflow-owned Markdown remains the source of truth while built output
    // can materialize private Skills into Chat's runtime data directory.
    { baseName: "workflow-resources", dir: "src/workflows", pattern: "**/*.md" },
  ],
});
