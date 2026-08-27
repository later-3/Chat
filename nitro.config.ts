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
});
