import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePlanSha256 } from "@chat/application";
import {
  contextPackageIdSchema,
  contextRequestIdSchema,
  messageIdSchema,
  memoryAdoptionIdSchema,
  memoryBackendIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
  planIdSchema,
  planRevisionIdSchema,
  productSnapshotSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runAttemptIdSchema,
  workflowViewDefinitionIdSchema,
  workflowViewDefinitionSchema,
  type PlanContent,
  type ProductSnapshot,
  type TraceEventInput,
} from "@chat/contracts";
import {
  computeContextPackageSha256,
  computeMemoryBackendDescriptorSha256,
  computeMemoryResultSnapshotSha256,
  computeRunContextRequestSha256,
  hashCanonical,
  createLegacyPlanningWorkflowView,
} from "@chat/domain";
import { describe, expect, it, vi } from "vitest";
import {
  assembleRunReplay,
  ReplayError,
  type ReplayAssemblerDeps,
  type SnapshotIntegrityCheck,
} from "./replay.js";
import { createTraceSink } from "./trace-sink.js";

const NOW = "2026-08-07T00:00:00.000Z";
const RUN_ID = productRunIdSchema.parse("run_replay1");
const SESSION_ID = productSessionIdSchema.parse("psn_replay1");
const MESSAGE_ID = messageIdSchema.parse("msg_replay1");
const ATTEMPT_ID = runAttemptIdSchema.parse("att_workflow1");
const PLANNING_ATTEMPT_ID = runAttemptIdSchema.parse("att_planning1");
const CONTEXT_REQUEST_ID = contextRequestIdSchema.parse("ctxr_replay1");
const MEMORY_QUERY_ID = memoryQueryIdSchema.parse("mqy_replay1");
const MEMORY_BACKEND_ID = memoryBackendIdSchema.parse("mbk_replay1");
const CONTEXT_PACKAGE_ID = contextPackageIdSchema.parse("ctxp_replay1");
const MEMORY_SNAPSHOT_ID = memoryResultSnapshotIdSchema.parse("mrs_replay1");
const MEMORY_ADOPTION_ID = memoryAdoptionIdSchema.parse("mad_replay1");
const WORKFLOW_VIEW_ID = workflowViewDefinitionIdSchema.parse("wvd_planninglegacyv1");
const SECRET = "PRODUCT_CONTENT_ONLY_7f9c";
const MEMORY_SECRET = "MEMORY_CONTENT_ONLY_13e8";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chat-replay-"));
}

function minimalSnapshot(
  run: Partial<ProductSnapshot["entities"]["runs"][string]> = {},
): ProductSnapshot {
  const sourceMessageSha256 = hashCanonical("message.v1", {
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: SECRET },
  });
  const contextRequestShape = {
    productRunId: RUN_ID,
    requestedByPrincipalId: "usr_replay1",
    sourceMessageId: MESSAGE_ID,
    sourceMessageSha256,
  } as const;
  return productSnapshotSchema.parse({
    schemaVersion: "chat-product-store.v18",
    storeRevision: 1,
    committedAt: NOW,
    entities: {
      sessions: {
        [SESSION_ID]: {
          schemaVersion: "product-session.v1",
          sessionId: SESSION_ID,
          ownerPrincipalId: "usr_replay1",
          status: "active",
          lastMessageSequence: 1,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      messages: {
        [MESSAGE_ID]: {
          schemaVersion: "message.v1",
          messageId: MESSAGE_ID,
          sessionId: SESSION_ID,
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: SECRET },
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      runs: {
        [RUN_ID]: {
          schemaVersion: "product-run.v3",
          runKind: "planning",
          productRunId: RUN_ID,
          sessionId: SESSION_ID,
          sourceMessageId: MESSAGE_ID,
          workflowViewDefinitionId: WORKFLOW_VIEW_ID,
          status: "pending",
          phase: "queued",
          maxPlanRevisions: 5,
          runnerFamily: "legacy-planning.v1",
          runnerBundleVersion: "legacy-planning.bundle.v1",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          ...run,
        },
      },
      attempts: {
        [ATTEMPT_ID]: {
          schemaVersion: "run-attempt.v1",
          attemptId: ATTEMPT_ID,
          productRunId: RUN_ID,
          kind: "workflow",
          outcome: "running",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      plans: {},
      revisionInputs: {},
      approvalRequests: {},
      decisions: {},
      executionContracts: {},
      executionCandidates: {},
      directAgentCandidates: {},
      promptReviewRequests: {},
      promptReviewDecisions: {},
      promptFragments: {},
      promptFragmentRevisions: {},
      promptAssemblies: {},
      agentVersions: {},
      validationResults: {},
      artifacts: {},
      contextRequests: {
        [CONTEXT_REQUEST_ID]: {
          schemaVersion: "run-context-request.v1",
          contextRequestId: CONTEXT_REQUEST_ID,
          ...contextRequestShape,
          sha256: computeRunContextRequestSha256(contextRequestShape),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      memoryQueries: {},
      memoryResultSnapshots: {},
      memoryAdoptions: {},
      contextPackages: {},
      memoryImportIntents: {},
      memoryImportResults: {},
      workflowMemoryQueries: {},
      workflowMemorySnapshots: {},
      workflowMemoryContexts: {},
      memoryWriteIntents: {},
      memoryWriteResults: {},
      projects: {},
      projectMethodSnapshots: {},
      projectStages: {},
      projectMilestones: {},
      projectUpdates: {},
      projectStateTransitions: {},
      projectResources: {},
      projectParticipants: {},
      projectWorks: {},
      projectActions: {},
      projectContributions: {},
      projectEvidence: {},
      projectDecisions: {},
      projectObservations: {},
      projectCandidates: {},
      projectBootstrapCandidates: {},
      projectBootstrapDecisions: {},
      projectBootstrapOperations: {},
      projectWorkspaceBindings: {},
      workflowViewDefinitions: {
        [WORKFLOW_VIEW_ID]: workflowViewDefinitionSchema.parse(
          createLegacyPlanningWorkflowView(NOW),
        ),
      },
      workflowDefinitions: {},
      workflowDefinitionRevisions: {},
      workflowRunSpecs: {},
      workflowNodeRuns: {},
      nodeRunTransitions: {},
      nodeValueManifests: {},
      notes: {},
      noteRevisions: {},
      noteCandidates: {},
      noteDecisions: {},
      rules: {},
      ruleRevisions: {},
      ruleTags: {},
      ruleDecisions: {},
      ruleSelections: {},
      planningProjectContexts: {},
      planningMemorySelections: {},
      workflowPolicyResolutions: {},
    },
    commandReceipts: {},
    outbox: {},
  });
}

type MemoryFixtureOutcome = "completed" | "optional_failed" | "required_failed";

function withMemoryContext(
  snapshot: ProductSnapshot,
  outcome: MemoryFixtureOutcome = "completed",
): ProductSnapshot {
  const requirement: "optional" | "required" =
    outcome === "optional_failed" ? "optional" : "required";
  const memory = {
    backendId: MEMORY_BACKEND_ID,
    requirement,
    tags: ["project"],
    layers: ["L1" as const],
    limit: 5,
    contextBudget: 512,
  };
  const request = snapshot.entities.contextRequests[CONTEXT_REQUEST_ID]!;
  snapshot.entities.contextRequests[CONTEXT_REQUEST_ID] = {
    ...request,
    memory,
    sha256: computeRunContextRequestSha256({
      productRunId: request.productRunId,
      requestedByPrincipalId: request.requestedByPrincipalId,
      sourceMessageId: request.sourceMessageId,
      sourceMessageSha256: request.sourceMessageSha256,
      memory,
    }),
  };
  const backendDescriptor = {
    backendId: MEMORY_BACKEND_ID,
    displayName: "Replay Memmy",
    kind: "memmy" as const,
    adapterContractVersion: "memmy-http-query.v1" as const,
    configured: true,
    authMode: "none" as const,
    credentialRevision: "none" as const,
    configurationFingerprint: "d".repeat(64),
    capabilities: {
      query: true as const,
      tags: true as const,
      layers: ["L1" as const],
      maxLimit: 5,
      maxContextBudget: 512,
    },
  };
  const base = {
    schemaVersion: "memory-query.v1" as const,
    memoryQueryId: MEMORY_QUERY_ID,
    contextRequestId: CONTEXT_REQUEST_ID,
    productRunId: RUN_ID,
    planRevision: 1 as const,
    backendId: MEMORY_BACKEND_ID,
    backendDescriptor,
    backendDescriptorSha256: computeMemoryBackendDescriptorSha256(backendDescriptor),
    requirement,
    sourceMessageSha256: request.sourceMessageSha256,
    tags: memory.tags,
    layers: memory.layers,
    limit: memory.limit,
    contextBudget: memory.contextBudget,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (outcome === "completed") {
    const memorySnapshotShape = {
      backendId: MEMORY_BACKEND_ID,
      externalObjectIds: ["memmy-object-1"],
      title: "Replay Memory",
      kind: "trace" as const,
      memoryLayer: "L1" as const,
      content: MEMORY_SECRET,
      tags: ["project"],
      tokenEstimate: 10,
    };
    const memorySnapshot = {
      schemaVersion: "memory-result-snapshot.v1" as const,
      memoryResultSnapshotId: MEMORY_SNAPSHOT_ID,
      memoryQueryId: MEMORY_QUERY_ID,
      ...memorySnapshotShape,
      sha256: computeMemoryResultSnapshotSha256(memorySnapshotShape),
      revision: 1 as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    snapshot.entities.memoryResultSnapshots[MEMORY_SNAPSHOT_ID] = memorySnapshot;
    snapshot.entities.memoryQueries[MEMORY_QUERY_ID] = {
      ...base,
      status: "completed",
      externalQueryId: "memmy-query-1",
      hitCount: 1,
      adoptedCount: 1,
      tokenEstimate: 10,
      resultSetSha256: "e".repeat(64),
      completedAt: NOW,
      revision: 2,
    };
    const packageShape = {
      contextRequestId: CONTEXT_REQUEST_ID,
      productRunId: RUN_ID,
      assembledForPlanRevision: 1,
      purpose: "planning" as const,
      memoryQueryId: MEMORY_QUERY_ID,
      items: [
        {
          kind: "memory_snapshot" as const,
          memoryResultSnapshotId: MEMORY_SNAPSHOT_ID,
          revision: 1,
          sha256: memorySnapshot.sha256,
          selection: "retrieved" as const,
          reasonCode: "within_budget" as const,
        },
      ],
      exclusions: [],
    };
    snapshot.entities.contextPackages[CONTEXT_PACKAGE_ID] = {
      schemaVersion: "context-package.v1",
      contextPackageId: CONTEXT_PACKAGE_ID,
      ...packageShape,
      sha256: computeContextPackageSha256(packageShape),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    snapshot.entities.memoryAdoptions[MEMORY_ADOPTION_ID] = {
      schemaVersion: "memory-adoption.v1",
      memoryAdoptionId: MEMORY_ADOPTION_ID,
      productRunId: RUN_ID,
      contextPackageId: CONTEXT_PACKAGE_ID,
      memoryResultSnapshotId: MEMORY_SNAPSHOT_ID,
      status: "adopted",
      reasonCode: "within_budget",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    return snapshot;
  }

  snapshot.entities.memoryQueries[MEMORY_QUERY_ID] = {
    ...base,
    status: "failed",
    errorCode: "memory.backend.unavailable",
    completedAt: NOW,
    revision: 2,
  };
  if (outcome === "optional_failed") {
    const packageShape = {
      contextRequestId: CONTEXT_REQUEST_ID,
      productRunId: RUN_ID,
      assembledForPlanRevision: 1,
      purpose: "planning" as const,
      memoryQueryId: MEMORY_QUERY_ID,
      items: [],
      exclusions: [
        {
          kind: "memory_backend" as const,
          backendId: MEMORY_BACKEND_ID,
          reasonCode: "memory.backend.unavailable",
        },
      ],
    };
    snapshot.entities.contextPackages[CONTEXT_PACKAGE_ID] = {
      schemaVersion: "context-package.v1",
      contextPackageId: CONTEXT_PACKAGE_ID,
      ...packageShape,
      sha256: computeContextPackageSha256(packageShape),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }
  return snapshot;
}

function emitMemoryTrace(
  traceDir: string,
  snapshot: ProductSnapshot,
  outcome: MemoryFixtureOutcome,
  contextPackageRef?: {
    objectType: "context_package";
    objectId: string;
    revision: number;
    sha256: string;
  },
): void {
  const trace = createTraceSink({ dir: traceDir, now: () => new Date(NOW) });
  const request = snapshot.entities.contextRequests[CONTEXT_REQUEST_ID]!;
  const query = snapshot.entities.memoryQueries[MEMORY_QUERY_ID]!;
  const contextScope = {
    traceId: "trace_replay1",
    productRunId: RUN_ID,
    attemptId: PLANNING_ATTEMPT_ID,
    contextRequestId: CONTEXT_REQUEST_ID,
  } as const;
  const memoryScope = {
    ...contextScope,
    memoryQueryId: MEMORY_QUERY_ID,
    backendId: MEMORY_BACKEND_ID,
    requirement: query.requirement,
    sourceMessageSha256: request.sourceMessageSha256,
    tagCount: query.tags.length,
    layerCount: query.layers.length,
    requestedLimit: query.limit,
    contextBudget: query.contextBudget,
  } as const;
  trace.emit({
    ...contextScope,
    level: "info",
    eventName: "context.assembly.started",
    outcome: "unknown",
    spanId: "span_context-started",
    memoryRequested: true,
  } as TraceEventInput);
  trace.emit({
    ...memoryScope,
    level: "info",
    eventName: "memory.query.started",
    outcome: "unknown",
    spanId: "span_memory-started",
  } as TraceEventInput);
  if (outcome === "completed") {
    trace.emit({
      ...memoryScope,
      level: "info",
      eventName: "memory.query.completed",
      outcome: "success",
      spanId: "span_memory-completed",
      hitCount: 1,
      adoptedCount: 1,
      resultSetSha256: "e".repeat(64),
      durationMs: 10,
    } as TraceEventInput);
  } else {
    trace.emit({
      ...memoryScope,
      level: "warn",
      eventName: "memory.query.failed",
      outcome: "failure",
      spanId: "span_memory-failed",
      error: { code: "memory.backend.unavailable", type: "MemoryBackendError" },
      durationMs: 10,
    } as TraceEventInput);
  }
  if (outcome === "required_failed") {
    trace.emit({
      ...contextScope,
      level: "error",
      eventName: "context.assembly.failed",
      outcome: "failure",
      spanId: "span_context-failed",
      memoryRequested: true,
      error: { code: "memory.backend.unavailable", type: "MemoryBackendError" },
      durationMs: 10,
    } as TraceEventInput);
    return;
  }
  const packageEntity = snapshot.entities.contextPackages[CONTEXT_PACKAGE_ID]!;
  trace.emit({
    ...contextScope,
    level: "info",
    eventName: "context.assembly.completed",
    outcome: "success",
    spanId: "span_context-completed",
    status: outcome === "completed" ? "ready" : "optional_failed",
    memoryRequested: true,
    adoptedCount: outcome === "completed" ? 1 : 0,
    excludedCount: outcome === "completed" ? 0 : 1,
    contextPackageRef: contextPackageRef ?? {
      objectType: "context_package",
      objectId: packageEntity.contextPackageId,
      revision: packageEntity.revision,
      sha256: packageEntity.sha256,
    },
    durationMs: 10,
  } as TraceEventInput);
}

function planContent(label: string): PlanContent {
  return {
    objective: `目标${label}`,
    summary: `摘要${label}`,
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        stepId: `step-${label}`,
        title: `步骤${label}`,
        purpose: "验证精确版本",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "结果",
        successCriteria: ["通过"],
        requestedCapabilities: [],
        risk: "low",
      },
    ],
    completionCriteria: ["完成"],
    warnings: [],
  };
}

function withPlan(snapshot: ProductSnapshot, revision: number): ProductSnapshot {
  const content = planContent(String(revision));
  const planId = planIdSchema.parse("pln_replay1");
  const planRevisionId = planRevisionIdSchema.parse(`plr_replay${String(revision)}`);
  const planningAttemptId = runAttemptIdSchema.parse(`att_plan${String(revision)}`);
  snapshot.entities.plans[planRevisionId] = {
    schemaVersion: "plan-revision.v1",
    planRevisionId,
    planId,
    productRunId: RUN_ID,
    planningAttemptId,
    planRevision: revision,
    status: revision === 1 ? "superseded" : "under_review",
    content,
    sha256: computePlanSha256({ planId, productRunId: RUN_ID, planRevision: revision, content }),
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return snapshot;
}

function writeSnapshot(dir: string, snapshot: ProductSnapshot): string {
  const path = join(dir, "store.json");
  writeFileSync(path, JSON.stringify(snapshot), "utf8");
  return path;
}

function emitCreated(traceDir: string, run: ProductSnapshot["entities"]["runs"][string]): void {
  createTraceSink({ dir: traceDir, now: () => new Date(NOW) }).emit({
    level: "info",
    eventName: "product_run.created",
    outcome: "success",
    traceId: "trace_replay1",
    spanId: "span_replay1",
    productRunId: RUN_ID,
    productSessionId: SESSION_ID,
    runStatus: run.status,
    phase: run.phase,
    revision: run.revision,
  } as TraceEventInput);
}

function writeEvidence(
  dir: string,
  overrides: Partial<{
    sourceState: "clean" | "dirty";
    workflowDefinitionVersions: string[];
    promptTemplateVersions: string[];
    modelConfigVersions: string[];
  }> = {},
): string {
  const path = join(dir, "version-evidence.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "chat-runtime-version-evidence.v1",
      productRunId: RUN_ID,
      capturedAt: NOW,
      gitSha: "a".repeat(40),
      sourceState: overrides.sourceState ?? "clean",
      sourceManifestSha256: "b".repeat(64),
      bundleManifestSha256: "c".repeat(64),
      workflowDefinitionVersions: overrides.workflowDefinitionVersions ?? [],
      promptTemplateVersions: overrides.promptTemplateVersions ?? [],
      modelConfigVersions: overrides.modelConfigVersions ?? [],
    }),
    "utf8",
  );
  return path;
}

function deps(check: SnapshotIntegrityCheck = vi.fn()): ReplayAssemblerDeps {
  return { snapshotIntegrityCheck: check };
}

describe("assembleRunReplay", () => {
  it("强制调用完整快照校验Port，且默认导出不含任何产品正文", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot();
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const checker = vi.fn<(snapshot: ProductSnapshot) => void>();
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(checker),
    );

    expect(checker).toHaveBeenCalledOnce();
    expect(view.failures).toEqual([]);
    expect(view.content).toEqual({ included: false });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.versionEvidence.gitSha).toBe("a".repeat(40));
  });

  it("完整对象图校验失败时立即失败关闭", () => {
    const dir = tempDir();
    const snapshot = minimalSnapshot();
    expect(() =>
      assembleRunReplay(
        { productRunId: RUN_ID, storePath: writeSnapshot(dir, snapshot) },
        deps(() => {
          throw new Error("dangling object");
        }),
      ),
    ).toThrowError(new ReplayError("Product Store完整对象图校验失败"));
  });

  it("Product Run不存在时失败，而不是返回run:null的伪回放", () => {
    const dir = tempDir();
    expect(() =>
      assembleRunReplay(
        { productRunId: "run_missing1", storePath: writeSnapshot(dir, minimalSnapshot()) },
        deps(),
      ),
    ).toThrowError("Product Run不存在: run_missing1");
  });

  it("Plan对象引用按planId+revision精确命中历史版本", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = withPlan(withPlan(minimalSnapshot(), 1), 2);
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const planV2 = snapshot.entities.plans["plr_replay2"]!;
    createTraceSink({ dir: traceDir, now: () => new Date(NOW) }).emit({
      level: "info",
      eventName: "plan.candidate.published",
      outcome: "success",
      traceId: "trace_replay1",
      spanId: "span_plan2",
      productRunId: RUN_ID,
      attemptId: "att_plan2",
      planRef: {
        objectType: "plan",
        objectId: planV2.planId,
        revision: 2,
        sha256: planV2.sha256,
      },
    } as unknown as TraceEventInput);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(),
    );
    const planCheck = view.timeline
      .flatMap((entry) => entry.refs)
      .find((check) => check.ref.objectType === "plan" && check.ref.revision === 2);
    expect(planCheck?.status).toBe("ok");
  });

  it("不存在的Plan revision明确标记missing，不回退到同planId其他版本", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = withPlan(minimalSnapshot(), 1);
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    createTraceSink({ dir: traceDir, now: () => new Date(NOW) }).emit({
      level: "info",
      eventName: "plan.candidate.published",
      outcome: "success",
      traceId: "trace_replay1",
      spanId: "span_plan-missing",
      productRunId: RUN_ID,
      attemptId: "att_plan2",
      planRef: {
        objectType: "plan",
        objectId: "pln_replay1",
        revision: 2,
        sha256: "f".repeat(64),
      },
    } as unknown as TraceEventInput);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(),
    );
    expect(view.timeline.flatMap((entry) => entry.refs).at(-1)?.status).toBe("missing");
    expect(view.failures.some((failure) => failure.includes("指定Plan revision不存在"))).toBe(true);
  });

  it("未提供历史版本证据时不读取当前HEAD冒充，gitSha保持null", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot();
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const view = assembleRunReplay(
      { productRunId: RUN_ID, storePath: writeSnapshot(dir, snapshot), traceDir },
      deps(),
    );
    expect(view.versionEvidence).toMatchObject({ status: "missing", gitSha: null });
    expect(view.failures).toContain("版本证据缺失：未提供运行当时保存的版本证据文件");
  });

  it("保存版本集合与Trace不一致时失败，不把文件存在当作证据有效", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot();
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    createTraceSink({ dir: traceDir, now: () => new Date(NOW) }).emit({
      level: "info",
      eventName: "workflow.start.requested",
      outcome: "unknown",
      traceId: "trace_replay1",
      spanId: "span_mismatch1",
      productRunId: RUN_ID,
      attemptId: ATTEMPT_ID,
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      workflowDefinitionId: "wfd_mismatch1",
    } as TraceEventInput);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir, {
          workflowDefinitionVersions: ["planning-execution-workflow.v999"],
        }),
      },
      deps(),
    );
    expect(view.versionEvidence.status).toBe("mismatch");
    expect(view.failures).toContain("版本证据不匹配：Trace出现了保存证据未捕获的运行版本");
  });

  it("dirty源码构建的版本证据明确不可复现", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot();
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir, { sourceState: "dirty" }),
      },
      deps(),
    );
    expect(view.versionEvidence.status).toBe("dirty");
    expect(view.failures).toContain(
      "版本证据不可复现：运行由dirty源码构建，不能归因为记录的Git SHA",
    );
  });

  it("Provider请求前缺少凭据时不伪造Provider或pi的started事件", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot({
      status: "failed",
      phase: "planning",
      failure: { code: "provider.pre_request.no_api_key", summary: "Provider凭据未配置" },
      revision: 2,
    });
    snapshot.entities.attempts[PLANNING_ATTEMPT_ID] = {
      schemaVersion: "run-attempt.v1",
      attemptId: PLANNING_ATTEMPT_ID,
      productRunId: RUN_ID,
      kind: "planning",
      planRevision: 1,
      outcome: "failure",
      errorCode: "provider.pre_request.no_api_key",
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const trace = createTraceSink({ dir: traceDir, now: () => new Date(NOW) });
    const modelScope = {
      traceId: "trace_replay1",
      productRunId: RUN_ID,
      attemptId: PLANNING_ATTEMPT_ID,
      promptTemplateVersion: "planner-prompt.v1",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
    } as const;
    trace.emit({
      ...modelScope,
      level: "warn",
      eventName: "provider.request.failed",
      outcome: "failure",
      spanId: "span_providernokey",
      provider: "bailian",
      model: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      operation: "chat_completion",
      error: { code: "provider.pre_request.no_api_key", type: "BailianNotReadyError" },
      durationMs: 0,
    } as TraceEventInput);
    trace.emit({
      ...modelScope,
      level: "warn",
      eventName: "pi.node.failed",
      outcome: "failure",
      spanId: "span_pinokey",
      nodeKind: "planner",
      error: { code: "provider.pre_request.no_api_key", type: "BailianNotReadyError" },
    } as TraceEventInput);

    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir, {
          promptTemplateVersions: ["planner-prompt.v1"],
          modelConfigVersions: ["bailian.qwen3.7-plus.v1"],
        }),
      },
      deps(),
    );
    expect(view.timeline.some((event) => event.eventName === "provider.request.started")).toBe(
      false,
    );
    expect(view.timeline.some((event) => event.eventName === "pi.node.started")).toBe(false);
    expect(view.failures.some((failure) => failure.includes("终态没有对应started"))).toBe(false);
  });

  it("任意单条Trace不能冒充成功Run的完整时间线", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot({ status: "succeeded", phase: "completed" });
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(),
    );
    expect(view.failures.length).toBeGreaterThan(4);
    expect(view.failures).toContain("产品事实缺口：成功Run缺少正式Assistant Message");
    expect(view.failures.some((failure) => failure.includes("product_commit.committed"))).toBe(
      true,
    );
  });

  it("调用终态前缺少started时明确报告事件链缺口", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot();
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    createTraceSink({ dir: traceDir, now: () => new Date(NOW) }).emit({
      level: "info",
      eventName: "provider.request.completed",
      outcome: "success",
      traceId: "trace_replay1",
      spanId: "span_provider1",
      productRunId: RUN_ID,
      attemptId: ATTEMPT_ID,
      promptTemplateVersion: "planner-prompt.v1",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
      provider: "bailian",
      model: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      operation: "chat_completion",
      httpStatus: 200,
      providerRequestId: "provider-request-1",
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      inputManifestSha256: "b".repeat(64),
      durationMs: 5,
    } as TraceEventInput);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir, {
          promptTemplateVersions: ["planner-prompt.v1"],
          modelConfigVersions: ["bailian.qwen3.7-plus.v1"],
        }),
      },
      deps(),
    );
    expect(
      view.failures.some((failure) => failure.includes("Provider请求终态没有对应started")),
    ).toBe(true);
  });

  it.each([
    ["ok", CONTEXT_PACKAGE_ID, undefined, "ok"],
    ["hash mismatch", CONTEXT_PACKAGE_ID, "f".repeat(64), "hash_mismatch"],
    ["missing", "ctxp_missing1", "f".repeat(64), "missing"],
  ] as const)("Context Package引用校验：%s", (_label, objectId, shaOverride, expectedStatus) => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = withMemoryContext(minimalSnapshot(), "completed");
    const contextPackage = snapshot.entities.contextPackages[CONTEXT_PACKAGE_ID]!;
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    emitMemoryTrace(traceDir, snapshot, "completed", {
      objectType: "context_package",
      objectId,
      revision: 1,
      sha256: shaOverride ?? contextPackage.sha256,
    });

    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(),
    );
    const check = view.timeline
      .flatMap((entry) => entry.refs)
      .find((candidate) => candidate.ref.objectType === "context_package");
    expect(check?.status).toBe(expectedStatus);
    if (expectedStatus === "ok") expect(view.failures).toEqual([]);
    else {
      expect(view.failures.some((failure) => failure.includes("context.assembly.completed"))).toBe(
        true,
      );
    }
  });

  it.each(["optional_failed", "required_failed"] as const)(
    "%s Memory失败按产品终态结束且不伪造成功包",
    (outcome) => {
      const dir = tempDir();
      const traceDir = join(dir, "traces");
      const snapshot = withMemoryContext(minimalSnapshot(), outcome);
      emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
      emitMemoryTrace(traceDir, snapshot, outcome);
      const view = assembleRunReplay(
        {
          productRunId: RUN_ID,
          storePath: writeSnapshot(dir, snapshot),
          traceDir,
          versionEvidencePath: writeEvidence(dir),
        },
        deps(),
      );
      expect(view.failures).toEqual([]);
      expect(Object.keys(snapshot.entities.contextPackages)).toHaveLength(
        outcome === "optional_failed" ? 1 : 0,
      );
    },
  );

  it("Memory Query孤立started与孤立terminal都被按memoryQueryId拒绝", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = withMemoryContext(minimalSnapshot(), "completed");
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    emitMemoryTrace(traceDir, snapshot, "completed");
    const request = snapshot.entities.contextRequests[CONTEXT_REQUEST_ID]!;
    const query = snapshot.entities.memoryQueries[MEMORY_QUERY_ID]!;
    const trace = createTraceSink({ dir: traceDir, now: () => new Date(NOW) });
    const common = {
      traceId: "trace_replay1",
      productRunId: RUN_ID,
      attemptId: PLANNING_ATTEMPT_ID,
      contextRequestId: CONTEXT_REQUEST_ID,
      backendId: MEMORY_BACKEND_ID,
      requirement: query.requirement,
      sourceMessageSha256: request.sourceMessageSha256,
      tagCount: 1,
      layerCount: 1,
      requestedLimit: 5,
      contextBudget: 512,
    } as const;
    trace.emit({
      ...common,
      level: "info",
      eventName: "memory.query.started",
      outcome: "unknown",
      spanId: "span_orphan-started",
      memoryQueryId: "mqy_orphanstarted1",
    } as TraceEventInput);
    trace.emit({
      ...common,
      level: "warn",
      eventName: "memory.query.failed",
      outcome: "failure",
      spanId: "span_orphan-terminal",
      memoryQueryId: "mqy_orphanterminal1",
      error: { code: "memory.backend.unavailable", type: "MemoryBackendError" },
      durationMs: 1,
    } as TraceEventInput);

    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(),
    );
    expect(view.failures.some((failure) => failure.includes("started没有终态"))).toBe(true);
    expect(view.failures.some((failure) => failure.includes("终态没有对应started"))).toBe(true);
  });

  it("no-memory ContextRequest拒绝任何memory.query Trace", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = minimalSnapshot();
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const request = snapshot.entities.contextRequests[CONTEXT_REQUEST_ID]!;
    createTraceSink({ dir: traceDir, now: () => new Date(NOW) }).emit({
      level: "info",
      eventName: "memory.query.started",
      outcome: "unknown",
      traceId: "trace_replay1",
      spanId: "span_no-memory-query",
      productRunId: RUN_ID,
      attemptId: PLANNING_ATTEMPT_ID,
      contextRequestId: CONTEXT_REQUEST_ID,
      memoryQueryId: MEMORY_QUERY_ID,
      backendId: MEMORY_BACKEND_ID,
      requirement: "required",
      sourceMessageSha256: request.sourceMessageSha256,
      tagCount: 0,
      layerCount: 1,
      requestedLimit: 1,
      contextBudget: 128,
    } as TraceEventInput);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
      },
      deps(),
    );
    expect(view.failures).toContain(
      "Trace关联错误：no-memory ContextRequest不应出现memory.query事件",
    );
  });

  it("Context/Memory正文默认隔离，授权后才组装Request、Query、Snapshot、Adoption与Package", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = withMemoryContext(minimalSnapshot(), "completed");
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    emitMemoryTrace(traceDir, snapshot, "completed");
    const input = {
      productRunId: RUN_ID,
      storePath: writeSnapshot(dir, snapshot),
      traceDir,
      versionEvidencePath: writeEvidence(dir),
    };
    const hidden = assembleRunReplay(input, deps());
    expect(hidden.content).toEqual({ included: false });
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect(JSON.stringify(hidden)).not.toContain(MEMORY_SECRET);

    const authorized = assembleRunReplay(
      {
        ...input,
        contentAccess: {
          mode: "authorized",
          principalId: "usr_operator1",
          purpose: "debug",
        },
      },
      { snapshotIntegrityCheck: () => undefined, authorizeContentAccess: () => true },
    );
    expect(authorized.content.included).toBe(true);
    if (!authorized.content.included) throw new Error("测试授权正文未组装");
    expect(authorized.content.facts.contextRequests).toHaveLength(1);
    expect(authorized.content.facts.memoryQueries).toHaveLength(1);
    expect(authorized.content.facts.memoryResultSnapshots).toHaveLength(1);
    expect(authorized.content.facts.memoryAdoptions).toHaveLength(1);
    expect(authorized.content.facts.contextPackages).toHaveLength(1);
    expect(JSON.stringify(authorized.content)).toContain(MEMORY_SECRET);
  });

  it("只有组合根授权后才组装Message与Plan正文", () => {
    const dir = tempDir();
    const traceDir = join(dir, "traces");
    const snapshot = withPlan(minimalSnapshot(), 1);
    emitCreated(traceDir, snapshot.entities.runs[RUN_ID]!);
    const access = { mode: "authorized" as const, principalId: "usr_operator1", purpose: "debug" };
    const authorize = vi.fn(() => true);
    const view = assembleRunReplay(
      {
        productRunId: RUN_ID,
        storePath: writeSnapshot(dir, snapshot),
        traceDir,
        versionEvidencePath: writeEvidence(dir),
        contentAccess: access,
      },
      { snapshotIntegrityCheck: () => undefined, authorizeContentAccess: authorize },
    );
    expect(authorize).toHaveBeenCalledWith(access);
    expect(view.content.included).toBe(true);
    expect(JSON.stringify(view.content)).toContain(SECRET);
    expect(JSON.stringify(view.content)).toContain("目标1");
  });

  it("请求正文但未获授权时失败关闭", () => {
    const dir = tempDir();
    const snapshot = minimalSnapshot();
    expect(() =>
      assembleRunReplay(
        {
          productRunId: RUN_ID,
          storePath: writeSnapshot(dir, snapshot),
          contentAccess: {
            mode: "authorized",
            principalId: "usr_operator1",
            purpose: "debug",
          },
        },
        { snapshotIntegrityCheck: () => undefined, authorizeContentAccess: () => false },
      ),
    ).toThrowError("未授权读取Product Store正文");
  });
});
