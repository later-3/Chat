import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXECUTION_CAPABILITY_SHELL_EXECUTE, type ExecutionEvidenceRef } from "@chat/contracts";
import { projectExecutorStepCandidate } from "./executor.js";
import { operationIdForExecutionAttempt } from "./executor-service-client.js";
import { hashExecutorValue, PiExecutorOperationStore } from "./executor-operation-store.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  startPiExecutorOperationRequestSchema,
} from "./executor-service-contract.js";
import { createPiExecutionEvidenceVerifier } from "./execution-evidence-verifier.js";

const roots: string[] = [];
const executionAttemptId = "att_evidenceverifier1";
const operationId = operationIdForExecutionAttempt(executionAttemptId);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function validReceipt() {
  const root = await mkdtemp(join(tmpdir(), "chat-execution-evidence-"));
  roots.push(root);
  const contract = {
    schemaVersion: "execution-contract.v1" as const,
    executionContractId: "exc_evidenceverifier1" as never,
    productRunId: "run_evidenceverifier1" as never,
    approvedPlanId: "pln_evidenceverifier1" as never,
    approvedPlanRevision: 1,
    approvedPlanSha256: "a".repeat(64),
    approvalDecisionId: "dec_evidenceverifier1" as never,
    steps: [
      {
        stepId: "step-shell",
        title: "运行校验命令",
        purpose: "验证真实Pi Journal Evidence",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "命令输出",
        successCriteria: ["命令成功"],
        capabilityRefs: [EXECUTION_CAPABILITY_SHELL_EXECUTE],
      },
    ],
    completionCriteria: ["完成校验"],
    capabilityRefs: [EXECUTION_CAPABILITY_SHELL_EXECUTE],
    limits: { maxTurnsPerStep: 8, timeoutMsPerStep: 300_000, tokenBudgetPerStep: 16_000 },
    sha256: "b".repeat(64),
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const request = startPiExecutorOperationRequestSchema.parse({
    schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
    operationId,
    executionAttemptId,
    inputManifestSha256: "c".repeat(64),
    contract,
    stepId: "step-shell",
    contextItems: [],
    dependencyResults: [],
  });
  const store = await PiExecutorOperationStore.open(join(root, "operations"));
  await store.createOrGet(request);
  await store.markRunning(operationId);
  await store.setSession(operationId, "pis_evidenceverifier1", ["bash"]);
  await store.append(operationId, {
    operationId,
    type: "turn.started",
    sessionId: "pis_evidenceverifier1",
    turnIndex: 0,
  });
  const inputSha256 = hashExecutorValue({ command: "pnpm test" });
  await store.append(operationId, {
    operationId,
    type: "tool.intent_persisted",
    sessionId: "pis_evidenceverifier1",
    turnIndex: 0,
    toolCallId: "call_evidenceverifier1",
    toolName: "bash",
    inputSha256,
    inputDisplay: '{"command":"pnpm test"}',
    inputDisplayTruncated: false,
  });
  await store.append(operationId, {
    operationId,
    type: "tool.completed",
    sessionId: "pis_evidenceverifier1",
    turnIndex: 0,
    toolCallId: "call_evidenceverifier1",
    toolName: "bash",
    inputSha256,
    resultSha256: hashExecutorValue({ output: "tests passed" }),
    resultDisplay: "tests passed",
    resultDisplayTruncated: false,
    durationMs: 1,
  });
  const providerInputSha256 = hashExecutorValue({ messages: ["真实执行完成"] });
  await store.append(operationId, {
    operationId,
    type: "provider.started",
    sessionId: "pis_evidenceverifier1",
    requestIndex: 1,
    endpointHost: "provider.test",
    inputSha256: providerInputSha256,
  });
  await store.append(operationId, {
    operationId,
    type: "message.completed",
    sessionId: "pis_evidenceverifier1",
    messageIndex: 0,
    role: "assistant",
    contentSha256: hashExecutorValue("真实执行完成"),
    visibleTextSha256: hashExecutorValue("真实执行完成"),
    visibleText: "真实执行完成",
    visibleTextTruncated: false,
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
  await store.append(operationId, {
    operationId,
    type: "provider.completed",
    sessionId: "pis_evidenceverifier1",
    requestIndex: 1,
    endpointHost: "provider.test",
    inputSha256: providerInputSha256,
    httpStatus: 200,
    providerRequestId: "req_evidenceverifier1",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    stopReason: "stop",
    toolCallCount: 1,
    durationMs: 1,
  });
  await store.append(operationId, {
    operationId,
    type: "turn.completed",
    sessionId: "pis_evidenceverifier1",
    turnIndex: 0,
    durationMs: 1,
  });
  await store.append(operationId, {
    operationId,
    type: "session.settled",
    sessionId: "pis_evidenceverifier1",
    turnCount: 1,
    providerRequestCount: 1,
  });
  const candidate = projectExecutorStepCandidate(
    { stepId: "step-shell", output: "真实执行完成" },
    contract.steps[0]!,
    contract.completionCriteria,
    true,
  );
  await store.complete(operationId, candidate, 2);
  const snapshot = store.getSnapshot(operationId);
  const events = store.getEvents(operationId);
  const evidenceRefs = snapshot.result?.executionEvidenceRefs;
  if (evidenceRefs === undefined || evidenceRefs.length !== 1) {
    throw new Error("测试Receipt缺少权威Tool Evidence");
  }
  return { snapshot, events, evidenceRefs };
}

function verifierFor(
  snapshot: Awaited<ReturnType<typeof validReceipt>>["snapshot"],
  events: Awaited<ReturnType<typeof validReceipt>>["events"],
) {
  return createPiExecutionEvidenceVerifier({
    baseUrl: "http://pi-executor.test",
    credential: "rtk_test",
    fetchFn: async (input) =>
      new Response(
        JSON.stringify(
          new URL(String(input)).pathname.endsWith("/events")
            ? {
                schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
                operationId: snapshot.operationId,
                events,
                lastEventSequence: events.length,
              }
            : snapshot,
        ),
        { status: 200 },
      ),
  });
}

describe("Planning Execution Evidence authority", () => {
  it("accepts only the exact completed refs derived from the real Pi Journal", async () => {
    const receipt = await validReceipt();
    await expect(
      verifierFor(receipt.snapshot, receipt.events).verify({
        executionAttemptId,
        evidenceRefs: receipt.evidenceRefs,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["nonexistent toolCallId", { toolCallId: "call_nonexistent" }],
    ["Attempt drift", { executionAttemptId: "att_otherevidence1" }],
    ["Capability drift", { capabilityId: "pi_planning:tool:builtin:read" }],
    ["input hash drift", { inputSha256: "d".repeat(64) }],
    ["result hash drift", { resultSha256: "e".repeat(64) }],
    ["failed outcome", { outcome: "failed" }],
  ] as const)("rejects %s", async (_label, drift) => {
    const receipt = await validReceipt();
    const evidenceRefs = [{ ...receipt.evidenceRefs[0]!, ...drift } as ExecutionEvidenceRef];
    await expect(
      verifierFor(receipt.snapshot, receipt.events).verify({
        executionAttemptId,
        evidenceRefs,
      }),
    ).rejects.toThrow(/executor\.evidence_receipt_mismatch/u);
  });

  it.each(["failed", "outcome_unknown"] as const)(
    "rejects a %s Operation even when the response is well-shaped",
    async (status) => {
      const receipt = await validReceipt();
      const snapshot = {
        ...receipt.snapshot,
        status,
        errorCode: `executor.${status}`,
      };
      await expect(
        verifierFor(snapshot, receipt.events).verify({
          executionAttemptId,
          evidenceRefs: receipt.evidenceRefs,
        }),
      ).rejects.toThrow(/executor\.evidence_receipt_identity_mismatch/u);
    },
  );

  it("rejects a succeeded Operation whose Tool Intent is still open", async () => {
    const receipt = await validReceipt();
    const events = receipt.events
      .filter((event) => event.type !== "tool.completed")
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    const snapshot = { ...receipt.snapshot, lastEventSequence: events.length };
    await expect(
      verifierFor(snapshot, events).verify({
        executionAttemptId,
        evidenceRefs: receipt.evidenceRefs,
      }),
    ).rejects.toThrow();
  });
});
