import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODING_EXECUTOR_MAX_TURNS_PER_STEP,
  CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
  CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  executionContractSchema,
} from "@chat/contracts";
import { computeExecutionInputManifestSha256, hashCanonical } from "@chat/domain";
import {
  assertExecutorWorkspacePath,
  executorShellEnvironment,
  toObservableTraceDisplay,
  type PiCodingAgentRunInput,
  type PiCodingAgentRunner,
} from "./coding-agent-executor.js";
import { createPiExecutorServiceClient } from "./executor-service-client.js";
import {
  PiExecutorOperationConflictError,
  PiExecutorOperationNotFoundError,
  PiExecutorOperationStore,
  hashExecutorValue,
} from "./executor-operation-store.js";
import { createPiExecutorService } from "./executor-service.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  startPiExecutorOperationRequestSchema,
  type StartPiExecutorOperationRequest,
} from "./executor-service-contract.js";

const CONTENT_MARKER = "PRIVATE_EXECUTION_BODY_MUST_NOT_ENTER_EVENTS";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-pi-executor-test-"));
  roots.push(root);
  return root;
}

function contract() {
  const now = "2026-08-18T00:00:00.000Z";
  const body = {
    schemaVersion: "execution-contract.v1",
    executionContractId: "exc_test1",
    productRunId: "run_test1",
    approvedPlanId: "pln_test1",
    approvedPlanRevision: 1,
    approvedPlanSha256: "a".repeat(64),
    approvalDecisionId: "dec_test1",
    steps: [
      {
        stepId: "step-1",
        title: "执行测试",
        purpose: CONTENT_MARKER,
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "产生结果",
        successCriteria: ["结果存在"],
        capabilityRefs: [EXECUTION_CAPABILITY_MARKDOWN_COMPOSE],
      },
    ],
    completionCriteria: ["完成测试"],
    capabilityRefs: [EXECUTION_CAPABILITY_MARKDOWN_COMPOSE],
    limits: {
      maxTurnsPerStep: CODING_EXECUTOR_MAX_TURNS_PER_STEP,
      timeoutMsPerStep: CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
      tokenBudgetPerStep: CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
    },
    sha256: "b".repeat(64),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  body.sha256 = hashCanonical("execution-contract.v1", {
    productRunId: body.productRunId,
    approvedPlanId: body.approvedPlanId,
    approvedPlanRevision: body.approvedPlanRevision,
    approvedPlanSha256: body.approvedPlanSha256,
    approvalDecisionId: body.approvalDecisionId,
    steps: body.steps,
    completionCriteria: body.completionCriteria,
    capabilityRefs: body.capabilityRefs,
    limits: body.limits,
  });
  return executionContractSchema.parse(body);
}

function request(): StartPiExecutorOperationRequest {
  const executionContract = contract();
  return startPiExecutorOperationRequestSchema.parse({
    schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
    operationId: "pio_test1",
    executionAttemptId: "att_test1",
    inputManifestSha256: inputManifest(executionContract),
    contract: executionContract,
    stepId: "step-1",
    contextItems: [],
    dependencyResults: [],
  });
}

function inputManifest(executionContract: ReturnType<typeof contract>): string {
  return computeExecutionInputManifestSha256({
    executionContractId: executionContract.executionContractId,
    approvedPlanSha256: executionContract.approvedPlanSha256,
    stepId: "step-1",
    inputRefs: [],
    dependencyRefs: [],
    promptTemplateVersion: "executor-coding-agent-prompt.v1",
    modelConfigVersion: "bailian.qwen3.7-plus.v1",
  });
}

describe("PiExecutorOperationStore", () => {
  it("同一Operation请求幂等，不同请求Hash冲突", async () => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    const first = await store.createOrGet(request());
    const second = await store.createOrGet(request());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshot.requestSha256).toBe(first.snapshot.requestSha256);

    const changed = startPiExecutorOperationRequestSchema.parse({
      ...request(),
      inputManifestSha256: "d".repeat(64),
    });
    await expect(store.createOrGet(changed)).rejects.toBeInstanceOf(
      PiExecutorOperationConflictError,
    );
  });

  it("重启把未闭合Tool与running Operation收敛为outcome_unknown", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["bash"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_1",
      toolName: "bash",
      inputSha256: hashExecutorValue({ command: CONTENT_MARKER }),
      inputDisplay: JSON.stringify({ command: CONTENT_MARKER }),
      inputDisplayTruncated: false,
    });

    const recovered = await PiExecutorOperationStore.open(directory);
    expect(recovered.getSnapshot("pio_test1").status).toBe("outcome_unknown");
    expect(recovered.getEvents("pio_test1").map((event) => event.type)).toContain(
      "tool.outcome_unknown",
    );
    const recoveredToolEvents = recovered
      .getEvents("pio_test1")
      .filter(
        (event) => event.type === "tool.intent_persisted" || event.type === "tool.outcome_unknown",
      );
    expect(recoveredToolEvents).toHaveLength(2);
    expect(recoveredToolEvents.every((event) => event.inputDisplay.includes(CONTENT_MARKER))).toBe(
      true,
    );
  });
});

describe("Executor Workspace与Shell环境边界", () => {
  it("可见Trace保留命令与路径，但在Journal前脱敏密钥", () => {
    const display = toObservableTraceDisplay({
      command: "DASHSCOPE_API_KEY=secret-value pnpm test",
      path: "src/index.ts",
      authorization: "Bearer very-secret-token",
      apiKey: "sk-abcdefghijklmnop",
    });
    expect(display.text).toContain("pnpm test");
    expect(display.text).toContain("src/index.ts");
    expect(display.text).not.toContain("secret-value");
    expect(display.text).not.toContain("very-secret-token");
    expect(display.text).not.toContain("sk-abcdefghijklmnop");
    expect(display.truncated).toBe(false);
  });

  it("拒绝..、绝对路径和symlink越过批准Root", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await writeFile(outside, "secret", "utf8");
    await rm(workspace, { force: true });
    await mkdir(workspace);
    await symlink(outside, join(workspace, "escape"));

    await expect(assertExecutorWorkspacePath("../outside", workspace)).rejects.toMatchObject({
      code: "executor.tool_path_outside_workspace",
    });
    await expect(assertExecutorWorkspacePath(outside, workspace)).rejects.toMatchObject({
      code: "executor.tool_path_outside_workspace",
    });
    await expect(assertExecutorWorkspacePath("escape", workspace)).rejects.toMatchObject({
      code: "executor.tool_path_outside_workspace",
    });
    await expect(assertExecutorWorkspacePath("allowed.txt", workspace)).resolves.toBeUndefined();
  });

  it("bash不继承Provider、Runtime或任意父进程秘密", () => {
    process.env.CHAT_TEST_EXECUTOR_SECRET = "must-not-leak";
    try {
      const environment = executorShellEnvironment("/tmp/chat-agent-home");
      expect(environment.HOME).toBe("/tmp/chat-agent-home");
      expect(environment.CHAT_TEST_EXECUTOR_SECRET).toBeUndefined();
      expect(environment.DASHSCOPE_API_KEY).toBeUndefined();
      expect(environment.CHAT_RUNTIME_KEY).toBeUndefined();
    } finally {
      delete process.env.CHAT_TEST_EXECUTOR_SECRET;
    }
  });
});

class FakeRunner implements PiCodingAgentRunner {
  async run(input: PiCodingAgentRunInput) {
    await input.store.setSession(input.request.operationId, "pis_fake1", []);
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "turn.started",
      sessionId: "pis_fake1",
      turnIndex: 0,
    });
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "message.completed",
      sessionId: "pis_fake1",
      messageIndex: 0,
      role: "assistant",
      contentSha256: hashExecutorValue(CONTENT_MARKER),
      stopReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "turn.completed",
      sessionId: "pis_fake1",
      turnIndex: 0,
      durationMs: 2,
    });
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "session.settled",
      sessionId: "pis_fake1",
      turnCount: 1,
      providerRequestCount: 1,
    });
    return {
      stepId: "step-1",
      output: CONTENT_MARKER,
      sections: [{ heading: "执行测试", body: CONTENT_MARKER }],
      successCriteriaEvidence: ["结果存在｜有输出"],
      criteriaEvidence: ["完成测试｜有输出"],
      warnings: [],
    };
  }
}

describe("Pi Executor Service + Client", () => {
  it("Application授权失败时不创建Operation或AgentSession", async () => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    const runtime = createPiExecutorService({
      credential: "rtk_1234567890abcdef",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      authorizeOperation: async () => {
        throw new Error("product authorization rejected");
      },
      runner: new FakeRunner(),
    });
    const submitted = request();
    const response = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/operations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chat-runtime-key": "rtk_1234567890abcdef",
        },
        body: JSON.stringify(submitted),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errorCode: "executor.authorization_failed" });
    expect(() => store.getSnapshot(submitted.operationId)).toThrow(
      PiExecutorOperationNotFoundError,
    );
    await runtime.close();
  });

  it("通过202 + cursor轮询取得结果，并按序交付完整安全事件", async () => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    const runtime = createPiExecutorService({
      credential: "rtk_1234567890abcdef",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      authorizeOperation: async (input) => ({
        schemaVersion: "chat-internal-runtime.v1",
        productRunId: "run_test1" as never,
        executionAttemptId: input.executionAttemptId,
        contract: contract(),
        contextItems: [],
        dependencyRefs: [],
      }),
      runner: new FakeRunner(),
    });
    const events: string[] = [];
    const client = createPiExecutorServiceClient({
      baseUrl: "http://executor.test",
      credential: "rtk_1234567890abcdef",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => await runtime.app.request(url, init),
    });
    const executionContract = contract();
    const result = await client({
      contract: executionContract,
      stepId: "step-1",
      executionAttemptId: "att_test1",
      inputManifestSha256: inputManifest(executionContract),
      contextItems: [],
      dependencyResults: [],
      onEvent: (event) => events.push(event.type),
    });
    expect(result.output).toBe(CONTENT_MARKER);
    expect(events).toEqual([
      "operation.accepted",
      "operation.started",
      "session.started",
      "turn.started",
      "message.completed",
      "turn.completed",
      "session.settled",
      "operation.completed",
    ]);
    expect(
      JSON.stringify(store.getEvents(store.getSnapshot(eventsOperationId(store)).operationId)),
    ).not.toContain(CONTENT_MARKER);
    await runtime.close();
  });
});

function eventsOperationId(store: PiExecutorOperationStore): string {
  const operationId = `pio_${hashExecutorValue({ executionAttemptId: "att_test1" }).slice(0, 32)}`;
  store.getSnapshot(operationId);
  return operationId;
}
