import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
  DIRECT_AGENT_TOKEN_BUDGET,
  LEGACY_DIRECT_PROMPT_COMPILER_VERSION,
  LEGACY_DIRECT_PROMPT_PROFILE_VERSION,
  MODEL_CONFIG_VERSION,
  PROMPT_ASSEMBLY_SCHEMA_VERSION,
  promptAssemblySchema,
  type PromptAssembly,
  type ProductSnapshot,
} from "@chat/contracts";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST, StoreCorruptedError } from "@chat/application";
import { compileWorkflowRunSpec } from "@chat/application/workflow-run-spec-compiler";
import {
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  createSystemDirectAgentDefinition,
} from "@chat/application/workflow-system-definitions";
import {
  canonicalJsonStringify,
  computeDirectAgentCandidateSha256,
  computeDirectAgentInputManifestSha256,
  computePromptAssemblySha256,
  computePromptReviewPayloadSha256,
  computePromptReviewSha256,
  computeRunContextRequestSha256,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore } from "./json-product-store.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const NOW = "2026-08-19T12:00:00.000Z";
const PRINCIPAL = "usr_promptreview" as const;

function rehashPromptAssembly(assembly: PromptAssembly): void {
  if (assembly.schemaVersion !== "prompt-assembly.v1") {
    throw new Error("该测试helper只修改Prompt Assembly V1 fixture");
  }
  assembly.sha256 = computePromptAssemblySha256({
    promptAssemblyId: assembly.promptAssemblyId,
    productSessionId: assembly.productSessionId,
    productRunId: assembly.productRunId,
    sourceMessageId: assembly.sourceMessageId,
    workflowDefinitionRevisionId: assembly.workflowDefinitionRevisionId,
    profileVersion: assembly.profileVersion,
    compilerVersion: assembly.compilerVersion,
    ...(assembly.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: assembly.workspaceRootId }),
    regions: assembly.regions,
    systemPromptAppend: assembly.systemPromptAppend,
    userPrompt: assembly.userPrompt,
  }) as never;
}

async function validDirectReviewSnapshot(): Promise<{
  readonly snapshot: ProductSnapshot;
  readonly store: JsonProductStore;
  readonly filePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "chat-prompt-review-store-"));
  const filePath = join(directory, "product.json");
  const store = await JsonProductStore.open({
    filePath,
    now: () => NOW,
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const seed = createSystemDirectAgentDefinition(NOW);
  const compiled = compileWorkflowRunSpec({
    workflowRunSpecId: "wrs_promptreview1",
    productRunId: "run_promptreview1",
    createdAt: NOW,
    definition: {
      schemaVersion: "workflow-definition-revision-input.v1",
      workflowDefinitionRevisionId: seed.revision.workflowDefinitionRevisionId,
      definitionRevision: seed.revision.definitionRevision,
      blueprintKey: seed.revision.blueprintKey,
      blueprintVersion: seed.revision.blueprintVersion,
      semanticRoot: seed.revision.semanticRoot,
      expectedSha256: seed.revision.definitionSha256,
    },
    runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    principal: { principalId: PRINCIPAL, capabilities: [] },
    availableResources: [],
    executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
    runner: {
      runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
      runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
    },
    businessInput: { kind: "direct_agent_message" },
  });
  if (!compiled.success) throw new Error("Direct RunSpec fixture编译失败");

  const sourceMessageSha256 = hashCanonical("message.v1", {
    messageId: "msg_promptreview1",
    sessionId: "psn_promptreview1",
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "执行只读检查" },
  });
  const promptAssemblyBody = {
    promptAssemblyId: "pma_promptreview1",
    productSessionId: "psn_promptreview1",
    productRunId: "run_promptreview1",
    sourceMessageId: "msg_promptreview1",
    workflowDefinitionRevisionId: seed.revision.workflowDefinitionRevisionId,
    profileVersion: LEGACY_DIRECT_PROMPT_PROFILE_VERSION,
    compilerVersion: LEGACY_DIRECT_PROMPT_COMPILER_VERSION,
    regions: [],
    systemPromptAppend: "",
    userPrompt: "执行只读检查",
  };
  const promptAssembly = promptAssemblySchema.parse({
    schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
    ...promptAssemblyBody,
    sha256: computePromptAssemblySha256(promptAssemblyBody),
    createdAt: NOW,
  });
  const inputManifestSha256 = computeDirectAgentInputManifestSha256({
    productRunId: "run_promptreview1",
    inputRunRevision: 1,
    workflowRunSpecId: compiled.runSpec.workflowRunSpecId,
    workflowRunSpecSha256: compiled.runSpec.sha256,
    sourceMessageId: "msg_promptreview1",
    sourceMessageSha256,
    promptAssemblySha256: promptAssembly.sha256,
    capabilityMode: "pi_cli_default",
    promptTemplateVersion: DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
    limits: {
      maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
      activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
      tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
    },
  });
  const canonicalPayloadJson = canonicalJsonStringify({
    messages: [{ content: "执行只读检查", role: "user" }],
    model: "qwen3.7-plus",
  });
  const payloadSha256 = computePromptReviewPayloadSha256(canonicalPayloadJson);
  const reviewSha256 = computePromptReviewSha256({
    promptReviewRequestId: "prr_promptreview1",
    productRunId: "run_promptreview1",
    directAgentAttemptId: "att_promptreview1",
    requestIndex: 1,
    requestKind: "agent_turn",
    providerId: "bailian",
    modelId: "qwen3.7-plus",
    endpointHost: "dashscope.aliyuncs.com",
    requestRevision: 1,
    payloadSha256,
    rendererVersion: "prompt-readable.v1",
  });

  snapshot.entities.sessions["psn_promptreview1"] = {
    schemaVersion: "product-session.v1",
    sessionId: "psn_promptreview1" as never,
    ownerPrincipalId: PRINCIPAL as never,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages["msg_promptreview1"] = {
    schemaVersion: "message.v1",
    messageId: "msg_promptreview1" as never,
    sessionId: "psn_promptreview1" as never,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "执行只读检查" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.workflowRunSpecs[compiled.runSpec.workflowRunSpecId] = compiled.runSpec;
  snapshot.entities.promptAssemblies[promptAssembly.promptAssemblyId] = promptAssembly;
  const contextRequestShape = {
    productRunId: "run_promptreview1",
    requestedByPrincipalId: PRINCIPAL,
    sourceMessageId: "msg_promptreview1",
    sourceMessageSha256,
  };
  snapshot.entities.contextRequests["ctxr_promptreview1"] = {
    schemaVersion: "run-context-request.v1",
    contextRequestId: "ctxr_promptreview1" as never,
    productRunId: "run_promptreview1" as never,
    requestedByPrincipalId: PRINCIPAL as never,
    sourceMessageId: "msg_promptreview1" as never,
    sourceMessageSha256: sourceMessageSha256 as never,
    sha256: computeRunContextRequestSha256(contextRequestShape) as never,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.runs["run_promptreview1"] = {
    schemaVersion: "product-run.v3",
    runKind: "direct_agent",
    productRunId: "run_promptreview1" as never,
    sessionId: "psn_promptreview1" as never,
    sourceMessageId: "msg_promptreview1" as never,
    workflowViewDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID as never,
    workflowRunSpecId: compiled.runSpec.workflowRunSpecId,
    runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
    runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
    status: "waiting_human",
    phase: "prompt_review",
    currentPromptReviewRequestId: "prr_promptreview1" as never,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.attempts["att_workflowpromptreview1"] = {
    schemaVersion: "run-attempt.v1",
    attemptId: "att_workflowpromptreview1" as never,
    productRunId: "run_promptreview1" as never,
    kind: "workflow",
    outcome: "running",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.attempts["att_promptreview1"] = {
    schemaVersion: "run-attempt.v1",
    attemptId: "att_promptreview1" as never,
    productRunId: "run_promptreview1" as never,
    kind: "direct_agent",
    inputRunRevision: 1,
    sourceMessageSha256: sourceMessageSha256 as never,
    inputManifestSha256: inputManifestSha256 as never,
    promptTemplateVersion: DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
    outcome: "running",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.promptReviewRequests["prr_promptreview1"] = {
    schemaVersion: "prompt-review-request.v1",
    promptReviewRequestId: "prr_promptreview1" as never,
    productRunId: "run_promptreview1" as never,
    directAgentAttemptId: "att_promptreview1" as never,
    requestIndex: 1,
    requestKind: "agent_turn",
    providerId: "bailian",
    modelId: "qwen3.7-plus",
    endpointHost: "dashscope.aliyuncs.com",
    requestRevision: 1,
    status: "open",
    canonicalPayloadJson,
    payloadSha256: payloadSha256 as never,
    rendererVersion: "prompt-readable.v1",
    reviewSha256: reviewSha256 as never,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { snapshot, store, filePath };
}

describe("Prompt Review Product Snapshot完整性", () => {
  it("接受Direct Run→Attempt→唯一open Review的完整Hash链", async () => {
    const { snapshot } = await validDirectReviewSnapshot();
    expect(
      snapshot.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID],
    ).toBeDefined();
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
  });

  it.each(["Definition", "RunSpec"] as const)(
    "%s中的Direct Agent多配置来源由Snapshot Integrity统一拒绝",
    async (target) => {
      const { snapshot } = await validDirectReviewSnapshot();
      if (target === "Definition") {
        const revision =
          snapshot.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
        const node = revision?.semanticRoot.elements[0];
        if (node?.kind !== "composite") throw new Error("测试Fixture缺少Direct Definition节点");
        node.config = {
          ...node.config,
          agentPromptOverride: "旧Prompt",
          agentTemporaryConfiguration: {},
        };
      } else {
        const runSpec = Object.values(snapshot.entities.workflowRunSpecs).find((candidate) =>
          candidate.nodeResolutions.some((node) => node.nodeType === "agent.direct"),
        );
        const node = runSpec?.nodeResolutions.find(
          (candidate) => candidate.nodeType === "agent.direct",
        );
        if (node === undefined) throw new Error("测试Fixture缺少Direct RunSpec节点");
        node.config = {
          ...node.config,
          agentPromptOverride: "旧Prompt",
          agentTemporaryConfiguration: {},
        };
      }
      expect(() => assertSnapshotIntegrity(snapshot)).toThrow(
        /Agent配置来源非法:agent\.configuration\.sources_conflict/u,
      );
    },
  );

  it("拒绝Prompt Assembly Hash篡改、悬空关系与Direct Run非唯一Assembly", async () => {
    const { snapshot: hashBroken } = await validDirectReviewSnapshot();
    hashBroken.entities.promptAssemblies["pma_promptreview1"]!.sha256 = "0".repeat(64) as never;
    expect(() => assertSnapshotIntegrity(hashBroken)).toThrow(/Assembly Hash不一致/u);

    const { snapshot: relationBroken } = await validDirectReviewSnapshot();
    const relationAssembly = relationBroken.entities.promptAssemblies["pma_promptreview1"]!;
    relationAssembly.sourceMessageId = "msg_missingpromptassembly" as never;
    rehashPromptAssembly(relationAssembly);
    expect(() => assertSnapshotIntegrity(relationBroken)).toThrow(/绑定不一致/u);

    const { snapshot: missing } = await validDirectReviewSnapshot();
    delete missing.entities.promptAssemblies["pma_promptreview1"];
    expect(() => assertSnapshotIntegrity(missing)).toThrow(/Assembly数量无效/u);

    const { snapshot: duplicate } = await validDirectReviewSnapshot();
    const second = structuredClone(duplicate.entities.promptAssemblies["pma_promptreview1"]!);
    second.promptAssemblyId = "pma_promptreview2" as never;
    rehashPromptAssembly(second);
    duplicate.entities.promptAssemblies[second.promptAssemblyId] = second;
    expect(() => assertSnapshotIntegrity(duplicate)).toThrow(/Assembly数量无效/u);
  });

  it("拒绝Payload/Review Hash篡改、多个open与requestIndex断号", async () => {
    const { snapshot: payloadBroken } = await validDirectReviewSnapshot();
    payloadBroken.entities.promptReviewRequests["prr_promptreview1"]!.payloadSha256 = "0".repeat(
      64,
    ) as never;
    expect(() => assertSnapshotIntegrity(payloadBroken)).toThrow(StoreCorruptedError);

    const { snapshot: multipleOpen } = await validDirectReviewSnapshot();
    const first = multipleOpen.entities.promptReviewRequests["prr_promptreview1"]!;
    multipleOpen.entities.promptReviewRequests["prr_promptreview2"] = {
      ...first,
      promptReviewRequestId: "prr_promptreview2" as never,
      requestIndex: 2,
      reviewSha256: computePromptReviewSha256({
        promptReviewRequestId: "prr_promptreview2",
        productRunId: first.productRunId,
        directAgentAttemptId: first.directAgentAttemptId,
        requestIndex: 2,
        requestKind: first.requestKind,
        providerId: first.providerId,
        modelId: first.modelId,
        endpointHost: first.endpointHost,
        requestRevision: first.requestRevision,
        payloadSha256: first.payloadSha256,
        rendererVersion: first.rendererVersion,
      }) as never,
    };
    expect(() => assertSnapshotIntegrity(multipleOpen)).toThrow(/多个open/u);

    const { snapshot: indexGap } = await validDirectReviewSnapshot();
    const only = indexGap.entities.promptReviewRequests["prr_promptreview1"]!;
    only.requestIndex = 2;
    only.reviewSha256 = computePromptReviewSha256({
      promptReviewRequestId: only.promptReviewRequestId,
      productRunId: only.productRunId,
      directAgentAttemptId: only.directAgentAttemptId,
      requestIndex: only.requestIndex,
      requestKind: only.requestKind,
      providerId: only.providerId,
      modelId: only.modelId,
      endpointHost: only.endpointHost,
      requestRevision: only.requestRevision,
      payloadSha256: only.payloadSha256,
      rendererVersion: only.rendererVersion,
    }) as never;
    expect(() => assertSnapshotIntegrity(indexGap)).toThrow(/requestIndex/u);
  });

  it("Direct Candidate必须绑定已完成模型调用的success Attempt且Hash一致", async () => {
    const { snapshot } = await validDirectReviewSnapshot();
    const run = snapshot.entities.runs["run_promptreview1"]!;
    if (run.runKind !== "direct_agent") throw new Error("fixture必须是Direct Run");
    delete run.currentPromptReviewRequestId;
    run.status = "running";
    run.phase = "executing";
    run.currentDirectAgentCandidateId = "drc_promptreview1" as never;
    const attempt = snapshot.entities.attempts["att_promptreview1"]!;
    attempt.outcome = "success";
    snapshot.entities.promptReviewRequests["prr_promptreview1"]!.status = "cancelled";
    snapshot.entities.directAgentCandidates["drc_promptreview1"] = {
      schemaVersion: "direct-agent-candidate.v1",
      directAgentCandidateId: "drc_promptreview1" as never,
      productRunId: run.productRunId,
      directAgentAttemptId: attempt.attemptId,
      output: { format: "markdown", text: "候选结果" },
      sha256: computeDirectAgentCandidateSha256({
        directAgentCandidateId: "drc_promptreview1",
        productRunId: run.productRunId,
        directAgentAttemptId: attempt.attemptId,
        output: { format: "markdown", text: "候选结果" },
      }) as never,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    attempt.outcome = "running";
    expect(() => assertSnapshotIntegrity(snapshot)).toThrow(/Candidate.*Attempt/u);
    attempt.outcome = "success";
    snapshot.entities.directAgentCandidates["drc_promptreview1"]!.sha256 = "0".repeat(64) as never;
    expect(() => assertSnapshotIntegrity(snapshot)).toThrow(/Candidate.*Hash/u);
  });

  it("终态Run不得遗留未闭合Review；approved取消后可保留approve Decision", async () => {
    const { snapshot: unresolved } = await validDirectReviewSnapshot();
    const unresolvedRun = unresolved.entities.runs["run_promptreview1"]!;
    if (unresolvedRun.runKind !== "direct_agent") throw new Error("fixture必须是Direct Run");
    delete unresolvedRun.currentPromptReviewRequestId;
    unresolvedRun.status = "outcome_unknown";
    unresolvedRun.phase = "executing";
    unresolvedRun.failure = { code: "provider.outcome_unknown", summary: "结果未知" };
    unresolved.entities.attempts["att_promptreview1"]!.outcome = "failure";
    unresolved.entities.attempts["att_promptreview1"]!.errorCode = "provider.outcome_unknown";
    expect(() => assertSnapshotIntegrity(unresolved)).toThrow(/终态遗留未闭合Prompt Review/u);

    const { snapshot: approvedCancelled } = await validDirectReviewSnapshot();
    const run = approvedCancelled.entities.runs["run_promptreview1"]!;
    const request = approvedCancelled.entities.promptReviewRequests["prr_promptreview1"]!;
    if (run.runKind !== "direct_agent") throw new Error("fixture必须是Direct Run");
    delete run.currentPromptReviewRequestId;
    run.status = "failed";
    run.phase = "executing";
    run.failure = { code: "direct_executor.failed", summary: "批准后执行层失败" };
    approvedCancelled.entities.attempts["att_promptreview1"]!.outcome = "failure";
    approvedCancelled.entities.attempts["att_promptreview1"]!.errorCode = "direct_executor.failed";
    request.status = "cancelled";
    request.decidedByPromptReviewDecisionId = "prd_cancelled1" as never;
    request.revision += 1;
    approvedCancelled.entities.promptReviewDecisions["prd_cancelled1"] = {
      schemaVersion: "prompt-review-decision.v1",
      promptReviewDecisionId: "prd_cancelled1" as never,
      promptReviewRequestId: request.promptReviewRequestId,
      productRunId: request.productRunId,
      requestRevision: request.requestRevision,
      reviewSha256: request.reviewSha256,
      payloadSha256: request.payloadSha256,
      kind: "approve",
      principalId: PRINCIPAL as never,
      commandId: "cmd_cancelleddecision1" as never,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(() => assertSnapshotIntegrity(approvedCancelled)).not.toThrow();
  });

  it("真实JSON事务允许先Persist Candidate、重开Store后再Product Commit", async () => {
    const { snapshot: fixture, store, filePath } = await validDirectReviewSnapshot();
    await store.transact({
      commandId: "cmd_directsetup1" as never,
      commandType: "PublishPromptReviewRequest",
      requestSha256: "1".repeat(64),
      traceContext: { productRunId: "run_promptreview1" as never },
      mutate: (draft) => {
        Object.assign(draft.entities, structuredClone(fixture.entities));
        return {
          resultRefs: {
            promptReviewRequestId: "prr_promptreview1",
            productRunId: "run_promptreview1",
          },
        };
      },
    });

    const candidateOutput = { format: "markdown" as const, text: "两事务候选结果" };
    const candidateSha256 = computeDirectAgentCandidateSha256({
      directAgentCandidateId: "drc_twophase1",
      productRunId: "run_promptreview1",
      directAgentAttemptId: "att_promptreview1",
      output: candidateOutput,
    });
    await store.transact({
      commandId: "cmd_persistcandidate1" as never,
      commandType: "PersistDirectAgentCandidate",
      requestSha256: "2".repeat(64),
      traceContext: { productRunId: "run_promptreview1" as never },
      mutate: (draft) => {
        const run = draft.entities.runs["run_promptreview1"];
        if (run?.runKind !== "direct_agent") throw new Error("fixture必须是Direct Run");
        const request = draft.entities.promptReviewRequests["prr_promptreview1"];
        if (request === undefined) throw new Error("fixture缺少Prompt Review");
        request.status = "cancelled";
        request.revision += 1;
        delete run.currentPromptReviewRequestId;
        run.status = "running";
        run.phase = "executing";
        run.currentDirectAgentCandidateId = "drc_twophase1" as never;
        run.revision += 1;
        const attempt = draft.entities.attempts["att_promptreview1"];
        if (attempt === undefined) throw new Error("fixture缺少Direct Agent Attempt");
        attempt.outcome = "success";
        attempt.revision += 1;
        draft.entities.directAgentCandidates["drc_twophase1"] = {
          schemaVersion: "direct-agent-candidate.v1",
          directAgentCandidateId: "drc_twophase1" as never,
          productRunId: run.productRunId,
          directAgentAttemptId: "att_promptreview1" as never,
          output: candidateOutput,
          sha256: candidateSha256 as never,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        return { resultRefs: { directAgentCandidateId: "drc_twophase1" } };
      },
    });

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    const persisted = await reopened.read({ kind: "committedSnapshot" });
    expect(persisted.snapshot.entities.attempts["att_promptreview1"]?.outcome).toBe("success");
    expect(persisted.snapshot.entities.directAgentCandidates["drc_twophase1"]?.sha256).toBe(
      candidateSha256,
    );

    await reopened.transact({
      commandId: "cmd_commitdirect1" as never,
      commandType: "CommitDirectAgentResult",
      requestSha256: "3".repeat(64),
      traceContext: { productRunId: "run_promptreview1" as never },
      mutate: (draft) => {
        const run = draft.entities.runs["run_promptreview1"];
        const session = draft.entities.sessions["psn_promptreview1"];
        const directAttempt = draft.entities.attempts["att_promptreview1"];
        const workflowAttempt = draft.entities.attempts["att_workflowpromptreview1"];
        if (
          run?.runKind !== "direct_agent" ||
          session === undefined ||
          directAttempt === undefined ||
          workflowAttempt === undefined
        ) {
          throw new Error("fixture提交引用缺失");
        }
        draft.entities.messages["msg_directresult1"] = {
          schemaVersion: "message.v1",
          messageId: "msg_directresult1" as never,
          sessionId: session.sessionId,
          sessionSequence: 2,
          role: "assistant",
          content: candidateOutput,
          sourceRunId: run.productRunId,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        session.lastMessageSequence = 2;
        session.revision += 1;
        directAttempt.outcome = "success";
        directAttempt.revision += 1;
        workflowAttempt.outcome = "success";
        workflowAttempt.revision += 1;
        run.status = "succeeded";
        run.phase = "completed";
        run.finalDirectAgentCandidateId = "drc_twophase1" as never;
        run.finalMessageId = "msg_directresult1" as never;
        run.revision += 1;
        return {
          resultRefs: {
            directAgentCandidateId: "drc_twophase1",
            messageId: "msg_directresult1",
            productRunId: "run_promptreview1",
          },
        };
      },
    });

    const committedStore = await JsonProductStore.open({ filePath, now: () => NOW });
    const committed = await committedStore.read({ kind: "committedSnapshot" });
    expect(committed.snapshot.entities.runs["run_promptreview1"]?.status).toBe("succeeded");
    expect(committed.snapshot.entities.messages["msg_directresult1"]?.content.text).toBe(
      candidateOutput.text,
    );
  });
});
