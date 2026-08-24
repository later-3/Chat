import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODING_EXECUTOR_MAX_TURNS_PER_STEP,
  CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
  CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  agentRuntimeBaselineDtoSchema,
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
import { PiExecutorRemoteError, createPiExecutorServiceClient } from "./executor-service-client.js";
import { projectExecutorStepCandidate } from "./executor.js";
import {
  PiExecutorOperationConflictError,
  PiExecutorJournalIntegrityError,
  PiExecutorOperationNotFoundError,
  PiExecutorOperationOutcomeUnknownError,
  PiExecutorOperationStore,
  PiExecutorToolCallConflictError,
  PiExecutorToolResultConflictError,
  hashExecutorValue,
  validatePiExecutorOperationJournal,
} from "./executor-operation-store.js";
import { createPiExecutorService } from "./executor-service.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  piExecutorEventSchema,
  piExecutorOperationSnapshotSchema,
  startPiExecutorOperationRequestSchema,
  type PiExecutorOperationStatus,
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

function expectedCandidate(output: string) {
  const executionContract = contract();
  return projectExecutorStepCandidate(
    { stepId: "step-1", output },
    executionContract.steps[0]!,
    executionContract.completionCriteria,
    true,
  );
}

async function settleAndComplete(
  store: PiExecutorOperationStore,
  output: string,
  options: {
    readonly turnAlreadyStarted?: boolean;
    readonly providerRequestIndex?: number;
  } = {},
): Promise<void> {
  if (options.turnAlreadyStarted !== true) {
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
  }
  const providerRequestIndex = options.providerRequestIndex ?? 1;
  const providerInputSha256 = hashExecutorValue({ output });
  await store.append("pio_test1", {
    operationId: "pio_test1",
    type: "provider.started",
    sessionId: "pis_test1",
    requestIndex: providerRequestIndex,
    endpointHost: "provider.test",
    inputSha256: providerInputSha256,
  });
  await store.append("pio_test1", {
    operationId: "pio_test1",
    type: "message.completed",
    sessionId: "pis_test1",
    messageIndex: 0,
    role: "assistant",
    contentSha256: hashExecutorValue(output),
    visibleTextSha256: hashExecutorValue(output),
    visibleText: output,
    visibleTextTruncated: false,
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
  await store.append("pio_test1", {
    operationId: "pio_test1",
    type: "provider.completed",
    sessionId: "pis_test1",
    requestIndex: providerRequestIndex,
    endpointHost: "provider.test",
    inputSha256: providerInputSha256,
    httpStatus: 200,
    providerRequestId: "req_settle1",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    stopReason: "stop",
    toolCallCount: 0,
    durationMs: 1,
  });
  await store.append("pio_test1", {
    operationId: "pio_test1",
    type: "turn.completed",
    sessionId: "pis_test1",
    turnIndex: 0,
    durationMs: 1,
  });
  await store.append("pio_test1", {
    operationId: "pio_test1",
    type: "session.settled",
    sessionId: "pis_test1",
    turnCount: 1,
    providerRequestCount: providerRequestIndex,
  });
  await store.complete("pio_test1", expectedCandidate(output), 2);
}

interface MutableJournalFixture {
  readonly request: StartPiExecutorOperationRequest;
  readonly snapshot: Record<string, unknown>;
  readonly events: Array<Record<string, unknown>>;
}

function validJournalForStatus(
  status: PiExecutorOperationStatus,
  journalRequest: StartPiExecutorOperationRequest = request(),
): MutableJournalFixture {
  const createdAt = "2026-08-23T00:00:00.000Z";
  const timestamp = (index: number) =>
    new Date(Date.parse(createdAt) + index * 1_000).toISOString();
  const requestSha256 = hashExecutorValue(journalRequest);
  const events: Array<Record<string, unknown>> = [
    {
      sequence: 1,
      timestamp: createdAt,
      operationId: journalRequest.operationId,
      type: "operation.accepted",
      requestSha256,
    },
  ];
  if (status === "running" || status === "failed" || status === "succeeded") {
    events.push({
      sequence: events.length + 1,
      timestamp: timestamp(events.length),
      operationId: journalRequest.operationId,
      type: "operation.started",
      requestSha256,
    });
  }
  let result: ReturnType<typeof expectedCandidate> | undefined;
  let resultSha256: string | undefined;
  let sessionId: string | undefined;
  if (status === "succeeded") {
    sessionId = "pis_integrity1";
    const runtimeEvents: Array<Record<string, unknown>> = [
      { type: "session.started", sessionId, enabledTools: [] },
      { type: "turn.started", sessionId, turnIndex: 0 },
      {
        type: "provider.started",
        sessionId,
        requestIndex: 1,
        endpointHost: "provider.test",
        inputSha256: hashExecutorValue({ messages: ["完整状态机结果"] }),
      },
      {
        type: "message.completed",
        sessionId,
        messageIndex: 0,
        role: "assistant",
        contentSha256: hashExecutorValue("完整状态机结果"),
        visibleTextSha256: hashExecutorValue("完整状态机结果"),
        visibleText: "完整状态机结果",
        visibleTextTruncated: false,
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        type: "provider.completed",
        sessionId,
        requestIndex: 1,
        endpointHost: "provider.test",
        inputSha256: hashExecutorValue({ messages: ["完整状态机结果"] }),
        httpStatus: 200,
        providerRequestId: "req_integrity1",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        toolCallCount: 0,
        durationMs: 1,
      },
      { type: "turn.completed", sessionId, turnIndex: 0, durationMs: 1 },
      { type: "session.settled", sessionId, turnCount: 1, providerRequestCount: 1 },
    ];
    for (const runtimeEvent of runtimeEvents) {
      events.push({
        ...runtimeEvent,
        sequence: events.length + 1,
        timestamp: timestamp(events.length),
        operationId: journalRequest.operationId,
      });
    }
    result = projectExecutorStepCandidate(
      { stepId: journalRequest.stepId, output: "完整状态机结果" },
      journalRequest.contract.steps[0]!,
      journalRequest.contract.completionCriteria,
      true,
    );
    resultSha256 = hashExecutorValue(result);
    events.push({
      sequence: events.length + 1,
      timestamp: timestamp(events.length),
      operationId: journalRequest.operationId,
      type: "operation.completed",
      requestSha256,
      resultSha256,
      durationMs: 2,
    });
  } else if (status === "failed" || status === "outcome_unknown") {
    events.push({
      sequence: events.length + 1,
      timestamp: timestamp(events.length),
      operationId: journalRequest.operationId,
      type: status === "failed" ? "operation.failed" : "operation.outcome_unknown",
      requestSha256,
      errorCode: status === "failed" ? "executor.session_failed" : "executor.operation_interrupted",
      durationMs: 2,
    });
  }
  return {
    request: journalRequest,
    snapshot: {
      schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
      integrityVersion: "full-operation.v2",
      operationId: journalRequest.operationId,
      requestSha256,
      request: journalRequest,
      status,
      ...(sessionId === undefined ? {} : { sessionId }),
      lastEventSequence: events.length,
      ...(result === undefined ? {} : { result, resultSha256 }),
      ...(status === "failed"
        ? { errorCode: "executor.session_failed" }
        : status === "outcome_unknown"
          ? { errorCode: "executor.operation_interrupted" }
          : {}),
      createdAt,
      updatedAt: events.at(-1)!["timestamp"],
    },
    events,
  };
}

function validateMutableJournal(journal: MutableJournalFixture): void {
  validatePiExecutorOperationJournal({
    request: startPiExecutorOperationRequestSchema.parse(journal.request),
    snapshot: piExecutorOperationSnapshotSchema.parse(journal.snapshot),
    events: journal.events.map((event) => piExecutorEventSchema.parse(event)),
  });
}

function eventOfType(journal: MutableJournalFixture, type: string): Record<string, unknown> {
  const event = journal.events.find((candidate) => candidate["type"] === type);
  if (event === undefined) throw new Error(`测试Journal缺少${type}`);
  return event;
}

function resequence(journal: MutableJournalFixture): void {
  for (const [index, event] of journal.events.entries()) event["sequence"] = index + 1;
  journal.snapshot["lastEventSequence"] = journal.events.length;
}

function nodePrompt() {
  return {
    promptAssemblyId: "pma_executorservice1" as never,
    promptAssemblySha256: "c".repeat(64),
    definitionNodeId: "planning.execute",
    nodeAssemblySha256: "d".repeat(64),
    profileVersion: "executor-coding-agent-prompt.v1",
    systemPromptAppend: "EXECUTOR_USER_LAYER_CANARY：保留验证证据。",
    piSystemPrompt: {
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: "CODING_EXECUTOR_CUSTOM_SYSTEM_PROMPT",
      sha256: "e".repeat(64),
    },
  } as const;
}

function inputManifest(
  executionContract: ReturnType<typeof contract>,
  prompt: ReturnType<typeof nodePrompt> | undefined = undefined,
): string {
  return computeExecutionInputManifestSha256({
    executionContractId: executionContract.executionContractId,
    approvedPlanSha256: executionContract.approvedPlanSha256,
    stepId: "step-1",
    inputRefs: [],
    dependencyRefs: [],
    promptTemplateVersion: "executor-coding-agent-prompt.v1",
    modelConfigVersion: "bailian.qwen3.7-plus.v1",
    ...(prompt === undefined
      ? {}
      : {
          promptAssemblyRef: {
            promptAssemblyId: prompt.promptAssemblyId as never,
            sha256: prompt.promptAssemblySha256,
            definitionNodeId: prompt.definitionNodeId,
            nodeAssemblySha256: prompt.nodeAssemblySha256,
          },
        }),
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
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
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

  it("Tool结果一次性落盘失败后complete拒绝成功，fail与重启保持同一unknown终态", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    let failToolResultOnce = true;
    const store = await PiExecutorOperationStore.open(directory, {
      beforePersist: (evidence) => {
        if (failToolResultOnce && evidence.lastEventType === "tool.completed") {
          failToolResultOnce = false;
          throw new Error("injected tool result journal failure");
        }
      },
    });
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["bash"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_once",
      toolName: "bash",
      inputSha256: hashExecutorValue({ command: "pnpm test" }),
      inputDisplay: JSON.stringify({ command: "pnpm test" }),
      inputDisplayTruncated: false,
    });
    await expect(
      store.append("pio_test1", {
        operationId: "pio_test1",
        type: "tool.completed",
        sessionId: "pis_test1",
        turnIndex: 0,
        toolCallId: "call_once",
        toolName: "bash",
        inputSha256: hashExecutorValue({ command: "pnpm test" }),
        resultSha256: hashExecutorValue({ output: "passed" }),
        resultDisplay: "passed",
        resultDisplayTruncated: false,
        durationMs: 5,
      }),
    ).rejects.toThrow("injected tool result journal failure");

    await expect(
      store.complete(
        "pio_test1",
        {
          stepId: "step-1",
          output: "候选不能提交",
          sections: [{ heading: "执行测试", body: "候选不能提交" }],
          successCriteriaEvidence: ["结果存在｜有输出"],
          criteriaEvidence: ["完成测试｜有输出"],
          warnings: [],
        },
        10,
      ),
    ).rejects.toBeInstanceOf(PiExecutorOperationOutcomeUnknownError);
    expect(store.getSnapshot("pio_test1")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "executor.tool_result_persist_failed",
    });
    await store.fail("pio_test1", "executor.session_failed", 11);
    expect(store.getSnapshot("pio_test1")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "executor.tool_result_persist_failed",
    });

    const recovered = await PiExecutorOperationStore.open(directory);
    const unknownEvents = recovered
      .getEvents("pio_test1")
      .filter((event) => event.type === "tool.outcome_unknown");
    expect(unknownEvents).toHaveLength(1);
    expect(recovered.getSnapshot("pio_test1").status).toBe("outcome_unknown");
  });

  it("同一Operation跨Turn复用toolCallId会在新Intent落盘前拒绝", async () => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    const intent = {
      operationId: "pio_test1" as const,
      type: "tool.intent_persisted" as const,
      sessionId: "pis_test1" as const,
      turnIndex: 0,
      toolCallId: "call_reused",
      toolName: "read" as const,
      inputSha256: hashExecutorValue({ path: "README.md" }),
      inputDisplay: JSON.stringify({ path: "README.md" }),
      inputDisplayTruncated: false,
    };
    await store.append("pio_test1", intent);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.completed",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_reused",
      toolName: "read",
      inputSha256: intent.inputSha256,
      resultSha256: hashExecutorValue({ output: "ok" }),
      resultDisplay: "ok",
      resultDisplayTruncated: false,
      durationMs: 1,
    });
    await expect(store.append("pio_test1", { ...intent, turnIndex: 1 })).rejects.toBeInstanceOf(
      PiExecutorToolCallConflictError,
    );
    expect(
      store.getEvents("pio_test1").filter((event) => event.type === "tool.intent_persisted"),
    ).toHaveLength(1);
  });

  it.each([
    ["sessionId", { sessionId: "pis_other1" }],
    ["turnIndex", { turnIndex: 1 }],
    ["toolName", { toolName: "bash" }],
    ["inputSha256", { inputSha256: "f".repeat(64) }],
  ] as const)("Tool Result的%s与耐久Intent不一致时拒绝闭合", async (_field, mismatch) => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read", "bash"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    const intent = {
      operationId: "pio_test1" as const,
      type: "tool.intent_persisted" as const,
      sessionId: "pis_test1" as const,
      turnIndex: 0,
      toolCallId: "call_exact_match",
      toolName: "read" as const,
      inputSha256: hashExecutorValue({ path: "README.md" }),
      inputDisplay: JSON.stringify({ path: "README.md" }),
      inputDisplayTruncated: false,
    };
    await store.append("pio_test1", intent);

    await expect(
      store.append("pio_test1", {
        operationId: "pio_test1",
        type: "tool.completed",
        sessionId: "pis_test1",
        turnIndex: 0,
        toolCallId: intent.toolCallId,
        toolName: intent.toolName,
        inputSha256: intent.inputSha256,
        resultSha256: hashExecutorValue({ output: "ok" }),
        resultDisplay: "ok",
        resultDisplayTruncated: false,
        durationMs: 1,
        ...mismatch,
      }),
    ).rejects.toBeInstanceOf(PiExecutorToolResultConflictError);
    expect(store.getEvents("pio_test1").filter((event) => event.type === "tool.completed")).toEqual(
      [],
    );
  });

  it("full-operation.v2 succeeded的Tool Result缺少inputSha256时open失败关闭", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    const inputSha256 = hashExecutorValue({ path: "README.md" });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_v2_completed",
      toolName: "read",
      inputSha256,
      inputDisplay: JSON.stringify({ path: "README.md" }),
      inputDisplayTruncated: false,
    });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.completed",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_v2_completed",
      toolName: "read",
      inputSha256,
      resultSha256: hashExecutorValue({ output: "ok" }),
      resultDisplay: "ok",
      resultDisplayTruncated: false,
      durationMs: 1,
    });
    await settleAndComplete(store, "v2 completed", { turnAlreadyStarted: true });
    const recordPath = join(directory, "pio_test1.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };
    const toolResult = record.events.find((event) => event["type"] === "tool.completed");
    if (toolResult === undefined) throw new Error("测试缺少Tool Result");
    delete toolResult["inputSha256"];
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(PiExecutorOperationStore.open(directory)).rejects.toBeInstanceOf(
      PiExecutorJournalIntegrityError,
    );
  });

  it("full-operation.v3强制Intent/Result携带一致Capability Ref且损坏时open失败关闭", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    const inputSha256 = hashExecutorValue({ path: "README.md" });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_v3_capability",
      toolName: "read",
      inputSha256,
      inputDisplay: '{"path":"README.md"}',
      inputDisplayTruncated: false,
    });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.completed",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_v3_capability",
      toolName: "read",
      inputSha256,
      resultSha256: hashExecutorValue({ output: "ok" }),
      resultDisplay: "ok",
      resultDisplayTruncated: false,
      durationMs: 1,
    });
    const toolEvents = store
      .getEvents("pio_test1")
      .filter((event) => event.type === "tool.intent_persisted" || event.type === "tool.completed");
    expect(toolEvents).toEqual([
      expect.objectContaining({
        capabilityId: "pi_planning:tool:builtin:read",
        capabilityRefSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({
        capabilityId: "pi_planning:tool:builtin:read",
        capabilityRefSha256: toolEvents[0]?.capabilityRefSha256,
      }),
    ]);
    await settleAndComplete(store, "v3 capability", { turnAlreadyStarted: true });
    const recordPath = join(directory, "pio_test1.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };
    const result = record.events.find((event) => event["type"] === "tool.completed");
    if (result === undefined) throw new Error("测试缺少v3 Tool Result");
    result["capabilityRefSha256"] = "0".repeat(64);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await expect(PiExecutorOperationStore.open(directory)).rejects.toBeInstanceOf(
      PiExecutorJournalIntegrityError,
    );
  });

  it("full-operation.v2 tool.failed缺少inputSha256时persist与open均失败关闭", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    const inputSha256 = hashExecutorValue({ path: "missing.md" });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_v2_failed",
      toolName: "read",
      inputSha256,
      inputDisplay: JSON.stringify({ path: "missing.md" }),
      inputDisplayTruncated: false,
    });
    const failedWithoutInputSha256 = {
      operationId: "pio_test1" as const,
      type: "tool.failed" as const,
      sessionId: "pis_test1" as const,
      turnIndex: 0,
      toolCallId: "call_v2_failed",
      toolName: "read" as const,
      resultSha256: hashExecutorValue({ error: "not found" }),
      resultDisplay: "not found",
      resultDisplayTruncated: false,
      errorCode: "executor.tool_failed",
      durationMs: 1,
    };
    await expect(store.append("pio_test1", failedWithoutInputSha256)).rejects.toBeInstanceOf(
      PiExecutorToolResultConflictError,
    );
    expect(store.getEvents("pio_test1").some((event) => event.type === "tool.failed")).toBe(false);

    await store.append("pio_test1", { ...failedWithoutInputSha256, inputSha256 });
    await settleAndComplete(store, "v2 failed", { turnAlreadyStarted: true });
    const recordPath = join(directory, "pio_test1.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };
    const toolResult = record.events.find((event) => event["type"] === "tool.failed");
    if (toolResult === undefined) throw new Error("测试缺少Tool Failure");
    delete toolResult["inputSha256"];
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(PiExecutorOperationStore.open(directory)).rejects.toBeInstanceOf(
      PiExecutorJournalIntegrityError,
    );
  });

  it.each([
    ["缺少", undefined],
    ["不匹配", "0".repeat(64)],
  ] as const)(
    "full-operation.v2 provider.failed的inputSha256%s时append持久化失败关闭",
    async (_case, failedInputSha256) => {
      const root = await temporaryRoot();
      const store = await PiExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request());
      await store.markRunning("pio_test1");
      await store.setSession("pio_test1", "pis_test1", []);
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "turn.started",
        sessionId: "pis_test1",
        turnIndex: 0,
      });
      const inputSha256 = hashExecutorValue({ messages: ["provider failure"] });
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "provider.started",
        sessionId: "pis_test1",
        requestIndex: 1,
        endpointHost: "provider.test",
        inputSha256,
      });
      await expect(
        store.append("pio_test1", {
          operationId: "pio_test1",
          type: "provider.failed",
          sessionId: "pis_test1",
          requestIndex: 1,
          endpointHost: "provider.test",
          ...(failedInputSha256 === undefined ? {} : { inputSha256: failedInputSha256 }),
          errorCode: "executor.provider_failed",
          durationMs: 1,
        }),
      ).rejects.toBeInstanceOf(PiExecutorJournalIntegrityError);
      expect(store.getEvents("pio_test1").some((event) => event.type === "provider.failed")).toBe(
        false,
      );
    },
  );

  it("真正旧v1可缺少Result/Provider inputSha256、settled与可见正文Hash", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    const inputSha256 = hashExecutorValue({ path: "README.md" });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_legacy_result",
      toolName: "read",
      inputSha256,
      inputDisplay: JSON.stringify({ path: "README.md" }),
      inputDisplayTruncated: false,
    });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.failed",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_legacy_result",
      toolName: "read",
      inputSha256,
      resultSha256: hashExecutorValue({ output: "ok" }),
      resultDisplay: "ok",
      resultDisplayTruncated: false,
      errorCode: "executor.tool_failed",
      durationMs: 1,
    });
    const providerInputSha256 = hashExecutorValue({ messages: ["legacy retry"] });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "provider.started",
      sessionId: "pis_test1",
      requestIndex: 1,
      endpointHost: "provider.test",
      inputSha256: providerInputSha256,
    });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "provider.failed",
      sessionId: "pis_test1",
      requestIndex: 1,
      endpointHost: "provider.test",
      inputSha256: providerInputSha256,
      errorCode: "executor.provider_failed",
      durationMs: 1,
    });
    await settleAndComplete(store, "legacy success", {
      turnAlreadyStarted: true,
      providerRequestIndex: 2,
    });
    const recordPath = join(directory, "pio_test1.json");
    const legacyRecord = JSON.parse(await readFile(recordPath, "utf8")) as {
      schemaVersion: string;
      integrityVersion?: string;
      events: Array<Record<string, unknown>>;
    };
    legacyRecord.schemaVersion = "pi-executor-operation-store.v1";
    delete legacyRecord.integrityVersion;
    const legacyResult = legacyRecord.events.find((event) => event["type"] === "tool.failed");
    if (legacyResult === undefined) throw new Error("测试缺少Tool Result");
    delete legacyResult["inputSha256"];
    const legacyProviderFailure = legacyRecord.events.find(
      (event) => event["type"] === "provider.failed",
    );
    if (legacyProviderFailure === undefined) throw new Error("测试缺少Provider Failure");
    delete legacyProviderFailure["inputSha256"];
    const settledIndex = legacyRecord.events.findIndex(
      (event) => event["type"] === "session.settled",
    );
    if (settledIndex < 0) throw new Error("测试缺少Session settled");
    legacyRecord.events.splice(settledIndex, 1);
    const assistant = legacyRecord.events.find(
      (event) => event["type"] === "message.completed" && event["role"] === "assistant",
    );
    if (assistant === undefined) throw new Error("测试缺少Assistant Evidence");
    delete assistant["visibleTextSha256"];
    delete assistant["visibleText"];
    delete assistant["visibleTextTruncated"];
    for (const [index, event] of legacyRecord.events.entries()) event["sequence"] = index + 1;
    await writeFile(recordPath, `${JSON.stringify(legacyRecord)}\n`, { mode: 0o600 });

    const recovered = await PiExecutorOperationStore.open(directory);

    expect(
      recovered.getEvents("pio_test1").find((event) => event.type === "tool.failed"),
    ).not.toHaveProperty("inputSha256");
    expect(
      recovered.getEvents("pio_test1").find((event) => event.type === "provider.failed"),
    ).not.toHaveProperty("inputSha256");
    expect(recovered.getEvents("pio_test1").some((event) => event.type === "session.settled")).toBe(
      false,
    );
    expect(recovered.getSnapshot("pio_test1").status).toBe("succeeded");
  });

  it.each(["integrity_version", "session_settled", "visible_text_sha", "capability"] as const)(
    "新外层Store v2删除full-operation.v3耐久证据不得降级：%s",
    async (removed) => {
      const root = await temporaryRoot();
      const directory = join(root, "operations");
      const store = await PiExecutorOperationStore.open(directory);
      await store.createOrGet(request());
      await store.markRunning("pio_test1");
      await store.setSession("pio_test1", "pis_test1", ["bash"]);
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "turn.started",
        sessionId: "pis_test1",
        turnIndex: 0,
      });
      const inputSha256 = hashExecutorValue({ command: "pnpm test" });
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "tool.intent_persisted",
        sessionId: "pis_test1",
        turnIndex: 0,
        toolCallId: "call_v3_durable",
        toolName: "bash",
        inputSha256,
        inputDisplay: '{"command":"pnpm test"}',
        inputDisplayTruncated: false,
      });
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "tool.completed",
        sessionId: "pis_test1",
        turnIndex: 0,
        toolCallId: "call_v3_durable",
        toolName: "bash",
        inputSha256,
        resultSha256: hashExecutorValue({ output: "ok" }),
        resultDisplay: "ok",
        resultDisplayTruncated: false,
        durationMs: 1,
      });
      await settleAndComplete(store, "v3 durable", { turnAlreadyStarted: true });
      const path = join(directory, "pio_test1.json");
      const record = JSON.parse(await readFile(path, "utf8")) as {
        integrityVersion?: string;
        events: Array<Record<string, unknown>>;
      };
      if (removed === "integrity_version") delete record.integrityVersion;
      if (removed === "session_settled") {
        record.events.splice(
          record.events.findIndex((event) => event["type"] === "session.settled"),
          1,
        );
      }
      if (removed === "visible_text_sha") {
        const message = record.events.find(
          (event) => event["type"] === "message.completed" && event["role"] === "assistant",
        );
        if (message === undefined) throw new Error("测试缺少Assistant Message证据");
        delete message["visibleTextSha256"];
      }
      if (removed === "capability") {
        for (const event of record.events) {
          if (String(event["type"]).startsWith("tool.")) {
            delete event["capabilityId"];
            delete event["capabilityRefSha256"];
          }
        }
      }
      for (const [index, event] of record.events.entries()) event["sequence"] = index + 1;
      await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await expect(PiExecutorOperationStore.open(directory)).rejects.toThrow();
    },
  );

  it.each(["duplicate_intent", "result_before_intent", "cross_session"] as const)(
    "旧v1 succeeded Journal拒绝语义矛盾：%s",
    async (contradiction) => {
      const root = await temporaryRoot();
      const directory = join(root, "operations");
      const store = await PiExecutorOperationStore.open(directory);
      await store.createOrGet(request());
      await store.markRunning("pio_test1");
      await store.setSession("pio_test1", "pis_test1", ["read"]);
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "turn.started",
        sessionId: "pis_test1",
        turnIndex: 0,
      });
      const inputSha256 = hashExecutorValue({ path: "README.md" });
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "tool.intent_persisted",
        sessionId: "pis_test1",
        turnIndex: 0,
        toolCallId: "call_legacy_contradiction",
        toolName: "read",
        inputSha256,
        inputDisplay: JSON.stringify({ path: "README.md" }),
        inputDisplayTruncated: false,
      });
      await store.append("pio_test1", {
        operationId: "pio_test1",
        type: "tool.completed",
        sessionId: "pis_test1",
        turnIndex: 0,
        toolCallId: "call_legacy_contradiction",
        toolName: "read",
        inputSha256,
        resultSha256: hashExecutorValue({ output: "ok" }),
        resultDisplay: "ok",
        resultDisplayTruncated: false,
        durationMs: 1,
      });
      await settleAndComplete(store, "legacy contradiction", { turnAlreadyStarted: true });
      const recordPath = join(directory, "pio_test1.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        schemaVersion: string;
        integrityVersion?: string;
        events: Array<Record<string, unknown>>;
      };
      record.schemaVersion = "pi-executor-operation-store.v1";
      delete record.integrityVersion;
      const intentIndex = record.events.findIndex(
        (event) => event["type"] === "tool.intent_persisted",
      );
      const resultIndex = record.events.findIndex((event) => event["type"] === "tool.completed");
      if (intentIndex < 0 || resultIndex < 0) throw new Error("测试Journal缺少Tool事件");
      if (contradiction === "duplicate_intent") {
        record.events.splice(resultIndex, 0, { ...record.events[intentIndex]! });
      } else if (contradiction === "result_before_intent") {
        const [result] = record.events.splice(resultIndex, 1);
        if (result === undefined) throw new Error("测试Journal缺少Result");
        record.events.splice(intentIndex, 0, result);
      } else {
        record.events[resultIndex]!["sessionId"] = "pis_other1";
      }
      for (const [index, event] of record.events.entries()) event["sequence"] = index + 1;
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

      await expect(PiExecutorOperationStore.open(directory)).rejects.toBeInstanceOf(
        PiExecutorJournalIntegrityError,
      );
    },
  );

  it.each([
    "accepted_request_hash",
    "started_request_hash",
    "completed_request_hash",
    "completed_result_hash",
    "session_id",
    "failed_before_succeeded",
    "missing_accepted",
  ] as const)("旧v1 succeeded Journal拒绝Operation生命周期矛盾：%s", async (contradiction) => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["read"]);
    await settleAndComplete(store, "operation lifecycle");
    const recordPath = join(directory, "pio_test1.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      schemaVersion: string;
      integrityVersion?: string;
      requestSha256: string;
      events: Array<Record<string, unknown>>;
    };
    record.schemaVersion = "pi-executor-operation-store.v1";
    delete record.integrityVersion;
    const eventOfType = (type: string) => {
      const event = record.events.find((candidate) => candidate["type"] === type);
      if (event === undefined) throw new Error(`测试Journal缺少${type}`);
      return event;
    };
    if (contradiction === "accepted_request_hash") {
      eventOfType("operation.accepted")["requestSha256"] = "0".repeat(64);
    } else if (contradiction === "started_request_hash") {
      eventOfType("operation.started")["requestSha256"] = "1".repeat(64);
    } else if (contradiction === "completed_request_hash") {
      eventOfType("operation.completed")["requestSha256"] = "2".repeat(64);
    } else if (contradiction === "completed_result_hash") {
      eventOfType("operation.completed")["resultSha256"] = "3".repeat(64);
    } else if (contradiction === "session_id") {
      eventOfType("session.started")["sessionId"] = "pis_other1";
    } else if (contradiction === "failed_before_succeeded") {
      const completedIndex = record.events.findIndex(
        (event) => event["type"] === "operation.completed",
      );
      const completed = record.events[completedIndex];
      if (completedIndex < 0 || completed === undefined) throw new Error("测试缺少完成事件");
      record.events.splice(completedIndex, 0, {
        sequence: completedIndex + 1,
        timestamp: completed["timestamp"],
        operationId: "pio_test1",
        type: "operation.failed",
        requestSha256: record.requestSha256,
        errorCode: "executor.test_failure",
        durationMs: 1,
      });
    } else {
      const acceptedIndex = record.events.findIndex(
        (event) => event["type"] === "operation.accepted",
      );
      if (acceptedIndex < 0) throw new Error("测试缺少接受事件");
      record.events.splice(acceptedIndex, 1);
    }
    for (const [index, event] of record.events.entries()) event["sequence"] = index + 1;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(PiExecutorOperationStore.open(directory)).rejects.toBeInstanceOf(
      PiExecutorJournalIntegrityError,
    );
  });

  it("晚到complete不能把已收敛的outcome_unknown反转为成功", async () => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    await store.createOrGet(request());
    await store.markRunning("pio_test1");
    await store.setSession("pio_test1", "pis_test1", ["bash"]);
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "turn.started",
      sessionId: "pis_test1",
      turnIndex: 0,
    });
    await store.append("pio_test1", {
      operationId: "pio_test1",
      type: "tool.intent_persisted",
      sessionId: "pis_test1",
      turnIndex: 0,
      toolCallId: "call_late",
      toolName: "bash",
      inputSha256: hashExecutorValue({ command: "pnpm test" }),
      inputDisplay: JSON.stringify({ command: "pnpm test" }),
      inputDisplayTruncated: false,
    });
    await store.fail("pio_test1", "executor.session_failed", 10);
    await expect(
      store.complete(
        "pio_test1",
        {
          stepId: "step-1",
          output: "晚到候选",
          sections: [{ heading: "结果", body: "晚到候选" }],
          successCriteriaEvidence: ["结果存在｜有输出"],
          criteriaEvidence: ["完成测试｜有输出"],
          warnings: [],
        },
        20,
      ),
    ).rejects.toBeInstanceOf(PiExecutorOperationOutcomeUnknownError);
    expect(store.getSnapshot("pio_test1")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "executor.tool_result_persist_failed",
    });
    expect(store.getEvents("pio_test1").some((event) => event.type === "operation.completed")).toBe(
      false,
    );
  });
});

describe("Pi Executor完整Operation Journal状态机", () => {
  it.each(["queued", "running", "failed", "outcome_unknown", "succeeded"] as const)(
    "%s合法矩阵通过同一Validator",
    (status) => {
      expect(() => validateMutableJournal(validJournalForStatus(status))).not.toThrow();
    },
  );

  const contradictionCases: ReadonlyArray<
    readonly [string, (journal: MutableJournalFixture) => void]
  > = [
    [
      "accepted_request_hash",
      (journal) => {
        eventOfType(journal, "operation.accepted")["requestSha256"] = "0".repeat(64);
      },
    ],
    [
      "started_request_hash",
      (journal) => {
        eventOfType(journal, "operation.started")["requestSha256"] = "1".repeat(64);
      },
    ],
    [
      "completed_request_hash",
      (journal) => {
        eventOfType(journal, "operation.completed")["requestSha256"] = "2".repeat(64);
      },
    ],
    [
      "completed_result_hash",
      (journal) => {
        eventOfType(journal, "operation.completed")["resultSha256"] = "3".repeat(64);
      },
    ],
    [
      "session_id",
      (journal) => {
        eventOfType(journal, "session.started")["sessionId"] = "pis_other1";
      },
    ],
    [
      "provider_identity",
      (journal) => {
        eventOfType(journal, "provider.completed")["endpointHost"] = "other.test";
      },
    ],
    [
      "assistant_after_provider_completed",
      (journal) => {
        const assistantIndex = journal.events.findIndex(
          (event) => event["type"] === "message.completed" && event["role"] === "assistant",
        );
        const [assistant] = journal.events.splice(assistantIndex, 1);
        if (assistant === undefined) throw new Error("测试Journal缺少Assistant Evidence");
        const turnCompletedIndex = journal.events.findIndex(
          (event) => event["type"] === "turn.completed",
        );
        assistant["timestamp"] = journal.events[turnCompletedIndex - 1]!["timestamp"];
        journal.events.splice(turnCompletedIndex, 0, assistant);
        resequence(journal);
      },
    ],
    [
      "assistant_after_turn_completed",
      (journal) => {
        const assistantIndex = journal.events.findIndex(
          (event) => event["type"] === "message.completed" && event["role"] === "assistant",
        );
        const [assistant] = journal.events.splice(assistantIndex, 1);
        if (assistant === undefined) throw new Error("测试Journal缺少Assistant Evidence");
        const settledIndex = journal.events.findIndex(
          (event) => event["type"] === "session.settled",
        );
        assistant["timestamp"] = journal.events[settledIndex - 1]!["timestamp"];
        journal.events.splice(settledIndex, 0, assistant);
        resequence(journal);
      },
    ],
    [
      "assistant_after_session_settled",
      (journal) => {
        const assistantIndex = journal.events.findIndex(
          (event) => event["type"] === "message.completed" && event["role"] === "assistant",
        );
        const [assistant] = journal.events.splice(assistantIndex, 1);
        if (assistant === undefined) throw new Error("测试Journal缺少Assistant Evidence");
        const completedIndex = journal.events.findIndex(
          (event) => event["type"] === "operation.completed",
        );
        assistant["timestamp"] = journal.events[completedIndex - 1]!["timestamp"];
        journal.events.splice(completedIndex, 0, assistant);
        resequence(journal);
      },
    ],
    [
      "missing_accepted",
      (journal) => {
        journal.events.splice(0, 1);
        resequence(journal);
      },
    ],
    [
      "missing_started",
      (journal) => {
        journal.events.splice(
          journal.events.findIndex((event) => event["type"] === "operation.started"),
          1,
        );
        resequence(journal);
      },
    ],
    [
      "duplicate_accepted",
      (journal) => {
        journal.events.splice(1, 0, { ...eventOfType(journal, "operation.accepted") });
        resequence(journal);
      },
    ],
    [
      "duplicate_started",
      (journal) => {
        const index = journal.events.findIndex((event) => event["type"] === "operation.started");
        journal.events.splice(index + 1, 0, { ...eventOfType(journal, "operation.started") });
        resequence(journal);
      },
    ],
    [
      "duplicate_session",
      (journal) => {
        const index = journal.events.findIndex((event) => event["type"] === "session.started");
        journal.events.splice(index + 1, 0, { ...eventOfType(journal, "session.started") });
        resequence(journal);
      },
    ],
    [
      "failed_before_completed",
      (journal) => {
        const completed = eventOfType(journal, "operation.completed");
        journal.events.splice(journal.events.length - 1, 0, {
          sequence: journal.events.length,
          timestamp: completed["timestamp"],
          operationId: journal.request.operationId,
          type: "operation.failed",
          requestSha256: journal.snapshot["requestSha256"],
          errorCode: "executor.session_failed",
          durationMs: 1,
        });
        resequence(journal);
      },
    ],
    [
      "unknown_before_completed",
      (journal) => {
        const completed = eventOfType(journal, "operation.completed");
        journal.events.splice(journal.events.length - 1, 0, {
          sequence: journal.events.length,
          timestamp: completed["timestamp"],
          operationId: journal.request.operationId,
          type: "operation.outcome_unknown",
          requestSha256: journal.snapshot["requestSha256"],
          errorCode: "executor.operation_interrupted",
          durationMs: 1,
        });
        resequence(journal);
      },
    ],
    [
      "terminal_not_last",
      (journal) => {
        const completed = journal.events.pop();
        if (completed === undefined) throw new Error("测试Journal缺少terminal");
        completed["timestamp"] = eventOfType(journal, "turn.completed")["timestamp"];
        journal.events.splice(journal.events.length - 1, 0, completed);
        resequence(journal);
      },
    ],
    [
      "status_terminal_mismatch",
      (journal) => {
        journal.snapshot["status"] = "failed";
        journal.snapshot["errorCode"] = "executor.session_failed";
      },
    ],
    [
      "result_body_self_forged",
      (journal) => {
        const forged = expectedCandidate("攻击者同步重算的伪造正文");
        const forgedHash = hashExecutorValue(forged);
        journal.snapshot["result"] = forged;
        journal.snapshot["resultSha256"] = forgedHash;
        eventOfType(journal, "operation.completed")["resultSha256"] = forgedHash;
      },
    ],
    [
      "sequence_reordered",
      (journal) => {
        [journal.events[0], journal.events[1]] = [journal.events[1]!, journal.events[0]!];
      },
    ],
    [
      "timestamp_reversed",
      (journal) => {
        eventOfType(journal, "operation.started")["timestamp"] = "2026-08-22T23:59:59.000Z";
      },
    ],
    [
      "updated_at_before_last_event",
      (journal) => {
        journal.snapshot["updatedAt"] = journal.snapshot["createdAt"];
      },
    ],
    [
      "operation_identity_mismatch",
      (journal) => {
        journal.snapshot["operationId"] = "pio_other1";
      },
    ],
  ];

  it.each(contradictionCases)("矛盾Journal失败关闭：%s", (_case, mutate) => {
    const journal = validJournalForStatus("succeeded");
    mutate(journal);
    expect(() => validateMutableJournal(journal)).toThrow();
  });

  it("Client收到结构合法但Operation事件Hash矛盾的succeeded响应时不返回Candidate", async () => {
    let journal: MutableJournalFixture | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      const href = String(url);
      if (init?.method === "POST") {
        const submitted = startPiExecutorOperationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        journal = validJournalForStatus("succeeded", submitted);
        eventOfType(journal, "operation.accepted")["requestSha256"] = "0".repeat(64);
        return Response.json(journal.snapshot, { status: 202 });
      }
      if (journal === undefined) throw new Error("测试Client尚未提交Operation");
      if (href.includes("/events?")) {
        return Response.json({
          schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
          operationId: journal.request.operationId,
          events: journal.events,
          lastEventSequence: journal.events.length,
        });
      }
      return Response.json(journal.snapshot);
    };
    const client = createPiExecutorServiceClient({
      baseUrl: "http://executor-integrity.test",
      credential: "rtk_integrity_test",
      pollIntervalMs: 1,
      fetchFn,
    });
    const executionContract = contract();
    const error = await client({
      contract: executionContract,
      stepId: "step-1",
      executionAttemptId: "att_test1",
      inputManifestSha256: inputManifest(executionContract),
      contextItems: [],
      dependencyResults: [],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiExecutorRemoteError);
    expect(error).toMatchObject({
      code: "executor.journal_integrity_invalid",
      outcomeUnknown: true,
    });
  });

  it("Client钉住首次v2身份，终态Snapshot删除v2标记不得降级返回Candidate", async () => {
    let startJournal: MutableJournalFixture | undefined;
    let terminalJournal: MutableJournalFixture | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      const href = String(url);
      if (init?.method === "POST") {
        const submitted = startPiExecutorOperationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        startJournal = validJournalForStatus("running", submitted);
        terminalJournal = validJournalForStatus("succeeded", submitted);
        delete terminalJournal.snapshot["integrityVersion"];
        const settledIndex = terminalJournal.events.findIndex(
          (event) => event["type"] === "session.settled",
        );
        terminalJournal.events.splice(settledIndex, 1);
        delete eventOfType(terminalJournal, "message.completed")["visibleTextSha256"];
        resequence(terminalJournal);
        return Response.json(startJournal.snapshot, { status: 202 });
      }
      if (startJournal === undefined || terminalJournal === undefined) {
        throw new Error("测试Client尚未提交Operation");
      }
      if (href.includes("/events?")) {
        return Response.json({
          schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
          operationId: terminalJournal.request.operationId,
          events: terminalJournal.events,
          lastEventSequence: terminalJournal.events.length,
        });
      }
      return Response.json(terminalJournal.snapshot);
    };
    const executionContract = contract();
    const error = await createPiExecutorServiceClient({
      baseUrl: "http://executor-downgrade.test",
      credential: "rtk_downgrade_test",
      pollIntervalMs: 1,
      fetchFn,
    })({
      contract: executionContract,
      stepId: "step-1",
      executionAttemptId: "att_test1",
      inputManifestSha256: inputManifest(executionContract),
      contextItems: [],
      dependencyResults: [],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PiExecutorRemoteError);
    expect(error).toMatchObject({
      code: "executor.journal_integrity_invalid",
      outcomeUnknown: true,
    });
  });

  it("Client钉住首次full-operation.v3后拒绝终态降级为v2", async () => {
    let terminalJournal: MutableJournalFixture | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      const href = String(url);
      if (init?.method === "POST") {
        const submitted = startPiExecutorOperationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        const startJournal = validJournalForStatus("running", submitted);
        startJournal.snapshot["integrityVersion"] = "full-operation.v3";
        terminalJournal = validJournalForStatus("succeeded", submitted);
        return Response.json(startJournal.snapshot, { status: 202 });
      }
      if (terminalJournal === undefined) throw new Error("测试Client尚未提交Operation");
      if (href.includes("/events?")) {
        return Response.json({
          schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
          operationId: terminalJournal.request.operationId,
          events: terminalJournal.events,
          lastEventSequence: terminalJournal.events.length,
        });
      }
      return Response.json(terminalJournal.snapshot);
    };
    const executionContract = contract();
    const error = await createPiExecutorServiceClient({
      baseUrl: "http://executor-v3-downgrade.test",
      credential: "rtk_v3_downgrade_test",
      pollIntervalMs: 1,
      fetchFn,
    })({
      contract: executionContract,
      stepId: "step-1",
      executionAttemptId: "att_test1",
      inputManifestSha256: inputManifest(executionContract),
      contextItems: [],
      dependencyResults: [],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiExecutorRemoteError);
    expect(error).toMatchObject({
      code: "executor.journal_integrity_invalid",
      outcomeUnknown: true,
    });
  });

  it("新Client只读兼容缺少v2标记、settled与可见正文Hash的合法旧v1 succeeded", async () => {
    let journal: MutableJournalFixture | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      const href = String(url);
      if (init?.method === "POST") {
        const submitted = startPiExecutorOperationRequestSchema.parse(
          JSON.parse(String(init.body)),
        );
        journal = validJournalForStatus("succeeded", submitted);
        delete journal.snapshot["integrityVersion"];
        const settledIndex = journal.events.findIndex(
          (event) => event["type"] === "session.settled",
        );
        journal.events.splice(settledIndex, 1);
        const assistant = eventOfType(journal, "message.completed");
        delete assistant["visibleTextSha256"];
        delete assistant["visibleText"];
        delete assistant["visibleTextTruncated"];
        resequence(journal);
        return Response.json(journal.snapshot, { status: 200 });
      }
      if (journal === undefined) throw new Error("测试Client尚未提交Operation");
      if (href.includes("/events?")) {
        return Response.json({
          schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
          operationId: journal.request.operationId,
          events: journal.events,
          lastEventSequence: journal.events.length,
        });
      }
      return Response.json(journal.snapshot);
    };
    const executionContract = contract();
    const result = await createPiExecutorServiceClient({
      baseUrl: "http://executor-legacy.test",
      credential: "rtk_legacy_test",
      pollIntervalMs: 1,
      fetchFn,
    })({
      contract: executionContract,
      stepId: "step-1",
      executionAttemptId: "att_test1",
      inputManifestSha256: inputManifest(executionContract),
      contextItems: [],
      dependencyResults: [],
    });
    expect(result).toEqual(expectedCandidate("完整状态机结果"));
  });

  it("Store open拒绝文件名与Record operationId不一致", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiExecutorOperationStore.open(directory);
    await store.createOrGet(request());
    await rename(join(directory, "pio_test1.json"), join(directory, "pio_other1.json"));
    await expect(PiExecutorOperationStore.open(directory)).rejects.toBeInstanceOf(
      PiExecutorJournalIntegrityError,
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
  constructor(private readonly capture: (input: PiCodingAgentRunInput) => void = () => undefined) {}

  async run(input: PiCodingAgentRunInput) {
    this.capture(input);
    await input.store.setSession(input.request.operationId, "pis_fake1", []);
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "turn.started",
      sessionId: "pis_fake1",
      turnIndex: 0,
    });
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "provider.started",
      sessionId: "pis_fake1",
      requestIndex: 1,
      endpointHost: "provider.test",
      inputSha256: hashExecutorValue({ marker: CONTENT_MARKER }),
    });
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "message.completed",
      sessionId: "pis_fake1",
      messageIndex: 0,
      role: "assistant",
      contentSha256: hashExecutorValue(CONTENT_MARKER),
      visibleTextSha256: hashExecutorValue(CONTENT_MARKER),
      stopReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await input.store.append(input.request.operationId, {
      operationId: input.request.operationId,
      type: "provider.completed",
      sessionId: "pis_fake1",
      requestIndex: 1,
      endpointHost: "provider.test",
      inputSha256: hashExecutorValue({ marker: CONTENT_MARKER }),
      httpStatus: 200,
      providerRequestId: "req_fake1",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      stopReason: "stop",
      toolCallCount: 0,
      durationMs: 1,
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
    return expectedCandidate(CONTENT_MARKER);
  }
}

describe("Pi Executor Service + Client", () => {
  it("Agent运行时配置接口要求私有凭据，并只投影已注册的Pi Agent", async () => {
    const root = await temporaryRoot();
    const store = await PiExecutorOperationStore.open(join(root, "operations"));
    const baseline = agentRuntimeBaselineDtoSchema.parse({
      kind: "pi_coding_agent",
      title: "Pi Coding Agent",
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.84.2",
      managedSource: "later-3/pi@codex/later-custom",
      managedSourceRevision: "1".repeat(40),
      compositionStrategy: "pi_default_or_custom_then_chat_runtime_then_context",
      chatRuntimeAppend: {
        bodyMarkdown: "Chat runtime append",
        sha256: "a".repeat(64),
        sourceRelativePath: "packages/pi-runtime/src/direct-agent-executor.ts",
      },
      variants: [
        {
          variantKey: "read_only",
          title: "只读执行",
          description: "只读能力",
          capabilityCatalogSha256: "c".repeat(64),
          readiness: "available",
          diagnostics: [],
          enabledToolNames: ["read"],
          piSystemPrompt: {
            bodyMarkdown: "Pi runtime system prompt",
            sha256: "b".repeat(64),
            dynamicPlaceholders: ["WORKSPACE_ROOT"],
            sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
          },
          tools: [
            {
              name: "read",
              description: "Read a file",
              parametersJson: "{}",
              sourceRelativePath: "pi/packages/coding-agent/src/core/tools/read.ts",
              capability: {
                schemaVersion: "capability-descriptor.v1",
                capabilityId: "pi_direct:tool:builtin:read",
                kind: "executable_tool",
                runtimeOwner: "pi_direct",
                localName: "read",
                sourceRef: {
                  sourceKind: "builtin",
                  package: "@earendil-works/pi-coding-agent",
                  revision: "1".repeat(40),
                },
                inputSchemaSha256: "2".repeat(64),
                effect: "read",
                scopePolicy: "workspace_required",
                approvalPolicy: "run_policy",
                evidencePolicy: "runtime_journal",
                readiness: "available",
                descriptorSha256: "3".repeat(64),
              },
            },
          ],
        },
      ],
      finalReviewNote: "最终内容以发送前审核为准。",
    });
    const observedReads: [string, string | undefined][] = [];
    const runtime = createPiExecutorService({
      credential: "rtk_1234567890abcdef",
      store,
      workspaceRoots: new Map([["root_chat", { rootId: "root_chat", canonicalPath: root }]]),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      authorizeOperation: async () => {
        throw new Error("unused");
      },
      runner: new FakeRunner(),
      agentRuntimeProfiles: {
        read: async (agentKey, workspaceRootId) => {
          observedReads.push([agentKey, workspaceRootId]);
          return agentKey === "direct" ? baseline : undefined;
        },
      },
    });

    const unauthorized = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/direct",
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/direct",
      { headers: { "x-chat-runtime-key": "rtk_1234567890abcdef" } },
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual(baseline);

    const scoped = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/direct?workspaceRootId=root_chat",
      { headers: { "x-chat-runtime-key": "rtk_1234567890abcdef" } },
    );
    expect(scoped.status).toBe(200);
    expect(observedReads).toContainEqual(["direct", "root_chat"]);

    const unknownRoot = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/direct?workspaceRootId=root_missing",
      { headers: { "x-chat-runtime-key": "rtk_1234567890abcdef" } },
    );
    expect(unknownRoot.status).toBe(400);
    expect(await unknownRoot.json()).toEqual({ errorCode: "executor.workspace_root_not_allowed" });

    const invalidQuery = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/direct?unknown=1",
      { headers: { "x-chat-runtime-key": "rtk_1234567890abcdef" } },
    );
    expect(invalidQuery.status).toBe(400);

    const missing = await runtime.app.request(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/planner",
      { headers: { "x-chat-runtime-key": "rtk_1234567890abcdef" } },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ errorCode: "executor.agent_profile_not_found" });
    await runtime.close();
  });

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
    const authorizedNodePrompt = nodePrompt();
    let runnerRequest: StartPiExecutorOperationRequest | undefined;
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
        nodePrompt: authorizedNodePrompt,
      }),
      runner: new FakeRunner((input) => {
        runnerRequest = input.request;
      }),
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
      inputManifestSha256: inputManifest(executionContract, authorizedNodePrompt),
      contextItems: [],
      dependencyResults: [],
      onEvent: (event) => events.push(event.type),
    });
    expect(result.output).toBe(CONTENT_MARKER);
    expect(runnerRequest?.nodePrompt).toEqual(authorizedNodePrompt);
    expect(events).toEqual([
      "operation.accepted",
      "operation.started",
      "session.started",
      "turn.started",
      "provider.started",
      "message.completed",
      "provider.completed",
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
