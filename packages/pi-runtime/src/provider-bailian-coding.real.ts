import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { hashCanonical } from "@chat/domain";
import { AgentSessionPiCodingAgentRunner } from "./coding-agent-executor.js";
import { PiExecutorOperationStore } from "./executor-operation-store.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  startPiExecutorOperationRequestSchema,
} from "./executor-service-contract.js";
import { assertRealTestChildAuthorization } from "../../../scripts/ci/real-test-child-guard.mjs";

assertRealTestChildAuthorization({
  mode: "paid",
  commandName: "test:paid:provider:bailian:coding",
  credentials: ["DASHSCOPE_API_KEY"],
});

/**
 * 显式真实门：在临时Workspace中要求完整AgentSession观察、写入并用bash验证文件。
 * 输出已在Journal边界脱敏且有界的命令、路径和工具结果证据；不输出Prompt、
 * Provider Payload、凭据或隐藏推理。
 */
let root: string | undefined;
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const GOVERNANCE_FRAGMENTS = [
  {
    promptFragmentRevisionId: "pfr_builtincontrolledprojectchangev3",
    sha256: "6dcdeed142c38bb6a674e061011b0b4b0693e31409e1c3ef3b56c6e7b4f2a578",
    path: "prompts/fragments/rules/controlled-project-change.md",
    marker: "计划、旧任务或模型判断不能扩大范围",
  },
  {
    promptFragmentRevisionId: "pfr_builtinengineeringevidencev3",
    sha256: "30b7515dbf151a0b55fb6c531f3db0aef69b02692daa6eb5bb8285f7431404f7",
    path: "prompts/fragments/requirements/engineering-evidence.md",
    marker: "Mock只证明调用合同",
  },
  {
    promptFragmentRevisionId: "pfr_builtinmultiagentdeliveryv3",
    sha256: "f761911e1ff73182e7632f569d63a556b5e89fccc27a53f139def0d30879ebcf",
    path: "prompts/fragments/experience/multi-agent-delivery.md",
    marker: "多个同模型Agent的一致意见不能按票数",
  },
] as const;

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("真实百炼Pi Coding Agent（付费，显式运行）", () => {
  it("3个治理Fragment进入AgentSession并留下真实文件与bash Journal", async () => {
    root = await mkdtemp(join(tmpdir(), "chat-pi-coding-real-"));
    const workspace = join(root, "workspace");
    const marker = `PI_TRACE_GATE_${randomUUID().replaceAll("-", "")}`;
    const governanceBodies = await Promise.all(
      GOVERNANCE_FRAGMENTS.map((fragment) => readFile(resolve(REPO_ROOT, fragment.path), "utf8")),
    );
    const governanceSystemPromptAppend = governanceBodies.join("\n\n");
    for (const fragment of GOVERNANCE_FRAGMENTS) {
      expect(governanceSystemPromptAppend).toContain(fragment.marker);
    }
    const governancePromptSha256 = hashCanonical("governance-provider-real-prompt.v1", {
      fragments: GOVERNANCE_FRAGMENTS.map(({ promptFragmentRevisionId, sha256 }) => ({
        promptFragmentRevisionId,
        sha256,
      })),
      systemPromptAppend: governanceSystemPromptAppend,
    });
    await mkdir(workspace);
    await writeFile(
      join(workspace, "TASK.md"),
      [
        "Inspect this TASK.md with an available Pi workspace tool; the required marker is not present in the execution contract.",
        "Copy only the marker from the final line into result.txt. Prefer the Pi write tool for this edit.",
        "Then use the Pi bash tool to verify result.txt exists and exactly matches the discovered marker.",
        "Then report completion.",
        `MARKER=${marker}`,
        "",
      ].join("\n"),
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
          purpose: "从TASK.md发现未在合同中提供的marker，写入result.txt，并用Pi bash做最终验证",
          dependsOn: [],
          inputRefs: [],
          expectedOutput: "result.txt只包含从TASK.md读取的marker，并报告实际工具与验证结果",
          successCriteria: [
            "从TASK.md读取合同中没有提供的marker",
            "创建只包含该marker的result.txt",
            "使用bash工具验证result.txt与marker精确一致",
          ],
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
      nodePrompt: {
        promptAssemblyId: "pma_codinggovernancereal",
        promptAssemblySha256: governancePromptSha256,
        definitionNodeId: "planning.execute",
        nodeAssemblySha256: governancePromptSha256,
        profileVersion: "workflow-agent-prompt-profile.v1",
        systemPromptAppend: governanceSystemPromptAppend,
      },
    });
    await store.createOrGet(request);
    await store.markRunning(request.operationId);
    const runner = new AgentSessionPiCodingAgentRunner();
    let result: Awaited<ReturnType<typeof runner.run>>;
    try {
      result = await runner.run({
        request,
        cwd: workspace,
        agentDir: join(root, "agent"),
        sessionsDir: join(root, "sessions"),
        store,
        signal: AbortSignal.timeout(CODING_EXECUTOR_TIMEOUT_MS_PER_STEP),
      });
    } catch (error) {
      const events = store.getEvents(request.operationId);
      console.error(
        `[provider-coding-failure] ${JSON.stringify({
          errorCode:
            error instanceof Error && "code" in error ? String(error.code) : "unknown_error",
          eventTypes: events.map((event) => event.type),
          providerRequests: events.filter((event) => event.type === "provider.started").length,
          providerCompletions: events.filter((event) => event.type === "provider.completed").length,
          toolNames: events.flatMap((event) =>
            event.type === "tool.intent_persisted" ? [event.toolName] : [],
          ),
          messageRoles: events.flatMap((event) =>
            event.type === "message.completed" ? [event.role] : [],
          ),
        })}`,
      );
      throw error;
    }
    await store.complete(request.operationId, result, 0);

    expect((await readFile(join(workspace, "result.txt"), "utf8")).trim()).toBe(marker);
    const events = store.getEvents(request.operationId);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_item, index) => index + 1),
    );
    const tools = events.flatMap((event) =>
      event.type === "tool.intent_persisted" ? [event.toolName] : [],
    );
    const sessionStarted = events.find((event) => event.type === "session.started");
    expect(sessionStarted?.type).toBe("session.started");
    if (sessionStarted?.type !== "session.started") throw new Error("missing session.started");
    expect(sessionStarted.enabledTools).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "edit", "write", "bash"]),
    );
    // 具体选择read/write还是等价bash是Provider行为，不冻结成产品合同；完成门验证
    // AgentSession确实开放全部批准工具，并且实际工具调用的输入/结果完整成对进入Journal。
    expect(tools).toContain("bash");
    const intents = events.filter((event) => event.type === "tool.intent_persisted");
    const terminalToolCallIds = new Set(
      events.flatMap((event) =>
        event.type === "tool.completed" || event.type === "tool.failed" ? [event.toolCallId] : [],
      ),
    );
    expect(intents.length).toBeGreaterThanOrEqual(2);
    expect(intents.every((event) => terminalToolCallIds.has(event.toolCallId))).toBe(true);
    expect(events.some((event) => event.type === "provider.started")).toBe(true);
    expect(events.some((event) => event.type === "provider.completed")).toBe(true);
    expect(events.some((event) => event.type === "session.settled")).toBe(true);
    const observable: Array<{
      sequence: number;
      phase: "call" | "result";
      toolName: (typeof tools)[number];
      display: string;
      truncated: boolean;
      durationMs?: number;
    }> = [];
    for (const event of events) {
      if (event.type === "tool.intent_persisted") {
        observable.push({
          sequence: event.sequence,
          phase: "call",
          toolName: event.toolName,
          display: event.inputDisplay.slice(0, 800),
          truncated: event.inputDisplayTruncated,
        });
      }
      if (event.type === "tool.completed" || event.type === "tool.failed") {
        observable.push({
          sequence: event.sequence,
          phase: "result",
          toolName: event.toolName,
          display: event.resultDisplay.slice(0, 800),
          truncated: event.resultDisplayTruncated,
          durationMs: event.durationMs,
        });
      }
    }
    const displays = observable.map((item) => item.display).join("\n");
    expect(displays).toContain("TASK.md");
    expect(displays).toContain("result.txt");
    expect(displays).toContain(marker);
    expect(
      observable.some(
        (item) => item.phase === "result" && item.toolName === "bash" && item.display.length > 0,
      ),
    ).toBe(true);
    expect(displays).not.toMatch(/(?:api[_-]?key|authorization)\s*[:=]\s*(?!\[REDACTED\])/iu);
    console.log(
      JSON.stringify({
        provider: "bailian",
        model: "qwen3.7-plus",
        operationId: request.operationId,
        governanceFragmentRevisionIds: GOVERNANCE_FRAGMENTS.map(
          (fragment) => fragment.promptFragmentRevisionId,
        ),
        enabledTools: sessionStarted.enabledTools,
        eventCount: events.length,
        toolNames: tools,
        eventTypes: events.map((event) => event.type),
        observable,
      }),
    );
  });
});
