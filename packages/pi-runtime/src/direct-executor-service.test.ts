import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DirectAgentRunInput, DirectAgentRunner } from "./direct-agent-executor.js";
import { DirectAgentSuspendedError, P1_DIRECT_AGENT_PROFILE } from "./direct-agent-executor.js";
import { applyPiRuntimeApiKey } from "./coding-agent-executor.js";
import { operationIdForDirectAgentAttempt } from "./direct-executor-identity.js";
import { PiDirectExecutorOperationStore } from "./direct-executor-operation-store.js";
import { createPiDirectExecutorServiceClient } from "./direct-executor-service-client.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  type DirectPromptReviewRef,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import {
  assertDirectExecutorWorkspaceGrant,
  PausableOperationTimeout,
  createPiDirectExecutorService,
} from "./direct-executor-service.js";
import { DirectAgentRuntimeCallbackError } from "./direct-runtime-api-callbacks.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import { computeWorkspaceGrantSha256, hashCanonical } from "@chat/domain";
import {
  hashFinalProviderPayload,
  hashPromptReviewEnvelope,
  type DirectPromptReviewProductPort,
} from "./prompt-review-gate.js";

const PRIVATE_SOURCE = "PRIVATE_DIRECT_SOURCE_MUST_NOT_ENTER_OPERATION";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-pi-direct-service-"));
  roots.push(root);
  return root;
}

const providerPayload = {
  model: "direct-test-model",
  messages: [{ role: "user", content: PRIVATE_SOURCE }],
};

function testCapability(localName: string, capabilityId = `pi_direct:tool:builtin:${localName}`) {
  const read = ["read", "grep", "find", "ls"].includes(localName);
  const sourceRef = {
    sourceKind: "builtin" as const,
    package: "@earendil-works/pi-coding-agent",
    repository: "later-3/pi",
    revision: "d".repeat(40),
    resourcePath: `pi/packages/coding-agent/src/core/tools/${localName}.ts`,
  };
  const inputSchemaSha256 = hashExecutorValue({ localName, schema: "test" });
  const descriptorInput = {
    schemaVersion: "capability-descriptor.v1" as const,
    capabilityId,
    kind: "executable_tool" as const,
    runtimeOwner: "pi_direct" as const,
    localName,
    sourceRef,
    inputSchemaSha256,
    effect: read
      ? ("read" as const)
      : localName === "bash"
        ? ("shell" as const)
        : ("local_write" as const),
    scopePolicy: "workspace_required" as const,
    approvalPolicy: read ? ("run_policy" as const) : ("product_decision_required" as const),
    evidencePolicy: read ? ("runtime_journal" as const) : ("product_intent_result" as const),
    readiness: "available" as const,
  };
  const descriptorSha256 = hashCanonical("capability-descriptor.v1", descriptorInput);
  return {
    ref: {
      capabilityId: descriptorInput.capabilityId,
      descriptorSha256,
      inputSchemaSha256,
      resolvedImplementationSha256: hashExecutorValue({ sourceRef, descriptorSha256 }),
      scopeRef: { kind: "workspace" as const, rootId: "root_chat" },
    },
    localName,
    kind: descriptorInput.kind,
    runtimeOwner: descriptorInput.runtimeOwner,
    sourceRef,
    effect: descriptorInput.effect,
    scopePolicy: descriptorInput.scopePolicy,
    approvalPolicy: descriptorInput.approvalPolicy,
    evidencePolicy: descriptorInput.evidencePolicy,
  };
}

function testManifestForCapabilities(
  resolvedCapabilities: readonly ReturnType<typeof testCapability>[],
  seed = "a",
) {
  const resolvedRuntimeManifest = {
    schemaVersion: "pi-direct-resolved-runtime-manifest.v1" as const,
    systemPromptSha256: seed.repeat(64).slice(0, 64),
    resourceInventorySha256: seed.repeat(64).slice(0, 64),
  };
  return {
    resolvedRuntimeManifest,
    resolvedCapabilities,
    resolvedRuntimeManifestSha256: hashExecutorValue({
      systemPromptSha256: resolvedRuntimeManifest.systemPromptSha256,
      capabilities: resolvedCapabilities,
      resourceInventorySha256: resolvedRuntimeManifest.resourceInventorySha256,
    }),
  };
}

function testManifest(enabledTools: readonly string[], seed = "a") {
  return testManifestForCapabilities(
    enabledTools.map((localName) => testCapability(localName)),
    seed,
  );
}

function startIdentity(): Omit<StartPiDirectExecutorOperationRequest, "operationId"> {
  return {
    schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
    productRunId: "run_directservice" as never,
    directAgentAttemptId: "att_directservice" as never,
    workflowRunSpecId: "wrs_directservice" as never,
    workflowRunSpecSha256: "1".repeat(64),
    inputManifestSha256: "2".repeat(64),
  };
}

class WaitingThenCompleteRunner implements DirectAgentRunner {
  readonly review: DirectPromptReviewRef = {
    promptReviewRequestId: "prr_directservice" as never,
    requestRevision: 1,
    revision: 1,
    requestIndex: 1,
    payloadSha256: hashFinalProviderPayload(providerPayload),
    reviewSha256: "4".repeat(64),
  };

  constructor(private readonly resumedRuntimeManifestSha256 = "f".repeat(64)) {}

  async run(input: Parameters<DirectAgentRunner["run"]>[0]): Promise<string> {
    if (!input.resume) {
      await input.store.setSession({
        operationId: input.request.operationId,
        sessionId: "pis_directservice",
        enabledTools: ["read", "grep", "find", "ls"],
        ...testManifest(["read", "grep", "find", "ls"], "f"),
      });
      await input.store.beginPromptReview({
        operationId: input.request.operationId,
        publishCommandId: "cmd_directservicepublish",
        payloadSha256: this.review.payloadSha256,
        payloadEnvelopeSha256: hashPromptReviewEnvelope({
          providerId: "openai",
          modelId: "direct-test-model",
          endpointHost: "provider.example",
          payload: providerPayload,
        }),
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        checkpoint: {
          fileName: "direct-service.jsonl",
          fileSha256: "5".repeat(64),
          sessionId: "pis_directservice",
          leafId: "leaf-direct-service",
        },
      });
      await input.store.markPromptReviewWaiting(input.request.operationId, this.review, 2);
      throw new DirectAgentSuspendedError();
    }
    const active = input.store.getActivePromptReview(input.request.operationId);
    if (active === undefined) throw new Error("恢复缺少Prompt Review checkpoint");
    await input.store.setSession({
      operationId: input.request.operationId,
      sessionId: active.checkpoint.sessionId,
      enabledTools: ["read", "grep", "find", "ls"],
      ...testManifest(["read", "grep", "find", "ls"], this.resumedRuntimeManifestSha256[0]),
      resumedFromCheckpointSha256: active.checkpoint.fileSha256,
    });
    await input.store.markProviderDispatching(input.request.operationId);
    await input.promptReview.markProviderSettled({
      operationId: input.request.operationId,
      completionTokens: 7,
      stopReason: "stop",
    });
    return "已审核的Direct Agent结果";
  }
}

describe("Pi Direct Executor Service + Client", () => {
  it("Direct Store v1只读兼容且任何恢复写入都不改写旧字节", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "legacy-v1-operations");
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const current = await PiDirectExecutorOperationStore.open(directory);
    await current.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "read_only",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    const filePath = join(directory, `${operationId}.json`);
    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    legacy["schemaVersion"] = "pi-direct-executor-operation-store.v1";
    (legacy["request"] as Record<string, unknown>)["schemaVersion"] = "pi-direct-executor.v1";
    await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });
    const legacyBytes = await readFile(filePath, "utf8");

    const reopened = await PiDirectExecutorOperationStore.open(directory);
    expect(reopened.getSnapshot(operationId).schemaVersion).toBe("pi-direct-executor.v2");
    await expect(reopened.markRunning(operationId)).rejects.toMatchObject({
      code: "direct_executor.operation_conflict",
    });
    expect(await readFile(filePath, "utf8")).toBe(legacyBytes);
  });

  it.each([
    "succeeded_missing_terminal",
    "intent_result_tool_drift",
    "cross_session",
    "result_before_intent",
    "duplicate_tool_call",
    "capability_deleted",
    "result_after_terminal",
    "record_manifest_deleted",
    "session_manifest_deleted",
    "resolved_capabilities_deleted",
    "coherent_capability_hash_forgery",
    "tool_not_in_manifest",
    "multiple_manifest_matches",
  ] as const)("Direct Store v2 open拒绝完整Journal反例：%s", async (contradiction) => {
    const root = await temporaryRoot();
    const directory = join(root, `corrupt-${contradiction}`);
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const store = await PiDirectExecutorOperationStore.open(directory);
    const capability = testCapability("write");
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["write"],
      ...testManifest(["write"], "e"),
    });
    await store.appendToolIntent({
      operationId,
      sessionId: "pis_directservice",
      toolCallId: "call_corruption",
      toolName: "write",
      inputSha256: "f".repeat(64),
      inputDisplay: "{}",
      inputDisplayTruncated: false,
      capability,
    });
    await store.closeToolIntent({
      operationId,
      sessionId: "pis_directservice",
      toolCallId: "call_corruption",
      toolName: "write",
      resultSha256: "1".repeat(64),
      outcome: "completed",
    });
    await store.complete(operationId, {
      directAgentCandidateId: "drc_directcorruption" as never,
      sha256: "2".repeat(64),
    });
    const filePath = join(directory, `${operationId}.json`);
    const record = JSON.parse(await readFile(filePath, "utf8")) as {
      resolvedRuntimeManifestSha256?: string;
      resolvedCapabilities?: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };
    const intentIndex = record.events.findIndex(
      (event) => event["type"] === "tool.intent_persisted",
    );
    const resultIndex = record.events.findIndex((event) => event["type"] === "tool.completed");
    const terminalIndex = record.events.findIndex(
      (event) => event["type"] === "operation.completed",
    );
    const sessionIndex = record.events.findIndex((event) => event["type"] === "session.started");
    if (intentIndex < 0 || resultIndex < 0 || terminalIndex < 0 || sessionIndex < 0) {
      throw new Error("测试Journal缺少预期事件");
    }
    if (contradiction === "succeeded_missing_terminal") {
      record.events.splice(terminalIndex, 1);
    } else if (contradiction === "intent_result_tool_drift") {
      record.events[resultIndex]!["toolName"] = "bash";
    } else if (contradiction === "cross_session") {
      record.events[resultIndex]!["sessionId"] = "pis_otherdirect";
    } else if (contradiction === "result_before_intent") {
      const [result] = record.events.splice(resultIndex, 1);
      if (result === undefined) throw new Error("测试缺少Result");
      record.events.splice(intentIndex, 0, result);
    } else if (contradiction === "duplicate_tool_call") {
      record.events.splice(resultIndex, 0, { ...record.events[intentIndex]! });
    } else if (contradiction === "capability_deleted") {
      delete record.events[intentIndex]!["capability"];
    } else if (contradiction === "result_after_terminal") {
      record.events.push({ ...record.events[resultIndex]! });
    } else if (contradiction === "record_manifest_deleted") {
      delete record.resolvedRuntimeManifestSha256;
    } else if (contradiction === "session_manifest_deleted") {
      delete record.events[sessionIndex]!["resolvedRuntimeManifestSha256"];
    } else if (contradiction === "resolved_capabilities_deleted") {
      delete record.resolvedCapabilities;
      delete record.events[sessionIndex]!["resolvedCapabilities"];
    } else if (contradiction === "coherent_capability_hash_forgery") {
      const snapshots = [
        ...(record.resolvedCapabilities ?? []),
        ...((record.events[sessionIndex]!["resolvedCapabilities"] as
          Array<Record<string, unknown>> | undefined) ?? []),
        record.events[intentIndex]!["capability"] as Record<string, unknown>,
        record.events[resultIndex]!["capability"] as Record<string, unknown>,
      ];
      for (const snapshot of snapshots) {
        snapshot["effect"] = "shell";
        snapshot["scopePolicy"] = "global";
      }
    } else if (contradiction === "tool_not_in_manifest") {
      for (const event of [record.events[intentIndex]!, record.events[resultIndex]!]) {
        event["toolName"] = "bash";
        const snapshot = event["capability"] as Record<string, unknown>;
        snapshot["localName"] = "bash";
        snapshot["effect"] = "shell";
      }
    } else {
      const manifestCapability = structuredClone(record.resolvedCapabilities?.[0]);
      if (manifestCapability === undefined) throw new Error("测试Manifest缺少Capability");
      record.resolvedCapabilities!.push(manifestCapability);
      const sessionCapabilities = record.events[sessionIndex]!["resolvedCapabilities"] as Array<
        Record<string, unknown>
      >;
      sessionCapabilities.push(structuredClone(manifestCapability));
    }
    for (const [index, event] of record.events.entries()) event["sequence"] = index + 1;
    await writeFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(PiDirectExecutorOperationStore.open(directory)).rejects.toMatchObject({
      code: "direct_executor.journal_integrity_invalid",
    });
  });

  it("Direct Store v2显式冻结零能力Manifest为空数组", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "zero-capabilities");
    const store = await PiDirectExecutorOperationStore.open(directory);
    const operationId = operationIdForDirectAgentAttempt("att_directzero");
    await store.createOrGet(
      {
        ...startIdentity(),
        operationId,
        directAgentAttemptId: "att_directzero" as never,
      },
      {
        runRevision: 1,
        sourceMessageId: "msg_directzero" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "custom",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.setSession({
      operationId,
      sessionId: "pis_directzero",
      enabledTools: [],
      ...testManifest([], "e"),
    });
    await store.complete(operationId, {
      directAgentCandidateId: "drc_directzero" as never,
      sha256: "4".repeat(64),
    });
    expect(store.getSnapshot(operationId)).toMatchObject({
      status: "succeeded",
      sessionId: "pis_directzero",
      resolvedRuntimeManifestSha256: testManifest([], "e").resolvedRuntimeManifestSha256,
      resolvedRuntimeManifest: testManifest([], "e").resolvedRuntimeManifest,
      resolvedCapabilities: [],
    });
    expect(
      store
        .getEvents(operationId)
        .filter((event) => event.type === "session.started" || event.type === "session.resumed"),
    ).toEqual([
      expect.objectContaining({
        type: "session.started",
        sessionId: "pis_directzero",
        enabledTools: [],
        resolvedCapabilities: [],
      }),
    ]);
    await expect(PiDirectExecutorOperationStore.open(directory)).resolves.toBeDefined();
  });

  it("Direct Store v2拒绝删除零Tool succeeded的完整Session事实", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "succeeded-without-session");
    const store = await PiDirectExecutorOperationStore.open(directory);
    const operationId = operationIdForDirectAgentAttempt("att_directnosession");
    await store.createOrGet(
      {
        ...startIdentity(),
        operationId,
        directAgentAttemptId: "att_directnosession" as never,
      },
      {
        runRevision: 1,
        sourceMessageId: "msg_directnosession" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "custom",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.setSession({
      operationId,
      sessionId: "pis_directnosession",
      enabledTools: [],
      ...testManifest([], "e"),
    });
    await store.complete(operationId, {
      directAgentCandidateId: "drc_directnosession" as never,
      sha256: "4".repeat(64),
    });

    const filePath = join(directory, `${operationId}.json`);
    const record = JSON.parse(await readFile(filePath, "utf8")) as {
      sessionId?: string;
      resolvedRuntimeManifestSha256?: string;
      resolvedRuntimeManifest?: unknown;
      resolvedCapabilities?: unknown;
      events: Array<Record<string, unknown>>;
    };
    delete record.sessionId;
    delete record.resolvedRuntimeManifestSha256;
    delete record.resolvedRuntimeManifest;
    delete record.resolvedCapabilities;
    record.events = record.events.filter((event) => event["type"] !== "session.started");
    for (const [index, event] of record.events.entries()) event["sequence"] = index + 1;
    await writeFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(PiDirectExecutorOperationStore.open(directory)).rejects.toMatchObject({
      code: "direct_executor.journal_integrity_invalid",
    });
  });

  it("Direct Manifest拒绝重复capabilityId并接受两个真正不同的ID", async () => {
    const root = await temporaryRoot();
    const sharedCapabilityId = "pi_direct:tool:builtin:shared";
    const duplicatedCapabilities = [
      testCapability("read", sharedCapabilityId),
      testCapability("bash", sharedCapabilityId),
    ];
    const duplicateDirectory = join(root, "duplicate-capability-id");
    const duplicateStore = await PiDirectExecutorOperationStore.open(duplicateDirectory);
    const duplicateOperationId = operationIdForDirectAgentAttempt("att_directduplicatecap");
    await duplicateStore.createOrGet(
      {
        ...startIdentity(),
        operationId: duplicateOperationId,
        directAgentAttemptId: "att_directduplicatecap" as never,
      },
      {
        runRevision: 1,
        sourceMessageId: "msg_directduplicatecap" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "custom",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await duplicateStore.markRunning(duplicateOperationId);
    await expect(
      duplicateStore.setSession({
        operationId: duplicateOperationId,
        sessionId: "pis_directduplicatecap",
        enabledTools: ["read", "bash"],
        ...testManifestForCapabilities(duplicatedCapabilities),
      }),
    ).rejects.toMatchObject({ code: "direct_executor.journal_integrity_invalid" });

    const distinctDirectory = join(root, "distinct-capability-ids");
    const distinctStore = await PiDirectExecutorOperationStore.open(distinctDirectory);
    const distinctOperationId = operationIdForDirectAgentAttempt("att_directdistinctcap");
    await distinctStore.createOrGet(
      {
        ...startIdentity(),
        operationId: distinctOperationId,
        directAgentAttemptId: "att_directdistinctcap" as never,
      },
      {
        runRevision: 1,
        sourceMessageId: "msg_directdistinctcap" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "custom",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await distinctStore.markRunning(distinctOperationId);
    await expect(
      distinctStore.setSession({
        operationId: distinctOperationId,
        sessionId: "pis_directdistinctcap",
        enabledTools: ["read", "bash"],
        ...testManifest(["read", "bash"]),
      }),
    ).resolves.toBeUndefined();
  });

  it("Executor在runner前拒绝API冻结Grant与实际canonical Root不一致", () => {
    const assembly = {
      schemaVersion: "prompt-assembly.v2" as const,
      promptAssemblyId: "pma_workspacegrant",
      sha256: "7".repeat(64),
      systemPromptAppend: "",
      messages: [],
      tools: {
        capabilityMode: "custom" as const,
        names: ["read"],
        estimatedTokens: 8_000 as const,
      },
      requestOptions: {
        providerId: "dashscope-coding" as const,
        modelId: "qwen3.7-plus" as const,
        thinkingLevel: "off" as const,
        retryEnabled: false,
        compactionEnabled: false,
      },
      budget: {},
      workspaceRootId: "root_chat",
      workspaceGrantSha256: computeWorkspaceGrantSha256("/approved/workspace"),
    };
    expect(() =>
      assertDirectExecutorWorkspaceGrant(assembly, {
        rootId: "root_chat",
        canonicalPath: "/remapped/workspace",
      }),
    ).toThrowError(expect.objectContaining({ code: "direct_executor.workspace_grant_mismatch" }));
    expect(() =>
      assertDirectExecutorWorkspaceGrant(assembly, {
        rootId: "root_chat",
        canonicalPath: "/approved/workspace",
      }),
    ).not.toThrow();
  });

  it("Session恢复拒绝覆盖首次resolved runtime manifest SHA", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    const firstManifest = testManifest(["grep", "runtime_probe"], "a");
    const driftedManifest = testManifest(["grep", "runtime_probe"], "b");
    await store.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["grep", "runtime_probe"],
      ...firstManifest,
    });
    await expect(
      store.setSession({
        operationId,
        sessionId: "pis_directservice",
        enabledTools: ["grep", "runtime_probe"],
        ...driftedManifest,
        resumedFromCheckpointSha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "direct_executor.runtime_manifest_mismatch" });

    expect(
      store
        .getEvents(operationId)
        .filter((event) => event.type === "session.started" || event.type === "session.resumed"),
    ).toEqual([
      expect.objectContaining({
        type: "session.started",
        enabledTools: ["grep", "runtime_probe"],
        resolvedRuntimeManifestSha256: firstManifest.resolvedRuntimeManifestSha256,
      }),
    ]);
  });

  it("Session恢复允许与首次完全一致的resolved runtime manifest SHA", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    const manifest = testManifest(["grep", "runtime_probe"], "a");
    for (const resumedFromCheckpointSha256 of [undefined, "c".repeat(64)]) {
      await store.setSession({
        operationId,
        sessionId: "pis_directservice",
        enabledTools: ["grep", "runtime_probe"],
        ...manifest,
        ...(resumedFromCheckpointSha256 === undefined ? {} : { resumedFromCheckpointSha256 }),
      });
    }

    expect(
      store
        .getEvents(operationId)
        .filter((event) => event.type === "session.started" || event.type === "session.resumed"),
    ).toEqual([
      expect.objectContaining({
        type: "session.started",
        resolvedRuntimeManifestSha256: manifest.resolvedRuntimeManifestSha256,
      }),
      expect.objectContaining({
        type: "session.resumed",
        resolvedRuntimeManifestSha256: manifest.resolvedRuntimeManifestSha256,
      }),
    ]);
  });

  it("当前v2删除首次Manifest字段不能降级为历史Operation恢复", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const store = await PiDirectExecutorOperationStore.open(directory);
    const runner = new WaitingThenCompleteRunner();
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["grep"],
      ...testManifest(["grep"], "a"),
    });
    await store.beginPromptReview({
      operationId,
      publishCommandId: "cmd_directservicelegacypublish",
      payloadSha256: runner.review.payloadSha256,
      payloadEnvelopeSha256: hashPromptReviewEnvelope({
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        payload: providerPayload,
      }),
      providerId: "openai",
      modelId: "direct-test-model",
      endpointHost: "provider.example",
      checkpoint: {
        fileName: "legacy-direct-service.jsonl",
        fileSha256: "c".repeat(64),
        sessionId: "pis_directservice",
        leafId: "leaf-legacy-direct-service",
      },
    });
    await store.markPromptReviewWaiting(operationId, runner.review, 2);

    const filePath = join(directory, `${operationId}.json`);
    const legacyRecord = z
      .object({
        resolvedRuntimeManifestSha256: z.string().optional(),
        resolvedRuntimeManifest: z.unknown().optional(),
        resolvedCapabilities: z.unknown().optional(),
        events: z.array(z.record(z.string(), z.unknown())),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(filePath, "utf8")));
    delete legacyRecord.resolvedRuntimeManifestSha256;
    delete legacyRecord.resolvedRuntimeManifest;
    delete legacyRecord.resolvedCapabilities;
    for (const event of legacyRecord.events) {
      delete event["resolvedRuntimeManifestSha256"];
      delete event["resolvedRuntimeManifest"];
      delete event["resolvedCapabilities"];
    }
    await writeFile(filePath, JSON.stringify(legacyRecord), { mode: 0o600 });
    await expect(PiDirectExecutorOperationStore.open(directory)).rejects.toMatchObject({
      code: "direct_executor.journal_integrity_invalid",
    });
  });

  it("Direct与Workflow共享的显式百炼Key只注册为Pi进程内runtime override", async () => {
    const setRuntimeApiKey = vi.fn(async () => undefined);
    const signal = new AbortController().signal;
    await applyPiRuntimeApiKey({
      modelRuntime: { setRuntimeApiKey },
      environment: { DASHSCOPE_API_KEY: "  e2e-runtime-key  " },
      providerId: "dashscope-coding",
      signal,
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("dashscope-coding", "e2e-runtime-key", {
      signal,
    });
  });

  it("Direct与Workflow未配置Chat百炼Key时保留Pi自己的认证链", async () => {
    const setRuntimeApiKey = vi.fn(async () => undefined);
    await applyPiRuntimeApiKey({
      modelRuntime: { setRuntimeApiKey },
      environment: { DASHSCOPE_API_KEY: "  " },
      providerId: "dashscope-coding",
      signal: new AbortController().signal,
    });
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("V1固定只读工具、关闭thinking/retry/compaction/外部扩展", () => {
    expect(P1_DIRECT_AGENT_PROFILE).toEqual({
      providerId: "dashscope-coding",
      modelId: "qwen3.7-plus",
      capabilityMode: "read_only",
      enabledTools: ["read", "grep", "find", "ls"],
      thinkingLevel: "off",
      retryEnabled: false,
      compactionEnabled: false,
      branchSummarySkipPrompt: true,
      noExtensions: true,
    });
  });

  it("Prompt Review等待不计入active timeout", () => {
    vi.useFakeTimers();
    try {
      let timedOut = false;
      const timeout = new PausableOperationTimeout(1_000, () => {
        timedOut = true;
      });
      vi.advanceTimersByTime(400);
      timeout.pause();
      vi.advanceTimersByTime(60_000);
      expect(timedOut).toBe(false);
      timeout.resume();
      vi.advanceTimersByTime(599);
      expect(timedOut).toBe(false);
      vi.advanceTimersByTime(1);
      expect(timedOut).toBe(true);
      timeout.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Prompt Assembly V2把正式历史保持原role交给同一个Pi Session", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    let received: DirectAgentRunInput | undefined;
    const runner: DirectAgentRunner = {
      run: async (input) => {
        received = input;
        await input.store.setSession({
          operationId: input.request.operationId,
          sessionId: "pis_directservicev2",
          enabledTools: ["read", "grep", "find", "ls"],
          ...testManifest(["read", "grep", "find", "ls"], "7"),
        });
        return "V2完成";
      },
    };
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async (input) => ({
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        runRevision: 1,
        sourceMessage: {
          messageId: "msg_directservicecurrent",
          text: "当前问题",
          sha256: "3".repeat(64),
        },
        promptAssembly: {
          schemaVersion: "prompt-assembly.v2",
          promptAssemblyId: "pma_directservicev2",
          sha256: "7".repeat(64),
          systemPromptAppend: "## 规则\n只读检查",
          piSystemPrompt: {
            kind: "pi_coding_agent",
            mode: "replace",
            bodyMarkdown: "DIRECT_CUSTOM_SYSTEM_PROMPT",
            sha256: "6".repeat(64),
          },
          messages: [
            {
              role: "user",
              text: "上一问",
              source: {
                kind: "product_message",
                messageId: "msg_directservicehistoryuser",
                sessionSequence: 1,
                sha256: "8".repeat(64),
              },
              estimatedTokens: 3,
            },
            {
              role: "assistant",
              text: "上一答",
              source: {
                kind: "product_message",
                messageId: "msg_directservicehistoryassistant",
                sessionSequence: 2,
                sha256: "9".repeat(64),
              },
              estimatedTokens: 3,
            },
            {
              role: "user",
              text: "当前问题",
              source: {
                kind: "current_input",
                messageId: "msg_directservicecurrent",
                sessionSequence: 3,
                sha256: "3".repeat(64),
              },
              estimatedTokens: 4,
            },
          ],
          tools: {
            capabilityMode: "read_only",
            names: ["read", "grep", "find", "ls"],
            estimatedTokens: 8_000,
          },
          requestOptions: {
            providerId: "dashscope-coding",
            modelId: "qwen3.7-plus",
            thinkingLevel: "off",
            retryEnabled: false,
            compactionEnabled: false,
          },
          budget: {
            meterVersion: "utf8-bytes-div-3.v1",
            inputTokenLimit: 64_000,
            instructionsEstimatedTokens: 5,
            messagesEstimatedTokens: 10,
            toolsEstimatedTokens: 8_000,
            totalEstimatedTokens: 8_015,
            excludedHistoryMessageIds: [],
          },
        },
        capabilityMode: "read_only",
        promptReviewMode: "manual",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      }),
      promptReviewProduct: {
        publish: async () => {
          throw new Error("Immediate runner不发布Review");
        },
        consumeDecision: async () => {
          throw new Error("Immediate runner不消费Decision");
        },
        commitDispatchOutcome: async () => undefined,
      },
      publishResult: async () => ({
        directAgentCandidateId: "drc_directservicev2" as never,
        sha256: hashExecutorValue("V2完成"),
      }),
      runner,
    });
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://pi-direct.test",
      credential: "rtk_directservice123",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => runtime.app.request(url, init),
    });
    const response = await client.start(startIdentity());
    expect(response.kind).toBe("succeeded");
    expect(received?.prompt).toBe("当前问题");
    expect(received?.history).toEqual([
      { role: "user", text: "上一问" },
      { role: "assistant", text: "上一答" },
    ]);
    expect(received?.systemPromptAppend).toBe("## 规则\n只读检查");
    expect(received?.piSystemPrompt).toEqual({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: "DIRECT_CUSTOM_SYSTEM_PROMPT",
      sha256: "6".repeat(64),
    });
    await runtime.close();
  });

  it("start只携Manifest证据，decision单次consume后恢复并回写dispatch outcome", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const runner = new WaitingThenCompleteRunner();
    let authorizeCalls = 0;
    let consumeCalls = 0;
    const dispatchOutcomes: string[] = [];
    const product: DirectPromptReviewProductPort = {
      publish: async () => {
        throw new Error("Fake runner不调用publish");
      },
      consumeDecision: async (input) => {
        consumeCalls += 1;
        return {
          status: "authorized",
          review: input.review,
          decision: {
            promptReviewDecisionId: input.promptReviewDecisionId as never,
            revision: 1,
            decisionSha256: "6".repeat(64),
            kind: "approve",
          },
          productRunRevision: 3,
          frozenPayload: providerPayload,
        };
      },
      commitDispatchOutcome: async (input) => {
        dispatchOutcomes.push(input.outcome);
      },
    };
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async (input) => {
        authorizeCalls += 1;
        return {
          productRunId: input.productRunId,
          directAgentAttemptId: input.directAgentAttemptId,
          runRevision: 1,
          sourceMessage: {
            messageId: "msg_directservice",
            text: PRIVATE_SOURCE,
            sha256: "3".repeat(64),
          },
          promptAssembly: {
            schemaVersion: "prompt-assembly.v1",
            promptAssemblyId: "pma_directservice",
            sha256: "7".repeat(64),
            systemPromptAppend: "",
            userPrompt: PRIVATE_SOURCE,
          },
          capabilityMode: "read_only",
          promptReviewMode: "manual",
          limits: {
            maxProviderRequests: 16,
            activeTimeoutMs: 1_200_000,
            tokenBudget: 64_000,
          },
        };
      },
      promptReviewProduct: product,
      publishResult: async (input) => ({
        directAgentCandidateId: "drc_directservice" as never,
        sha256: hashExecutorValue(input.output),
      }),
      runner,
    });
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://pi-direct.test",
      credential: "rtk_directservice123",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => runtime.app.request(url, init),
    });

    const waiting = await client.start(startIdentity());
    expect(waiting).toMatchObject({ kind: "waiting_prompt_review", review: runner.review });
    if (waiting.kind !== "waiting_prompt_review") throw new Error("测试缺少审核等待态");
    const completed = await client.submitDecision({
      operationId: waiting.operationId,
      requestSha256: waiting.requestSha256,
      review: waiting.review,
      promptReviewDecisionId: "prd_directservice",
    });

    expect(completed).toMatchObject({
      kind: "succeeded",
      result: { directAgentCandidateId: "drc_directservice" },
    });
    // 创建Operation、首次Session和checkpoint恢复都重新读取权威Assembly；正文不进Journal。
    expect(authorizeCalls).toBe(3);
    expect(consumeCalls).toBe(1);
    expect(dispatchOutcomes).toEqual(["dispatched"]);
    const operationFile = await readFile(
      join(root, "operations", `${waiting.operationId}.json`),
      "utf8",
    );
    expect(operationFile).not.toContain(PRIVATE_SOURCE);
    expect(operationFile).not.toContain("已审核的Direct Agent结果");
    await runtime.close();
  });

  it("resume运行清单漂移在Provider前形成稳定failed终态", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const runner = new WaitingThenCompleteRunner("e".repeat(64));
    let providerDispatchCommitted = false;
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async (input) => ({
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        runRevision: 1,
        sourceMessage: {
          messageId: "msg_directservice",
          text: PRIVATE_SOURCE,
          sha256: "3".repeat(64),
        },
        promptAssembly: {
          schemaVersion: "prompt-assembly.v1",
          promptAssemblyId: "pma_directservice",
          sha256: "7".repeat(64),
          systemPromptAppend: "",
          userPrompt: PRIVATE_SOURCE,
        },
        capabilityMode: "read_only",
        promptReviewMode: "manual",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      }),
      promptReviewProduct: {
        publish: async () => {
          throw new Error("Fake runner不调用publish");
        },
        consumeDecision: async (input) => ({
          status: "authorized",
          review: input.review,
          decision: {
            promptReviewDecisionId: input.promptReviewDecisionId as never,
            revision: 1,
            decisionSha256: "6".repeat(64),
            kind: "approve",
          },
          productRunRevision: 3,
          frozenPayload: providerPayload,
        }),
        commitDispatchOutcome: async () => {
          providerDispatchCommitted = true;
        },
      },
      publishResult: async () => {
        throw new Error("运行清单漂移后不能发布Candidate");
      },
      runner,
    });
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://pi-direct.test",
      credential: "rtk_directservice123",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => runtime.app.request(url, init),
    });

    const waiting = await client.start(startIdentity());
    if (waiting.kind !== "waiting_prompt_review") throw new Error("测试缺少审核等待态");
    const failed = await client.submitDecision({
      operationId: waiting.operationId,
      requestSha256: waiting.requestSha256,
      review: waiting.review,
      promptReviewDecisionId: "prd_directservicedrift",
    });

    expect(failed).toEqual({
      kind: "failed",
      operationId: waiting.operationId,
      requestSha256: waiting.requestSha256,
      errorCode: "direct_executor.runtime_manifest_mismatch",
    });
    expect(providerDispatchCommitted).toBe(false);
    expect(
      store.getEvents(waiting.operationId).some((event) => event.type === "provider.started"),
    ).toBe(false);
    await runtime.close();
  });

  it("拒绝Attempt未绑定的Operation ID且不调用Application授权", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    let authorizeCalls = 0;
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        authorizeCalls += 1;
        throw new Error("不应调用");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("不应调用");
        },
        consumeDecision: async () => {
          throw new Error("不应调用");
        },
        commitDispatchOutcome: async () => {
          throw new Error("不应调用");
        },
      },
      publishResult: async () => {
        throw new Error("不应调用");
      },
      runner: new WaitingThenCompleteRunner(),
    });
    const response = await runtime.app.request(
      "http://pi-direct.test/internal/pi-direct-executor/v2/operations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chat-runtime-key": "rtk_directservice123",
        },
        body: JSON.stringify({ ...startIdentity(), operationId: "pio_wrongidentity" }),
      },
    );
    expect(response.status).toBe(409);
    expect(authorizeCalls).toBe(0);
    expect(() =>
      store.getSnapshot(operationIdForDirectAgentAttempt("att_directservice")),
    ).toThrow();
    await runtime.close();
  });

  it("consume网络结果未知立即收敛permit outcome_unknown，不遗留永久waiting", async () => {
    const root = await temporaryRoot();
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const runner = new WaitingThenCompleteRunner();
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "read_only",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.beginPromptReview({
      operationId,
      publishCommandId: "cmd_directservicepublish",
      payloadSha256: runner.review.payloadSha256,
      payloadEnvelopeSha256: hashPromptReviewEnvelope({
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        payload: providerPayload,
      }),
      providerId: "openai",
      modelId: "direct-test-model",
      endpointHost: "provider.example",
      checkpoint: {
        fileName: "direct-service.jsonl",
        fileSha256: "5".repeat(64),
        sessionId: "pis_directservice",
        leafId: "leaf-direct-service",
      },
    });
    await store.markPromptReviewWaiting(operationId, runner.review, 2);
    const dispatchOutcomes: string[] = [];
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        throw new Error("不应调用");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("不应调用");
        },
        consumeDecision: async () => {
          throw new DirectAgentRuntimeCallbackError(
            "direct_runtime.callback_outcome_unknown",
            true,
          );
        },
        commitDispatchOutcome: async (input) => {
          dispatchOutcomes.push(input.outcome);
        },
      },
      publishResult: async () => {
        throw new Error("不应调用");
      },
      runner,
    });
    const response = await runtime.app.request(
      `http://pi-direct.test/internal/pi-direct-executor/v2/operations/${operationId}/prompt-review-decisions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chat-runtime-key": "rtk_directservice123",
        },
        body: JSON.stringify({
          schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
          promptReviewRequestId: runner.review.promptReviewRequestId,
          requestRevision: runner.review.requestRevision,
          reviewSha256: runner.review.reviewSha256,
          payloadSha256: runner.review.payloadSha256,
          promptReviewDecisionId: "prd_directserviceunknown",
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "outcome_unknown",
      errorCode: "direct_executor.provider_permit_outcome_unknown",
    });
    expect(dispatchOutcomes).toEqual(["outcome_unknown"]);
    await runtime.close();
  });

  it("重启发现waiting+approve时不再等待丢失的内存正文，直接收敛permit未知", async () => {
    const root = await temporaryRoot();
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const directory = join(root, "operations");
    const firstStore = await PiDirectExecutorOperationStore.open(directory);
    const runner = new WaitingThenCompleteRunner();
    await firstStore.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "read_only",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await firstStore.markRunning(operationId);
    await firstStore.beginPromptReview({
      operationId,
      publishCommandId: "cmd_directservicepublish",
      payloadSha256: runner.review.payloadSha256,
      payloadEnvelopeSha256: hashPromptReviewEnvelope({
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        payload: providerPayload,
      }),
      providerId: "openai",
      modelId: "direct-test-model",
      endpointHost: "provider.example",
      checkpoint: {
        fileName: "direct-service.jsonl",
        fileSha256: "5".repeat(64),
        sessionId: "pis_directservice",
        leafId: "leaf-direct-service",
      },
    });
    await firstStore.markPromptReviewWaiting(operationId, runner.review, 2);
    await firstStore.bindPromptReviewDecision(
      operationId,
      {
        promptReviewDecisionId: "prd_directservicecrash" as never,
        revision: 1,
        decisionSha256: "6".repeat(64),
        kind: "approve",
      },
      3,
    );

    const recoveredStore = await PiDirectExecutorOperationStore.open(directory);
    const dispatchOutcomes: string[] = [];
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store: recoveredStore,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        throw new Error("不应调用");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("不应调用");
        },
        consumeDecision: async () => {
          throw new Error("不应再次消费permit");
        },
        commitDispatchOutcome: async (input) => {
          dispatchOutcomes.push(input.outcome);
        },
      },
      publishResult: async () => {
        throw new Error("不应调用");
      },
      runner,
    });
    await runtime.recover();

    expect(recoveredStore.getSnapshot(operationId)).toMatchObject({
      status: "outcome_unknown",
      errorCode: "direct_executor.provider_permit_outcome_unknown",
    });
    expect(dispatchOutcomes).toEqual(["outcome_unknown"]);
    await runtime.close();
  });

  it("Journal Result已落盘而Product响应连续丢失时，重启只重放Result且不再执行handler", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "tool-result-recovery");
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const firstStore = await PiDirectExecutorOperationStore.open(directory);
    const capability = testCapability("write");
    await firstStore.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await firstStore.markRunning(operationId);
    await firstStore.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["write"],
      ...testManifest(["write"], "e"),
    });
    await firstStore.appendToolIntent({
      operationId,
      sessionId: "pis_directservice",
      toolCallId: "tool_result_recovery_1",
      toolName: "write",
      inputSha256: "f".repeat(64),
      inputDisplay: '{"path":"README.md"}',
      inputDisplayTruncated: false,
      capability,
    });
    const journalResultSha256 = await firstStore.closeToolIntent({
      operationId,
      sessionId: "pis_directservice",
      toolCallId: "tool_result_recovery_1",
      toolName: "write",
      resultSha256: "1".repeat(64),
      outcome: "completed",
    });
    await firstStore.fail(operationId, "direct_executor.product_result_response_lost");

    const recoveredStore = await PiDirectExecutorOperationStore.open(directory);
    const commitResult = vi.fn(async () => undefined);
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store: recoveredStore,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        throw new Error("恢复Product Result不能重新授权Operation");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("恢复Product Result不能发布Prompt Review");
        },
        consumeDecision: async () => {
          throw new Error("恢复Product Result不能消费Prompt permit");
        },
        commitDispatchOutcome: async () => undefined,
      },
      toolExecutionProduct: {
        publish: async () => {
          throw new Error("恢复Product Result不能重新发布Intent");
        },
        claim: async () => {
          throw new Error("恢复Product Result不能重新claim或执行handler");
        },
        commitResult,
      },
      publishResult: async () => {
        throw new Error("恢复Product Result不能提交Agent Candidate");
      },
      runner: new WaitingThenCompleteRunner(),
    });
    await runtime.recover();
    expect(commitResult).toHaveBeenCalledTimes(1);
    expect(commitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        resultSha256: "1".repeat(64),
        journalResultSha256,
      }),
    );
    expect(recoveredStore.getSnapshot(operationId).status).toBe("failed");
    await runtime.close();
  });
});
