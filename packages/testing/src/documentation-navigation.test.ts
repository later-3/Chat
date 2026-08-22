import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 关键纵向链的文档导航合同。
 *
 * 目的不是把整份Markdown快照化，而是防止函数迁移后调试文档继续指向不存在的入口，
 * 或重新退化为新增几行注释就失效的固定行号。行为和字段仍由各层合同测试负责。
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const readme = read("README.md");
const interaction = read("docs/architecture/frontend-backend-interaction.md");
const debugging = read("docs/debug/local-debug.md");
const navigation = `${interaction}\n${debugging}`;

function collectFiles(root: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (predicate(path)) files.push(path);
    }
  };
  walk(root);
  return files;
}

const mainChainSymbols = [
  {
    file: "packages/dsh-lifeos-bridge/src/adapter.ts",
    symbol: "LifeosLlmAdapter",
  },
  {
    file: "packages/dsh-lifeos-bridge/src/chat-client.ts",
    symbol: "submitMessage",
  },
  {
    file: "packages/application/src/session-message-use-cases.ts",
    symbol: "submitUserMessage",
  },
  { file: "apps/api/src/outbox-dispatcher.ts", symbol: "dispatchStart" },
  {
    file: "packages/workflows/src/planning-execution-workflow.ts",
    symbol: "planningExecutionWorkflow",
  },
  {
    file: "packages/dsh-lifeos-bridge/src/bridge-service.ts",
    symbol: "LifeosBridgeService",
  },
  {
    file: "packages/dsh-lifeos-bridge/src/chat-client.ts",
    symbol: "submitDecision",
  },
  {
    file: "packages/application/src/plan-decision-use-cases.ts",
    symbol: "submitPlanDecision",
  },
  { file: "apps/api/src/outbox-dispatcher.ts", symbol: "dispatchResume" },
  {
    file: "packages/workflows/src/workflow-result-steps.ts",
    symbol: "commitExecutionResultStep",
  },
  {
    file: "packages/application/src/commit-runtime-use-cases.ts",
    symbol: "commitExecutionResult",
  },
] as const;

describe("当前实现文档与调试导航", () => {
  it("README暴露前后端交互和本地调试两个入口", () => {
    expect(readme).toContain("./docs/architecture/frontend-backend-interaction.md");
    expect(readme).toContain("./docs/debug/local-debug.md");
  });

  it.each(mainChainSymbols)("$symbol在源码和导航文档中同时存在", ({ file, symbol }) => {
    expect(read(file), `${file} 应保留 ${symbol} 入口`).toContain(symbol);
    expect(navigation, `交互/调试文档应指向 ${symbol}`).toContain(symbol);
  });

  it("调试指南不使用TypeScript固定行号作为断点合同", () => {
    expect(debugging).not.toMatch(/`(?:apps|packages)\/[^`]+\.tsx?:\d+`/u);
    expect(debugging).toContain("文件 + 函数/路由 + 观察变量");
  });

  it("关键跨层源码保留事实边界注释", () => {
    const files = [
      "packages/dsh-lifeos-bridge/src/adapter.ts",
      "packages/dsh-lifeos-bridge/src/bridge-service.ts",
      "apps/api/src/product-routes.ts",
      "apps/api/src/outbox-dispatcher.ts",
      "apps/api/src/internal-runtime-router.ts",
      "packages/workflows/src/runtime-server.ts",
      "packages/workflows/src/workflow-result-steps.ts",
    ];
    for (const file of files) {
      expect(read(file), `${file} 应解释关键事实边界`).toMatch(
        /(?:调试导航|Product Store|产品事实)/u,
      );
    }
  });

  it("当前事实树不重新收录个人学习、历史任务书或过程截图", () => {
    for (const path of ["learning", "docs/tasks", "docs/design/qa"]) {
      expect(
        collectFiles(resolve(repoRoot, path), () => true),
        `${path} 应只从Git历史按需恢复`,
      ).toEqual([]);
    }
  });

  it("现行Markdown相对链接有效，docs图片必须被正文引用", () => {
    const markdownFiles = [
      ...collectFiles(resolve(repoRoot, "docs"), (path) => extname(path) === ".md"),
      ...[
        "AGENTS.md",
        "PROJECT_CONTEXT.md",
        "PROJECT_LESSONS.md",
        "PROJECT_PLAN.md",
        "PROJECT_STATE.md",
        "README.md",
      ].map((path) => resolve(repoRoot, path)),
    ];
    const linkedFiles = new Set<string>();

    for (const markdownFile of markdownFiles) {
      const source = readFileSync(markdownFile, "utf8");
      expect(source, `${relative(repoRoot, markdownFile)} 不得保存个人绝对路径`).not.toMatch(
        /\/Users\/[^/]+\//u,
      );
      for (const match of source.matchAll(/\]\(([^)]+)\)/gu)) {
        const target = match[1]?.trim() ?? "";
        if (target === "" || target.startsWith("#") || /^[a-z]+:/iu.test(target)) continue;
        const pathPart = target.split("#", 1)[0];
        if (pathPart === undefined || pathPart === "") continue;
        const absoluteTarget = resolve(dirname(markdownFile), decodeURIComponent(pathPart));
        expect(
          existsSync(absoluteTarget),
          `${relative(repoRoot, markdownFile)} 引用了不存在的 ${pathPart}`,
        ).toBe(true);
        linkedFiles.add(relative(repoRoot, absoluteTarget));
      }
    }

    const documentationImages = collectFiles(resolve(repoRoot, "docs"), (path) =>
      [".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(extname(path).toLowerCase()),
    );
    for (const image of documentationImages) {
      expect(
        linkedFiles.has(relative(repoRoot, image)),
        `${relative(repoRoot, image)} 没有正文引用`,
      ).toBe(true);
    }
  });
});
