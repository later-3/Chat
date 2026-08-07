import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePlanSha256 } from "@chat/application";
import {
  messageIdSchema,
  planIdSchema,
  planRevisionIdSchema,
  productSnapshotSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runAttemptIdSchema,
  type PlanContent,
  type ProductSnapshot,
  type TraceEventInput,
} from "@chat/contracts";
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
const SECRET = "PRODUCT_CONTENT_ONLY_7f9c";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chat-replay-"));
}

function minimalSnapshot(
  run: Partial<ProductSnapshot["entities"]["runs"][string]> = {},
): ProductSnapshot {
  return productSnapshotSchema.parse({
    schemaVersion: "chat-product-store.v1",
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
          schemaVersion: "product-run.v1",
          productRunId: RUN_ID,
          sessionId: SESSION_ID,
          sourceMessageId: MESSAGE_ID,
          status: "pending",
          phase: "queued",
          maxPlanRevisions: 5,
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
      validationResults: {},
      artifacts: {},
    },
    commandReceipts: {},
    outbox: {},
  });
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
