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
const agentGovernanceMap = read("docs/agent-governance/README.md");
const agentGovernanceStandard = read("docs/agent-governance/standards.md");
const agentGovernanceExemplars = read("docs/agent-governance/exemplars/README.md");
const agentGovernanceSourceReports = ["pi.md", "nanoclaw.md", "vercel-ai-sdk.md", "openai-codex.md"]
  .map((name) => read(`docs/agent-governance/exemplars/${name}`))
  .join("\n");
const governancePromptPacks = [
  read("prompts/fragments/rules/controlled-project-change.md"),
  read("prompts/fragments/requirements/engineering-evidence.md"),
  read("prompts/fragments/experience/multi-agent-delivery.md"),
];
const engineeringStandards = read("docs/engineering-standards.md");
const engineeringGovernanceSkill = read(".agents/skills/chat-engineering-governance/SKILL.md");
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

  it("README暴露Agent治理Map且Map路由规范、证据与既有事实源", () => {
    expect(readme).toContain("./docs/agent-governance/README.md");
    expect(agentGovernanceMap).toContain("agent-governance-map.v0.5");
    for (const target of [
      "./standards.md",
      "./basis-and-evidence.md",
      "./exemplars/README.md",
      "../../AGENTS.md",
      "../../PROJECT_LESSONS.md",
      "../engineering-standards.md",
      "../architecture/technology-contract.md",
    ]) {
      expect(agentGovernanceMap, `Agent治理Map应路由到 ${target}`).toContain(target);
    }
    for (let index = 1; index <= 11; index += 1) {
      expect(agentGovernanceStandard, `Agent治理规范应保留稳定规则组 S${index}`).toContain(
        `## S${index} `,
      );
    }
    for (const exemplar of [
      "./pi.md",
      "./nanoclaw.md",
      "./vercel-ai-sdk.md",
      "./openai-codex.md",
    ]) {
      expect(agentGovernanceExemplars, `标杆横向抽取应路由到 ${exemplar}`).toContain(exemplar);
    }
  });

  it("仓库Skill以渐进披露方式路由治理事实而不复制S1-S11", () => {
    expect(engineeringGovernanceSkill).toMatch(
      /^---\nname: chat-engineering-governance\ndescription: .+\n---\n/u,
    );
    for (const target of [
      "../../../docs/agent-governance/README.md",
      "../../../docs/engineering-standards.md",
      "../../../docs/architecture/technology-contract.md",
      "../../../PROJECT_STATE.md",
    ]) {
      expect(engineeringGovernanceSkill, `工程治理Skill应路由到 ${target}`).toContain(target);
    }
    expect(engineeringGovernanceSkill).not.toMatch(/^## S(?:[1-9]|1[01])\b/gmu);
    expect(engineeringGovernanceSkill).toContain("不要在每个内部步骤后要求用户审核");
  });

  it("精选经验逐项声明目的、场景、动作、检查、固定来源和边界", () => {
    const ids = ["A1", "A2", "C1", "Q1", "T1", "T2", "M1", "R1", "U1"];
    const headings = [...agentGovernanceExemplars.matchAll(/^### ([A-Z][0-9]+)\. /gmu)];
    expect(headings.map((match) => match[1])).toEqual(ids);
    for (const [index, heading] of headings.entries()) {
      const start = heading.index!;
      const end = headings[index + 1]?.index ?? agentGovernanceExemplars.length;
      const item = agentGovernanceExemplars.slice(start, end);
      for (const field of [
        "**目的**",
        "**场景**",
        "**执行**",
        "**Sub-agent 检查**",
        "**固定来源**",
        "**边界**",
      ]) {
        expect(item, `${heading[1]} 应包含 ${field}`).toContain(field);
      }
      const fixedSources = [
        ...item.matchAll(/https:\/\/github\.com\/[^)\s]+\/(?:blob|tree)\/[a-f0-9]{40}\/[^)\s]+/gu),
      ].map((match) => match[0]);
      expect(
        fixedSources.length,
        `${heading[1]} 至少需要两个固定源码或文档来源`,
      ).toBeGreaterThanOrEqual(2);
      for (const source of fixedSources) {
        expect(agentGovernanceSourceReports, `${heading[1]} 来源应先存在于固定项目报告`).toContain(
          source,
        );
      }
    }
    for (const pack of governancePromptPacks) {
      const selectedIds = pack.match(/经验索引：([^；]+)/u)?.[1]?.match(/[A-Z][0-9]+/gu) ?? [];
      expect(selectedIds.length).toBeGreaterThan(0);
      expect(selectedIds.every((id) => ids.includes(id))).toBe(true);
    }
  });

  it("v0.2规范保留Chat具体质量入口和关键反例", () => {
    expect(agentGovernanceStandard).toContain("agent-engineering-standard.v0.2");
    for (const heading of [
      "### 2.1 架构与设计质量门",
      "### 3.1 代码质量门",
      "### 8.1 测试用例质量门",
    ]) {
      expect(engineeringStandards, `Chat工程规范应包含 ${heading}`).toContain(heading);
    }
    for (const rejection of ["第二事实源", "Service-per-method", "巨型Snapshot", "事后合理化"]) {
      expect(engineeringStandards, `Chat工程规范应保留可判定反例 ${rejection}`).toContain(
        rejection,
      );
    }
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
        ".agents/skills/chat-engineering-governance/SKILL.md",
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
