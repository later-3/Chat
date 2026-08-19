import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 架构依赖方向测试（工程规范§2）。
 *
 * 固定依赖方向：
 *   Hono与服务端Store/Workflow/Memory/Project Adapter → Application → Domain + Contracts
 *   DSH Bridge → public Contracts；pi Adapter → stable runtime Contracts
 *
 * Domain不得依赖React、Hono、数据库、Vercel Workflow、AG-UI或pi；
 * DSH Bridge只依赖公开Contracts，不导入Chat服务端实现。
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
    // Definition/RunSpec网络与Store边界使用strict Zod解析；Domain仍保持零运行时依赖。
    external: ["zod"],
    internal: ["@chat/contracts", "@chat/domain"],
  },
  // realtime的Replay Assembler需要@chat/application的Hash唯一实现（computePlanSha256）
  // 与@chat/domain的canonical hash；不产生反向运行时依赖
  "packages/realtime": {
    external: [],
    internal: ["@chat/contracts", "@chat/application", "@chat/domain"],
  },
  // packages/testing是跨Adapter集成测试与Fixture边界，允许组合全部内部包
  "packages/testing": {
    external: ["@hono/node-server"],
    internal: [
      "@chat/api",
      "@chat/application",
      "@chat/contracts",
      "@chat/domain",
      "@chat/memory-runtime",
      "@chat/pi-runtime",
      "@chat/project-runtime",
      "@chat/product-store-json",
      "@chat/realtime",
      "@chat/workflows",
    ],
  },
  "packages/workflows": {
    // Runtime组合根用Undici显式装配Provider连接预算；它不进入Workflow定义、
    // Product事实或pi适配器，且仍受每个Provider节点的总Abort预算约束。
    external: ["hono", "@hono/node-server", "zod", "workflow", "@workflow/world-local", "undici"],
    internal: [
      "@chat/contracts",
      "@chat/application",
      "@chat/domain",
      // runtime-server 是 Workflow 进程的组合根，负责注入具体 Memory Adapter。
      "@chat/memory-runtime",
      "@chat/pi-runtime",
      "@chat/realtime",
    ],
    devInternal: ["@workflow/builders"],
    forbidden: [/^react/, /^@ag-ui\//, /^pi-/],
  },
  "packages/pi-runtime": {
    // 包根入口仍是Workflow/API使用的轻量Pi Adapter；Hono与Coding Agent只从
    // `@chat/pi-runtime/coding-executor`被独立Executor进程加载。Domain只用于
    // 重算Chat冻结Contract/Manifest/Step Result哈希，不获得产品写入权。
    external: [
      "zod",
      "hono",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-coding-agent",
    ],
    internal: ["@chat/contracts", "@chat/domain"],
    forbidden: [/^react/, /^@hono\//, /^workflow$/],
  },
  "packages/product-store-json": {
    external: ["zod"],
    internal: ["@chat/contracts", "@chat/domain", "@chat/application"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@ag-ui\//],
  },
  "packages/memory-runtime": {
    external: ["zod"],
    // Adapter 可依赖内层 Domain 的 canonical hash / token 预算算法。
    internal: ["@chat/contracts", "@chat/application", "@chat/domain"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@ag-ui\//],
  },
  "packages/project-runtime": {
    external: ["zod"],
    internal: ["@chat/contracts", "@chat/application", "@chat/domain"],
    forbidden: [/^react/, /^hono$/, /^@hono\//, /^workflow$/, /^pi-/, /^@ag-ui\//],
  },
  "packages/dsh-lifeos-bridge": {
    external: [
      "react",
      "zod",
      "@deepseek-ai/cordis",
      "@deepseek-ai/dsh-host-webserver",
      "@deepseek-ai/dsh-llm",
      // 将远端Pi事件投影成DSH原生tool/call + tool/result，供Trajectory消费。
      "@deepseek-ai/dsh-tools",
      // 通过公开SessionQuery读取live/persisted原始日志；Bridge只做Workspace授权、
      // 分页与双侧身份投影，不接管DSH持久化或把日志写入Product Store。
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-session-query",
      "@deepseek-ai/dsh-workspace",
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-layout",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-ui-sidebar",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-trajectory",
      "@deepseek-ai/dsh-client-web-react",
    ],
    internal: ["@chat/contracts"],
    forbidden: [
      /^hono$/,
      /^@hono\//,
      /^workflow$/,
      /^@workflow\//,
      /^@chat\/application(?:\/|$)/,
      /^@chat\/product-store-json(?:\/|$)/,
      /^@chat\/workflows(?:\/|$)/,
      /^@chat\/pi-runtime(?:\/|$)/,
    ],
  },
  "apps/api": {
    external: ["hono", "@hono/node-server", "zod"],
    internal: [
      "@chat/contracts",
      "@chat/application",
      "@chat/domain",
      "@chat/memory-runtime",
      "@chat/realtime",
      "@chat/product-store-json",
      "@chat/pi-runtime",
      "@chat/project-runtime",
      "@chat/workflows",
    ],
    forbidden: [/^react/, /^workflow$/, /^pi-/],
  },
};

/** 测试与构建配置等dev文件额外允许的dev依赖（Mock只能证明调用合同）。 */
const devOnlyExternal = [
  "vitest",
  "react",
  "react-dom",
  "@testing-library/react",
  "@testing-library/dom",
  "@testing-library/user-event",
  "jsdom",
  "@playwright/test",
  "tsdown",
  // B2：workflow bundle预构建脚本（仅开发期）
  "@workflow/builders",
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
          /\.(test|spec|real|e2e)\.tsx?$/.test(file) ||
          /(^|\/)vite\.config\.ts$/.test(file) ||
          /(^|\/)vitest(\.global-setup)?\.ts$/.test(file) ||
          /(^|\/)vitest(\.[a-z-]+)*\.config\.ts$/.test(file) ||
          /(^|\/)playwright(\.[a-z-]+)*\.config\.ts$/.test(file) ||
          /(^|\/)tsdown\.config\.ts$/.test(file) ||
          // 构建/开发期脚本（如workflow bundle预构建），不进入运行时
          /(^|\/)scripts\/[^/]+\.ts$/.test(file);
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
