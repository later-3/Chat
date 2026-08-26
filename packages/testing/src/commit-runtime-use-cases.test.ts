import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EXECUTOR_PROMPT_TEMPLATE_VERSION,
  MODEL_CONFIG_VERSION,
  executionEvidenceVerificationReceiptSchema,
  type CommandId,
  type ExecutionCandidate,
  type PlanContent,
  type PrincipalId,
  type PromptAssemblyV3,
} from "@chat/contracts";
import { computeExecutionInputManifestSha256, hashCanonical } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { createFilePromptCatalog } from "@chat/api/prompt-catalog";
import {
  type ApplicationDeps,
  type IdFactory,
  beginRunAttempt,
  compileExecutionContract,
  completeRunAttempt,
  commitExecutionResult,
  persistExecutionCandidate,
  persistValidationResult,
  prepareGovernanceReviewInput,
  compilePlanningInput,
  publishPlanForReview,
  submitPlanDecision,
  createProductSession,
  submitUserMessage,
} from "@chat/application";

const PRINCIPAL = "usr_committest" as PrincipalId;
const NOW = "2026-08-07T12:00:00.000Z";

function ids(): IdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_commit${(++value).toString(36)}`;
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

function commands() {
  let value = 0;
  return () => `cmd_commit${(++value).toString(36)}` as CommandId;
}

const plan: PlanContent = {
  objective: "根据输入生成周报",
  summary: "先整理，再形成Markdown",
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "collect",
      title: "整理",
      purpose: "整理输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点",
      successCriteria: ["覆盖输入要点"],
      requestedCapabilities: [],
      risk: "low",
    },
    {
      stepId: "compose",
      title: "成稿",
      purpose: "形成Markdown",
      dependsOn: ["collect"],
      inputRefs: [],
      expectedOutput: "周报",
      successCriteria: ["包含风险与下一步"],
      requestedCapabilities: ["markdown_text_compose"],
      risk: "low",
    },
  ],
  completionCriteria: ["正式周报可读"],
  warnings: [],
};

async function createDeps(): Promise<{ deps: ApplicationDeps; cmd: () => CommandId }> {
  const directory = await mkdtemp(join(tmpdir(), "chat-commit-test-"));
  let tick = 0;
  const now = () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString();
  const store = await JsonProductStore.open({
    filePath: join(directory, "chat-product-store.v1.json"),
    now,
  });
  const promptCatalog = await createFilePromptCatalog();
  const runtimeProfiles = (
    await import("@chat/pi-runtime/coding-executor")
  ).createPiAgentRuntimeProfileReader();
  return {
    deps: {
      store,
      now,
      ids: ids(),
      promptCatalog,
      agentRuntimeProfiles: runtimeProfiles,
      executionEvidenceVerifier: {
        verify: vi.fn(async (input) =>
          executionEvidenceVerificationReceiptSchema.parse({
            schemaVersion: "execution-evidence-verification-receipt.v1",
            executionAttemptId: input.executionAttemptId,
            evidenceRefsSha256: hashCanonical("execution-evidence-refs.v1", input.evidenceRefs),
            journalSha256: "f".repeat(64),
          }),
        ),
      },
    },
    cmd: commands(),
  };
}

async function buildCandidate(
  validEvidence: boolean,
  strictEvidence = true,
  withGovernanceReview = true,
) {
  const { deps, cmd } = await createDeps();
  const { session } = await createProductSession(deps, {
    principalId: PRINCIPAL,
    commandId: cmd(),
    payload: {},
  });
  const { run } = await submitUserMessage(deps, {
    principalId: PRINCIPAL,
    sessionId: session.sessionId,
    commandId: cmd(),
    payload: { text: "请生成周报" },
  });
  const planning = await compilePlanningInput(deps, {
    commandId: cmd(),
    productRunId: run.productRunId,
    planRevision: 1,
  });
  const review = await publishPlanForReview(deps, {
    productRunId: run.productRunId,
    commandId: cmd(),
    content: plan,
    attemptId: planning.attemptId,
    expectedRunRevision: planning.inputRunRevision,
    inputManifestSha256: planning.inputManifestSha256,
  });
  const approved = await submitPlanDecision(deps, {
    principalId: PRINCIPAL,
    productRunId: run.productRunId,
    commandId: cmd(),
    expectedRunRevision: review.run.revision,
    payload: {
      approvalRequestId: review.approval.approvalRequestId,
      planId: review.plan.planId,
      planRevision: review.plan.planRevision,
      planSha256: review.plan.sha256,
      kind: "approve",
    },
  });
  const { contract } = await compileExecutionContract(deps, {
    commandId: cmd(),
    productRunId: run.productRunId,
    approvalDecisionId: approved.decision.decisionId,
  });
  const promptSnapshot = await deps.store.read({ kind: "committedSnapshot" });
  const workflowAssembly = Object.values(promptSnapshot.snapshot.entities.promptAssemblies).find(
    (assembly): assembly is PromptAssemblyV3 =>
      assembly.schemaVersion === "prompt-assembly.v3" && assembly.productRunId === run.productRunId,
  );
  const executorPrompt = workflowAssembly?.nodes.find((node) => node.nodeType === "execute.plan");
  if (workflowAssembly === undefined || executorPrompt === undefined) {
    throw new Error("fixture缺少Executor Prompt Assembly");
  }
  const promptAssemblyRef = {
    promptAssemblyId: workflowAssembly.promptAssemblyId,
    sha256: workflowAssembly.sha256,
    definitionNodeId: executorPrompt.definitionNodeId,
    nodeAssemblySha256: executorPrompt.sha256,
  };

  const stepResults: ExecutionCandidate["stepResults"] = [];
  for (const contractStep of contract.steps) {
    const dependencyRefs = contractStep.dependsOn.map((stepId) => {
      const dependency = stepResults.find((candidate) => candidate.stepId === stepId);
      if (dependency === undefined) throw new Error("fixture依赖缺失");
      return {
        stepId,
        executionAttemptId: dependency.executionAttemptId,
        sha256: dependency.sha256,
      };
    });
    const inputManifestSha256 = computeExecutionInputManifestSha256({
      executionContractId: contract.executionContractId,
      approvedPlanSha256: contract.approvedPlanSha256,
      stepId: contractStep.stepId,
      inputRefs: contractStep.inputRefs,
      dependencyRefs,
      promptAssemblyRef,
      promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
      modelConfigVersion: MODEL_CONFIG_VERSION,
    });
    const { attemptId, inputManifestSha256: committedManifestSha256 } = await beginRunAttempt(
      deps,
      {
        commandId: cmd(),
        productRunId: run.productRunId,
        kind: "execution",
        executionContractId: contract.executionContractId,
        stepId: contractStep.stepId,
        dependencyRefs,
        promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
      },
    );
    expect(committedManifestSha256).toBe(inputManifestSha256);
    await completeRunAttempt(deps, { commandId: cmd(), attemptId, outcome: "success" });
    const base = {
      stepId: contractStep.stepId,
      executionAttemptId: attemptId,
      inputManifestSha256,
      dependencyRefs,
      output: contractStep.stepId === "collect" ? "要点A" : "完整周报",
      sections: [
        {
          heading: contractStep.stepId === "collect" ? "进展" : "风险与下一步",
          body: contractStep.stepId === "collect" ? "完成A" : "风险低；下一步继续",
        },
      ],
      successCriteriaEvidence: [
        validEvidence
          ? `${contractStep.successCriteria[0] ?? ""}：已由产出证明`
          : "与成功标准无关的自述",
      ],
      criteriaEvidence: contractStep.stepId === "compose" ? ["正式周报可读：结构完整"] : [],
      warnings: [],
    };
    const executionEvidenceRefs =
      contractStep.stepId === "collect"
        ? [
            {
              kind: "pi_tool_result" as const,
              executionAttemptId: attemptId,
              capabilityId: "pi_planning:tool:builtin:read",
              localName: "read",
              toolCallId: `call_${contractStep.stepId}`,
              inputSha256: "a".repeat(64),
              resultSha256: "b".repeat(64),
              outcome: "completed" as const,
            },
          ]
        : [];
    stepResults.push({
      ...base,
      executionEvidenceRefs,
      sha256: hashCanonical("execution-step-result.v1", { ...base, executionEvidenceRefs }),
    });
  }

  const candidateCommandId = cmd();
  const candidateInput = {
    commandId: candidateCommandId,
    productRunId: run.productRunId,
    executionContractId: contract.executionContractId,
    evidencePolicyVersion: "structured-tool-result.v1",
    stepResults,
    finalOutput: {
      format: "markdown_sections",
      sections: stepResults.flatMap((result) => result.sections),
    },
    completionCriteriaEvidence: stepResults.flatMap((result) => result.criteriaEvidence),
    warnings: stepResults.flatMap((result) => result.warnings),
  } as const;
  const candidate = await persistExecutionCandidate(deps, candidateInput);
  const snapshotBeforeGovernance = await deps.store.read({ kind: "committedSnapshot" });
  const storedRun = snapshotBeforeGovernance.snapshot.entities.runs[run.productRunId];
  if (storedRun?.runKind !== "planning" || storedRun.workflowRunSpecId === undefined) {
    throw new Error("fixture缺少Planning RunSpec");
  }
  const governanceInput = await prepareGovernanceReviewInput(deps, {
    commandId: cmd(),
    productRunId: run.productRunId,
    workflowRunSpecId: storedRun.workflowRunSpecId,
    executionCandidateId: candidate.executionCandidateId,
  });
  const validation = await persistValidationResult(deps, {
    commandId: cmd(),
    productRunId: run.productRunId,
    executionContractId: contract.executionContractId,
    executionCandidateId: candidate.executionCandidateId,
    strictEvidence,
    ...(withGovernanceReview
      ? {
          governanceReview: {
            schemaVersion: "governance-review-candidate.v1" as const,
            outcome: "pass" as const,
            summary: "候选满足已选工程治理规范。",
            findings: [],
            residualRisks: [],
          },
          governanceReviewAttemptId: governanceInput.attemptId,
          governanceReviewInputManifestSha256: governanceInput.inputManifestSha256,
        }
      : {}),
  });
  return {
    deps,
    cmd,
    run,
    session,
    contract,
    candidate,
    candidateInput,
    candidateCommandId,
    governanceInput,
    validation,
  };
}

describe("验证与Product Commit信任边界", () => {
  it("PersistExecutionCandidate精确Receipt在Evidence/时间/ID前恢复不可变ID与SHA", async () => {
    const state = await buildCandidate(true);
    const verifier = state.deps.executionEvidenceVerifier?.verify;
    if (verifier === undefined || !("mockClear" in verifier)) {
      throw new Error("测试缺少可观察Evidence Verifier");
    }
    const poison = vi.fn(async () => {
      throw new Error("Receipt重放不得调用Evidence Verifier");
    });
    const poisonedDeps: ApplicationDeps = {
      ...state.deps,
      now: () => {
        throw new Error("Receipt重放不得读取时间");
      },
      ids: {
        ...state.deps.ids,
        executionCandidate: () => {
          throw new Error("Receipt重放不得分配Candidate ID");
        },
      },
      executionEvidenceVerifier: { verify: poison },
    };

    await expect(persistExecutionCandidate(poisonedDeps, state.candidateInput)).resolves.toEqual(
      state.candidate,
    );
    expect(poison).toHaveBeenCalledTimes(0);

    await expect(
      persistExecutionCandidate(poisonedDeps, {
        ...state.candidateInput,
        warnings: ["同Command ID的另一Payload"],
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });
    expect(poison).toHaveBeenCalledTimes(0);
  });

  it("PersistExecutionCandidate并发首次提交只增加一组事实", async () => {
    const state = await buildCandidate(true);
    const before = await state.deps.store.read({ kind: "committedSnapshot" });
    const commandId = state.cmd();
    const input = { ...state.candidateInput, commandId };
    const [left, right] = await Promise.all([
      persistExecutionCandidate(state.deps, input),
      persistExecutionCandidate(state.deps, input),
    ]);
    expect(left).toEqual(right);
    const after = await state.deps.store.read({ kind: "committedSnapshot" });
    expect(
      Object.keys(after.snapshot.entities.executionCandidates).length -
        Object.keys(before.snapshot.entities.executionCandidates).length,
    ).toBe(1);
  });

  it("Application自行验证持久化Candidate并从它确定性渲染正式正文", async () => {
    const state = await buildCandidate(true);
    expect(state.validation.outcome).toBe("pass");
    const committed = await commitExecutionResult(state.deps, {
      commandId: state.cmd(),
      productRunId: state.run.productRunId,
      executionContractId: state.contract.executionContractId,
      executionCandidateId: state.candidate.executionCandidateId,
      validationResultId: state.validation.validationResultId,
    });
    const { snapshot } = await state.deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[state.run.productRunId]?.status).toBe("succeeded");
    expect(snapshot.entities.messages[committed.finalMessageId]?.content.text).toBe(
      "## 进展\n\n完成A\n\n## 风险与下一步\n\n风险低；下一步继续",
    );
  });

  it("模型只复述无关证据时验证失败，不能提交Assistant Message或成功终态", async () => {
    const state = await buildCandidate(false);
    expect(state.validation.outcome).toBe("fail");
    await expect(
      commitExecutionResult(state.deps, {
        commandId: state.cmd(),
        productRunId: state.run.productRunId,
        executionContractId: state.contract.executionContractId,
        executionCandidateId: state.candidate.executionCandidateId,
        validationResultId: state.validation.validationResultId,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const { snapshot } = await state.deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[state.run.productRunId]?.status).toBe("running");
    expect(
      Object.values(snapshot.entities.messages).filter((message) => message.role === "assistant"),
    ).toHaveLength(0);
  });

  it("Runtime不能把默认治理流程冻结的strictEvidence从true降级为false", async () => {
    await expect(buildCandidate(false, false)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("默认治理流程缺少Review、独立Attempt或Manifest时拒绝持久化Validation", async () => {
    await expect(buildCandidate(true, true, false)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("同一Execution Candidate不能用新Command写入第二份冲突Validation", async () => {
    const state = await buildCandidate(true);
    await expect(
      persistValidationResult(state.deps, {
        commandId: state.cmd(),
        productRunId: state.run.productRunId,
        executionContractId: state.contract.executionContractId,
        executionCandidateId: state.candidate.executionCandidateId,
        strictEvidence: true,
        governanceReview: {
          schemaVersion: "governance-review-candidate.v1",
          outcome: "fail",
          summary: "试图覆盖既有结论。",
          findings: [
            {
              severity: "blocking",
              code: "review.conflict",
              summary: "冲突结论",
              detail: "同一候选不得重复审查直至通过。",
              evidenceKeys: [`candidate:${state.candidate.sha256}`],
            },
          ],
          residualRisks: [],
        },
        governanceReviewAttemptId: state.governanceInput.attemptId,
        governanceReviewInputManifestSha256: state.governanceInput.inputManifestSha256,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("Candidate落盘后Pi Journal漂移时Product Commit失败且不产生正式Message", async () => {
    const state = await buildCandidate(true);
    const driftedDeps: ApplicationDeps = {
      ...state.deps,
      executionEvidenceVerifier: {
        verify: vi.fn(async () => {
          throw new Error("journal drift");
        }),
      },
    };
    await expect(
      commitExecutionResult(driftedDeps, {
        commandId: state.cmd(),
        productRunId: state.run.productRunId,
        executionContractId: state.contract.executionContractId,
        executionCandidateId: state.candidate.executionCandidateId,
        validationResultId: state.validation.validationResultId,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const { snapshot } = await state.deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[state.run.productRunId]?.status).toBe("running");
    expect(
      Object.values(snapshot.entities.messages).filter((message) => message.role === "assistant"),
    ).toHaveLength(0);
  });
});
