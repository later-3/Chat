import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommandId,
  type PrincipalId,
  type ProductSessionId,
  type ProjectId,
} from "@chat/contracts";
import {
  compilePlanningInput,
  compileExecutionContract,
  beginRunAttempt,
  preparePlanningProjectContext,
  publishPlanForReview,
  setProjectArchiveStatus,
  submitPlanDecision,
  submitUserMessage,
  type ApplicationDeps,
  type IdFactory,
  type ProjectIdFactory,
} from "@chat/application";
import { SYSTEM_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
  computeWorkflowProjectResourceSha256,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { auditProductIntegrity } from "./product-integrity-auditor.js";
import { createApiApp } from "@chat/api";

const NOW = "2026-08-10T12:00:00.000Z";
const PRINCIPAL = "usr_projectcontext" as PrincipalId;
const SESSION_ID = "psn_projectcontext1" as ProductSessionId;
const PROJECT_ID = "prj_projectcontext1" as ProjectId;

function ids(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_projectctx${(++sequence).toString(36)}`;
  return {
    session: () => next("psn") as ReturnType<IdFactory["session"]>,
    message: () => next("msg") as ReturnType<IdFactory["message"]>,
    run: () => next("run") as ReturnType<IdFactory["run"]>,
    attempt: () => next("att") as ReturnType<IdFactory["attempt"]>,
    plan: () => next("pln") as ReturnType<IdFactory["plan"]>,
    planRevision: () => next("plr") as ReturnType<IdFactory["planRevision"]>,
    revisionInput: () => next("rin") as ReturnType<IdFactory["revisionInput"]>,
    approval: () => next("apr") as ReturnType<IdFactory["approval"]>,
    decision: () => next("dec") as ReturnType<IdFactory["decision"]>,
    executionContract: () => next("exc") as ReturnType<IdFactory["executionContract"]>,
    executionCandidate: () => next("xcd") as ReturnType<IdFactory["executionCandidate"]>,
    validationResult: () => next("val") as ReturnType<IdFactory["validationResult"]>,
    artifact: () => next("art") as ReturnType<IdFactory["artifact"]>,
    outbox: () => next("obx") as ReturnType<IdFactory["outbox"]>,
  };
}

function projectIds(): ProjectIdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_projectctx${(++sequence).toString(36)}`;
  return {
    project: () => next("prj") as ReturnType<ProjectIdFactory["project"]>,
    methodSnapshot: () => next("pms") as ReturnType<ProjectIdFactory["methodSnapshot"]>,
    stage: () => next("pst") as ReturnType<ProjectIdFactory["stage"]>,
    resource: () => next("prs") as ReturnType<ProjectIdFactory["resource"]>,
    participant: () => next("ppt") as ReturnType<ProjectIdFactory["participant"]>,
    work: () => next("pwk") as ReturnType<ProjectIdFactory["work"]>,
    action: () => next("pac") as ReturnType<ProjectIdFactory["action"]>,
    contribution: () => next("pcb") as ReturnType<ProjectIdFactory["contribution"]>,
    evidence: () => next("pev") as ReturnType<ProjectIdFactory["evidence"]>,
    decision: () => next("pdc") as ReturnType<ProjectIdFactory["decision"]>,
    observation: () => next("pob") as ReturnType<ProjectIdFactory["observation"]>,
    candidate: () => next("pcd") as ReturnType<ProjectIdFactory["candidate"]>,
    milestone: () => next("pml") as ReturnType<ProjectIdFactory["milestone"]>,
    update: () => next("pup") as ReturnType<ProjectIdFactory["update"]>,
    stateTransition: () => next("ptr") as ReturnType<ProjectIdFactory["stateTransition"]>,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chat-project-context-"));
  let tick = 0;
  let commandSequence = 0;
  const now = () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = { store, now, ids: ids(), projectIds: projectIds() };
  const command = () => `cmd_projectctx${(++commandSequence).toString(36)}` as CommandId;
  const policies = compileProjectMethodSnapshotPolicies("small-project.v1");
  const methodSha256 = computeProjectMethodSnapshotSha256({
    profileId: "small-project.v1",
    rationale: "冻结Planning Project Context测试",
    policies,
    source: "user_tailored",
  });
  await store.transact({
    commandId: command(),
    commandType: "CreateProductSession",
    requestSha256: hashCanonical("planning-project-context-fixture.v1", { PROJECT_ID }),
    mutate: (draft) => {
      draft.entities.sessions[SESSION_ID] = {
        schemaVersion: "product-session.v1",
        sessionId: SESSION_ID,
        ownerPrincipalId: PRINCIPAL,
        status: "active",
        lastMessageSequence: 0,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.projectMethodSnapshots["pms_projectcontext1"] = {
        schemaVersion: "project-method-snapshot.v3",
        projectMethodSnapshotId: "pms_projectcontext1" as never,
        projectId: PROJECT_ID,
        profileId: "small-project.v1",
        rationale: "冻结Planning Project Context测试",
        policies,
        source: "user_tailored",
        sha256: methodSha256,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.projectStages["pst_projectcontext1"] = {
        schemaVersion: "project-stage.v2",
        projectStageId: "pst_projectcontext1" as never,
        projectId: PROJECT_ID,
        methodSnapshotId: "pms_projectcontext1" as never,
        key: "delivery",
        name: "交付",
        goal: "完成可验证的Project Context纵向链",
        successCriteria: ["PROJECT_CONTEXT_CANARY_61AF进入Planner输入"],
        status: "active",
        sequence: 1,
        startedAt: NOW,
        completionEvidenceIds: [],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.projectParticipants["ppt_projectcontext1"] = {
        schemaVersion: "project-participant.v1",
        projectParticipantId: "ppt_projectcontext1" as never,
        projectId: PROJECT_ID,
        kind: "human",
        principalId: PRINCIPAL,
        displayName: "项目所有者",
        role: "owner",
        status: "active",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.projects[PROJECT_ID] = {
        schemaVersion: "project.v2",
        projectId: PROJECT_ID,
        ownerPrincipalId: PRINCIPAL,
        name: "Aurora",
        summary: "Project Context测试项目",
        goal: "验证运行前选择的Project在规划中按revision/hash冻结",
        scopeIn: ["Project Context", "Planning Input"],
        scopeOut: ["部署"],
        successCriteria: ["旧Context不受Project后续revision影响"],
        status: "active",
        methodSnapshotId: "pms_projectcontext1" as never,
        currentStageId: "pst_projectcontext1" as never,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return { resultRefs: { sessionId: SESSION_ID } };
    },
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const definition =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
  const project = snapshot.entities.projects[PROJECT_ID];
  if (definition === undefined || project === undefined) throw new Error("fixture seed missing");
  const submitted = await submitUserMessage(deps, {
    principalId: PRINCIPAL,
    sessionId: SESSION_ID,
    commandId: command(),
    payload: {
      text: "请结合当前项目给出下一阶段计划",
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
                  resourceId: PROJECT_ID,
                  expectedRevision: project.revision,
                  expectedSha256: computeWorkflowProjectResourceSha256(project),
                },
              ],
            },
          ],
        },
      },
    },
  });
  const committed = await store.read({ kind: "committedSnapshot" });
  const run = committed.snapshot.entities.runs[submitted.run.productRunId];
  const workflowRunSpecId = run?.workflowRunSpecId;
  if (run?.runKind !== "planning" || workflowRunSpecId === undefined) {
    throw new Error("RunSpec missing");
  }
  return {
    deps,
    store,
    command,
    run,
    workflowRunSpecId,
    fullWorkflowSelection: {
      kind: "published_revision" as const,
      workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
      definitionSha256: definition.definitionSha256,
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1" as const,
        overrides: [],
      },
    },
  };
}

describe("Planning Project Context", () => {
  it("未选择Project时业务集合保持空且context.project原子skipped", async () => {
    const test = await fixture();
    const submitted = await submitUserMessage(test.deps, {
      principalId: PRINCIPAL,
      sessionId: SESSION_ID,
      commandId: test.command(),
      payload: {
        text: "本轮不选择Project。",
        workflowSelection: test.fullWorkflowSelection,
      },
    });
    const before = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const run = before.entities.runs[submitted.run.productRunId];
    if (run?.workflowRunSpecId === undefined) throw new Error("fixture缺少RunSpec");
    const prepared = await preparePlanningProjectContext(test.deps, {
      commandId: test.command(),
      productRunId: run.productRunId,
      workflowRunSpecId: run.workflowRunSpecId,
      definitionNodeId: "planning.project",
      executionPath: [],
      attemptNumber: 1,
    });
    expect(prepared).toEqual({ status: "none" });
    const snapshot = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(snapshot.entities.planningProjectContexts)).toHaveLength(0);
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).find(
        (node) =>
          node.productRunId === run.productRunId && node.definitionNodeId === "planning.project",
      ),
    ).toMatchObject({ status: "skipped", outcomeCode: "optional_unavailable" });
  });

  it("按RunSpec精确冻结，并进入Planning Attempt/DTO；重放不产生第二份Context", async () => {
    const test = await fixture();
    const prepareCommandId = test.command();
    const prepared = await preparePlanningProjectContext(test.deps, {
      commandId: prepareCommandId,
      productRunId: test.run.productRunId,
      workflowRunSpecId: test.workflowRunSpecId,
      definitionNodeId: "planning.project",
      executionPath: [],
      attemptNumber: 1,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;

    const atomicSnapshot = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const contextNode = Object.values(atomicSnapshot.entities.workflowNodeRuns).find(
      (node) =>
        node.productRunId === test.run.productRunId && node.definitionNodeId === "planning.project",
    );
    expect(contextNode).toMatchObject({
      status: "succeeded",
      executionPath: [],
      attemptNumber: 1,
    });
    const inputManifest =
      contextNode?.inputManifestId === undefined
        ? undefined
        : atomicSnapshot.entities.nodeValueManifests[contextNode.inputManifestId];
    const outputManifest =
      contextNode?.outputManifestId === undefined
        ? undefined
        : atomicSnapshot.entities.nodeValueManifests[contextNode.outputManifestId];
    expect(inputManifest?.slots[0]?.refs[0]).toMatchObject({
      kind: "project",
      id: PROJECT_ID,
    });
    expect(outputManifest?.slots[0]?.refs[0]).toMatchObject({
      kind: "planning_project_context",
      id: prepared.contextRef.planningProjectContextId,
      sha256: prepared.contextRef.sha256,
    });

    const replayed = await preparePlanningProjectContext(test.deps, {
      commandId: prepareCommandId,
      productRunId: test.run.productRunId,
      workflowRunSpecId: test.workflowRunSpecId,
      definitionNodeId: "planning.project",
      executionPath: [],
      attemptNumber: 1,
    });
    expect(replayed).toEqual(prepared);

    const compileCommandId = test.command();
    const input = await compilePlanningInput(test.deps, {
      commandId: compileCommandId,
      productRunId: test.run.productRunId,
      planRevision: 1,
      planningProjectContextRef: prepared.contextRef,
    });
    await expect(
      compilePlanningInput(test.deps, {
        commandId: compileCommandId,
        productRunId: test.run.productRunId,
        planRevision: 1,
        planningProjectContextRef: {
          ...prepared.contextRef,
          sha256: "f".repeat(64),
        },
      }),
    ).rejects.toThrow("commandId");
    expect(input.projectContext?.snapshot.stage.successCriteria).toContain(
      "PROJECT_CONTEXT_CANARY_61AF进入Planner输入",
    );
    const committed = await test.store.read({ kind: "committedSnapshot" });
    expect(Object.values(committed.snapshot.entities.planningProjectContexts)).toHaveLength(1);
    expect(auditProductIntegrity(committed.snapshot)).toMatchObject({ ok: true, issues: [] });
    const damagedContext = structuredClone(committed.snapshot);
    const context = Object.values(damagedContext.entities.planningProjectContexts)[0];
    if (context === undefined) throw new Error("Auditor反证缺少Project Context");
    context.projectSha256 = "f".repeat(64);
    expect(auditProductIntegrity(damagedContext).issues.map((issue) => issue.code)).toContain(
      "planning_project_context.binding_invalid",
    );
    expect(committed.snapshot.entities.attempts[input.attemptId]?.planningProjectContextId).toBe(
      prepared.contextRef.planningProjectContextId,
    );
    const published = await publishPlanForReview(test.deps, {
      commandId: test.command(),
      productRunId: test.run.productRunId,
      attemptId: input.attemptId,
      expectedRunRevision: input.inputRunRevision,
      inputManifestSha256: input.inputManifestSha256,
      content: {
        objective: "基于冻结Project Context制定下一阶段计划",
        summary: "保留Project目标与Stage验收证据",
        assumptions: [{ statement: "Project Context已由服务端冻结", source: "context" }],
        openQuestions: [],
        steps: [
          {
            stepId: "step-1",
            title: "形成下一阶段任务书",
            purpose: "把Project Stage目标转换为可审核计划",
            dependsOn: [],
            inputRefs: [
              {
                refId: prepared.contextRef.planningProjectContextId,
                revision: prepared.contextRef.revision,
                sha256: prepared.contextRef.sha256,
              },
            ],
            expectedOutput: "下一阶段任务书",
            successCriteria: ["引用的Project Context三元组完全匹配"],
            requestedCapabilities: ["markdown_text_compose"],
            risk: "low",
          },
        ],
        completionCriteria: ["任务书可由用户审核"],
        warnings: [],
      },
    });
    expect(published.plan.content.steps[0]?.inputRefs[0]?.refId).toBe(
      prepared.contextRef.planningProjectContextId,
    );
    const decided = await submitPlanDecision(test.deps, {
      principalId: PRINCIPAL,
      commandId: test.command(),
      productRunId: test.run.productRunId,
      expectedRunRevision: published.run.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: published.plan.planRevision,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    const { contract } = await compileExecutionContract(test.deps, {
      commandId: test.command(),
      productRunId: test.run.productRunId,
      approvalDecisionId: decided.decision.decisionId,
    });
    const execution = await beginRunAttempt(test.deps, {
      commandId: test.command(),
      productRunId: test.run.productRunId,
      kind: "execution",
      executionContractId: contract.executionContractId,
      stepId: "step-1",
      dependencyRefs: [],
      promptTemplateVersion: "executor-prompt.v1",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
    });
    expect(execution.contextItems).toEqual([
      expect.objectContaining({
        contextKind: "project",
        refId: prepared.contextRef.planningProjectContextId,
        sha256: prepared.contextRef.sha256,
      }),
    ]);

    await setProjectArchiveStatus(test.deps, {
      principalId: PRINCIPAL,
      commandId: test.command(),
      projectId: PROJECT_ID,
      expectedRevision: 1,
      payload: { status: "archived" },
    });
    const afterProjectRevision = await test.store.read({ kind: "committedSnapshot" });
    expect(
      afterProjectRevision.snapshot.entities.planningProjectContexts[
        prepared.contextRef.planningProjectContextId
      ]?.snapshot.stage.key,
    ).toBe("delivery");
  });

  it("Project在首次冻结前变化时失败且不留下Context", async () => {
    const test = await fixture();
    await setProjectArchiveStatus(test.deps, {
      principalId: PRINCIPAL,
      commandId: test.command(),
      projectId: PROJECT_ID,
      expectedRevision: 1,
      payload: { status: "archived" },
    });
    await expect(
      preparePlanningProjectContext(test.deps, {
        commandId: test.command(),
        productRunId: test.run.productRunId,
        workflowRunSpecId: test.workflowRunSpecId,
        definitionNodeId: "planning.project",
        executionPath: [],
        attemptNumber: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const after = await test.store.read({ kind: "committedSnapshot" });
    expect(Object.values(after.snapshot.entities.planningProjectContexts)).toHaveLength(0);
  });

  it("私有HTTP边界校验Runtime凭据与strict请求，不暴露Project正文", async () => {
    const test = await fixture();
    const app = createApiApp({
      traceSink: null,
      product: { deps: test.deps, principalId: PRINCIPAL },
      internalRuntime: { credential: "rtk_project_context" },
    });
    const body = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: test.command(),
      productRunId: test.run.productRunId,
      workflowRunSpecId: test.workflowRunSpecId,
      definitionNodeId: "planning.project",
      executionPath: [],
      attemptNumber: 1,
    };
    const forbidden = await app.request("/internal/runtime/v1/prepare-planning-project-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(forbidden.status).toBe(403);

    const invalid = await app.request("/internal/runtime/v1/prepare-planning-project-context", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-runtime-key": "rtk_project_context",
      },
      body: JSON.stringify({ ...body, projectId: PROJECT_ID }),
    });
    expect(invalid.status).toBe(400);

    const response = await app.request("/internal/runtime/v1/prepare-planning-project-context", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-runtime-key": "rtk_project_context",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ status: "ready", productRunId: test.run.productRunId });
    expect(JSON.stringify(json)).not.toContain("PROJECT_CONTEXT_CANARY_61AF");
  });
});
