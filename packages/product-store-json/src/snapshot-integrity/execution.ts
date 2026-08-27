import {
  EXECUTION_CAPABILITIES,
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  GOVERNANCE_REVIEW_PROFILE_VERSION,
  type PromptAssemblyV3,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  computeExecutionInputManifestSha256,
  governanceEvidenceKeys,
  hashCanonical,
  resolvePlanningValidationPolicy,
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
    const allowedCapabilities = new Set<string>(EXECUTION_CAPABILITIES);
    if (
      JSON.stringify(contract.capabilityRefs) !== JSON.stringify(expectedCapabilities) ||
      contract.capabilityRefs.some((capability) => !allowedCapabilities.has(capability))
    ) {
      fail(`contract ${contract.executionContractId} Capability扩大或不一致`);
    }
    const requiresWorkspace = contract.capabilityRefs.some(
      (capability) => capability !== EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
    );
    if (requiresWorkspace && contract.workspaceRef === undefined) {
      fail(`contract ${contract.executionContractId} 缺少Workspace绑定`);
    }
    if (!requiresWorkspace && contract.workspaceRef !== undefined) {
      fail(`contract ${contract.executionContractId} 无Workspace能力却携带Workspace绑定`);
    }
    const hash = hashCanonical("execution-contract.v1", {
      productRunId: contract.productRunId,
      approvedPlanId: contract.approvedPlanId,
      approvedPlanRevision: contract.approvedPlanRevision,
      approvedPlanSha256: contract.approvedPlanSha256,
      approvalDecisionId: contract.approvalDecisionId,
      steps: contract.steps,
      completionCriteria: contract.completionCriteria,
      ...(contract.workspaceRef === undefined ? {} : { workspaceRef: contract.workspaceRef }),
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
              (candidate.schemaVersion === "prompt-assembly.v3" ||
                candidate.schemaVersion === "prompt-assembly.v6") &&
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
        ...(stepResult.executionEvidenceRefs === undefined
          ? {}
          : { executionEvidenceRefs: stepResult.executionEvidenceRefs }),
        warnings: stepResult.warnings,
      });
      if (stepHash !== stepResult.sha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤结果Hash不一致`);
      }
      priorResults.set(stepResult.stepId, stepResult);
    }
    const hash = hashCanonical("execution-candidate.v1", {
      executionContractId: candidate.executionContractId,
      ...(candidate.evidencePolicyVersion === undefined
        ? {}
        : { evidencePolicyVersion: candidate.evidencePolicyVersion }),
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

  const validatedCandidateIds = new Set<string>();
  for (const validation of Object.values(entities.validationResults)) {
    const contract = entities.executionContracts[validation.executionContractId];
    const candidate = entities.executionCandidates[validation.executionCandidateId];
    const run = entities.runs[validation.productRunId];
    if (
      contract === undefined ||
      candidate === undefined ||
      run?.runKind !== "planning" ||
      contract.productRunId !== validation.productRunId ||
      candidate.productRunId !== validation.productRunId ||
      candidate.executionContractId !== validation.executionContractId
    ) {
      fail(`validation ${validation.validationResultId} 与Contract/Candidate/Run不一致`);
    }
    if (validatedCandidateIds.has(candidate.executionCandidateId)) {
      fail(`candidate ${candidate.executionCandidateId} 存在多份Validation事实`);
    }
    validatedCandidateIds.add(candidate.executionCandidateId);
    let policyKind: "deterministic" | "governance_review" = "deterministic";
    let policyDefinitionNodeId: string | undefined;
    let strictEvidence = true;
    if (run.workflowRunSpecId !== undefined) {
      const runSpec = entities.workflowRunSpecs[run.workflowRunSpecId];
      if (runSpec === undefined) fail(`validation ${validation.validationResultId} 缺少RunSpec`);
      let policy;
      try {
        policy = resolvePlanningValidationPolicy(runSpec);
      } catch {
        fail(`validation ${validation.validationResultId} 的冻结Validation策略无效`);
      }
      policyKind = policy.kind;
      policyDefinitionNodeId = policy.definitionNodeId;
      strictEvidence = policy.strictEvidence;
      if (validation.strictEvidence !== strictEvidence) {
        fail(`validation ${validation.validationResultId} strictEvidence与RunSpec不一致`);
      }
    } else if ((validation.strictEvidence ?? true) !== true) {
      fail(`legacy validation ${validation.validationResultId} 不允许降级strictEvidence`);
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
      { strictEvidence },
    );
    const governanceReview = validation.governanceReview;
    if ((policyKind === "governance_review") !== (governanceReview !== undefined)) {
      fail(`validation ${validation.validationResultId} 的Governance Review与RunSpec不一致`);
    }
    const governanceFailures =
      governanceReview?.candidate.findings
        .filter((finding) => finding.severity === "blocking")
        .map((finding) => ({
          code: finding.code,
          detail: `${finding.summary}：${finding.detail}`.slice(0, 500),
        })) ?? [];
    if (
      JSON.stringify(validation.failures) !==
      JSON.stringify([...expectedFailures, ...governanceFailures])
    ) {
      fail(`validation ${validation.validationResultId} 不是服务端确定性验证结果`);
    }
    if (governanceReview !== undefined) {
      const assembly = entities.promptAssemblies[governanceReview.promptAssemblyId];
      const governanceNode =
        assembly?.schemaVersion === "prompt-assembly.v3" ||
        assembly?.schemaVersion === "prompt-assembly.v6"
          ? assembly.nodes.find((node) => node.nodeType === "agent.governance_check")
          : undefined;
      const attempt = entities.attempts[governanceReview.attemptId];
      if (
        assembly === undefined ||
        assembly.productRunId !== validation.productRunId ||
        assembly.sha256 !== governanceReview.promptAssemblySha256 ||
        governanceNode === undefined ||
        governanceNode.definitionNodeId !== policyDefinitionNodeId ||
        governanceNode.sha256 !== governanceReview.nodeAssemblySha256 ||
        governanceNode.profileVersion !== governanceReview.profileVersion ||
        governanceReview.profileVersion !== GOVERNANCE_REVIEW_PROFILE_VERSION ||
        attempt === undefined ||
        attempt.kind !== "governance_review" ||
        attempt.productRunId !== validation.productRunId ||
        attempt.executionContractId !== validation.executionContractId ||
        attempt.executionCandidateId !== validation.executionCandidateId ||
        attempt.outcome !== "success" ||
        attempt.inputManifestSha256 !== governanceReview.inputManifestSha256
      ) {
        fail(`validation ${validation.validationResultId} 治理检查Prompt/Attempt绑定不一致`);
      }
      const allowedEvidence = new Set(governanceEvidenceKeys(candidate));
      if (
        governanceReview.candidate.findings.some((finding) =>
          finding.evidenceKeys.some((evidenceKey) => !allowedEvidence.has(evidenceKey)),
        )
      ) {
        fail(`validation ${validation.validationResultId} 治理检查引用未知执行证据`);
      }
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

  const resultCollections: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    sessionId: entities.sessions,
    messageId: entities.messages,
    finalMessageId: entities.messages,
    productRunId: entities.runs,
    attemptId: entities.attempts,
    planRevisionId: entities.plans,
    approvalRequestId: entities.approvalRequests,
    decisionId: entities.decisions,
    executionContractId: entities.executionContracts,
    executionCandidateId: entities.executionCandidates,
    validationResultId: entities.validationResults,
    artifactId: entities.artifacts,
    directAgentCandidateId: entities.directAgentCandidates,
    promptReviewRequestId: entities.promptReviewRequests,
    promptReviewDecisionId: entities.promptReviewDecisions,
    contextRequestId: entities.contextRequests,
    memoryQueryId: entities.memoryQueries,
    contextPackageId: entities.contextPackages,
    memoryImportIntentId: entities.memoryImportIntents,
    memoryImportResultId: entities.memoryImportResults,
    memoryWriteIntentId: entities.memoryWriteIntents,
    memoryWriteResultId: entities.memoryWriteResults,
    memorySessionImportId: entities.memorySessionImports,
    memoryAgentOperationId: entities.memoryAgentOperations,
    memoryAgentWriteCandidateId: entities.memoryAgentWriteCandidates,
    memoryAgentWriteDecisionId: entities.memoryAgentWriteDecisions,
    workflowDefinitionId: entities.workflowDefinitions,
    workflowDefinitionRevisionId: entities.workflowDefinitionRevisions,
    workflowRunSpecId: entities.workflowRunSpecs,
    workflowNodeRunId: entities.workflowNodeRuns,
    noteCandidateId: entities.noteCandidates,
    noteDecisionId: entities.noteDecisions,
    noteRevisionId: entities.noteRevisions,
    ruleId: entities.rules,
    ruleRevisionId: entities.ruleRevisions,
    ruleTagId: entities.ruleTags,
  };
  for (const receipt of receipts) {
    for (const [key, value] of Object.entries(receipt.resultRefs)) {
      const collection = resultCollections[key];
      if (collection !== undefined && collection[value] === undefined) {
        fail(`receipt ${receipt.commandId} 的${key}悬空`);
      }
    }
  }

  for (const entry of Object.values(snapshot.outbox)) {
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
      } else if (entry.noteCandidateId !== undefined || entry.noteDecisionId !== undefined) {
        const candidate =
          entry.noteCandidateId === undefined
            ? undefined
            : entities.noteCandidates[entry.noteCandidateId];
        const decision =
          entry.noteDecisionId === undefined
            ? undefined
            : entities.noteDecisions[entry.noteDecisionId];
        if (
          candidate === undefined ||
          decision === undefined ||
          candidate.productRunId !== entry.productRunId ||
          decision.productRunId !== entry.productRunId ||
          decision.noteCandidateId !== candidate.noteCandidateId
        ) {
          fail(`outbox ${entry.outboxId} Note workflow_resume绑定不完整`);
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
