import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 架构依赖方向测试（工程规范§2）。
 *
 * 固定依赖方向：
 *   Web/Hono/Vercel/pi Adapters → Application → Domain + Contracts
 *
 * Domain不得依赖React、Hono、数据库、Vercel Workflow、AG-UI或pi；
 * Web只依赖公开Contracts，不导入服务端实现。
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

/** 每个源码目录允许的外部运行时依赖与@chat内部依赖。 */
const rules: Record<
  string,
  {
    external: readonly string[];
    internal: readonly string[];
    /** 仅测试文件允许的额外内部依赖（集成测试用真实Adapter验证用例）。 */
    devInternal?: readonly string[];
    forbidden?: readonly RegExp[];
  }
> = {
  "packages/contracts": { external: ["zod", "@ag-ui/core"], internal: [] },
  "packages/domain": { external: [], internal: [] },
  "packages/application": {
    external: [],
    internal: ["@chat/contracts", "@chat/domain"],
    devInternal: ["@chat/product-store-json"],
  },
  "packages/realtime": { external: [], internal: ["@chat/contracts"] },
  "packages/workflows": {
    external: [],
    internal: ["@chat/contracts", "@chat/application"],
    forbidden: [
      /^react/,
      /^hono$/,
      /^@hono\//,
      /^workflow$/,
      /^@ag-ui\//,
      /^pi-/,
      /^@earendil-works\//,
    ],
  },
  "packages/pi-runtime": {
    external: [],
    internal: ["@chat/contracts"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@earendil-works\//],
  },
  "packages/product-store-json": {
    external: ["zod"],
    internal: ["@chat/contracts", "@chat/domain", "@chat/application"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@ag-ui\//],
  },
  "apps/web": {
    // workbox-window 进入浏览器运行时bundle（PWA注册与更新提示），属于运行时依赖
    external: ["react", "react-dom", "@tanstack/react-query", "workbox-window"],
    internal: ["@chat/contracts"],
    forbidden: [/^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@ag-ui\//],
  },
  "apps/api": {
    external: ["hono", "@hono/node-server", "zod"],
    internal: [
      "@chat/contracts",
      "@chat/application",
      "@chat/realtime",
      "@chat/product-store-json",
    ],
    forbidden: [/^react/, /^workflow$/, /^pi-/],
  },
};

/** 测试与构建配置等dev文件额外允许的dev依赖（Mock只能证明调用合同）。 */
const devOnlyExternal = [
  "vitest",
  "vite",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "@testing-library/react",
  "@testing-library/dom",
  "jsdom",
  // P1.2：PWA构建插件与真实浏览器E2E
  "vite-plugin-pwa",
  "@playwright/test",
];

const importPattern = /(?:import|export)[^'"]*from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (entry === "node_modules" || entry === "dist") continue;
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

describe("架构依赖方向", () => {
  for (const [dir, rule] of Object.entries(rules)) {
    it(`${dir} 不引入越界依赖`, () => {
      const files = collectSourceFiles(resolve(repoRoot, dir));
      expect(files.length, `${dir} 应至少有一个源码文件`).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const file of files) {
        const isDevFile =
          /\.(test|spec)\.tsx?$/.test(file) ||
          /(^|\/)vite\.config\.ts$/.test(file) ||
          /(^|\/)playwright\.config\.ts$/.test(file);
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1] ?? match[2] ?? "";
          if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
          // 构建插件生成的虚拟模块（如virtual:pwa-register）由对应插件依赖钉住
          if (specifier.startsWith("virtual:")) continue;
          const name = packageName(specifier);
          const rel = relative(repoRoot, file);

          if (isDevFile && devOnlyExternal.includes(name)) continue;

          if (name.startsWith("@chat/")) {
            const devAllowed = isDevFile && (rule.devInternal?.includes(name) ?? false);
            if (!rule.internal.includes(name) && !devAllowed) {
              violations.push(`${rel}: 不允许依赖 ${name}`);
            }
            continue;
          }
          if (rule.forbidden?.some((pattern) => pattern.test(specifier))) {
            violations.push(`${rel}: 禁止依赖 ${specifier}`);
            continue;
          }
          if (!rule.external.includes(name)) {
            violations.push(`${rel}: 未声明的外部依赖 ${specifier}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it("domain的package.json不声明运行时依赖", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/domain/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
