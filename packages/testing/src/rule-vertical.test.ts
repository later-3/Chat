import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandId, PrincipalId } from "@chat/contracts";
import {
  beginRunAttempt,
  assertWorkflowResourceSelectionsAuthorized,
  compileExecutionContract,
  compilePlanningInput,
  createProductSession,
  createRule,
  createRuleTag,
  getRule,
  listAuthorizedWorkflowResources,
  publishPlanForReview,
  preparePlanningRulesContext,
  reviseRule,
  submitPlanDecision,
  submitUserMessage,
  transitionRuleLifecycle,
  type ApplicationDeps,
  type IdFactory,
  type RuleIdFactory as ApplicationRuleIdFactory,
} from "@chat/application";
import { JsonProductStore, assertSnapshotIntegrity } from "@chat/product-store-json";
import { auditProductIntegrity } from "./product-integrity-auditor.js";
import { SYSTEM_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { computeRuleRevisionSha256 } from "@chat/domain";

const OWNER = "usr_ruleowner" as PrincipalId;

function baseIds(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_rulebase${(++sequence).toString(36)}`;
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

function ruleIds(): ApplicationRuleIdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_rulefact${(++sequence).toString(36)}`;
  return {
    rule: () => next("rul") as ReturnType<ApplicationRuleIdFactory["rule"]>,
    revision: () => next("rrv") as ReturnType<ApplicationRuleIdFactory["revision"]>,
    tag: () => next("rtg") as ReturnType<ApplicationRuleIdFactory["tag"]>,
    scope: () => next("rsc") as ReturnType<ApplicationRuleIdFactory["scope"]>,
    decision: () => next("rde") as ReturnType<ApplicationRuleIdFactory["decision"]>,
    selection: () => next("rsl") as ReturnType<ApplicationRuleIdFactory["selection"]>,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chat-rule-vertical-"));
  let tick = 0;
  let commandSequence = 0;
  const now = () => new Date(Date.parse("2026-08-10T12:00:00.000Z") + tick++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = { store, now, ids: baseIds(), ruleIds: ruleIds() };
  const command = () => `cmd_rulevertical${(++commandSequence).toString(36)}` as CommandId;
  const { session } = await createProductSession(deps, {
    principalId: OWNER,
    commandId: command(),
    payload: {},
  });
  return { deps, store, command, sessionId: session.sessionId };
}

describe("Rule正式纵向", () => {
  it("未选择Rule时Selection集合保持空且policy.rules原子skipped", async () => {
    const { deps, store, command, sessionId } = await fixture();
    const seeded = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const definition =
      seeded.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
    if (definition === undefined) throw new Error("fixture缺少完整Planning Definition");
    const submitted = await submitUserMessage(deps, {
      principalId: OWNER,
      sessionId,
      commandId: command(),
      payload: {
        text: "本轮不选择Project Rules。",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
          definitionSha256: definition.definitionSha256,
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [],
          },
        },
      },
    });
    const before = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const run = before.entities.runs[submitted.run.productRunId];
    if (run?.workflowRunSpecId === undefined) throw new Error("fixture缺少RunSpec");
    const prepared = await preparePlanningRulesContext(deps, {
      schemaVersion: "chat-internal-runtime.v1" as const,
      commandId: command(),
      productRunId: run.productRunId,
      workflowRunSpecId: run.workflowRunSpecId,
      definitionNodeId: "planning.rules",
      executionPath: [],
      attemptNumber: 1,
    });
    expect(prepared.status).toBe("none");
    const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(snapshot.entities.ruleSelections)).toHaveLength(0);
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).find(
        (node) =>
          node.productRunId === run.productRunId && node.definitionNodeId === "planning.rules",
      ),
    ).toMatchObject({ status: "skipped", outcomeCode: "optional_unavailable" });
  });

  it("Tag、Revision、生命周期、幂等、权限与Workflow目录保持同一权威事实", async () => {
    const { deps, store, command, sessionId } = await fixture();
    const tagCommand = command();
    const tag = await createRuleTag(deps, {
      principalId: OWNER,
      commandId: tagCommand,
      payload: { name: "Quality Gate" },
    });
    const replayedTag = await createRuleTag(deps, {
      principalId: OWNER,
      commandId: tagCommand,
      payload: { name: "Quality Gate" },
    });
    expect(replayedTag.replayed).toBe(true);
    expect(replayedTag.tag.ruleTagId).toBe(tag.tag.ruleTagId);

    const created = await createRule(deps, {
      principalId: OWNER,
      commandId: command(),
      payload: {
        title: "交付前验证",
        priority: 800,
        revision: {
          body: "交付前必须运行与风险匹配的测试。",
          rationale: "完成必须有证据。",
          appliesWhen: ["修改产品行为"],
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
    await expect(
      getRule(deps, {
        principalId: "usr_ruleattacker" as PrincipalId,
        ruleId: created.rule.ruleId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const trial = await transitionRuleLifecycle(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: created.rule.ruleId,
      expectedRevision: created.rule.revision,
      payload: {
        boundRevisionId: created.rule.currentRevision.ruleRevisionId,
        boundRevisionSha256: created.rule.currentRevision.sha256,
        toLifecycle: "trial",
        reason: "先验证实际效果",
      },
    });
    const active = await transitionRuleLifecycle(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: trial.rule.ruleId,
      expectedRevision: trial.rule.revision,
      payload: {
        boundRevisionId: trial.rule.currentRevision.ruleRevisionId,
        boundRevisionSha256: trial.rule.currentRevision.sha256,
        toLifecycle: "active",
        reason: "试用验证通过",
      },
    });
    const revised = await reviseRule(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: active.rule.ruleId,
      expectedRevision: active.rule.revision,
      payload: {
        currentRevisionId: active.rule.currentRevision.ruleRevisionId,
        currentRevisionSha256: active.rule.currentRevision.sha256,
        revision: {
          body: "交付前必须运行测试，并记录命令与结果。",
          rationale: "证据应能复查。",
          appliesWhen: ["修改产品行为"],
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
    expect(revised.rule.currentRevision.revision).toBe(2);
    const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    expect(
      listAuthorizedWorkflowResources(snapshot, OWNER).find(
        (resource) => resource.frozen.resourceId === revised.rule.ruleId,
      )?.frozen,
    ).toMatchObject({ resourceKind: "rule", status: "active" });
    expect(JSON.stringify(listAuthorizedWorkflowResources(snapshot, OWNER))).not.toContain(
      "交付前必须运行测试",
    );

    const systemRevision =
      snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
    if (systemRevision === undefined) throw new Error("fixture缺少Planning Definition");
    const submitted = await submitUserMessage(deps, {
      principalId: OWNER,
      sessionId,
      commandId: command(),
      payload: {
        text: "按质量规则制定计划",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: systemRevision.workflowDefinitionRevisionId,
          definitionSha256: systemRevision.definitionSha256,
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [
              {
                kind: "node_enabled",
                definitionNodeId: "planning.rules",
                enabled: true,
              },
              {
                kind: "resource_selection",
                definitionNodeId: "planning.rules",
                resourceKind: "rule",
                required: false,
                selections: [
                  {
                    resourceId: revised.rule.ruleId,
                    expectedRevision: revised.rule.currentRevision.revision,
                    expectedSha256: revised.rule.currentRevision.sha256,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const submittedSnapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const submittedRun = submittedSnapshot.entities.runs[submitted.run.productRunId];
    if (
      submittedRun === undefined ||
      submittedRun.runKind !== "planning" ||
      submittedRun.workflowRunSpecId === undefined
    ) {
      throw new Error("Run缺少Planning RunSpec");
    }
    const prepareRequest = {
      schemaVersion: "chat-internal-runtime.v1" as const,
      commandId: command(),
      productRunId: submitted.run.productRunId,
      workflowRunSpecId: submittedRun.workflowRunSpecId,
      definitionNodeId: "planning.rules",
      executionPath: [],
      attemptNumber: 1,
    };
    const prepared = await preparePlanningRulesContext(deps, prepareRequest);
    expect(prepared).toMatchObject({
      status: "ready",
      rules: [
        {
          ruleRevisionId: revised.rule.currentRevision.ruleRevisionId,
          ruleRevisionSha256: revised.rule.currentRevision.sha256,
          body: "交付前必须运行测试，并记录命令与结果。",
        },
      ],
    });
    if (prepared.status !== "ready") throw new Error("Rule Selection缺失");
    const atomicRulesSnapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const rulesNode = Object.values(atomicRulesSnapshot.entities.workflowNodeRuns).find(
      (node) =>
        node.productRunId === submitted.run.productRunId &&
        node.definitionNodeId === "planning.rules",
    );
    expect(rulesNode).toMatchObject({
      status: "succeeded",
      executionPath: [],
      attemptNumber: 1,
    });
    const rulesInput =
      rulesNode?.inputManifestId === undefined
        ? undefined
        : atomicRulesSnapshot.entities.nodeValueManifests[rulesNode.inputManifestId];
    const rulesOutput =
      rulesNode?.outputManifestId === undefined
        ? undefined
        : atomicRulesSnapshot.entities.nodeValueManifests[rulesNode.outputManifestId];
    expect(rulesInput?.slots[0]?.refs[0]).toMatchObject({
      kind: "rule_revision",
      id: revised.rule.currentRevision.ruleRevisionId,
      sha256: revised.rule.currentRevision.sha256,
    });
    expect(rulesOutput?.slots[0]?.refs[0]).toMatchObject({
      kind: "rule_selection",
      id: prepared.selectionRef.ruleSelectionId,
      sha256: prepared.selectionRef.sha256,
    });
    const futureRevision = await reviseRule(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: revised.rule.ruleId,
      expectedRevision: revised.rule.revision,
      payload: {
        currentRevisionId: revised.rule.currentRevision.ruleRevisionId,
        currentRevisionSha256: revised.rule.currentRevision.sha256,
        revision: {
          body: "后续Run使用的新正文，不得倒灌已冻结Run。",
          rationale: "验证运行冻结语义。",
          appliesWhen: ["修改产品行为"],
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
    expect(await preparePlanningRulesContext(deps, prepareRequest)).toEqual(prepared);
    const planningInput = await compilePlanningInput(deps, {
      commandId: command(),
      productRunId: submitted.run.productRunId,
      planRevision: 1,
      ruleSelectionRef: prepared.selectionRef,
    });
    expect(planningInput.rulesContext?.rules[0]?.body).toBe(
      "交付前必须运行测试，并记录命令与结果。",
    );
    await expect(
      publishPlanForReview(deps, {
        commandId: command(),
        productRunId: submitted.run.productRunId,
        attemptId: planningInput.attemptId,
        expectedRunRevision: planningInput.inputRunRevision,
        inputManifestSha256: planningInput.inputManifestSha256,
        content: {
          objective: "验证Rule引用白名单",
          summary: "故意引用未冻结Hash",
          assumptions: [],
          openQuestions: [],
          steps: [
            {
              stepId: "step-1",
              title: "错误引用",
              purpose: "证明Plan只能引用本轮冻结Rule",
              dependsOn: [],
              inputRefs: [
                {
                  refId: revised.rule.currentRevision.ruleRevisionId,
                  revision: revised.rule.currentRevision.revision,
                  sha256: "f".repeat(64),
                },
              ],
              expectedOutput: "失败",
              successCriteria: ["不能发布"],
              requestedCapabilities: ["markdown_text_compose"],
              risk: "low",
            },
          ],
          completionCriteria: ["失败即通过"],
          warnings: [],
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const published = await publishPlanForReview(deps, {
      commandId: command(),
      productRunId: submitted.run.productRunId,
      attemptId: planningInput.attemptId,
      expectedRunRevision: planningInput.inputRunRevision,
      inputManifestSha256: planningInput.inputManifestSha256,
      content: {
        objective: "按冻结Rule制定计划",
        summary: "Step引用已冻结Rule Revision三元组",
        assumptions: [],
        openQuestions: [],
        steps: [
          {
            stepId: "step-1",
            title: "执行质量门",
            purpose: "按规则输出测试清单",
            dependsOn: [],
            inputRefs: [
              {
                refId: revised.rule.currentRevision.ruleRevisionId,
                revision: revised.rule.currentRevision.revision,
                sha256: revised.rule.currentRevision.sha256,
              },
            ],
            expectedOutput: "测试清单",
            successCriteria: ["Rule正文只在私有执行输入出现"],
            requestedCapabilities: ["markdown_text_compose"],
            risk: "low",
          },
        ],
        completionCriteria: ["清单完成"],
        warnings: [],
      },
    });
    const decision = await submitPlanDecision(deps, {
      principalId: OWNER,
      commandId: command(),
      productRunId: submitted.run.productRunId,
      expectedRunRevision: published.run.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: published.plan.planRevision,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    const executionContract = await compileExecutionContract(deps, {
      commandId: command(),
      productRunId: submitted.run.productRunId,
      approvalDecisionId: decision.decision.decisionId,
    });
    const execution = await beginRunAttempt(deps, {
      commandId: command(),
      productRunId: submitted.run.productRunId,
      kind: "execution",
      executionContractId: executionContract.contract.executionContractId,
      stepId: "step-1",
      dependencyRefs: [],
      promptTemplateVersion: "executor-prompt.v1",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
    });
    expect(execution.contextItems).toEqual([
      {
        contextKind: "rule",
        refId: revised.rule.currentRevision.ruleRevisionId,
        revision: revised.rule.currentRevision.revision,
        sha256: revised.rule.currentRevision.sha256,
        ruleId: revised.rule.ruleId,
        content: "交付前必须运行测试，并记录命令与结果。",
      },
    ]);
    const disabled = await transitionRuleLifecycle(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: futureRevision.rule.ruleId,
      expectedRevision: futureRevision.rule.revision,
      payload: {
        boundRevisionId: futureRevision.rule.currentRevision.ruleRevisionId,
        boundRevisionSha256: futureRevision.rule.currentRevision.sha256,
        toLifecycle: "disabled",
        reason: "验证Owner自己的停用Rule返回stale而不是伪装成越权",
      },
    });
    const finalSnapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(() =>
      assertWorkflowResourceSelectionsAuthorized(finalSnapshot, OWNER, {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [
          {
            kind: "resource_selection",
            definitionNodeId: "planning.rules",
            resourceKind: "rule",
            required: false,
            selections: [
              {
                resourceId: disabled.rule.ruleId,
                expectedRevision: disabled.rule.currentRevision.revision,
                expectedSha256: disabled.rule.currentRevision.sha256,
              },
            ],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "resource_stale" }));
    const selection = Object.values(finalSnapshot.entities.ruleSelections)[0];
    expect(selection?.candidates).toHaveLength(1);
    expect(() => assertSnapshotIntegrity(finalSnapshot)).not.toThrow();
    expect(auditProductIntegrity(finalSnapshot)).toMatchObject({ ok: true, issues: [] });
    const damagedRules = structuredClone(finalSnapshot);
    const damagedRevision = Object.values(damagedRules.entities.ruleRevisions)[0];
    const damagedSelection = Object.values(damagedRules.entities.ruleSelections)[0];
    if (damagedRevision === undefined || damagedSelection === undefined) {
      throw new Error("Auditor反证缺少Rule Revision/Selection");
    }
    damagedRevision.sha256 = "f".repeat(64);
    damagedSelection.sha256 = "e".repeat(64);
    expect(new Set(auditProductIntegrity(damagedRules).issues.map((issue) => issue.code))).toEqual(
      expect.objectContaining(
        new Set(["rule_revision.integrity_invalid", "rule_selection.binding_invalid"]),
      ),
    );
    const tampered = structuredClone(finalSnapshot);
    const historical = tampered.entities.ruleRevisions[active.rule.currentRevision.ruleRevisionId];
    if (historical === undefined) throw new Error("fixture缺少历史Rule Revision");
    historical.body = "历史正文被改写";
    historical.sha256 = computeRuleRevisionSha256(historical);
    expect(() => assertSnapshotIntegrity(tampered)).toThrow(/Revision Hash/u);
  });

  it("历史Revision正文即使重算Hash也会被不可变链检查拒绝", async () => {
    const { deps, store, command } = await fixture();
    const created = await createRule(deps, {
      principalId: OWNER,
      commandId: command(),
      payload: {
        title: "不可变规则",
        priority: 100,
        revision: {
          body: "原正文",
          rationale: "审计",
          appliesWhen: [],
          doesNotApplyWhen: [],
          positiveExamples: [],
          negativeExamples: [],
          scopes: [{ kind: "global" }],
          tagIds: [],
          conflictsWithRuleIds: [],
          risk: "low",
          sourceCases: [],
        },
      },
    });
    const snapshot = structuredClone((await store.read({ kind: "committedSnapshot" })).snapshot);
    const revision = snapshot.entities.ruleRevisions[created.rule.currentRevision.ruleRevisionId];
    if (revision === undefined) throw new Error("fixture缺少Rule Revision");
    revision.body = "篡改";
    expect(() => assertSnapshotIntegrity(snapshot)).toThrow(/Hash不匹配/u);
  });

  it("Prepare Rules同commandId异payload与跨Run请求失败且不追加Selection", async () => {
    const { deps, store, command, sessionId } = await fixture();
    const created = await createRule(deps, {
      principalId: OWNER,
      commandId: command(),
      payload: {
        title: "幂等规则",
        priority: 100,
        revision: {
          body: "同一commandId不能换Run重放。",
          rationale: "Runtime命令必须可审计。",
          appliesWhen: ["规划"],
          doesNotApplyWhen: [],
          positiveExamples: [],
          negativeExamples: [],
          scopes: [{ kind: "contextual", scenario: "planning", workflowNodeKey: "policy.rules" }],
          tagIds: [],
          conflictsWithRuleIds: [],
          risk: "medium",
          sourceCases: [],
        },
      },
    });
    const trial = await transitionRuleLifecycle(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: created.rule.ruleId,
      expectedRevision: created.rule.revision,
      payload: {
        boundRevisionId: created.rule.currentRevision.ruleRevisionId,
        boundRevisionSha256: created.rule.currentRevision.sha256,
        toLifecycle: "trial",
        reason: "测试可选目录",
      },
    });
    const active = await transitionRuleLifecycle(deps, {
      principalId: OWNER,
      commandId: command(),
      ruleId: trial.rule.ruleId,
      expectedRevision: trial.rule.revision,
      payload: {
        boundRevisionId: trial.rule.currentRevision.ruleRevisionId,
        boundRevisionSha256: trial.rule.currentRevision.sha256,
        toLifecycle: "active",
        reason: "测试可选目录",
      },
    });
    const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const systemRevision =
      snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
    if (systemRevision === undefined) throw new Error("fixture缺少Planning Definition");
    const submitRun = async () => {
      const submitted = await submitUserMessage(deps, {
        principalId: OWNER,
        sessionId,
        commandId: command(),
        payload: {
          text: "准备规则上下文",
          workflowSelection: {
            kind: "published_revision",
            workflowDefinitionRevisionId: systemRevision.workflowDefinitionRevisionId,
            definitionSha256: systemRevision.definitionSha256,
            runConfiguration: {
              schemaVersion: "workflow-run-configuration.v1",
              overrides: [
                { kind: "node_enabled", definitionNodeId: "planning.rules", enabled: true },
                {
                  kind: "resource_selection",
                  definitionNodeId: "planning.rules",
                  resourceKind: "rule",
                  required: false,
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
      const committed = (await store.read({ kind: "committedSnapshot" })).snapshot;
      const run = committed.entities.runs[submitted.run.productRunId];
      if (run?.runKind !== "planning" || run.workflowRunSpecId === undefined) {
        throw new Error("Run缺少RunSpec");
      }
      return { productRunId: run.productRunId, workflowRunSpecId: run.workflowRunSpecId };
    };
    const first = await submitRun();
    const second = await submitRun();
    const prepareCommand = command();
    await preparePlanningRulesContext(deps, {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: prepareCommand,
      productRunId: first.productRunId,
      workflowRunSpecId: first.workflowRunSpecId,
      definitionNodeId: "planning.rules",
      executionPath: [],
      attemptNumber: 1,
    });
    await expect(
      preparePlanningRulesContext(deps, {
        schemaVersion: "chat-internal-runtime.v1",
        commandId: prepareCommand,
        productRunId: second.productRunId,
        workflowRunSpecId: second.workflowRunSpecId,
        definitionNodeId: "planning.rules",
        executionPath: [],
        attemptNumber: 1,
      }),
    ).rejects.toThrow("commandId");
    const finalSnapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(finalSnapshot.entities.ruleSelections)).toHaveLength(1);
    expect(() => assertSnapshotIntegrity(finalSnapshot)).not.toThrow();
  });
});
