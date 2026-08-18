import { defineConfig } from "tsdown";

const HOST_EXTERNALS = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/dsh-llm",
];

const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
  "@deepseek-ai/dsh-client-runtime/client",
];

export default defineConfig([
  {
    name: "@chat/dsh-lifeos-bridge",
    entry: { "dsh-bundle": "src/index.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node22",
    dts: false,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: HOST_EXTERNALS, onlyBundle: false },
    outputOptions: { entryFileNames: "dsh-bundle.js" },
  },
  {
    name: "@chat/dsh-lifeos-bridge/client",
    entry: { client: "src/client/index.tsx" },
    outDir: "dist",
    format: "cjs",
    platform: "browser",
    target: "es2022",
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: CLIENT_EXTERNALS, onlyBundle: false },
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner:
        'window.__ModuleLoader__.load({ id: "@chat/dsh-lifeos-bridge", factory: (require) => {',
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
