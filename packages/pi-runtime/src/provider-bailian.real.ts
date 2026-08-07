import "../../../scripts/load-env.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  B2_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  B2_PLANNER_TOKEN_BUDGET,
  PROVIDER_MODEL,
  type ExecutionContract,
  type PlanningInputDto,
} from "@chat/contracts";
import { loadBailianConfig, isBailianReady } from "./config.js";
import { runPiPlanner } from "./planner.js";
import { runPiExecutor } from "./executor.js";

/**
 * 真实Provider门（任务书§20.2）：pnpm test:provider:bailian。
 *
 * - 真实调用百炼qwen3.7-plus完成Planner与Executor（真实pi Agent loop）。
 * - 缺少DASHSCOPE_API_KEY时明确失败并给出配置方法，绝不Skip。
 * - 付费调用不自动重试；报告实际调用次数、脱敏请求ID、耗时与usage。
 * - 不记录Prompt、消息正文、工具参数正文、Key或隐藏推理。
 */

const config = loadBailianConfig(process.env);
const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const evidence: Record<string, unknown> = {
  provider: "bailian",
  model: PROVIDER_MODEL,
  endpointHost: config.endpointHost,
  startedAt: new Date().toISOString(),
  calls: [] as unknown[],
};

function recordCall(entry: unknown): void {
  (evidence["calls"] as unknown[]).push(entry);
}

function writeEvidence(): void {
  const dir = resolve(repoRoot, ".data/provider-evidence");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `bailian-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(`[provider-evidence] ${file}`);
}

describe("真实百炼qwen3.7-plus（付费，显式运行）", () => {
  it("缺少DASHSCOPE_API_KEY时明确失败并说明配置方法", () => {
    if (!isBailianReady(config)) {
      writeEvidence();
      throw new Error(
        "缺少DASHSCOPE_API_KEY：请在仓库根.env中配置百炼按量付费或业务空间Key后重跑 pnpm test:provider:bailian（本测试不Skip）",
      );
    }
  });

  it("Planner经真实pi Agent loop产生Schema合法候选", async () => {
    if (!isBailianReady(config)) throw new Error("缺少DASHSCOPE_API_KEY");
    const planningInput: PlanningInputDto = {
      schemaVersion: "chat-internal-runtime.v1",
      productRunId: "run_providergate" as never,
      attemptId: "att_providergate" as never,
      inputRunRevision: 2,
      inputManifestSha256: "d".repeat(64),
      sourceMessageRef: { messageId: "msg_providergate" as never, sha256: "a".repeat(64) },
      sourceMessageText:
        "本周完成了登录模块联调并修复了两个崩溃问题；下周计划做支付对接。请整理为一份Markdown周报，必须包含“风险与下一步”。",
      planRevision: 1,
      limits: { maxTurns: 1, timeoutMs: 120_000, tokenBudget: B2_PLANNER_TOKEN_BUDGET },
      promptTemplateVersion: "planner-prompt.v1",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
    };
    const result = await runPiPlanner({ config, planningInput });
    recordCall({
      node: "planner",
      kind: result.kind,
      durationMs: result.durationMs,
      httpStatus: result.providerMeta.httpStatus,
      providerRequestId: result.providerMeta.providerRequestId,
      providerCallCount: result.providerCallCount,
      usage: result.usage,
    });
    writeEvidence();
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.objective.length).toBeGreaterThan(0);
      expect(result.candidate.steps.length).toBeGreaterThan(0);
      for (const step of result.candidate.steps) {
        for (const capability of step.requestedCapabilities) {
          expect(capability).toBe(EXECUTION_CAPABILITY_MARKDOWN_COMPOSE);
        }
      }
      expect(result.providerCallCount).toBe(1);
      expect(result.providerMeta.httpStatus).toBeGreaterThanOrEqual(200);
      expect(result.providerMeta.httpStatus).toBeLessThan(300);
      expect(result.providerMeta.providerRequestId).toMatch(/^[A-Za-z0-9-]{1,128}$/);
      if (result.usage === undefined) throw new Error("Planner响应缺少真实usage");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    }
  }, 180_000);

  it("Executor经真实pi Agent loop按Execution Contract产出候选", async () => {
    if (!isBailianReady(config)) throw new Error("缺少DASHSCOPE_API_KEY");
    const contract: ExecutionContract = {
      schemaVersion: "execution-contract.v1",
      executionContractId: "exc_providergate" as never,
      productRunId: "run_providergate" as never,
      approvedPlanId: "pln_providergate" as never,
      approvedPlanRevision: 1,
      approvedPlanSha256: "b".repeat(64),
      approvalDecisionId: "dec_providergate" as never,
      steps: [
        {
          stepId: "step-1",
          title: "整理本周进展",
          purpose: "把原始进展整理为结构化要点",
          dependsOn: [],
          inputRefs: [],
          expectedOutput: "要点清单",
          successCriteria: ["覆盖登录联调与崩溃修复两个要点"],
          capabilityRefs: [EXECUTION_CAPABILITY_MARKDOWN_COMPOSE],
        },
      ],
      completionCriteria: ["周报包含风险与下一步"],
      capabilityRefs: [EXECUTION_CAPABILITY_MARKDOWN_COMPOSE],
      limits: {
        maxTurnsPerStep: 1,
        timeoutMsPerStep: 120_000,
        tokenBudgetPerStep: B2_EXECUTOR_TOKEN_BUDGET_PER_STEP,
      },
      sha256: "c".repeat(64),
      revision: 1,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    const result = await runPiExecutor({
      config,
      contract,
      stepId: "step-1",
      dependencyResults: [],
    });
    recordCall({
      node: "executor",
      kind: result.kind,
      durationMs: result.durationMs,
      httpStatus: result.providerMeta.httpStatus,
      providerRequestId: result.providerMeta.providerRequestId,
      providerCallCount: result.providerCallCount,
      usage: result.usage,
    });
    writeEvidence();
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.stepId).toBe("step-1");
      expect(result.candidate.sections.length).toBeGreaterThan(0);
      expect(result.candidate.successCriteriaEvidence.length).toBeGreaterThan(0);
      expect(result.providerCallCount).toBe(1);
      expect(result.providerMeta.httpStatus).toBeGreaterThanOrEqual(200);
      expect(result.providerMeta.httpStatus).toBeLessThan(300);
      expect(result.providerMeta.providerRequestId).toMatch(/^[A-Za-z0-9-]{1,128}$/);
      if (result.usage === undefined) throw new Error("Executor响应缺少真实usage");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    }
    const calls = evidence["calls"] as unknown[];
    console.log(
      `[provider-evidence] 真实调用次数: ${calls.length}（planner=1, executor=1，无自动重试）`,
    );
  }, 180_000);
});
