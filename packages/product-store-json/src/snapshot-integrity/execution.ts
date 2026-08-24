import {
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  type PromptAssemblyV3,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  computeExecutionInputManifestSha256,
  hashCanonical,
  validateExecutionCandidate,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertExecution(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const contract of Object.values(entities.executionContracts)) {
    const decision = entities.decisions[contract.approvalDecisionId];
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === contract.approvedPlanId &&
        candidate.planRevision === contract.approvedPlanRevision,
    );
    if (
      decision === undefined ||
      decision.kind !== "approve" ||
      decision.productRunId !== contract.productRunId ||
      plan === undefined ||
      plan.productRunId !== contract.productRunId ||
      plan.status !== "approved" ||
      plan.sha256 !== contract.approvedPlanSha256 ||
      decision.planSha256 !== contract.approvedPlanSha256
    ) {
      fail(`contract ${contract.executionContractId} 与Approved Plan/Decision不一致`);
    }
    const expectedSteps = plan.content.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      purpose: step.purpose,
      dependsOn: step.dependsOn,
      inputRefs: step.inputRefs,
      expectedOutput: step.expectedOutput,
      successCriteria: step.successCriteria,
      capabilityRefs: step.requestedCapabilities,
    }));
    if (JSON.stringify(contract.steps) !== JSON.stringify(expectedSteps)) {
      fail(`contract ${contract.executionContractId} steps与Approved Plan不一致`);
    }
    if (
      JSON.stringify(contract.completionCriteria) !==
      JSON.stringify(plan.content.completionCriteria)
    ) {
      fail(`contract ${contract.executionContractId} completionCriteria不一致`);
    }
    const expectedCapabilities = [
      ...new Set(plan.content.steps.flatMap((step) => step.requestedCapabilities)),
    ];
    if (
      JSON.stringify(contract.capabilityRefs) !== JSON.stringify(expectedCapabilities) ||
      contract.capabilityRefs.some(
        (capability) => capability !== EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
      )
    ) {
      fail(`contract ${contract.executionContractId} Capability扩大或不一致`);
    }
    const hash = hashCanonical("execution-contract.v1", {
      productRunId: contract.productRunId,
      approvedPlanId: contract.approvedPlanId,
      approvedPlanRevision: contract.approvedPlanRevision,
      approvedPlanSha256: contract.approvedPlanSha256,
      approvalDecisionId: contract.approvalDecisionId,
      steps: contract.steps,
      completionCriteria: contract.completionCriteria,
      capabilityRefs: contract.capabilityRefs,
      limits: contract.limits,
    });
    if (hash !== contract.sha256) fail(`contract ${contract.executionContractId} Hash不一致`);
  }

  for (const candidate of Object.values(entities.executionCandidates)) {
    const contract = entities.executionContracts[candidate.executionContractId];
    if (contract === undefined || contract.productRunId !== candidate.productRunId) {
      fail(`candidate ${candidate.executionCandidateId} 与Contract不一致`);
    }
    if (candidate.stepResults.length !== contract.steps.length) {
      fail(`candidate ${candidate.executionCandidateId} 步骤数与Contract不一致`);
    }
    const priorResults = new Map<string, (typeof candidate.stepResults)[number]>();
    for (let index = 0; index < candidate.stepResults.length; index += 1) {
      const stepResult = candidate.stepResults[index];
      const contractStep = contract.steps[index];
      if (
        stepResult === undefined ||
        contractStep === undefined ||
        stepResult.stepId !== contractStep.stepId
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤顺序与Contract不一致`);
      }
      const attempt = entities.attempts[stepResult.executionAttemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== candidate.productRunId ||
        attempt.kind !== "execution" ||
        attempt.stepId !== stepResult.stepId ||
        attempt.outcome !== "success" ||
        attempt.inputManifestSha256 !== stepResult.inputManifestSha256 ||
        attempt.promptTemplateVersion === undefined ||
        attempt.modelConfigVersion === undefined
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤Attempt血缘不一致`);
      }
      if (
        stepResult.dependencyRefs.length !== contractStep.dependsOn.length ||
        stepResult.dependencyRefs.some((ref, dependencyIndex) => {
          const prior = priorResults.get(ref.stepId);
          return (
            contractStep.dependsOn[dependencyIndex] !== ref.stepId ||
            prior === undefined ||
            prior.executionAttemptId !== ref.executionAttemptId ||
            prior.sha256 !== ref.sha256
          );
        })
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤依赖血缘不一致`);
      }
      const inputManifestSha256 = computeExecutionInputManifestSha256({
        executionContractId: contract.executionContractId,
        approvedPlanSha256: contract.approvedPlanSha256,
        stepId: stepResult.stepId,
        inputRefs: contractStep.inputRefs,
        dependencyRefs: stepResult.dependencyRefs,
        promptTemplateVersion: attempt.promptTemplateVersion,
        modelConfigVersion: attempt.modelConfigVersion,
        ...(() => {
          const assembly = Object.values(entities.promptAssemblies).find(
            (candidate): candidate is PromptAssemblyV3 =>
              candidate.schemaVersion === "prompt-assembly.v3" &&
              candidate.productRunId === attempt.productRunId,
          );
          const node = assembly?.nodes.find((candidate) => candidate.nodeType === "execute.plan");
          if (assembly !== undefined && node === undefined) {
            fail(`execution attempt ${attempt.attemptId} 缺少Executor Prompt节点`);
          }
          return assembly === undefined || node === undefined
            ? {}
            : {
                promptAssemblyRef: {
                  promptAssemblyId: assembly.promptAssemblyId,
                  sha256: assembly.sha256,
                  definitionNodeId: node.definitionNodeId,
                  nodeAssemblySha256: node.sha256,
                },
              };
        })(),
      });
      if (inputManifestSha256 !== stepResult.inputManifestSha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤输入Manifest不一致`);
      }
      const stepHash = hashCanonical("execution-step-result.v1", {
        stepId: stepResult.stepId,
        executionAttemptId: stepResult.executionAttemptId,
        inputManifestSha256: stepResult.inputManifestSha256,
        dependencyRefs: stepResult.dependencyRefs,
        output: stepResult.output,
        sections: stepResult.sections,
        successCriteriaEvidence: stepResult.successCriteriaEvidence,
        criteriaEvidence: stepResult.criteriaEvidence,
        warnings: stepResult.warnings,
      });
      if (stepHash !== stepResult.sha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤结果Hash不一致`);
      }
      priorResults.set(stepResult.stepId, stepResult);
    }
    const hash = hashCanonical("execution-candidate.v1", {
      executionContractId: candidate.executionContractId,
      stepResults: candidate.stepResults,
      finalOutput: candidate.finalOutput,
      completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      warnings: candidate.warnings,
    });
    if (hash !== candidate.sha256) fail(`candidate ${candidate.executionCandidateId} Hash不一致`);
    if (
      JSON.stringify(candidate.finalOutput.sections) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.sections)) ||
      JSON.stringify(candidate.completionCriteriaEvidence) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.criteriaEvidence)) ||
      JSON.stringify(candidate.warnings) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.warnings))
    ) {
      fail(`candidate ${candidate.executionCandidateId} 汇总字段不是步骤结果的确定性投影`);
    }
  }

  for (const validation of Object.values(entities.validationResults)) {
    const contract = entities.executionContracts[validation.executionContractId];
    const candidate = entities.executionCandidates[validation.executionCandidateId];
    if (
      contract === undefined ||
      candidate === undefined ||
      contract.productRunId !== validation.productRunId ||
      candidate.productRunId !== validation.productRunId ||
      candidate.executionContractId !== validation.executionContractId
    ) {
      fail(`validation ${validation.validationResultId} 与Contract/Candidate/Run不一致`);
    }
    if ((validation.outcome === "pass") !== (validation.failures.length === 0)) {
      fail(`validation ${validation.validationResultId} outcome与failures不一致`);
    }
    const expectedFailures = validateExecutionCandidate(
      {
        executionContractId: contract.executionContractId,
        approvedPlanId: contract.approvedPlanId,
        approvedPlanRevision: contract.approvedPlanRevision,
        approvedPlanSha256: contract.approvedPlanSha256,
        steps: contract.steps,
        completionCriteria: contract.completionCriteria,
      },
      {
        executionContractId: candidate.executionContractId,
        stepResults: candidate.stepResults,
        finalOutputSections: candidate.finalOutput.sections,
        completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      },
      { strictEvidence: validation.strictEvidence ?? true },
    );
    if (JSON.stringify(validation.failures) !== JSON.stringify(expectedFailures)) {
      fail(`validation ${validation.validationResultId} 不是服务端确定性验证结果`);
    }
  }

  for (const artifact of Object.values(entities.artifacts)) {
    if (entities.runs[artifact.productRunId] === undefined) {
      fail(`artifact ${artifact.artifactId} 悬空productRunId`);
    }
    const hash = hashCanonical("artifact.v1", {
      productRunId: artifact.productRunId,
      kind: artifact.kind,
      title: artifact.title,
      content: artifact.content,
    });
    if (hash !== artifact.sha256) fail(`artifact ${artifact.artifactId} Hash不一致`);
  }
}

export function assertReceiptsAndOutbox(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const receipts = Object.values(snapshot.commandReceipts);
  if (receipts.length !== snapshot.storeRevision) {
    fail("Command Receipt数量与storeRevision不一致");
  }
  const committedRevisions = new Set(receipts.map((receipt) => receipt.committedStoreRevision));
  for (let revision = 1; revision <= snapshot.storeRevision; revision += 1) {
    if (!committedRevisions.has(revision)) fail(`缺少store revision ${String(revision)}的Receipt`);
  }
  const receiptShapes: Record<string, readonly string[]> = {
    CreateProductSession: ["sessionId"],
    // Message提交在下方按Run保存的runner family区分历史/正式configurable形状。
    CompilePlanningInput: ["attemptId", "productRunId"],
    PublishPlanForReview: ["planRevisionId", "approvalRequestId", "productRunId"],
    BeginRunAttempt: ["attemptId"],
    CompleteRunAttempt: [],
    CompileExecutionContract: ["executionContractId"],
    PersistExecutionCandidate: ["executionCandidateId"],
    PersistValidationResult: ["validationResultId"],
    CommitExecutionResult: ["finalMessageId", "productRunId", "messageSha256"],
    BeginDirectAgentAttempt: ["attemptId"],
    PublishPromptReviewRequest: ["productRunId", "promptReviewRequestId"],
    SubmitPromptReviewDecision: ["productRunId", "promptReviewDecisionId", "promptReviewRequestId"],
    MarkPromptReviewDispatching: ["promptReviewRequestId"],
    CommitPromptReviewDispatched: ["promptReviewRequestId"],
    CommitPromptReviewOutcomeUnknown: ["promptReviewRequestId"],
    PersistDirectAgentCandidate: ["directAgentCandidateId"],
    CommitDirectAgentResult: ["directAgentCandidateId", "messageId", "productRunId"],
    PrepareProjectBootstrapCandidate: ["projectBootstrapCandidateId"],
    RequestProjectBootstrapOperationRetry: ["projectBootstrapOperationId", "outboxId"],
    RenewProjectBootstrapExecutionLease: [],
    CommitRejectedRun: ["productRunId"],
    ExpireApproval: ["status"],
    CommitRunFailure: ["productRunId"],
    UpdateOutboxStatus: [],
    FailOutboxAndRun: ["productRunId"],
    CommitRunOutcomeUnknown: ["productRunId"],
    TransitionConfigurablePlanningNode: ["workflowNodeRunId"],
    CopyWorkflowDefinition: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    SaveWorkflowAgentNodeConfiguration: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    SaveWorkflowDefinitionDraft: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    PublishWorkflowDefinition: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    ChangeWorkflowDefinitionArchiveStatus: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    SettleIncompatibleWorkflowRun: ["productRunId"],
    SettleRunAfterTerminalWorkflow: ["productRunId"],
    PreparePlanningContextNone: ["contextRequestId", "productRunId"],
    BeginMemoryContextQuery: ["memoryQueryId", "productRunId"],
    CompleteMemoryContextQuery: ["contextPackageId", "productRunId"],
    CommitOptionalMemoryQueryFailure: ["contextPackageId", "productRunId"],
    CommitRequiredMemoryQueryFailure: ["productRunId"],
    BeginWorkflowMemoryQuery: ["productRunId", "workflowMemoryQueryId"],
    PersistWorkflowMemoryQueryResult: [
      "productRunId",
      "workflowMemoryQueryId",
      "workflowNodeRunId",
    ],
    CreateMemoryWrite: ["memoryWriteIntentId", "memoryWriteResultId"],
    MarkMemoryWriteDispatching: ["memoryWriteResultId"],
    CommitMemoryWriteAccepted: ["memoryWriteResultId"],
    CommitMemoryWriteMaterialized: ["memoryWriteResultId"],
    CommitMemoryWriteFailed: ["memoryWriteResultId"],
    CommitMemoryWriteOutcomeUnknown: ["memoryWriteResultId"],
    RequestMemoryWriteReconciliation: ["memoryWriteIntentId", "memoryWriteResultId"],
    CreateMemoryImport: ["memoryImportIntentId", "memoryImportResultId"],
    MarkMemoryImportDispatching: ["memoryImportResultId"],
    CommitMemoryImportAccepted: ["memoryImportResultId"],
    CommitMemoryImportMaterialized: ["memoryImportResultId"],
    CommitMemoryImportFailed: ["memoryImportResultId"],
    CommitMemoryImportOutcomeUnknown: ["memoryImportResultId"],
    RequestMemoryImportReconciliation: ["memoryImportIntentId", "memoryImportResultId"],
    RecoverMemoryImportAfterTerminalWorkflow: [
      "outboxId",
      "memoryImportResultId",
      "recoveryOutboxId",
    ],
    BeginProjectIntake: ["projectCandidateId", "messageId"],
    BeginProjectManagementCandidate: ["projectCandidateId", "messageId"],
    BeginProjectAdvancement: ["projectCandidateId", "messageId"],
    PrepareProjectAdvancementCandidate: ["projectCandidateId"],
    FailProjectAdvancementCandidate: ["projectCandidateId"],
    DecideProjectAdvancementCandidate: ["projectCandidateId", "projectId"],
    TransitionProjectStage: ["projectId", "projectStageId"],
    TransitionProjectMilestone: ["projectId", "projectMilestoneId"],
    DecideProjectManagementCandidate: ["projectCandidateId", "projectId"],
    PrepareProjectCandidateForReview: ["projectCandidateId"],
    FailProjectCandidateForReview: ["projectCandidateId"],
    CreateProjectAction: ["projectId", "projectActionId"],
    AssignProjectAction: ["projectId"],
    TransitionProjectAction: ["projectId"],
    SetProjectArchiveStatus: ["projectId", "projectDecisionId", "projectStateTransitionId"],
    TransitionProjectLifecycle: ["projectId", "projectDecisionId", "projectStateTransitionId"],
    RecordProjectDecision: ["projectId", "projectDecisionId"],
    RecordProjectContribution: ["projectId", "projectContributionId"],
    ObserveProjectResource: ["projectId", "projectObservationId"],
    ReviseNote: ["noteId", "noteRevisionId"],
    ArchiveNote: ["noteId"],
    RestoreNote: ["noteId"],
    // PublishNoteCandidate在下方按manual/system_policy动态校验resultRefs。
    SubmitNoteDecision: ["noteDecisionId", "noteCandidateId"],
    CommitConfirmedNote: ["noteId", "noteRevisionId", "productRunId", "finalMessageId"],
    CreateRule: ["ruleId", "ruleRevisionId"],
    ReviseRule: ["ruleId", "ruleRevisionId"],
    TransitionRuleLifecycle: ["ruleId", "ruleDecisionId"],
    CreateRuleTag: ["ruleTagId"],
    UpdateRuleTag: ["ruleTagId"],
    ArchiveRuleTag: ["ruleTagId"],
    CreatePromptFragment: ["promptFragmentId", "promptFragmentRevisionId"],
    CopyPromptFragment: ["promptFragmentId", "promptFragmentRevisionId"],
    RevisePromptFragment: ["promptFragmentId", "promptFragmentRevisionId"],
    ReviseAgentPrompt: ["promptFragmentId", "promptFragmentRevisionId"],
    ChangePromptFragmentArchiveStatus: ["promptFragmentId", "promptFragmentRevisionId"],
    CreateAgentVersion: ["agentVersionId"],
    // 三类Planning Context在none/ready时返回不同的事实引用，见下方动态分支。
  };
  for (const receipt of receipts) {
    if (
      receipt.committedStoreRevision < 1 ||
      receipt.committedStoreRevision > snapshot.storeRevision
    ) {
      fail(`receipt ${receipt.commandId} committedStoreRevision越界`);
    }
    const receiptRun = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
    const expectedKeys =
      receipt.commandType === "SubmitUserMessage" ||
      receipt.commandType === "SubmitProjectBootstrapUserMessage"
        ? receiptRun?.runnerFamily === "legacy-planning.v1"
          ? ["messageId", "productRunId"]
          : ["messageId", "productRunId", "workflowRunSpecId"]
        : receipt.commandType === "SubmitPlanDecision"
          ? receipt.resultRefs["approvalExpired"] === "true"
            ? ["approvalExpired", "productRunId"]
            : ["decisionId", "productRunId"]
          : receipt.commandType === "DecideProjectBootstrapCandidate"
            ? receipt.resultRefs["projectBootstrapOperationId"] === undefined
              ? ["projectBootstrapCandidateId", "projectBootstrapDecisionId"]
              : receipt.resultRefs["outboxId"] === undefined
                ? [
                    "projectBootstrapCandidateId",
                    "projectBootstrapDecisionId",
                    "projectBootstrapOperationId",
                  ]
                : [
                    "outboxId",
                    "projectBootstrapCandidateId",
                    "projectBootstrapDecisionId",
                    "projectBootstrapOperationId",
                  ]
            : receipt.commandType === "ClaimProjectBootstrapOperation"
              ? receipt.resultRefs["outboxId"] === undefined
                ? ["projectBootstrapOperationId"]
                : receipt.resultRefs["fencingToken"] === undefined
                  ? ["executionMode", "outboxId", "projectBootstrapOperationId"]
                  : ["executionMode", "fencingToken", "outboxId", "projectBootstrapOperationId"]
              : receipt.commandType === "FinalizeProjectBootstrapOperation"
                ? receipt.resultRefs["projectWorkspaceBindingId"] === undefined
                  ? ["projectBootstrapOperationId"]
                  : ["projectBootstrapOperationId", "projectWorkspaceBindingId"]
                : receipt.commandType === "DecideProjectCandidate"
                  ? receipt.resultRefs["projectId"] === undefined
                    ? ["projectCandidateId"]
                    : ["projectCandidateId", "projectId"]
                  : receipt.commandType === "PreparePlanningMemoryContext"
                    ? receipt.resultRefs["planningMemorySelectionId"] === undefined
                      ? ["contextStatus", "productRunId", "workflowNodeRunId"]
                      : [
                          "contextStatus",
                          "planningMemorySelectionId",
                          "productRunId",
                          "workflowNodeRunId",
                        ]
                    : receipt.commandType === "PreparePlanningProjectContext"
                      ? receipt.resultRefs["planningProjectContextId"] === undefined
                        ? ["productRunId", "workflowNodeRunId"]
                        : ["planningProjectContextId", "productRunId", "workflowNodeRunId"]
                      : receipt.commandType === "PreparePlanningRulesContext"
                        ? receipt.resultRefs["ruleSelectionId"] === undefined
                          ? ["productRunId", "workflowNodeRunId"]
                          : ["productRunId", "ruleSelectionId", "workflowNodeRunId"]
                        : receipt.commandType === "PublishNoteCandidate"
                          ? receipt.resultRefs["workflowPolicyResolutionId"] === undefined
                            ? ["noteCandidateId", "productRunId"]
                            : ["noteCandidateId", "productRunId", "workflowPolicyResolutionId"]
                          : receipt.commandType === "FreezeWorkflowMemoryContext"
                            ? receipt.resultRefs["workflowMemoryContextId"] === undefined
                              ? ["productRunId"]
                              : ["productRunId", "workflowMemoryContextId"]
                            : receiptShapes[receipt.commandType];
    if (expectedKeys === undefined) fail(`receipt ${receipt.commandId} commandType未知`);
    const actualKeys = Object.keys(receipt.resultRefs).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
      fail(`receipt ${receipt.commandId} resultRefs与Command类型不一致`);
    }
    for (const [key, value] of Object.entries(receipt.resultRefs)) {
      const exists =
        key === "sessionId"
          ? entities.sessions[value] !== undefined
          : key === "messageId" || key === "finalMessageId"
            ? entities.messages[value] !== undefined
            : key === "productRunId"
              ? entities.runs[value] !== undefined
              : key === "workflowRunSpecId"
                ? entities.workflowRunSpecs[value] !== undefined
                : key === "workflowDefinitionId"
                  ? entities.workflowDefinitions[value] !== undefined
                  : key === "workflowDefinitionRevisionId"
                    ? entities.workflowDefinitionRevisions[value] !== undefined
                    : key === "attemptId"
                      ? entities.attempts[value] !== undefined
                      : key === "planRevisionId"
                        ? entities.plans[value] !== undefined
                        : key === "approvalRequestId"
                          ? entities.approvalRequests[value] !== undefined
                          : key === "decisionId"
                            ? entities.decisions[value] !== undefined
                            : key === "projectBootstrapCandidateId"
                              ? entities.projectBootstrapCandidates[value] !== undefined
                              : key === "projectBootstrapDecisionId"
                                ? entities.projectBootstrapDecisions[value] !== undefined
                                : key === "projectBootstrapOperationId"
                                  ? entities.projectBootstrapOperations[value] !== undefined
                                  : key === "projectWorkspaceBindingId"
                                    ? entities.projectWorkspaceBindings[value] !== undefined
                                    : key === "promptReviewRequestId"
                                      ? entities.promptReviewRequests[value] !== undefined
                                      : key === "promptReviewDecisionId"
                                        ? entities.promptReviewDecisions[value] !== undefined
                                        : key === "directAgentCandidateId"
                                          ? entities.directAgentCandidates[value] !== undefined
                                          : key === "promptFragmentId"
                                            ? entities.promptFragments[value] !== undefined
                                            : key === "promptFragmentRevisionId"
                                              ? entities.promptFragmentRevisions[value] !==
                                                undefined
                                              : key === "executionContractId"
                                                ? entities.executionContracts[value] !== undefined
                                                : key === "executionCandidateId"
                                                  ? entities.executionCandidates[value] !==
                                                    undefined
                                                  : key === "validationResultId"
                                                    ? entities.validationResults[value] !==
                                                      undefined
                                                    : key === "workflowNodeRunId"
                                                      ? entities.workflowNodeRuns[value] !==
                                                        undefined
                                                      : key === "memoryQueryId"
                                                        ? entities.memoryQueries[value] !==
                                                          undefined
                                                        : key === "contextRequestId"
                                                          ? entities.contextRequests[value] !==
                                                            undefined
                                                          : key === "contextPackageId"
                                                            ? entities.contextPackages[value] !==
                                                              undefined
                                                            : key === "memoryImportIntentId"
                                                              ? entities.memoryImportIntents[
                                                                  value
                                                                ] !== undefined
                                                              : key === "memoryImportResultId"
                                                                ? entities.memoryImportResults[
                                                                    value
                                                                  ] !== undefined
                                                                : key === "workflowMemoryQueryId"
                                                                  ? entities.workflowMemoryQueries[
                                                                      value
                                                                    ] !== undefined
                                                                  : key ===
                                                                      "workflowMemoryContextId"
                                                                    ? entities
                                                                        .workflowMemoryContexts[
                                                                        value
                                                                      ] !== undefined
                                                                    : key === "memoryWriteIntentId"
                                                                      ? entities.memoryWriteIntents[
                                                                          value
                                                                        ] !== undefined
                                                                      : key ===
                                                                          "memoryWriteResultId"
                                                                        ? entities
                                                                            .memoryWriteResults[
                                                                            value
                                                                          ] !== undefined
                                                                        : key === "outboxId" ||
                                                                            key ===
                                                                              "recoveryOutboxId"
                                                                          ? snapshot.outbox[
                                                                              value
                                                                            ] !== undefined
                                                                          : key === "projectId"
                                                                            ? entities.projects[
                                                                                value
                                                                              ] !== undefined
                                                                            : key ===
                                                                                "projectCandidateId"
                                                                              ? entities
                                                                                  .projectCandidates[
                                                                                  value
                                                                                ] !== undefined
                                                                              : key ===
                                                                                  "projectStageId"
                                                                                ? entities
                                                                                    .projectStages[
                                                                                    value
                                                                                  ] !== undefined
                                                                                : key ===
                                                                                    "projectMilestoneId"
                                                                                  ? entities
                                                                                      .projectMilestones[
                                                                                      value
                                                                                    ] !== undefined
                                                                                  : key ===
                                                                                      "projectActionId"
                                                                                    ? entities
                                                                                        .projectActions[
                                                                                        value
                                                                                      ] !==
                                                                                      undefined
                                                                                    : key ===
                                                                                        "projectDecisionId"
                                                                                      ? entities
                                                                                          .projectDecisions[
                                                                                          value
                                                                                        ] !==
                                                                                        undefined
                                                                                      : key ===
                                                                                          "projectStateTransitionId"
                                                                                        ? entities
                                                                                            .projectStateTransitions[
                                                                                            value
                                                                                          ] !==
                                                                                          undefined
                                                                                        : key ===
                                                                                            "projectContributionId"
                                                                                          ? entities
                                                                                              .projectContributions[
                                                                                              value
                                                                                            ] !==
                                                                                            undefined
                                                                                          : key ===
                                                                                              "projectObservationId"
                                                                                            ? entities
                                                                                                .projectObservations[
                                                                                                value
                                                                                              ] !==
                                                                                              undefined
                                                                                            : key ===
                                                                                                "noteId"
                                                                                              ? entities
                                                                                                  .notes[
                                                                                                  value
                                                                                                ] !==
                                                                                                undefined
                                                                                              : key ===
                                                                                                  "noteRevisionId"
                                                                                                ? entities
                                                                                                    .noteRevisions[
                                                                                                    value
                                                                                                  ] !==
                                                                                                  undefined
                                                                                                : key ===
                                                                                                    "noteCandidateId"
                                                                                                  ? entities
                                                                                                      .noteCandidates[
                                                                                                      value
                                                                                                    ] !==
                                                                                                    undefined
                                                                                                  : key ===
                                                                                                      "noteDecisionId"
                                                                                                    ? entities
                                                                                                        .noteDecisions[
                                                                                                        value
                                                                                                      ] !==
                                                                                                      undefined
                                                                                                    : key ===
                                                                                                        "ruleId"
                                                                                                      ? entities
                                                                                                          .rules[
                                                                                                          value
                                                                                                        ] !==
                                                                                                        undefined
                                                                                                      : key ===
                                                                                                          "ruleRevisionId"
                                                                                                        ? entities
                                                                                                            .ruleRevisions[
                                                                                                            value
                                                                                                          ] !==
                                                                                                          undefined
                                                                                                        : key ===
                                                                                                            "ruleTagId"
                                                                                                          ? entities
                                                                                                              .ruleTags[
                                                                                                              value
                                                                                                            ] !==
                                                                                                            undefined
                                                                                                          : key ===
                                                                                                              "ruleDecisionId"
                                                                                                            ? entities
                                                                                                                .ruleDecisions[
                                                                                                                value
                                                                                                              ] !==
                                                                                                              undefined
                                                                                                            : key ===
                                                                                                                "agentVersionId"
                                                                                                              ? entities
                                                                                                                  .agentVersions[
                                                                                                                  value
                                                                                                                ] !==
                                                                                                                undefined
                                                                                                              : key ===
                                                                                                                  "ruleSelectionId"
                                                                                                                ? entities
                                                                                                                    .ruleSelections[
                                                                                                                    value
                                                                                                                  ] !==
                                                                                                                  undefined
                                                                                                                : key ===
                                                                                                                    "planningProjectContextId"
                                                                                                                  ? entities
                                                                                                                      .planningProjectContexts[
                                                                                                                      value
                                                                                                                    ] !==
                                                                                                                    undefined
                                                                                                                  : key ===
                                                                                                                      "planningMemorySelectionId"
                                                                                                                    ? entities
                                                                                                                        .planningMemorySelections[
                                                                                                                        value
                                                                                                                      ] !==
                                                                                                                      undefined
                                                                                                                    : key ===
                                                                                                                        "workflowPolicyResolutionId"
                                                                                                                      ? entities
                                                                                                                          .workflowPolicyResolutions[
                                                                                                                          value
                                                                                                                        ] !==
                                                                                                                        undefined
                                                                                                                      : key ===
                                                                                                                          "contextStatus"
                                                                                                                        ? value ===
                                                                                                                            "none" ||
                                                                                                                          value ===
                                                                                                                            "ready"
                                                                                                                        : key ===
                                                                                                                            "fencingToken"
                                                                                                                          ? /^\d+$/u.test(
                                                                                                                              value,
                                                                                                                            ) &&
                                                                                                                            Number(
                                                                                                                              value,
                                                                                                                            ) >
                                                                                                                              0
                                                                                                                          : key ===
                                                                                                                              "executionMode"
                                                                                                                            ? value ===
                                                                                                                                "execute" ||
                                                                                                                              value ===
                                                                                                                                "reconcile"
                                                                                                                            : key ===
                                                                                                                                "messageSha256"
                                                                                                                              ? /^[a-f0-9]{64}$/.test(
                                                                                                                                  value,
                                                                                                                                )
                                                                                                                              : key ===
                                                                                                                                  "approvalExpired"
                                                                                                                                ? value ===
                                                                                                                                  "true"
                                                                                                                                : key ===
                                                                                                                                    "status"
                                                                                                                                  ? value ===
                                                                                                                                      "expired" ||
                                                                                                                                    value ===
                                                                                                                                      "already_decided"
                                                                                                                                  : false;
      if (!exists) fail(`receipt ${receipt.commandId} 的${key}引用无效`);
    }
    const receiptDefinitionId = receipt.resultRefs["workflowDefinitionId"];
    const receiptRevisionId = receipt.resultRefs["workflowDefinitionRevisionId"];
    if (receiptDefinitionId !== undefined && receiptRevisionId !== undefined) {
      const referencedRevision = entities.workflowDefinitionRevisions[receiptRevisionId];
      if (referencedRevision?.workflowDefinitionId !== receiptDefinitionId) {
        fail(`receipt ${receipt.commandId} Definition与Revision交叉绑定不一致`);
      }
    }
    if (
      receipt.commandType === "SubmitUserMessage" ||
      receipt.commandType === "SubmitProjectBootstrapUserMessage"
    ) {
      const message = entities.messages[receipt.resultRefs["messageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        message === undefined ||
        run === undefined ||
        run.sourceMessageId !== message.messageId ||
        run.sessionId !== message.sessionId ||
        message.role !== "user"
      ) {
        fail(`receipt ${receipt.commandId} 的Message/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "PreparePlanningRulesContext") {
      const selection = entities.ruleSelections[receipt.resultRefs["ruleSelectionId"] ?? ""];
      if (
        receipt.resultRefs["ruleSelectionId"] !== undefined &&
        selection?.productRunId !== receipt.resultRefs["productRunId"]
      ) {
        fail(`receipt ${receipt.commandId} Rule Selection与Run交叉绑定不一致`);
      }
    }
    if (receipt.commandType === "PreparePlanningMemoryContext") {
      const selection =
        entities.planningMemorySelections[receipt.resultRefs["planningMemorySelectionId"] ?? ""];
      if (
        receipt.resultRefs["contextStatus"] === "ready" &&
        selection?.productRunId !== receipt.resultRefs["productRunId"]
      ) {
        fail(`receipt ${receipt.commandId} Memory Selection与Run交叉绑定不一致`);
      }
    }
    if (receipt.commandType === "PreparePlanningProjectContext") {
      const context =
        entities.planningProjectContexts[receipt.resultRefs["planningProjectContextId"] ?? ""];
      if (
        receipt.resultRefs["planningProjectContextId"] !== undefined &&
        context?.productRunId !== receipt.resultRefs["productRunId"]
      ) {
        fail(`receipt ${receipt.commandId} Project Context与Run交叉绑定不一致`);
      }
    }
    if (receipt.commandType === "PublishNoteCandidate") {
      const candidate = entities.noteCandidates[receipt.resultRefs["noteCandidateId"] ?? ""];
      const resolution =
        entities.workflowPolicyResolutions[receipt.resultRefs["workflowPolicyResolutionId"] ?? ""];
      if (
        candidate?.productRunId !== receipt.resultRefs["productRunId"] ||
        (receipt.resultRefs["workflowPolicyResolutionId"] !== undefined &&
          (resolution === undefined ||
            candidate === undefined ||
            resolution.productRunId !== receipt.resultRefs["productRunId"] ||
            resolution.noteCandidateId !== candidate.noteCandidateId))
      ) {
        fail(`receipt ${receipt.commandId} Note Candidate/Policy/Run交叉绑定不一致`);
      }
    }
    if (receipt.commandType === "PublishPlanForReview") {
      const plan = entities.plans[receipt.resultRefs["planRevisionId"] ?? ""];
      const approval = entities.approvalRequests[receipt.resultRefs["approvalRequestId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        plan === undefined ||
        approval === undefined ||
        run === undefined ||
        plan.productRunId !== run.productRunId ||
        approval.productRunId !== run.productRunId ||
        approval.planId !== plan.planId ||
        approval.planRevision !== plan.planRevision ||
        approval.planSha256 !== plan.sha256
      ) {
        fail(`receipt ${receipt.commandId} 的Plan/Approval/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "SubmitPlanDecision") {
      const decision = entities.decisions[receipt.resultRefs["decisionId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        receipt.resultRefs["approvalExpired"] !== "true" &&
        (decision === undefined || run === undefined || decision.productRunId !== run.productRunId)
      ) {
        fail(`receipt ${receipt.commandId} 的Decision/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "PublishPromptReviewRequest") {
      const request =
        entities.promptReviewRequests[receipt.resultRefs["promptReviewRequestId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        request === undefined ||
        run?.runKind !== "direct_agent" ||
        request.productRunId !== run.productRunId
      ) {
        fail(`receipt ${receipt.commandId} 的Prompt Review Request/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "SubmitPromptReviewDecision") {
      const request =
        entities.promptReviewRequests[receipt.resultRefs["promptReviewRequestId"] ?? ""];
      const decision =
        entities.promptReviewDecisions[receipt.resultRefs["promptReviewDecisionId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        request === undefined ||
        decision === undefined ||
        run?.runKind !== "direct_agent" ||
        request.productRunId !== run.productRunId ||
        decision.productRunId !== run.productRunId ||
        decision.promptReviewRequestId !== request.promptReviewRequestId
      ) {
        fail(`receipt ${receipt.commandId} 的Prompt Review Decision/Request/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "PersistDirectAgentCandidate") {
      const candidate =
        entities.directAgentCandidates[receipt.resultRefs["directAgentCandidateId"] ?? ""];
      if (
        candidate === undefined ||
        entities.runs[candidate.productRunId]?.runKind !== "direct_agent"
      ) {
        fail(`receipt ${receipt.commandId} 的Direct Agent Candidate绑定不一致`);
      }
    }
    if (receipt.commandType === "CommitDirectAgentResult") {
      const candidate =
        entities.directAgentCandidates[receipt.resultRefs["directAgentCandidateId"] ?? ""];
      const message = entities.messages[receipt.resultRefs["messageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        candidate === undefined ||
        message === undefined ||
        run?.runKind !== "direct_agent" ||
        candidate.productRunId !== run.productRunId ||
        run.finalDirectAgentCandidateId !== candidate.directAgentCandidateId ||
        run.finalMessageId !== message.messageId ||
        message.sourceRunId !== run.productRunId ||
        message.content.text !== candidate.output.text
      ) {
        fail(`receipt ${receipt.commandId} 的Direct Agent Candidate/Message/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "CommitExecutionResult") {
      const message = entities.messages[receipt.resultRefs["finalMessageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        message === undefined ||
        run === undefined ||
        run.finalMessageId !== message.messageId ||
        message.sourceRunId !== run.productRunId
      ) {
        fail(`receipt ${receipt.commandId} 的正式Message/Run绑定不一致`);
      }
      const messageSha256 = hashCanonical("message.v1", {
        messageId: message.messageId,
        sessionId: message.sessionId,
        sessionSequence: message.sessionSequence,
        role: message.role,
        content: message.content,
      });
      if (receipt.resultRefs["messageSha256"] !== messageSha256) {
        fail(`receipt ${receipt.commandId} 的messageSha256不一致`);
      }
    }
  }
  const leasedProjectBootstrapOperations = new Set<string>();
  for (const entry of Object.values(snapshot.outbox)) {
    if (entry.kind === "project_bootstrap_execute") {
      const operation = entities.projectBootstrapOperations[entry.projectBootstrapOperationId];
      if (operation === undefined || entry.expectedOperationRevision > operation.revision) {
        fail(`outbox ${entry.outboxId} Project Bootstrap绑定不完整`);
      }
      if (entry.executionLease !== undefined) {
        if (
          operation?.status !== "dispatching" ||
          !["pending", "dispatched", "outcome_unknown"].includes(entry.status)
        ) {
          fail(`outbox ${entry.outboxId} Project Bootstrap lease与执行状态不一致`);
        }
        if (leasedProjectBootstrapOperations.has(entry.projectBootstrapOperationId)) {
          fail(`operation ${entry.projectBootstrapOperationId} 存在多个Project Bootstrap lease`);
        }
        if (
          entry.executionLease.fencingToken !== undefined &&
          entry.executionLease.fencingToken !== operation?.revision
        ) {
          fail(`outbox ${entry.outboxId} Project Bootstrap fencing token与Operation不一致`);
        }
        leasedProjectBootstrapOperations.add(entry.projectBootstrapOperationId);
      }
      continue;
    }
    if (entry.kind === "project_intake_start" || entry.kind === "project_intake_resume") {
      const candidate = entities.projectCandidates[entry.projectCandidateId];
      if (
        candidate === undefined ||
        candidate.candidateKind !== "intake" ||
        entry.expectedCandidateRevision > candidate.revision
      ) {
        fail(`outbox ${entry.outboxId} Project Intake绑定不完整`);
      }
      continue;
    }
    if (entry.kind === "project_advancement_start" || entry.kind === "project_advancement_resume") {
      const candidate = entities.projectCandidates[entry.projectCandidateId];
      if (
        candidate === undefined ||
        candidate.candidateKind !== "advancement" ||
        entry.expectedCandidateRevision > candidate.revision
      ) {
        fail(`outbox ${entry.outboxId} Project Advancement绑定不完整`);
      }
      continue;
    }
    if (entry.kind === "workflow_start" || entry.kind === "workflow_resume") {
      if (entities.runs[entry.productRunId] === undefined) {
        fail(`outbox ${entry.outboxId} 悬空productRunId`);
      }
      if (entry.kind === "workflow_start") continue;
      if (entry.promptReviewRequestId !== undefined || entry.promptReviewDecisionId !== undefined) {
        const request =
          entry.promptReviewRequestId === undefined
            ? undefined
            : entities.promptReviewRequests[entry.promptReviewRequestId];
        const decision =
          entry.promptReviewDecisionId === undefined
            ? undefined
            : entities.promptReviewDecisions[entry.promptReviewDecisionId];
        if (
          request === undefined ||
          decision === undefined ||
          request.productRunId !== entry.productRunId ||
          decision.productRunId !== entry.productRunId ||
          decision.promptReviewRequestId !== request.promptReviewRequestId
        ) {
          fail(`outbox ${entry.outboxId} Prompt Review workflow_resume绑定不完整`);
        }
      } else if (entry.approvalRequestId !== undefined || entry.decisionId !== undefined) {
        const approval =
          entry.approvalRequestId === undefined
            ? undefined
            : entities.approvalRequests[entry.approvalRequestId];
        const decision =
          entry.decisionId === undefined ? undefined : entities.decisions[entry.decisionId];
        if (
          approval === undefined ||
          decision === undefined ||
          approval.productRunId !== entry.productRunId ||
          decision.productRunId !== entry.productRunId ||
          decision.approvalRequestId !== approval.approvalRequestId
        ) {
          fail(`outbox ${entry.outboxId} workflow_resume绑定不完整`);
        }
      } else {
        const hookCandidate =
          entry.hookNoteCandidateId === undefined
            ? undefined
            : entities.noteCandidates[entry.hookNoteCandidateId];
        const candidate =
          entry.noteCandidateId === undefined
            ? undefined
            : entities.noteCandidates[entry.noteCandidateId];
        const decision =
          entry.noteDecisionId === undefined
            ? undefined
            : entities.noteDecisions[entry.noteDecisionId];
        if (
          hookCandidate === undefined ||
          candidate === undefined ||
          decision === undefined ||
          hookCandidate.productRunId !== entry.productRunId ||
          candidate.productRunId !== entry.productRunId ||
          decision.productRunId !== entry.productRunId ||
          decision.noteCandidateId !== candidate.noteCandidateId ||
          (hookCandidate.noteCandidateId !== candidate.noteCandidateId &&
            candidate.supersedesCandidateId !== hookCandidate.noteCandidateId)
        ) {
          fail(`outbox ${entry.outboxId} workflow_resume绑定不完整`);
        }
      }
      continue;
    }
    if (entry.kind === "memory_write_start" || entry.kind === "memory_write_reconcile") {
      const intent = entities.memoryWriteIntents[entry.memoryWriteIntentId];
      const result = entities.memoryWriteResults[entry.memoryWriteResultId];
      if (
        intent === undefined ||
        result === undefined ||
        result.memoryWriteIntentId !== intent.memoryWriteIntentId ||
        entry.expectedResultRevision > result.revision
      ) {
        fail(`outbox ${entry.outboxId} Memory Write绑定不完整`);
      }
      continue;
    }
    const intent = entities.memoryImportIntents[entry.memoryImportIntentId];
    const result = entities.memoryImportResults[entry.memoryImportResultId];
    if (
      intent === undefined ||
      result === undefined ||
      result.memoryImportIntentId !== intent.memoryImportIntentId ||
      entry.expectedResultRevision > result.revision
    ) {
      fail(`outbox ${entry.outboxId} Memory Import绑定不完整`);
    }
  }
}
