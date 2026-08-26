import { serve } from "@hono/node-server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  planContentSchema,
  type ExecutionContract,
  type PlanContent,
  type PlanningInputDto,
  type TraceEventInput,
} from "@chat/contracts";
import {
  createRule,
  createRuleTag,
  createProductSession,
  submitUserMessage,
  submitPlanDecision,
  transitionRuleLifecycle,
  type ApplicationDeps,
  type IdFactory,
  type MemoryBackendRegistryPort,
  type RuleIdFactory,
} from "@chat/application";
import { SYSTEM_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
  computeWorkflowProjectResourceSha256,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { createWorkflowMemoryProviderRegistry } from "@chat/memory-runtime";
import { createApiApp } from "@chat/api";
import { OutboxDispatcher } from "@chat/api/outbox-dispatcher";
import {
  createWorkflowRuntimeServer,
  RuntimeBindingStore,
  setWorkflowRuntimeContext,
} from "@chat/workflows";
import type { AgentRunResult, BailianConfig, ExecutorStepCandidate } from "@chat/pi-runtime";

/**
 * M2后端闭环集成测试：
 * 真实Hono API + 真实JSON Product Store + 真实Vercel Workflow本地运行时 +
 * 真实Hook + 确定性pi实现（真实pi Agent loop已由pi-runtime单测证明，
 * 真实百炼由test:paid:provider:bailian证明）。
 *
 * 断言（任务书§20.3）：
 * - 一个Product Run只启动一个Workflow Run；v1后真实等待Hook。
 * - request_revision恢复同一Workflow并再次规划；approve进入Executor；reject不进入。
 * - 重复Decision只发生一次有效Resume；旧Approval不能再次决定。
 */

const PLAN_V1: PlanContent = planContentSchema.parse({
  objective: "整理项目进展并生成Markdown周报",
  summary: "v1：先归纳进展，再生成周报",
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "结构化原始输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      requestedCapabilities: [],
      risk: "low",
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  warnings: [],
});

const PLAN_V2: PlanContent = planContentSchema.parse({
  ...PLAN_V1,
  summary: "v2：风险单独成节，含三个行动项",
});

interface FakePi {
  plannerCalls: number;
  planningInputs: PlanningInputDto[];
  executorCalls: string[];
  planner: (input: {
    config: BailianConfig;
    planningInput: PlanningInputDto;
  }) => Promise<AgentRunResult<PlanContent>>;
  executor: (input: {
    config: BailianConfig;
    contract: ExecutionContract;
    stepId: string;
  }) => Promise<AgentRunResult<ExecutorStepCandidate>>;
}

function createFakePi(): FakePi {
  const state: FakePi = {
    plannerCalls: 0,
    planningInputs: [],
    executorCalls: [],
    planner: async ({ planningInput }) => {
      state.plannerCalls += 1;
      state.planningInputs.push(structuredClone(planningInput));
      const content = planningInput.planRevision === 1 ? PLAN_V1 : PLAN_V2;
      return {
        kind: "candidate",
        candidate: content,
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 5,
        providerCallCount: 1,
        providerMeta: { httpStatus: 200, providerRequestId: "req-fake-1" },
      };
    },
    executor: async ({ stepId }) => {
      state.executorCalls.push(stepId);
      return {
        kind: "candidate",
        candidate: {
          stepId,
          output: "要点清单：A完成，B进行中",
          sections: [
            { heading: "本周进展", body: "- A完成\n- B进行中" },
            { heading: "风险与下一步", body: "风险：B延期。下一步：行动项1/2/3" },
          ],
          successCriteriaEvidence: ["覆盖全部输入要点：已覆盖A与B两个要点"],
          criteriaEvidence: ["周报包含风险与下一步：已包含风险与下一步小节"],
          warnings: [],
        },
        usage: { inputTokens: 80, outputTokens: 40 },
        durationMs: 5,
        providerCallCount: 1,
        providerMeta: { httpStatus: 200, providerRequestId: "req-fake-2" },
      };
    },
  };
  return state;
}

let idCounter = 0;
function testIds(): IdFactory {
  const next = (prefix: string) => `${prefix}_it${(++idCounter).toString(36)}`;
  return {
    session: () => next("psn") as never,
    message: () => next("msg") as never,
    run: () => next("run") as never,
    attempt: () => next("att") as never,
    plan: () => next("pln") as never,
    planRevision: () => next("plr") as never,
    revisionInput: () => next("rin") as never,
    approval: () => next("apr") as never,
    decision: () => next("dec") as never,
    executionContract: () => next("exc") as never,
    executionCandidate: () => next("xcd") as never,
    validationResult: () => next("val") as never,
    artifact: () => next("art") as never,
    outbox: () => next("obx") as never,
  };
}

function testRuleIds(): RuleIdFactory {
  const next = (prefix: string) => `${prefix}_b2resource${(++idCounter).toString(36)}`;
  return {
    rule: () => next("rul") as ReturnType<RuleIdFactory["rule"]>,
    revision: () => next("rrv") as ReturnType<RuleIdFactory["revision"]>,
    tag: () => next("rtg") as ReturnType<RuleIdFactory["tag"]>,
    scope: () => next("rsc") as ReturnType<RuleIdFactory["scope"]>,
    decision: () => next("rde") as ReturnType<RuleIdFactory["decision"]>,
    selection: () => next("rsl") as ReturnType<RuleIdFactory["selection"]>,
  };
}

let cmdCounter = 0;
const nextCmd = (): string => `cmd_it${(++cmdCounter).toString(36)}`;

interface TestStack {
  deps: ApplicationDeps;
  dispatcher: OutboxDispatcher;
  fakePi: FakePi;
  traceEvents: TraceEventInput[];
  bindings: RuntimeBindingStore;
  worldRuns: () => Promise<unknown>;
  restartWorkflowRuntime: () => Promise<void>;
  close: () => Promise<void>;
}

// 与m1恢复测试同一预算口径：真实Runtime在负载高的机器上单次环回可能超过30s，
// 被测属性（幂等、原子投影、不双写）与时间无关。
async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitForCondition超时");
}

async function dumpDiagnostics(stack: TestStack, productRunId: string): Promise<void> {
  const current = await readRun(stack.deps, productRunId);
  process.stdout.write(
    "RUN " +
      JSON.stringify(
        current.run
          ? {
              status: current.run.status,
              phase: current.run.phase,
              revision: current.run.revision,
              failure: current.run.failure,
            }
          : null,
      ) +
      "\n",
  );
  process.stdout.write(
    "PLANS " +
      JSON.stringify(current.plans.map((p) => ({ rev: p.planRevision, status: p.status }))) +
      "\n",
  );
  process.stdout.write(
    "OUTBOX " +
      JSON.stringify(
        current.outbox.map((o) => ({
          kind: o.kind,
          status: o.status,
          attempts: o.dispatchAttempts,
          err: o.lastErrorCode,
        })),
      ) +
      "\n",
  );
  process.stdout.write(
    "TRACE " + JSON.stringify(stack.traceEvents.map((e) => `${e.eventName}:${e.outcome}`)) + "\n",
  );
}

const BUNDLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../workflows/.workflow-bundle",
);

/** B2场景不选择Memory；严格空Registry确保测试不会意外越过外部查询边界。 */
const EMPTY_MEMORY_BACKENDS: MemoryBackendRegistryPort = {
  list: () => [],
  get: () => undefined,
};

function listen(
  app: {
    fetch: (req: Request) => Promise<Response> | Response;
  },
  port = 0,
): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
      resolve({ server, port: info.port });
    });
    server.on("error", reject);
  });
}

async function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function startStack(fakePi: FakePi): Promise<TestStack> {
  const dir = await mkdtemp(join(tmpdir(), "chat-wf-it-"));
  const traceEvents: TraceEventInput[] = [];
  const trace = (event: TraceEventInput): void => {
    traceEvents.push(event);
  };

  const store = await JsonProductStore.open({
    filePath: join(dir, "product.json"),
    now: () => new Date().toISOString(),
  });
  const deps: ApplicationDeps = {
    store,
    now: () => new Date().toISOString(),
    ids: testIds(),
    ruleIds: testRuleIds(),
    workflowMemoryProviders: createWorkflowMemoryProviderRegistry({}),
    trace,
  };

  const credential = "rtk_integrationtest0000000000";
  const apiApp = createApiApp({
    traceSink: null,
    product: { deps, principalId: "usr_debug" as never },
    internalRuntime: { credential },
  });
  const { server: apiServer, port: apiPort } = await listen(apiApp);
  const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;

  const workflowOptions = {
    repoRoot: dir,
    bundleDir: BUNDLE_DIR,
    workflowDataDir: join(dir, "workflow-data"),
    bindingsPath: join(dir, "bindings.json"),
    apiBaseUrl,
    credential,
    traceSink: { emit: trace },
    runtimeOverrides: {
      memoryBackends: EMPTY_MEMORY_BACKENDS,
      workflowMemoryProviders: createWorkflowMemoryProviderRegistry({}),
      now: () => new Date().toISOString(),
      bailian: {
        apiKey: "fake",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        endpointHost: "dashscope.aliyuncs.com",
      },
      planner: fakePi.planner as never,
      executor: fakePi.executor as never,
    },
  } as const;
  let workflowRuntime = await createWorkflowRuntimeServer(workflowOptions);
  let listenedWorkflow = await listen(workflowRuntime.app);
  const workflowPort = listenedWorkflow.port;

  const dispatcher = new OutboxDispatcher({
    deps,
    workflowRuntimeBaseUrl: `http://127.0.0.1:${String(workflowPort)}`,
    credential,
  });

  const stack: TestStack = {
    deps,
    dispatcher,
    fakePi,
    traceEvents,
    bindings: workflowRuntime.bindings,
    worldRuns: async () => {
      const runs = await workflowRuntime.world.world.runs.list({ pagination: { limit: 5 } });
      const first = runs.data[0];
      if (first === undefined) return runs;
      const events = await workflowRuntime.world.world.events.list({
        runId: first.runId,
        pagination: { limit: 100 },
        resolveData: "all",
      });
      return {
        runs: runs.data,
        events: events.data.map((e) => ({
          type: e.eventType,
          data: "eventData" in e ? e.eventData : undefined,
        })),
      };
    },
    restartWorkflowRuntime: async () => {
      await closeServer(listenedWorkflow.server);
      await workflowRuntime.world.close();
      workflowRuntime = await createWorkflowRuntimeServer(workflowOptions);
      listenedWorkflow = await listen(workflowRuntime.app, workflowPort);
      stack.bindings = workflowRuntime.bindings;
    },
    close: async () => {
      await closeServer(apiServer);
      await closeServer(listenedWorkflow.server);
      await workflowRuntime.world.close();
      setWorkflowRuntimeContext(undefined);
    },
  };
  return stack;
}

async function seedRun(deps: ApplicationDeps, text = "根据我的项目进展生成包含风险与下一步的周报") {
  const { session } = await createProductSession(deps, {
    principalId: "usr_debug" as never,
    commandId: nextCmd() as never,
    payload: {},
  });
  const { run } = await submitUserMessage(deps, {
    principalId: "usr_debug" as never,
    sessionId: session.sessionId,
    commandId: nextCmd() as never,
    payload: { text },
  });
  return { session, run };
}

async function seedProjectAndRuleRun(deps: ApplicationDeps) {
  const principalId = "usr_debug" as never;
  const { session } = await createProductSession(deps, {
    principalId,
    commandId: nextCmd() as never,
    payload: {},
  });
  const at = deps.now();
  const projectId = "prj_b2resource1" as never;
  const methodSnapshotId = "pms_b2resource1" as never;
  const stageId = "pst_b2resource1" as never;
  const policies = compileProjectMethodSnapshotPolicies("small-project.v1");
  const methodSha256 = computeProjectMethodSnapshotSha256({
    profileId: "small-project.v1",
    rationale: "B2真实Project/Rule上下文链",
    policies,
    source: "user_tailored",
  });
  await deps.store.transact({
    commandId: nextCmd() as never,
    commandType: "CreateProductSession",
    requestSha256: hashCanonical("b2-project-rule-resource-fixture.v1", {
      sessionId: session.sessionId,
      projectId,
    }),
    mutate: (draft) => {
      draft.entities.projectMethodSnapshots[methodSnapshotId] = {
        schemaVersion: "project-method-snapshot.v3",
        projectMethodSnapshotId: methodSnapshotId,
        projectId,
        profileId: "small-project.v1",
        rationale: "B2真实Project/Rule上下文链",
        policies,
        source: "user_tailored",
        sha256: methodSha256,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      draft.entities.projectStages[stageId] = {
        schemaVersion: "project-stage.v2",
        projectStageId: stageId,
        projectId,
        methodSnapshotId,
        key: "delivery",
        name: "交付",
        goal: "PROJECT_CONTEXT_B2_CANARY进入真实Planner输入",
        successCriteria: ["Project与Rule Context原子投影成功"],
        status: "active",
        sequence: 1,
        startedAt: at,
        completionEvidenceIds: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      draft.entities.projectParticipants["ppt_b2resource1"] = {
        schemaVersion: "project-participant.v1",
        projectParticipantId: "ppt_b2resource1" as never,
        projectId,
        kind: "human",
        principalId,
        displayName: "B2 Owner",
        role: "owner",
        status: "active",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      draft.entities.projects[projectId] = {
        schemaVersion: "project.v2",
        projectId,
        ownerPrincipalId: principalId,
        name: "B2 Context Project",
        summary: "验证真实Workflow消费冻结Project与Rule",
        goal: "PROJECT_CONTEXT_B2_CANARY进入真实Planner输入",
        scopeIn: ["Planning Context"],
        scopeOut: ["外部副作用"],
        successCriteria: ["节点生命周期无Runner双写"],
        status: "active",
        methodSnapshotId,
        currentStageId: stageId,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      return { resultRefs: { sessionId: session.sessionId } };
    },
  });
  const tag = await createRuleTag(deps, {
    principalId,
    commandId: nextCmd() as never,
    payload: { name: "B2 Context" },
  });
  const created = await createRule(deps, {
    principalId,
    commandId: nextCmd() as never,
    payload: {
      title: "B2真实规则",
      priority: 900,
      revision: {
        body: "RULE_CONTEXT_B2_CANARY：提交前必须保留真实跨层证据。",
        rationale: "验证Rule Selection进入Planner",
        appliesWhen: ["执行Planning Workflow"],
        doesNotApplyWhen: [],
        positiveExamples: [],
        negativeExamples: [],
        scopes: [{ kind: "contextual", scenario: "planning", workflowNodeKey: "policy.rules" }],
        tagIds: [tag.tag.ruleTagId],
        conflictsWithRuleIds: [],
        risk: "high",
        sourceCases: [],
      },
    },
  });
  const trial = await transitionRuleLifecycle(deps, {
    principalId,
    commandId: nextCmd() as never,
    ruleId: created.rule.ruleId,
    expectedRevision: created.rule.revision,
    payload: {
      boundRevisionId: created.rule.currentRevision.ruleRevisionId,
      boundRevisionSha256: created.rule.currentRevision.sha256,
      toLifecycle: "trial",
      reason: "B2试用",
    },
  });
  const active = await transitionRuleLifecycle(deps, {
    principalId,
    commandId: nextCmd() as never,
    ruleId: trial.rule.ruleId,
    expectedRevision: trial.rule.revision,
    payload: {
      boundRevisionId: trial.rule.currentRevision.ruleRevisionId,
      boundRevisionSha256: trial.rule.currentRevision.sha256,
      toLifecycle: "active",
      reason: "B2启用",
    },
  });
  const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const definition =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
  const project = snapshot.entities.projects[projectId];
  if (definition === undefined || project === undefined) throw new Error("B2资源fixture损坏");
  const { run } = await submitUserMessage(deps, {
    principalId,
    sessionId: session.sessionId,
    commandId: nextCmd() as never,
    payload: {
      text: "结合冻结Project与Rule给出下一步计划",
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
        definitionSha256: definition.definitionSha256,
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "resource_selection",
              definitionNodeId: "planning.project",
              resourceKind: "project",
              required: true,
              selections: [
                {
                  resourceId: project.projectId,
                  expectedRevision: project.revision,
                  expectedSha256: computeWorkflowProjectResourceSha256(project),
                },
              ],
            },
            { kind: "node_enabled", definitionNodeId: "planning.rules", enabled: true },
            {
              kind: "resource_selection",
              definitionNodeId: "planning.rules",
              resourceKind: "rule",
              required: true,
              selections: [
                {
                  resourceId: active.rule.ruleId,
                  expectedRevision: active.rule.currentRevision.revision,
                  expectedSha256: active.rule.currentRevision.sha256,
                },
              ],
            },
          ],
        },
      },
    },
  });
  return { run };
}

async function readRun(deps: ApplicationDeps, productRunId: string) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[productRunId as never];
  const plans = Object.values(snapshot.entities.plans)
    .filter((plan) => plan.productRunId === productRunId)
    .sort((a, b) => a.planRevision - b.planRevision);
  const approvals = Object.values(snapshot.entities.approvalRequests).filter(
    (approval) => approval.productRunId === productRunId,
  );
  const messages = Object.values(snapshot.entities.messages)
    .filter((message) => message.sourceRunId === productRunId)
    .sort((a, b) => a.sessionSequence - b.sessionSequence);
  const outbox = Object.values(snapshot.outbox).filter(
    (entry) => "productRunId" in entry && entry.productRunId === productRunId,
  );
  return { run, plans, approvals, messages, outbox, snapshot };
}

async function reviewCheckpointReady(stack: TestStack, productRunId: string): Promise<boolean> {
  const current = await readRun(stack.deps, productRunId);
  if (current.run?.status !== "waiting_human") return false;
  const approval = current.approvals.find((candidate) => candidate.status === "open");
  if (approval === undefined) return false;
  const hook = stack.bindings.getHookBinding(approval.approvalRequestId);
  if (hook?.hookClaimState !== "claimed") return false;
  const reviewNode = Object.values(current.snapshot.entities.workflowNodeRuns).find(
    (candidate) =>
      candidate.productRunId === productRunId &&
      candidate.nodeType === "human.plan_review" &&
      candidate.status === "waiting_human" &&
      candidate.executionPath.at(-1)?.iteration === approval.planRevision,
  );
  // publishPlan原子生成waiting产品事实；Hook Binding已claim即是可恢复耐久点。
  // 不要求第二条通用Transition Receipt，避免测试反向制造业务节点双写。
  return reviewNode !== undefined;
}

describe("M2后端闭环（真实Workflow运行时 + Hook + 确定性pi）", () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack(createFakePi());
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
  });

  it("完整链路：v1 -> 修改 -> v2 -> 批准 -> 执行 -> 正式Assistant Message", async () => {
    const { run } = await seedRun(stack.deps);

    await stack.dispatcher.tick();
    try {
      await waitForCondition(() => reviewCheckpointReady(stack, run.productRunId));
    } catch (error) {
      const current = await readRun(stack.deps, run.productRunId);
      const runs = await stack.worldRuns();
      const diag = {
        run: current.run
          ? {
              status: current.run.status,
              phase: current.run.phase,
              revision: current.run.revision,
              failure: current.run.failure,
            }
          : null,
        plans: current.plans.map((p) => ({ rev: p.planRevision, status: p.status })),
        outbox: current.outbox.map((o) => ({
          kind: o.kind,
          status: o.status,
          attempts: o.dispatchAttempts,
          err: o.lastErrorCode,
        })),
        trace: stack.traceEvents.map((e) => `${e.eventName}:${e.outcome}`),
        world: runs,
      };
      throw new Error(`首阶段超时诊断:${JSON.stringify(diag)?.slice(0, 4000)}`, { cause: error });
    }
    let current = await readRun(stack.deps, run.productRunId);
    if (current.plans.length !== 1) await dumpDiagnostics(stack, run.productRunId);
    expect(current.plans).toHaveLength(1);
    expect(current.plans[0]?.planRevision).toBe(1);
    expect(current.plans[0]?.status).toBe("under_review");
    expect(stack.fakePi.plannerCalls).toBe(1);
    const bindingV1 = stack.bindings.getWorkflowBinding(run.productRunId as never);
    expect(bindingV1).toMatchObject({
      runnerFamily: "configurable-planning.v1",
      runnerBundleVersion: "configurable-planning.bundle.v1",
      workflowRunSpecId: current.run?.workflowRunSpecId,
    });

    const v1Approval = current.approvals.find((approval) => approval.status === "open");
    expect(v1Approval).toBeDefined();

    // 真实关闭并重建Workflow Runtime/Local World；恢复同一Hook，不重新调用Planner。
    await stack.restartWorkflowRuntime();
    expect(stack.bindings.getWorkflowBinding(run.productRunId as never)?.workflowRunId).toBe(
      bindingV1?.workflowRunId,
    );
    expect(stack.fakePi.plannerCalls).toBe(1);
    current = await readRun(stack.deps, run.productRunId);

    // 提交修改意见
    const v1 = current.plans[0];
    const decision1 = await submitPlanDecision(stack.deps, {
      principalId: "usr_debug" as never,
      productRunId: run.productRunId as never,
      commandId: nextCmd() as never,
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        approvalRequestId: v1Approval?.approvalRequestId as never,
        planId: v1?.planId as never,
        planRevision: 1,
        planSha256: v1?.sha256 ?? "",
        kind: "request_revision",
        revisionInstruction: "把风险单独成节，并增加下周三个行动项",
      },
    });
    expect(decision1.run.phase).toBe("planning");

    await stack.dispatcher.tick();
    try {
      await waitForCondition(async () => {
        const next = await readRun(stack.deps, run.productRunId);
        return next.plans.length === 2 && (await reviewCheckpointReady(stack, run.productRunId));
      });
    } catch (error) {
      const current2 = await readRun(stack.deps, run.productRunId);
      const hookB =
        v1Approval !== undefined
          ? stack.bindings.getHookBinding(v1Approval.approvalRequestId as never)
          : undefined;
      const runs = await stack.worldRuns();
      const diag = {
        run: current2.run
          ? {
              status: current2.run.status,
              phase: current2.run.phase,
              failure: current2.run.failure,
            }
          : null,
        plans: current2.plans.map((pp) => ({ rev: pp.planRevision, status: pp.status })),
        outbox: current2.outbox.map((o) => ({
          kind: o.kind,
          status: o.status,
          attempts: o.dispatchAttempts,
          err: o.lastErrorCode,
        })),
        hookBinding: hookB
          ? { claim: hookB.hookClaimState, resume: hookB.resumeDispatchState }
          : null,
        trace: stack.traceEvents.map((e) => `${e.eventName}:${e.outcome}`).slice(-20),
        world: JSON.stringify(runs)?.slice(0, 3000),
      };
      throw new Error(`v2等待超时诊断:${JSON.stringify(diag)}`, { cause: error });
    }
    current = await readRun(stack.deps, run.productRunId);
    if (stack.fakePi.plannerCalls !== 2) await dumpDiagnostics(stack, run.productRunId);
    expect(stack.fakePi.plannerCalls).toBe(2);
    expect(current.plans[0]?.status).toBe("superseded");
    expect(current.plans[1]?.planRevision).toBe(2);
    expect(current.plans[1]?.status).toBe("under_review");
    expect(current.plans[1]?.sha256).not.toBe(current.plans[0]?.sha256);
    // 仍是同一个Workflow私有映射（只断言唯一性，不暴露实际ID）
    expect(stack.bindings.getWorkflowBinding(run.productRunId as never)?.workflowRunId).toBe(
      bindingV1?.workflowRunId,
    );

    // 旧Approval重复决定失败关闭
    const v2 = current.plans[1];
    const v2Approval = current.approvals.find((approval) => approval.status === "open");
    await expect(
      submitPlanDecision(stack.deps, {
        principalId: "usr_debug" as never,
        productRunId: run.productRunId as never,
        commandId: nextCmd() as never,
        expectedRunRevision: current.run?.revision ?? 0,
        payload: {
          approvalRequestId: v1Approval?.approvalRequestId as never,
          planId: v1?.planId as never,
          planRevision: 1,
          planSha256: v1?.sha256 ?? "",
          kind: "approve",
        },
      }),
    ).rejects.toMatchObject({ code: "approval_already_decided" });

    // 批准v2
    const decision2 = await submitPlanDecision(stack.deps, {
      principalId: "usr_debug" as never,
      productRunId: run.productRunId as never,
      commandId: nextCmd() as never,
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        approvalRequestId: v2Approval?.approvalRequestId as never,
        planId: v2?.planId as never,
        planRevision: 2,
        planSha256: v2?.sha256 ?? "",
        kind: "approve",
      },
    });
    expect(decision2.run.phase).toBe("executing");

    await stack.dispatcher.tick();
    await waitForCondition(async () => {
      const next = await readRun(stack.deps, run.productRunId);
      return next.run?.status === "succeeded";
    });
    current = await readRun(stack.deps, run.productRunId);
    expect(current.run?.phase).toBe("completed");
    expect(stack.fakePi.executorCalls).toEqual(["step-1"]);
    expect(current.messages).toHaveLength(1);
    expect(current.messages[0]?.role).toBe("assistant");
    expect(current.messages[0]?.content.text).toContain("风险与下一步");
    expect(current.run?.finalMessageId).toBe(current.messages[0]?.messageId);
    expect(stack.fakePi.plannerCalls).toBe(2);
  }, 90_000);

  it("reject恢复同一Workflow进入cancelled，Executor调用数为0", async () => {
    const { run } = await seedRun(stack.deps, "另一条消息：测试拒绝路径");
    const executorBefore = stack.fakePi.executorCalls.length;
    await stack.dispatcher.tick();
    await waitForCondition(() => reviewCheckpointReady(stack, run.productRunId));
    const current = await readRun(stack.deps, run.productRunId);
    const approval = current.approvals.find((candidate) => candidate.status === "open");
    const plan = current.plans[0];
    await submitPlanDecision(stack.deps, {
      principalId: "usr_debug" as never,
      productRunId: run.productRunId as never,
      commandId: nextCmd() as never,
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        approvalRequestId: approval?.approvalRequestId as never,
        planId: plan?.planId as never,
        planRevision: 1,
        planSha256: plan?.sha256 ?? "",
        kind: "reject",
        reason: "不需要了",
      },
    });
    await stack.dispatcher.tick();
    await waitForCondition(async () => {
      const next = await readRun(stack.deps, run.productRunId);
      return next.run?.status === "cancelled";
    });
    const final = await readRun(stack.deps, run.productRunId);
    expect(final.run?.phase).toBe("rejected");
    expect(final.messages).toHaveLength(0);
    expect(stack.fakePi.executorCalls.length).toBe(executorBefore);
  }, 90_000);

  it("同一commandId重复提交Decision只恢复一次Hook", async () => {
    const { run } = await seedRun(stack.deps, "第三条消息：重复决定");
    await stack.dispatcher.tick();
    await waitForCondition(() => reviewCheckpointReady(stack, run.productRunId));
    const current = await readRun(stack.deps, run.productRunId);
    const approval = current.approvals.find((candidate) => candidate.status === "open");
    const plan = current.plans[0];
    const commandId = nextCmd();
    const input = {
      principalId: "usr_debug" as never,
      productRunId: run.productRunId as never,
      commandId: commandId as never,
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        approvalRequestId: approval?.approvalRequestId as never,
        planId: plan?.planId as never,
        planRevision: 1,
        planSha256: plan?.sha256 ?? "",
        kind: "request_revision" as const,
        revisionInstruction: "改一版",
      },
    };
    await submitPlanDecision(stack.deps, input);
    await submitPlanDecision(stack.deps, input); // 幂等重放
    await stack.dispatcher.tick();
    await stack.dispatcher.tick();
    await waitForCondition(async () => {
      const next = await readRun(stack.deps, run.productRunId);
      return next.plans.length === 2;
    });
    const final = await readRun(stack.deps, run.productRunId);
    const resumeEntries = final.outbox.filter((entry) => entry.kind === "workflow_resume");
    expect(resumeEntries).toHaveLength(1);
    const hookBinding = stack.bindings.getHookBinding(approval?.approvalRequestId as never);
    expect(hookBinding?.resumeDispatchState).toBe("dispatched");
  }, 90_000);

  it("真实Project+Rule选择由Application原子投影并进入Planner，Runner不双写Node", async () => {
    const plannerBefore = stack.fakePi.plannerCalls;
    const { run } = await seedProjectAndRuleRun(stack.deps);
    await stack.dispatcher.tick();
    await waitForCondition(() => reviewCheckpointReady(stack, run.productRunId));

    const current = await readRun(stack.deps, run.productRunId);
    expect(stack.fakePi.plannerCalls).toBe(plannerBefore + 1);
    const planningInput = stack.fakePi.planningInputs.at(-1);
    expect(planningInput?.projectContext?.snapshot.goal).toContain("PROJECT_CONTEXT_B2_CANARY");
    expect(planningInput?.rulesContext?.rules[0]?.body).toContain("RULE_CONTEXT_B2_CANARY");
    const resourceNodes = Object.values(current.snapshot.entities.workflowNodeRuns).filter(
      (node) =>
        node.productRunId === run.productRunId &&
        (node.definitionNodeId === "planning.project" ||
          node.definitionNodeId === "planning.rules"),
    );
    expect(resourceNodes).toHaveLength(2);
    for (const node of resourceNodes) {
      expect(node).toMatchObject({
        status: "succeeded",
        outcomeCode: "success",
        executionPath: [],
        attemptNumber: 1,
      });
      const transitions = Object.values(current.snapshot.entities.nodeRunTransitions)
        .filter((transition) => transition.workflowNodeRunId === node.workflowNodeRunId)
        .sort((left, right) => left.nodeSequence - right.nodeSequence);
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        "queued",
        "running",
        "succeeded",
      ]);
    }

    const approval = current.approvals.find((candidate) => candidate.status === "open");
    const plan = current.plans[0];
    await submitPlanDecision(stack.deps, {
      principalId: "usr_debug" as never,
      productRunId: run.productRunId as never,
      commandId: nextCmd() as never,
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        approvalRequestId: approval?.approvalRequestId as never,
        planId: plan?.planId as never,
        planRevision: 1,
        planSha256: plan?.sha256 ?? "",
        kind: "reject",
        reason: "跨层资源证据已验证",
      },
    });
    await stack.dispatcher.tick();
    await waitForCondition(
      async () => (await readRun(stack.deps, run.productRunId)).run?.status === "cancelled",
    );
  }, 90_000);
});
