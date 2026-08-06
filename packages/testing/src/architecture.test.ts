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
  { external: readonly string[]; internal: readonly string[]; forbidden?: readonly RegExp[] }
> = {
  "packages/contracts": { external: ["zod", "@ag-ui/core"], internal: [] },
  "packages/domain": { external: [], internal: [] },
  "packages/application": { external: [], internal: ["@chat/contracts", "@chat/domain"] },
  "packages/realtime": { external: [], internal: ["@chat/contracts"] },
  "packages/workflows": {
    external: ["workflow"],
    internal: ["@chat/contracts", "@chat/application"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^@ag-ui\//, /^pi-/, /^@earendil-works\//],
  },
  "packages/pi-runtime": {
    external: [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
    ],
    internal: ["@chat/contracts"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^workflow$/],
  },
  "apps/web": {
    external: ["react", "react-dom", "@tanstack/react-query"],
    internal: ["@chat/contracts"],
    forbidden: [/^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@ag-ui\//],
  },
  "apps/api": {
    external: ["hono", "@hono/node-server", "zod"],
    internal: ["@chat/contracts", "@chat/application"],
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
        const isDevFile = /\.test\.tsx?$/.test(file) || /(^|\/)vite\.config\.ts$/.test(file);
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1] ?? match[2] ?? "";
          if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
          const name = packageName(specifier);
          const rel = relative(repoRoot, file);

          if (isDevFile && devOnlyExternal.includes(name)) continue;

          if (name.startsWith("@chat/")) {
            if (!rule.internal.includes(name)) {
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
