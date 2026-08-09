import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

const mainChainSymbols = [
  { file: "apps/web/src/real/use-real-chain.ts", symbol: "sendMessage" },
  { file: "apps/web/src/api/client.ts", symbol: "apiSubmitMessage" },
  {
    file: "packages/application/src/session-message-use-cases.ts",
    symbol: "submitUserMessage",
  },
  { file: "apps/api/src/outbox-dispatcher.ts", symbol: "dispatchStart" },
  {
    file: "packages/workflows/src/planning-execution-workflow.ts",
    symbol: "planningExecutionWorkflow",
  },
  { file: "apps/web/src/api/client.ts", symbol: "apiSubmitDecision" },
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

  it("关键跨层源码保留中文调试导航注释", () => {
    const files = [
      "apps/web/src/components/RealWorkspace.tsx",
      "apps/web/src/real/use-real-chain.ts",
      "apps/api/src/product-routes.ts",
      "apps/api/src/outbox-dispatcher.ts",
      "apps/api/src/internal-runtime-router.ts",
      "packages/workflows/src/runtime-server.ts",
      "packages/workflows/src/workflow-result-steps.ts",
    ];
    for (const file of files) {
      expect(read(file), `${file} 应解释关键调试边界`).toContain("调试导航");
    }
  });
});
