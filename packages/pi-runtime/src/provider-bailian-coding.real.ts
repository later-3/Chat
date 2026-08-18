import "../../../scripts/load-env.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CODING_EXECUTOR_MAX_TURNS_PER_STEP,
  CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
  CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  EXECUTION_CAPABILITY_SHELL_EXECUTE,
  EXECUTION_CAPABILITY_WORKSPACE_READ,
  EXECUTION_CAPABILITY_WORKSPACE_WRITE,
  executionContractSchema,
} from "@chat/contracts";
import { AgentSessionPiCodingAgentRunner } from "./coding-agent-executor.js";
import { isBailianReady, loadBailianConfig } from "./config.js";
import { PiExecutorOperationStore } from "./executor-operation-store.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  startPiExecutorOperationRequestSchema,
} from "./executor-service-contract.js";

/**
 * 显式真实门：在临时Workspace中要求完整AgentSession读取、写入并用bash验证文件。
 * 不记录Prompt、文件正文、Tool参数/结果或隐藏推理；只输出事件类型、Tool名、Hash和统计。
 */
const config = loadBailianConfig(process.env);
let root: string | undefined;

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("真实百炼Pi Coding Agent（付费，显式运行）", () => {
  it("AgentSession完成read/write/bash工具链并留下连续Journal", async () => {
    if (!isBailianReady(config)) {
      throw new Error(
        "缺少DASHSCOPE_API_KEY：配置后显式运行 pnpm test:provider:bailian:coding（本测试不Skip）",
      );
    }
    root = await mkdtemp(join(tmpdir(), "chat-pi-coding-real-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(
      join(workspace, "TASK.md"),
      "Create result.txt and verify it with the shell.\n",
      "utf8",
    );
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    const contract = executionContractSchema.parse({
      schemaVersion: "execution-contract.v1",
      executionContractId: "exc_codinggate",
      productRunId: "run_codinggate",
      approvedPlanId: "pln_codinggate",
      approvedPlanRevision: 1,
      approvedPlanSha256: "a".repeat(64),
      approvalDecisionId: "dec_codinggate",
      steps: [
        {
          stepId: "step-1",
          title: "完成临时Workspace任务",
          purpose: "读取TASK.md，创建result.txt，并使用bash验证文件存在且非空",
          dependsOn: [],
          inputRefs: [],
          expectedOutput: "result.txt存在，并报告实际工具与验证结果",
          successCriteria: ["读取TASK.md", "创建result.txt", "使用bash验证result.txt非空"],
          capabilityRefs: [
            EXECUTION_CAPABILITY_WORKSPACE_READ,
            EXECUTION_CAPABILITY_WORKSPACE_WRITE,
            EXECUTION_CAPABILITY_SHELL_EXECUTE,
          ],
        },
      ],
      completionCriteria: ["临时Workspace任务有可复核文件结果"],
      workspaceRef: {
        projectId: "prj_codinggate",
        projectResourceId: "prs_codinggate",
        rootId: "root_codinggate",
        revision: 1,
      },
      capabilityRefs: [
        EXECUTION_CAPABILITY_WORKSPACE_READ,
        EXECUTION_CAPABILITY_WORKSPACE_WRITE,
        EXECUTION_CAPABILITY_SHELL_EXECUTE,
      ],
      limits: {
        maxTurnsPerStep: CODING_EXECUTOR_MAX_TURNS_PER_STEP,
        timeoutMsPerStep: CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
        tokenBudgetPerStep: CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
      },
      sha256: "b".repeat(64),
      revision: 1,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    const request = startPiExecutorOperationRequestSchema.parse({
      schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
      operationId: "pio_codinggate",
      executionAttemptId: "att_codinggate",
      inputManifestSha256: "c".repeat(64),
      contract,
      stepId: "step-1",
      contextItems: [],
      dependencyResults: [],
    });
    await store.createOrGet(request);
    await store.markRunning(request.operationId);
    const runner = new AgentSessionPiCodingAgentRunner();
    const result = await runner.run({
      request,
      cwd: workspace,
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      config,
      store,
      signal: AbortSignal.timeout(CODING_EXECUTOR_TIMEOUT_MS_PER_STEP),
    });
    await store.complete(request.operationId, result, 0);

    expect((await readFile(join(workspace, "result.txt"), "utf8")).trim().length).toBeGreaterThan(
      0,
    );
    const events = store.getEvents(request.operationId);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_item, index) => index + 1),
    );
    const tools = events.flatMap((event) =>
      event.type === "tool.intent_persisted" ? [event.toolName] : [],
    );
    expect(tools).toContain("read");
    expect(tools.some((tool) => tool === "write" || tool === "edit")).toBe(true);
    expect(tools).toContain("bash");
    console.log(
      JSON.stringify({
        provider: "bailian",
        model: "qwen3.7-plus",
        operationId: request.operationId,
        eventCount: events.length,
        toolNames: tools,
        eventTypes: events.map((event) => event.type),
      }),
    );
  });
});
