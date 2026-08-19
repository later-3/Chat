import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_TOKEN_BUDGET,
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  type ProductSnapshot,
} from "@chat/contracts";
import { computePlanSha256, StoreCorruptedError } from "@chat/application";
import { validateWorkflowRunSpecIntegrity } from "@chat/application/workflow-run-spec-compiler";
import {
  createSystemMemoryPlanningDefinition,
  createSystemPlanningDefinition,
  createSystemSimplePlanningDefinition,
  createSystemNoteDefinition,
  createSystemDirectAgentDefinition,
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
  SYSTEM_NOTE_WORKFLOW_VIEW_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import {
  assertSingleOpenApproval,
  assertSingleOpenPromptReview,
  assertPromptReviewRequestIndexes,
  assertSinglePlanUnderReview,
  computeExecutionInputManifestSha256,
  computeContextPackageSha256,
  computeMemoryBackendDescriptorSha256,
  computeMemoryImportBackendDescriptorSha256,
  computeMemoryImportRequestSha256,
  computeMemoryImportSemanticDedupeSha256,
  computeMemoryQueryResultSha256,
  computeMemoryResultSnapshotSha256,
  computeRunContextRequestSha256,
  computeWorkspaceInstructionItemSha256,
  computeWorkspaceInstructionsSha256,
  estimateMemorySectionTokens,
  hashCanonical,
  resolveMemoryImportContent,
  validateExecutionCandidate,
  assertProjectWorkGraph,
  computeProjectCandidateSha256,
  computeProjectAdvancementCandidateSha256,
  computeProjectManagementCandidateSha256,
  computeProjectMethodSnapshotSha256,
  computeProjectObservationSha256,
  assertWorkflowNodeRunTimestamps,
  assertPersistedWorkflowNodeTransition,
  assertWorkflowViewDefinition,
  computeNodeValueManifestSha256,
  workflowNodeRunIdentityKey,
  assertNoteAggregateIntegrity,
  assertNoteCandidateIntegrity,
  assertNoteDecisionBinding,
  assertNoteRevisionIntegrity,
  assertPlanningProjectContextIntegrity,
  assertPlanningMemorySelectionIntegrity,
  computePlanningProjectSourceRefSha256,
  computeWorkflowProjectResourceSha256,
  computePlanningInputManifestSha256,
  assertRuleLifecycleTransition,
  assertRuleRevisionAppend,
  assertRuleRevisionIntegrity,
  selectRules,
  assertWorkflowPolicyResolutionIntegrity,
  evaluateNoteLowRiskAutoPolicy,
  NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID,
  NOTE_LOW_RISK_AUTO_POLICY_REVISION,
  NOTE_LOW_RISK_AUTO_POLICY_SHA256,
  assertWorkflowMemoryContextOrder,
  computeMemoryProviderDescriptorSha256,
  computeMemoryWriteRequestSha256,
  computeMemoryWriteSemanticDedupeSha256,
  computeWorkflowMemoryContextSha256,
  computeWorkflowMemoryMessageSha256,
  computeWorkflowMemoryQueryResultSha256,
  computeWorkflowMemorySnapshotSha256,
  resolveMemoryWriteContent,
  sha256Hex,
  computePromptReviewPayloadSha256,
  computePromptReviewSha256,
  computePromptReviewDecisionSha256,
  computeDirectAgentCandidateSha256,
  computeDirectAgentInputManifestSha256,
  assertPromptFragmentRevision,
} from "@chat/domain";

/**
 * 完整快照的关系与生命周期校验。
 *
 * Zod负责单对象形状；这里负责Map键、跨对象引用、Hash、状态组合及双向关系。
 * open与transact都调用同一入口，任何不一致都失败关闭，绝不猜测修复。
 * 只有本入口公开；内部按产品对象拆分，避免调用方误把“通过局部校验”当作完整快照有效。
 */
export function assertSnapshotIntegrity(snapshot: ProductSnapshot): void {
  const { entities } = snapshot;
  const fail = (detail: string): never => {
    throw new StoreCorruptedError(`快照完整性校验失败:${detail}`);
  };

  assertMapKeys(snapshot, fail);
  assertSessionsAndMessages(snapshot, fail);
  assertAttempts(snapshot, fail);
  assertRuns(snapshot, fail);
  assertWorkflowDefinitions(snapshot, fail);
  assertWorkflowProjection(snapshot, fail);
  assertPlansAndReviews(snapshot, fail);
  assertPromptReviews(snapshot, fail);
  assertLongTermContext(snapshot, fail);
  assertMemoryImports(snapshot, fail);
  assertProjects(snapshot, fail);
  assertPlanningProjectContexts(snapshot, fail);
  assertPlanningMemorySelections(snapshot, fail);
  assertWorkflowMemory(snapshot, fail);
  assertRules(snapshot, fail);
  assertPromptFragments(snapshot, fail);
  assertNotes(snapshot, fail);
  assertWorkflowPolicyResolutions(snapshot, fail);
  assertExecution(snapshot, fail);
  assertDirectAgentCandidates(snapshot, fail);
  assertReceiptsAndOutbox(snapshot, fail);

  for (const runId of Object.keys(entities.runs)) {
    try {
      assertSinglePlanUnderReview(
        Object.values(entities.plans).filter((plan) => plan.productRunId === runId),
      );
      assertSingleOpenApproval(
        Object.values(entities.approvalRequests).filter(
          (approval) => approval.productRunId === runId,
        ),
      );
      assertSingleOpenPromptReview(
        Object.values(entities.promptReviewRequests).filter(
          (request) => request.productRunId === runId,
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

type Fail = (detail: string) => never;

function assertMapKeys(snapshot: ProductSnapshot, fail: Fail): void {
  const collections = [
    ["session", snapshot.entities.sessions, "sessionId"],
    ["message", snapshot.entities.messages, "messageId"],
    ["run", snapshot.entities.runs, "productRunId"],
    ["attempt", snapshot.entities.attempts, "attemptId"],
    ["plan", snapshot.entities.plans, "planRevisionId"],
    ["revisionInput", snapshot.entities.revisionInputs, "revisionInputId"],
    ["approval", snapshot.entities.approvalRequests, "approvalRequestId"],
    ["decision", snapshot.entities.decisions, "decisionId"],
    ["contract", snapshot.entities.executionContracts, "executionContractId"],
    ["candidate", snapshot.entities.executionCandidates, "executionCandidateId"],
    ["validation", snapshot.entities.validationResults, "validationResultId"],
    ["artifact", snapshot.entities.artifacts, "artifactId"],
    ["directAgentCandidate", snapshot.entities.directAgentCandidates, "directAgentCandidateId"],
    ["promptReviewRequest", snapshot.entities.promptReviewRequests, "promptReviewRequestId"],
    ["promptReviewDecision", snapshot.entities.promptReviewDecisions, "promptReviewDecisionId"],
    ["contextRequest", snapshot.entities.contextRequests, "contextRequestId"],
    ["memoryQuery", snapshot.entities.memoryQueries, "memoryQueryId"],
    ["memorySnapshot", snapshot.entities.memoryResultSnapshots, "memoryResultSnapshotId"],
    ["memoryAdoption", snapshot.entities.memoryAdoptions, "memoryAdoptionId"],
    ["contextPackage", snapshot.entities.contextPackages, "contextPackageId"],
    ["memoryImportIntent", snapshot.entities.memoryImportIntents, "memoryImportIntentId"],
    ["memoryImportResult", snapshot.entities.memoryImportResults, "memoryImportResultId"],
    ["project", snapshot.entities.projects, "projectId"],
    ["projectMethod", snapshot.entities.projectMethodSnapshots, "projectMethodSnapshotId"],
    ["projectStage", snapshot.entities.projectStages, "projectStageId"],
    ["projectMilestone", snapshot.entities.projectMilestones, "projectMilestoneId"],
    ["projectUpdate", snapshot.entities.projectUpdates, "projectUpdateId"],
    [
      "projectStateTransition",
      snapshot.entities.projectStateTransitions,
      "projectStateTransitionId",
    ],
    ["projectResource", snapshot.entities.projectResources, "projectResourceId"],
    ["projectParticipant", snapshot.entities.projectParticipants, "projectParticipantId"],
    ["projectWork", snapshot.entities.projectWorks, "projectWorkId"],
    ["projectAction", snapshot.entities.projectActions, "projectActionId"],
    ["projectContribution", snapshot.entities.projectContributions, "projectContributionId"],
    ["projectEvidence", snapshot.entities.projectEvidence, "projectEvidenceId"],
    ["projectDecision", snapshot.entities.projectDecisions, "projectDecisionId"],
    ["projectObservation", snapshot.entities.projectObservations, "projectObservationId"],
    ["projectCandidate", snapshot.entities.projectCandidates, "projectCandidateId"],
    ["workflowDefinition", snapshot.entities.workflowDefinitions, "workflowDefinitionId"],
    [
      "workflowDefinitionRevision",
      snapshot.entities.workflowDefinitionRevisions,
      "workflowDefinitionRevisionId",
    ],
    ["workflowRunSpec", snapshot.entities.workflowRunSpecs, "workflowRunSpecId"],
    [
      "workflowViewDefinition",
      snapshot.entities.workflowViewDefinitions,
      "workflowViewDefinitionId",
    ],
    ["workflowNodeRun", snapshot.entities.workflowNodeRuns, "workflowNodeRunId"],
    ["nodeRunTransition", snapshot.entities.nodeRunTransitions, "nodeRunTransitionId"],
    ["nodeValueManifest", snapshot.entities.nodeValueManifests, "nodeValueManifestId"],
    ["note", snapshot.entities.notes, "noteId"],
    ["noteRevision", snapshot.entities.noteRevisions, "noteRevisionId"],
    ["noteCandidate", snapshot.entities.noteCandidates, "noteCandidateId"],
    ["noteDecision", snapshot.entities.noteDecisions, "noteDecisionId"],
    ["rule", snapshot.entities.rules, "ruleId"],
    ["ruleRevision", snapshot.entities.ruleRevisions, "ruleRevisionId"],
    ["ruleTag", snapshot.entities.ruleTags, "ruleTagId"],
    ["ruleDecision", snapshot.entities.ruleDecisions, "ruleDecisionId"],
    ["ruleSelection", snapshot.entities.ruleSelections, "ruleSelectionId"],
    ["promptFragment", snapshot.entities.promptFragments, "promptFragmentId"],
    [
      "promptFragmentRevision",
      snapshot.entities.promptFragmentRevisions,
      "promptFragmentRevisionId",
    ],
    [
      "planningProjectContext",
      snapshot.entities.planningProjectContexts,
      "planningProjectContextId",
    ],
    [
      "planningMemorySelection",
      snapshot.entities.planningMemorySelections,
      "planningMemorySelectionId",
    ],
    [
      "workflowPolicyResolution",
      snapshot.entities.workflowPolicyResolutions,
      "workflowPolicyResolutionId",
    ],
    ["workflowMemoryQuery", snapshot.entities.workflowMemoryQueries, "workflowMemoryQueryId"],
    [
      "workflowMemorySnapshot",
      snapshot.entities.workflowMemorySnapshots,
      "workflowMemorySnapshotId",
    ],
    ["workflowMemoryContext", snapshot.entities.workflowMemoryContexts, "workflowMemoryContextId"],
    ["memoryWriteIntent", snapshot.entities.memoryWriteIntents, "memoryWriteIntentId"],
    ["memoryWriteResult", snapshot.entities.memoryWriteResults, "memoryWriteResultId"],
    ["receipt", snapshot.commandReceipts, "commandId"],
    ["outbox", snapshot.outbox, "outboxId"],
  ] as const;
  for (const [label, collection, idField] of collections) {
    for (const [key, entity] of Object.entries(collection)) {
      if ((entity as unknown as Record<string, string>)[idField] !== key) {
        fail(`${label} Map键${key}与${idField}不一致`);
      }
    }
  }
}

function assertWorkflowDefinitions(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const revisionNumbersByDefinition = new Map<string, Set<number>>();
  for (const revision of Object.values(entities.workflowDefinitionRevisions)) {
    const definition = entities.workflowDefinitions[revision.workflowDefinitionId];
    if (definition === undefined) {
      fail(`workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} 悬空Definition`);
    }
    if (
      definition.blueprintKey !== revision.blueprintKey ||
      definition.blueprintVersion !== revision.blueprintVersion
    ) {
      fail(`workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} Blueprint不一致`);
    }
    const numbers = revisionNumbersByDefinition.get(revision.workflowDefinitionId) ?? new Set();
    if (numbers.has(revision.definitionRevision)) {
      fail(`workflowDefinition ${revision.workflowDefinitionId} Revision号重复`);
    }
    numbers.add(revision.definitionRevision);
    revisionNumbersByDefinition.set(revision.workflowDefinitionId, numbers);
    if (
      hashCanonical("workflow-definition.v1", revision.semanticRoot) !== revision.definitionSha256
    ) {
      fail(`workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} Hash不一致`);
    }
    if (revision.state === "published" && revision.publishedAt === undefined) {
      fail(`workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} 缺少publishedAt`);
    }
    if (revision.state === "superseded" && revision.supersededAt === undefined) {
      fail(`workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} 缺少supersededAt`);
    }
    if (revision.basedOnRevisionId !== undefined) {
      const base = entities.workflowDefinitionRevisions[revision.basedOnRevisionId];
      if (
        base === undefined ||
        base.workflowDefinitionRevisionId === revision.workflowDefinitionRevisionId
      ) {
        fail(
          `workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} Base Revision悬空`,
        );
      }
      if (
        revision.definitionRevision === 1 &&
        (base.publishedAt === undefined || !["published", "superseded"].includes(base.state))
      ) {
        fail(
          `workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} Copy Base未曾发布`,
        );
      }
      if (
        revision.definitionRevision > 1 &&
        (base.workflowDefinitionId !== revision.workflowDefinitionId ||
          base.definitionRevision !== revision.definitionRevision - 1)
      ) {
        fail(`workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} Save Base不连续`);
      }
    }
  }
  for (const definition of Object.values(entities.workflowDefinitions)) {
    const published =
      definition.publishedRevisionId === undefined
        ? undefined
        : entities.workflowDefinitionRevisions[definition.publishedRevisionId];
    if (definition.publishedRevisionId !== undefined && published === undefined) {
      fail(`workflowDefinition ${definition.workflowDefinitionId} Published Revision悬空`);
    }
    if (
      published !== undefined &&
      (published.workflowDefinitionId !== definition.workflowDefinitionId ||
        published.state !== "published")
    ) {
      fail(`workflowDefinition ${definition.workflowDefinitionId} Published Revision绑定不一致`);
    }
    const draft =
      definition.currentDraftRevisionId === undefined
        ? undefined
        : entities.workflowDefinitionRevisions[definition.currentDraftRevisionId];
    if (definition.currentDraftRevisionId !== undefined && draft === undefined) {
      fail(`workflowDefinition ${definition.workflowDefinitionId} Current Draft悬空`);
    }
    if (
      draft !== undefined &&
      (draft.workflowDefinitionId !== definition.workflowDefinitionId || draft.state !== "draft")
    ) {
      fail(`workflowDefinition ${definition.workflowDefinitionId} Current Draft绑定不一致`);
    }
    const unboundDraft = Object.values(entities.workflowDefinitionRevisions).find(
      (revision) =>
        revision.workflowDefinitionId === definition.workflowDefinitionId &&
        revision.state === "draft" &&
        revision.workflowDefinitionRevisionId !== definition.currentDraftRevisionId,
    );
    if (unboundDraft !== undefined) {
      fail(`workflowDefinition ${definition.workflowDefinitionId} 存在未绑定的活动Draft`);
    }
  }
  for (const runSpec of Object.values(entities.workflowRunSpecs)) {
    const validation = validateWorkflowRunSpecIntegrity(runSpec);
    if (!validation.success) {
      fail(`workflowRunSpec ${runSpec.workflowRunSpecId} Hash不一致`);
    }
    const run = entities.runs[runSpec.productRunId];
    const revision =
      entities.workflowDefinitionRevisions[runSpec.definitionRef.workflowDefinitionRevisionId];
    if (run === undefined || run.workflowRunSpecId !== runSpec.workflowRunSpecId) {
      fail(`workflowRunSpec ${runSpec.workflowRunSpecId} Run反向绑定不一致`);
    }
    if (
      revision === undefined ||
      revision.definitionRevision !== runSpec.definitionRef.definitionRevision ||
      revision.definitionSha256 !== runSpec.definitionRef.definitionSha256 ||
      revision.blueprintKey !== runSpec.definitionRef.blueprintKey ||
      revision.blueprintVersion !== runSpec.definitionRef.blueprintVersion ||
      hashCanonical("workflow-definition.v1", runSpec.semanticRoot) !== revision.definitionSha256 ||
      !["published", "superseded"].includes(revision.state) ||
      revision.publishedAt === undefined
    ) {
      fail(`workflowRunSpec ${runSpec.workflowRunSpecId} Definition Revision绑定不一致`);
    }
    if (
      run !== undefined &&
      (run.runnerFamily !== runSpec.runner.runnerFamily ||
        run.runnerBundleVersion !== runSpec.runner.runnerBundleVersion)
    ) {
      fail(`workflowRunSpec ${runSpec.workflowRunSpecId} Runner证据与Run不一致`);
    }
    const view =
      run === undefined
        ? undefined
        : entities.workflowViewDefinitions[run.workflowViewDefinitionId];
    if (
      view === undefined ||
      view.source.kind !== "published_definition" ||
      view.source.workflowDefinitionId !== revision?.workflowDefinitionId ||
      view.source.definitionRevision !== runSpec.definitionRef.definitionRevision ||
      view.source.definitionSha256 !== runSpec.definitionRef.definitionSha256 ||
      view.source.blueprintKey !== runSpec.definitionRef.blueprintKey ||
      view.source.blueprintVersion !== String(runSpec.definitionRef.blueprintVersion)
    ) {
      fail(`workflowRunSpec ${runSpec.workflowRunSpecId} View快照绑定不一致`);
    }
  }

  for (const view of Object.values(entities.workflowViewDefinitions)) {
    if (view.source.kind !== "published_definition") continue;
    const source = view.source;
    const matchingRevision = Object.values(entities.workflowDefinitionRevisions).find(
      (revision) =>
        revision.workflowDefinitionId === source.workflowDefinitionId &&
        revision.definitionRevision === source.definitionRevision &&
        revision.definitionSha256 === source.definitionSha256,
    );
    if (
      matchingRevision === undefined ||
      !["published", "superseded"].includes(matchingRevision.state) ||
      matchingRevision.publishedAt === undefined ||
      matchingRevision.blueprintKey !== source.blueprintKey ||
      String(matchingRevision.blueprintVersion) !== source.blueprintVersion
    ) {
      fail(`workflowViewDefinition ${view.workflowViewDefinitionId} Published来源绑定不一致`);
    }
  }

  assertPinnedSystemDefinition(snapshot, fail, {
    label: "planning",
    workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    workflowDefinitionRevisionId: SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    workflowViewDefinitionId: SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
    create: createSystemPlanningDefinition,
  });
  assertPinnedSystemDefinition(snapshot, fail, {
    label: "memory planning",
    workflowDefinitionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
    workflowDefinitionRevisionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
    workflowViewDefinitionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
    create: createSystemMemoryPlanningDefinition,
  });
  assertPinnedSystemDefinition(snapshot, fail, {
    label: "simple planning",
    workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
    workflowDefinitionRevisionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    workflowViewDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
    create: createSystemSimplePlanningDefinition,
  });
  assertPinnedSystemDefinition(snapshot, fail, {
    label: "note",
    workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
    workflowDefinitionRevisionId: SYSTEM_NOTE_WORKFLOW_REVISION_ID,
    workflowViewDefinitionId: SYSTEM_NOTE_WORKFLOW_VIEW_ID,
    create: createSystemNoteDefinition,
  });
  assertPinnedSystemDefinition(snapshot, fail, {
    label: "direct agent",
    workflowDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
    workflowDefinitionRevisionId: SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    workflowViewDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
    create: createSystemDirectAgentDefinition,
  });
}

/** 内置Definition是部署的一部分；固定ID不能被同时改正文和Hash后伪装成合法系统流程。 */
function assertPinnedSystemDefinition(
  snapshot: ProductSnapshot,
  fail: Fail,
  input: {
    readonly label: string;
    readonly workflowDefinitionId: string;
    readonly workflowDefinitionRevisionId: string;
    readonly workflowViewDefinitionId: string;
    readonly create: typeof createSystemPlanningDefinition;
  },
): void {
  const definition = snapshot.entities.workflowDefinitions[input.workflowDefinitionId];
  const revision =
    snapshot.entities.workflowDefinitionRevisions[input.workflowDefinitionRevisionId];
  const view = snapshot.entities.workflowViewDefinitions[input.workflowViewDefinitionId];
  if (definition === undefined || revision === undefined || view === undefined) {
    fail(`system ${input.label} Definition种子不完整`);
  }
  const expected = input.create(revision.createdAt);
  if (
    definition.ownerKind !== expected.definition.ownerKind ||
    definition.key !== expected.definition.key ||
    definition.title !== expected.definition.title ||
    definition.description !== expected.definition.description ||
    definition.blueprintKey !== expected.definition.blueprintKey ||
    definition.blueprintVersion !== expected.definition.blueprintVersion ||
    definition.status !== "active" ||
    definition.publishedRevisionId !== input.workflowDefinitionRevisionId ||
    revision.workflowDefinitionId !== input.workflowDefinitionId ||
    revision.definitionRevision !== expected.revision.definitionRevision ||
    revision.state !== "published" ||
    revision.title !== expected.revision.title ||
    revision.definitionSha256 !== expected.revision.definitionSha256 ||
    view.sha256 !== expected.view.sha256
  ) {
    fail(`system ${input.label} Definition与部署种子不一致`);
  }
}

function assertWorkflowProjection(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const view of Object.values(entities.workflowViewDefinitions)) {
    try {
      assertWorkflowViewDefinition(view);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const identityKeys = new Set<string>();
  const transitionsByNode = new Map<string, (typeof entities.nodeRunTransitions)[string][]>();
  for (const transition of Object.values(entities.nodeRunTransitions)) {
    if (entities.workflowNodeRuns[transition.workflowNodeRunId] === undefined) {
      fail(`nodeRunTransition ${transition.nodeRunTransitionId} 悬空Node Run`);
    }
    const values = transitionsByNode.get(transition.workflowNodeRunId) ?? [];
    values.push(transition);
    transitionsByNode.set(transition.workflowNodeRunId, values);
    if (transition.relatedProductRef !== undefined) {
      assertNodeProductRef(snapshot, transition.relatedProductRef, fail);
    }
  }

  for (const nodeRun of Object.values(entities.workflowNodeRuns)) {
    const run = entities.runs[nodeRun.productRunId];
    const view = entities.workflowViewDefinitions[nodeRun.workflowViewDefinitionId];
    if (
      run === undefined ||
      view === undefined ||
      run.workflowViewDefinitionId !== nodeRun.workflowViewDefinitionId
    ) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} Run/View绑定不一致`);
    }
    const viewNode = view.nodes.find((node) => node.definitionNodeId === nodeRun.definitionNodeId);
    const dynamicParent =
      nodeRun.nodeType === "execute.plan_step" && nodeRun.parentNodeRunId !== undefined
        ? entities.workflowNodeRuns[nodeRun.parentNodeRunId]
        : undefined;
    const dynamicExecutionChild = dynamicParent !== undefined;
    if (
      (!dynamicExecutionChild &&
        (viewNode === undefined ||
          viewNode.nodeType !== nodeRun.nodeType ||
          viewNode.nodeSchemaVersion !== nodeRun.nodeSchemaVersion)) ||
      (dynamicExecutionChild && dynamicParent.productRunId !== nodeRun.productRunId)
    ) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} Definition节点绑定不一致`);
    }
    if (
      nodeRun.parentNodeRunId !== undefined &&
      (nodeRun.parentNodeRunId === nodeRun.workflowNodeRunId ||
        entities.workflowNodeRuns[nodeRun.parentNodeRunId]?.productRunId !== nodeRun.productRunId)
    ) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} Parent绑定不一致`);
    }
    const identityKey = workflowNodeRunIdentityKey(nodeRun);
    if (identityKeys.has(identityKey)) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} 稳定身份重复`);
    }
    identityKeys.add(identityKey);
    try {
      assertWorkflowNodeRunTimestamps(nodeRun);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }

    const transitions = transitionsByNode.get(nodeRun.workflowNodeRunId) ?? [];
    transitions.sort((left, right) => left.nodeSequence - right.nodeSequence);
    if (transitions.length === 0) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} 缺少Transition`);
    }
    for (let index = 0; index < transitions.length; index += 1) {
      const transition = transitions[index];
      const previous = transitions[index - 1];
      if (
        transition === undefined ||
        transition.nodeSequence !== index + 1 ||
        (index === 0 && transition.fromStatus !== undefined) ||
        (index > 0 && transition.fromStatus !== previous?.toStatus) ||
        transition.projectionSource !== nodeRun.projectionSource
      ) {
        fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} Transition链不连续`);
      }
      try {
        assertPersistedWorkflowNodeTransition({
          nodeType: nodeRun.nodeType,
          projectionSource: transition.projectionSource,
          ...(transition.fromStatus !== undefined ? { fromStatus: transition.fromStatus } : {}),
          toStatus: transition.toStatus,
          reasonKind: transition.reasonKind,
          ...(transition.relatedProductRef !== undefined
            ? { relatedProductRef: transition.relatedProductRef }
            : {}),
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    if (transitions.at(-1)?.toStatus !== nodeRun.status) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} 最新Transition与状态不一致`);
    }
    if (
      (nodeRun.inputManifestId !== undefined &&
        entities.nodeValueManifests[nodeRun.inputManifestId]?.workflowNodeRunId !==
          nodeRun.workflowNodeRunId) ||
      (nodeRun.outputManifestId !== undefined &&
        entities.nodeValueManifests[nodeRun.outputManifestId]?.workflowNodeRunId !==
          nodeRun.workflowNodeRunId)
    ) {
      fail(`workflowNodeRun ${nodeRun.workflowNodeRunId} Manifest引用悬空或Owner不一致`);
    }
  }

  for (const manifest of Object.values(entities.nodeValueManifests)) {
    const nodeRun = entities.workflowNodeRuns[manifest.workflowNodeRunId];
    if (
      nodeRun === undefined ||
      (manifest.direction === "input"
        ? nodeRun.inputManifestId !== manifest.nodeValueManifestId
        : nodeRun.outputManifestId !== manifest.nodeValueManifestId)
    ) {
      fail(`nodeValueManifest ${manifest.nodeValueManifestId} Owner绑定不一致`);
    }
    if (computeNodeValueManifestSha256(manifest) !== manifest.sha256) {
      fail(`nodeValueManifest ${manifest.nodeValueManifestId} Hash不一致`);
    }
    const slotNames = new Set<string>();
    for (const slot of manifest.slots) {
      if (slotNames.has(slot.name)) {
        fail(`nodeValueManifest ${manifest.nodeValueManifestId} Slot重名`);
      }
      slotNames.add(slot.name);
      for (const ref of slot.refs) assertNodeProductRef(snapshot, ref, fail);
    }
  }
}

function assertNodeProductRef(
  snapshot: ProductSnapshot,
  ref: ProductSnapshot["entities"]["nodeValueManifests"][string]["slots"][number]["refs"][number],
  fail: Fail,
): void {
  const { entities } = snapshot;
  let expected: { readonly revision: number; readonly sha256: string } | undefined;
  if (ref.kind === "message") {
    const target = entities.messages[ref.id];
    if (target !== undefined) {
      expected = {
        revision: target.revision,
        sha256: hashCanonical("message.v1", {
          messageId: target.messageId,
          sessionId: target.sessionId,
          sessionSequence: target.sessionSequence,
          role: target.role,
          content: target.content,
        }),
      };
    }
  } else if (ref.kind === "context_package") {
    const target = entities.contextPackages[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "memory_result_snapshot") {
    const target = entities.memoryResultSnapshots[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "planning_memory_selection") {
    const target = entities.planningMemorySelections[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "workflow_memory_snapshot") {
    const target = entities.workflowMemorySnapshots[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "workflow_memory_context") {
    const target = entities.workflowMemoryContexts[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "memory_write_result") {
    const target = entities.memoryWriteResults[ref.id];
    if (target !== undefined) {
      expected = {
        revision: target.revision,
        sha256: hashCanonical("memory-write-result.v1", target),
      };
    }
  } else if (ref.kind === "project") {
    const target = entities.projects[ref.id];
    if (target !== undefined) {
      if (target.revision === ref.revision) {
        expected = {
          revision: target.revision,
          sha256: computeWorkflowProjectResourceSha256(target),
        };
      } else if (
        ref.revision < target.revision &&
        Object.values(entities.planningProjectContexts).some((context) =>
          context.sourceRefs.some(
            (source) =>
              source.kind === "project" &&
              source.objectId === ref.id &&
              source.revision === ref.revision &&
              source.sha256 === ref.sha256,
          ),
        )
      ) {
        // Project当前无历史表；旧revision由不可变PlanningProjectContext继续自证。
        return;
      }
    }
  } else if (ref.kind === "planning_project_context") {
    const target = entities.planningProjectContexts[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "rule_revision") {
    const target = entities.ruleRevisions[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "rule_selection") {
    const target = entities.ruleSelections[ref.id];
    if (target !== undefined) expected = { revision: 1, sha256: target.sha256 };
  } else if (ref.kind === "plan_revision") {
    const target = entities.plans[ref.id];
    if (target !== undefined) {
      expected = { revision: target.planRevision, sha256: target.sha256 };
    }
  } else if (ref.kind === "approval_request") {
    const target = entities.approvalRequests[ref.id];
    if (target !== undefined) {
      expected = {
        revision: 1,
        sha256: hashCanonical("approval-request.v1", {
          productRunId: target.productRunId,
          planId: target.planId,
          planRevision: target.planRevision,
          planSha256: target.planSha256,
          expiresAt: target.expiresAt,
        }),
      };
    }
  } else if (ref.kind === "decision") {
    const target = entities.decisions[ref.id];
    if (target !== undefined) {
      expected = {
        revision: target.revision,
        sha256: hashCanonical("decision.v1", {
          approvalRequestId: target.approvalRequestId,
          productRunId: target.productRunId,
          planId: target.planId,
          planRevision: target.planRevision,
          planSha256: target.planSha256,
          kind: target.kind,
          principalId: target.principalId,
          commandId: target.commandId,
        }),
      };
    }
  } else if (ref.kind === "prompt_review_request") {
    const target = entities.promptReviewRequests[ref.id];
    if (target !== undefined) {
      expected = { revision: target.requestRevision, sha256: target.reviewSha256 };
    }
  } else if (ref.kind === "prompt_review_decision") {
    const target = entities.promptReviewDecisions[ref.id];
    if (target !== undefined) {
      expected = {
        revision: target.revision,
        sha256: computePromptReviewDecisionSha256({
          promptReviewDecisionId: target.promptReviewDecisionId,
          promptReviewRequestId: target.promptReviewRequestId,
          productRunId: target.productRunId,
          requestRevision: target.requestRevision,
          reviewSha256: target.reviewSha256,
          payloadSha256: target.payloadSha256,
          kind: target.kind,
          ...(target.reason !== undefined ? { reason: target.reason } : {}),
          principalId: target.principalId,
          commandId: target.commandId,
        }),
      };
    }
  } else if (ref.kind === "note_candidate") {
    const target = entities.noteCandidates[ref.id];
    if (
      target !== undefined &&
      ref.sha256 === target.sha256 &&
      ref.revision > 0 &&
      ref.revision <= target.revision
    ) {
      return;
    }
  } else if (ref.kind === "note_decision") {
    const target = entities.noteDecisions[ref.id];
    if (target !== undefined) {
      expected = {
        revision: target.revision,
        sha256: hashCanonical("note-decision.v1", {
          productRunId: target.productRunId,
          noteCandidateId: target.noteCandidateId,
          candidateRevision: target.candidateRevision,
          candidateSha256: target.candidateSha256,
          kind: target.kind,
          ...(target.kind === "request_revision"
            ? { revisionInstruction: target.revisionInstruction }
            : {}),
          ...(target.kind === "reject" && target.reason !== undefined
            ? { reason: target.reason }
            : {}),
          principalId: target.principalId,
          commandId: target.commandId,
        }),
      };
    }
  } else if (ref.kind === "note_revision") {
    const target = entities.noteRevisions[ref.id];
    if (target !== undefined) {
      expected = { revision: target.noteRevision, sha256: target.sha256 };
    }
  } else if (ref.kind === "workflow_policy_resolution") {
    const target = entities.workflowPolicyResolutions[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "execution_contract") {
    const target = entities.executionContracts[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "execution_candidate") {
    const target = entities.executionCandidates[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "direct_agent_candidate") {
    const target = entities.directAgentCandidates[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  } else if (ref.kind === "validation_result") {
    const target = entities.validationResults[ref.id];
    if (target !== undefined) {
      expected = {
        revision: target.revision,
        sha256: hashCanonical("validation-result.v1", {
          productRunId: target.productRunId,
          executionContractId: target.executionContractId,
          executionCandidateId: target.executionCandidateId,
          outcome: target.outcome,
          failures: target.failures,
        }),
      };
    }
  } else {
    const target = entities.artifacts[ref.id];
    if (target !== undefined) expected = { revision: target.revision, sha256: target.sha256 };
  }
  if (
    expected === undefined ||
    expected.revision !== ref.revision ||
    expected.sha256 !== ref.sha256
  ) {
    fail(`Node Product Ref ${ref.kind}:${ref.id} 悬空或版本证据不一致`);
  }
}

function assertProjects(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const project of Object.values(entities.projects)) {
    const method = entities.projectMethodSnapshots[project.methodSnapshotId];
    const stage = entities.projectStages[project.currentStageId];
    if (method?.projectId !== project.projectId || stage?.projectId !== project.projectId) {
      fail(`project ${project.projectId} Method/Stage绑定不一致`);
    }
  }
  for (const method of Object.values(entities.projectMethodSnapshots)) {
    if (entities.projects[method.projectId] === undefined)
      fail(`projectMethod ${method.projectMethodSnapshotId} 悬空Project`);
    if (
      computeProjectMethodSnapshotSha256({
        profileId: method.profileId,
        rationale: method.rationale,
        policies: method.policies,
        source: method.source,
      }) !== method.sha256
    ) {
      fail(`projectMethod ${method.projectMethodSnapshotId} Hash不一致`);
    }
  }
  for (const stage of Object.values(entities.projectStages)) {
    if (
      entities.projects[stage.projectId] === undefined ||
      entities.projectMethodSnapshots[stage.methodSnapshotId]?.projectId !== stage.projectId
    )
      fail(`projectStage ${stage.projectStageId} 悬空Project`);
    const terminal = stage.status === "completed" || stage.status === "skipped";
    const migratedLegacyStage =
      entities.projectMethodSnapshots[stage.methodSnapshotId]?.source === "migrated_v1";
    if (
      terminal !== (stage.completedAt !== undefined) ||
      (!migratedLegacyStage && terminal !== (stage.completionDecisionId !== undefined))
    ) {
      fail(`projectStage ${stage.projectStageId} 终态证据字段不一致`);
    }
    if (
      stage.completionDecisionId !== undefined &&
      entities.projectDecisions[stage.completionDecisionId]?.projectId !== stage.projectId
    ) {
      fail(`projectStage ${stage.projectStageId} Completion Decision绑定不一致`);
    }
    if (
      stage.completionEvidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== stage.projectId,
      )
    ) {
      fail(`projectStage ${stage.projectStageId} Completion Evidence绑定不一致`);
    }
  }
  const activeStageCounts = new Map<string, number>();
  for (const stage of Object.values(entities.projectStages)) {
    if (stage.status === "active") {
      activeStageCounts.set(stage.projectId, (activeStageCounts.get(stage.projectId) ?? 0) + 1);
    }
  }
  for (const [projectId, count] of activeStageCounts) {
    if (count > 1) fail(`project ${projectId} 存在多个active Stage`);
  }
  for (const milestone of Object.values(entities.projectMilestones)) {
    if (entities.projects[milestone.projectId] === undefined) {
      fail(`projectMilestone ${milestone.projectMilestoneId} 悬空Project`);
    }
    if (
      milestone.stageId !== undefined &&
      entities.projectStages[milestone.stageId]?.projectId !== milestone.projectId
    ) {
      fail(`projectMilestone ${milestone.projectMilestoneId} Stage绑定不一致`);
    }
    if (
      milestone.evidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== milestone.projectId,
      )
    ) {
      fail(`projectMilestone ${milestone.projectMilestoneId} Evidence绑定不一致`);
    }
    if (
      (milestone.status === "achieved") !== (milestone.achievedDecisionId !== undefined) ||
      (milestone.status === "achieved" && milestone.evidenceIds.length === 0) ||
      (milestone.achievedDecisionId !== undefined &&
        entities.projectDecisions[milestone.achievedDecisionId]?.projectId !== milestone.projectId)
    ) {
      fail(`projectMilestone ${milestone.projectMilestoneId} Achieved Decision不一致`);
    }
  }
  for (const update of Object.values(entities.projectUpdates)) {
    const project = entities.projects[update.projectId];
    const participant = entities.projectParticipants[update.authorParticipantId];
    const stage = entities.projectStages[update.stageId];
    const superseded =
      update.supersedesUpdateId === undefined
        ? undefined
        : entities.projectUpdates[update.supersedesUpdateId];
    if (
      project === undefined ||
      participant?.projectId !== update.projectId ||
      participant.principalId !== update.confirmedByPrincipalId ||
      participant.kind !== "human" ||
      participant.status !== "active" ||
      stage?.projectId !== update.projectId ||
      update.boundProjectRevision > project.revision ||
      update.boundStageRevision > stage.revision ||
      (update.supersedesUpdateId !== undefined && superseded === undefined) ||
      (superseded !== undefined &&
        (superseded.projectId !== update.projectId || superseded.publishedAt >= update.publishedAt))
    ) {
      fail(`projectUpdate ${update.projectUpdateId} 作者或Project绑定不一致`);
    }
    if (
      update.evidenceIds.some((id) => entities.projectEvidence[id]?.projectId !== update.projectId)
    ) {
      fail(`projectUpdate ${update.projectUpdateId} Evidence绑定不一致`);
    }
  }
  const transitionsByObject = new Map<
    string,
    (typeof entities.projectStateTransitions)[string][]
  >();
  for (const transition of Object.values(entities.projectStateTransitions)) {
    const object =
      transition.objectType === "stage"
        ? entities.projectStages[transition.objectId]
        : transition.objectType === "milestone"
          ? entities.projectMilestones[transition.objectId]
          : entities.projects[transition.objectId];
    if (
      entities.projects[transition.projectId] === undefined ||
      entities.projectParticipants[transition.actorParticipantId]?.projectId !==
        transition.projectId ||
      entities.projectDecisions[transition.decisionId]?.projectId !== transition.projectId ||
      object?.projectId !== transition.projectId ||
      object.revision < transition.afterRevision ||
      transition.afterRevision !== transition.beforeRevision + 1 ||
      transition.from === transition.to ||
      transition.evidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== transition.projectId,
      )
    ) {
      fail(`projectStateTransition ${transition.projectStateTransitionId} 绑定或revision无效`);
    }
    const key = `${transition.objectType}:${transition.objectId}`;
    const sequence = transitionsByObject.get(key) ?? [];
    sequence.push(transition);
    transitionsByObject.set(key, sequence);
  }
  for (const [key, transitions] of transitionsByObject) {
    transitions.sort((left, right) => left.beforeRevision - right.beforeRevision);
    for (let index = 1; index < transitions.length; index += 1) {
      const previous = transitions[index - 1];
      const current = transitions[index];
      if (
        previous === undefined ||
        current === undefined ||
        current.beforeRevision < previous.afterRevision ||
        current.from !== previous.to
      ) {
        fail(`projectStateTransition ${key} 历史链不连续`);
      }
    }
    const latest = transitions.at(-1);
    const currentObject =
      latest?.objectType === "stage"
        ? entities.projectStages[latest.objectId]
        : latest?.objectType === "milestone"
          ? entities.projectMilestones[latest.objectId]
          : latest === undefined
            ? undefined
            : entities.projects[latest.objectId];
    if (latest === undefined || currentObject?.status !== latest.to) {
      fail(`projectStateTransition ${key} 最新状态与对象不一致`);
    }
  }
  for (const resource of Object.values(entities.projectResources)) {
    if (entities.projects[resource.projectId] === undefined)
      fail(`projectResource ${resource.projectResourceId} 悬空Project`);
  }
  for (const participant of Object.values(entities.projectParticipants)) {
    const project = entities.projects[participant.projectId];
    if (project === undefined)
      fail(`projectParticipant ${participant.projectParticipantId} 悬空Project`);
    if (participant.principalId !== undefined && participant.kind !== "human") {
      fail(`projectParticipant ${participant.projectParticipantId} 非human不允许principalId`);
    }
  }
  try {
    const worksByProject = new Map<string, (typeof entities.projectWorks)[string][]>();
    for (const work of Object.values(entities.projectWorks)) {
      const group = worksByProject.get(work.projectId) ?? [];
      group.push(work);
      worksByProject.set(work.projectId, group);
    }
    for (const works of worksByProject.values()) assertProjectWorkGraph(works);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const work of Object.values(entities.projectWorks)) {
    const stage = entities.projectStages[work.stageId];
    const owner = entities.projectParticipants[work.ownerParticipantId];
    if (stage?.projectId !== work.projectId || owner?.projectId !== work.projectId) {
      fail(`projectWork ${work.projectWorkId} Stage/Owner绑定不一致`);
    }
  }
  for (const action of Object.values(entities.projectActions)) {
    const work = entities.projectWorks[action.workId];
    const owner = entities.projectParticipants[action.ownerParticipantId];
    if (work?.projectId !== action.projectId || owner?.projectId !== action.projectId) {
      fail(`projectAction ${action.projectActionId} Work/Owner绑定不一致`);
    }
    if ((action.status === "blocked") !== (action.blockedReason !== undefined)) {
      fail(`projectAction ${action.projectActionId} blockedReason不一致`);
    }
    for (const evidenceId of action.completedEvidenceIds) {
      if (entities.projectEvidence[evidenceId]?.projectId !== action.projectId) {
        fail(`projectAction ${action.projectActionId} Evidence绑定不一致`);
      }
    }
  }
  for (const evidence of Object.values(entities.projectEvidence)) {
    if (entities.projects[evidence.projectId] === undefined)
      fail(`projectEvidence ${evidence.projectEvidenceId} 悬空Project`);
    if (
      evidence.resourceId !== undefined &&
      entities.projectResources[evidence.resourceId]?.projectId !== evidence.projectId
    ) {
      fail(`projectEvidence ${evidence.projectEvidenceId} Resource绑定不一致`);
    }
  }
  for (const observation of Object.values(entities.projectObservations)) {
    if (entities.projectResources[observation.resourceId]?.projectId !== observation.projectId) {
      fail(`projectObservation ${observation.projectObservationId} Resource绑定不一致`);
    }
    if (computeProjectObservationSha256(observation.data) !== observation.sha256) {
      fail(`projectObservation ${observation.projectObservationId} Hash不一致`);
    }
    if (observation.previousObservationId !== undefined) {
      const previous = entities.projectObservations[observation.previousObservationId];
      if (
        previous?.resourceId !== observation.resourceId ||
        previous.observedAt >= observation.observedAt
      ) {
        fail(`projectObservation ${observation.projectObservationId} 前序Observation无效`);
      }
    }
  }
  for (const contribution of Object.values(entities.projectContributions)) {
    if (
      entities.projectParticipants[contribution.participantId]?.projectId !== contribution.projectId
    ) {
      fail(`projectContribution ${contribution.projectContributionId} Participant绑定不一致`);
    }
    if (contribution.evidenceStatus === "verified" && contribution.evidenceIds.length === 0) {
      fail(`projectContribution ${contribution.projectContributionId} verified缺少Evidence`);
    }
    if (
      contribution.evidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== contribution.projectId,
      )
    ) {
      fail(`projectContribution ${contribution.projectContributionId} Evidence绑定不一致`);
    }
  }
  for (const decision of Object.values(entities.projectDecisions)) {
    const project = entities.projects[decision.projectId];
    if (
      project === undefined ||
      entities.projectParticipants[decision.decidedByParticipantId]?.projectId !==
        decision.projectId
    ) {
      fail(`projectDecision ${decision.projectDecisionId} Project/Participant绑定不一致`);
    }
    if (decision.boundProjectRevision > project.revision)
      fail(`projectDecision ${decision.projectDecisionId} 绑定未来revision`);
  }
  for (const candidate of Object.values(entities.projectCandidates)) {
    const session = entities.sessions[candidate.sessionId];
    const message = entities.messages[candidate.sourceMessageId];
    if (
      session?.ownerPrincipalId !== candidate.requestedByPrincipalId ||
      message?.sessionId !== candidate.sessionId ||
      message.role !== "user"
    ) {
      fail(`projectCandidate ${candidate.projectCandidateId} Session/Message绑定不一致`);
    }
    if (
      candidate.candidateKind === "intake" &&
      (candidate.status === "under_review" || candidate.status === "confirmed")
    ) {
      if (
        computeProjectObservationSha256(candidate.observationData) !== candidate.observationSha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} Observation Hash不一致`);
      }
      if (
        computeProjectCandidateSha256({
          proposal: candidate.proposal,
          observationSha256: candidate.observationSha256,
          sourceMessageId: candidate.sourceMessageId,
          rootId: candidate.rootId,
          enabledAdapters: candidate.enabledAdapters,
        }) !== candidate.candidateSha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} Candidate Hash不一致`);
      }
    }
    if (
      candidate.candidateKind === "intake" &&
      candidate.status === "confirmed" &&
      entities.projects[candidate.confirmedProjectId] === undefined
    ) {
      fail(`projectCandidate ${candidate.projectCandidateId} 悬空confirmedProjectId`);
    }
    if (candidate.candidateKind === "management") {
      const project = entities.projects[candidate.projectId];
      if (
        project?.ownerPrincipalId !== candidate.requestedByPrincipalId ||
        candidate.boundProjectRevision > project.revision ||
        computeProjectManagementCandidateSha256({
          projectId: candidate.projectId,
          boundProjectRevision: candidate.boundProjectRevision,
          sourceMessageId: candidate.sourceMessageId,
          proposal: candidate.proposal,
        }) !== candidate.candidateSha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} 管理Candidate绑定或Hash不一致`);
      }
      if (candidate.proposal.kind === "action") {
        if (
          entities.projectWorks[candidate.proposal.workId]?.projectId !== candidate.projectId ||
          entities.projectParticipants[candidate.proposal.ownerParticipantId]?.projectId !==
            candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Action引用不一致`);
        }
        if (
          candidate.status === "confirmed" &&
          entities.projectActions[candidate.committedObjectId]?.projectId !== candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Action缺失`);
        }
      } else if (candidate.proposal.kind === "decision") {
        if (
          entities.projectParticipants[candidate.proposal.decidedByParticipantId]?.projectId !==
          candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Decision参与者不一致`);
        }
        if (
          candidate.status === "confirmed" &&
          entities.projectDecisions[candidate.committedObjectId]?.projectId !== candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Decision缺失`);
        }
      } else {
        if (
          entities.projectParticipants[candidate.proposal.participantId]?.projectId !==
            candidate.projectId ||
          (candidate.proposal.workId !== undefined &&
            entities.projectWorks[candidate.proposal.workId]?.projectId !== candidate.projectId) ||
          (candidate.proposal.actionId !== undefined &&
            entities.projectActions[candidate.proposal.actionId]?.projectId !==
              candidate.projectId) ||
          candidate.proposal.evidenceIds.some(
            (id) => entities.projectEvidence[id]?.projectId !== candidate.projectId,
          )
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Contribution引用不一致`);
        }
        if (
          candidate.status === "confirmed" &&
          entities.projectContributions[candidate.committedObjectId]?.projectId !==
            candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Contribution缺失`);
        }
      }
    }
    if (candidate.candidateKind === "advancement") {
      const project = entities.projects[candidate.projectId];
      const stage = entities.projectStages[candidate.boundStageId];
      const method = entities.projectMethodSnapshots[candidate.boundMethodSnapshotId];
      if (
        project?.ownerPrincipalId !== candidate.requestedByPrincipalId ||
        stage?.projectId !== candidate.projectId ||
        method?.projectId !== candidate.projectId ||
        candidate.boundProjectRevision > project.revision ||
        candidate.boundStageRevision > stage.revision ||
        candidate.boundMethodSha256 !== method.sha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} Advancement绑定不一致`);
      }
      if (
        candidate.status === "under_review" ||
        candidate.status === "confirmed" ||
        candidate.status === "rejected"
      ) {
        if (
          computeProjectAdvancementCandidateSha256({
            projectId: candidate.projectId,
            boundProjectRevision: candidate.boundProjectRevision,
            boundStageId: candidate.boundStageId,
            boundStageRevision: candidate.boundStageRevision,
            boundMethodSnapshotId: candidate.boundMethodSnapshotId,
            boundMethodSha256: candidate.boundMethodSha256,
            sourceMessageId: candidate.sourceMessageId,
            proposal: candidate.proposal,
          }) !== candidate.candidateSha256
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Advancement Hash不一致`);
        }
      }
      if (candidate.status === "confirmed") {
        if (
          entities.projectStages[candidate.committedStageId]?.projectId !== candidate.projectId ||
          entities.projectUpdates[candidate.committedUpdateId]?.projectId !== candidate.projectId ||
          candidate.committedMilestoneIds.some(
            (id) => entities.projectMilestones[id]?.projectId !== candidate.projectId,
          )
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Advancement缺失`);
        }
      }
    }
  }
}

function assertPlanningProjectContexts(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const runIds = new Set<string>();
  for (const context of Object.values(entities.planningProjectContexts)) {
    try {
      assertPlanningProjectContextIntegrity(context);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (runIds.has(context.productRunId)) {
      fail(`planningProjectContext ${context.planningProjectContextId} Run重复`);
    }
    runIds.add(context.productRunId);
    const run = entities.runs[context.productRunId];
    const runSession = run === undefined ? undefined : entities.sessions[run.sessionId];
    const project = entities.projects[context.projectId];
    const method = entities.projectMethodSnapshots[context.methodRef.projectMethodSnapshotId];
    const stage = entities.projectStages[context.stageRef.projectStageId];
    if (
      run?.runKind !== "planning" ||
      runSession === undefined ||
      project === undefined ||
      project.ownerPrincipalId !== runSession.ownerPrincipalId ||
      method?.projectId !== project.projectId ||
      stage?.projectId !== project.projectId ||
      stage.methodSnapshotId !== method.projectMethodSnapshotId
    ) {
      fail(`planningProjectContext ${context.planningProjectContextId} Run/Project绑定不一致`);
    }
    if (
      context.methodRef.revision !== method.revision ||
      context.methodRef.sha256 !== method.sha256
    ) {
      fail(`planningProjectContext ${context.planningProjectContextId} Method证据不一致`);
    }
    const projectSource = context.sourceRefs.find(
      (ref) => ref.kind === "project" && ref.objectId === context.projectId,
    );
    if (
      projectSource?.revision !== context.projectRevision ||
      projectSource.sha256 !== context.projectSha256
    ) {
      fail(`planningProjectContext ${context.planningProjectContextId} Project证据不一致`);
    }
    for (const ref of context.sourceRefs) {
      const entity = getPlanningProjectSourceEntity(snapshot, ref.kind, ref.objectId);
      if (entity === undefined || entity.projectId !== context.projectId) {
        fail(`planningProjectContext ${context.planningProjectContextId} 来源悬空或跨Project`);
      }
      // Project聚合与Stage等对象当前没有历史表；只有仍处于同一revision时才能反查正文。
      // 后续revision不得让旧运行Context损坏，旧Context由自身snapshot+Hash继续自证。
      if (entity.revision === ref.revision) {
        const expectedSha =
          ref.kind === "method" && "sha256" in entity
            ? String(entity.sha256)
            : ref.kind === "project"
              ? computeWorkflowProjectResourceSha256(entity)
              : computePlanningProjectSourceRefSha256({ kind: ref.kind, entity });
        if (expectedSha !== ref.sha256) {
          fail(`planningProjectContext ${context.planningProjectContextId} 来源Hash不一致`);
        }
      }
    }
  }
}

function getPlanningProjectSourceEntity(
  snapshot: ProductSnapshot,
  kind: ProductSnapshot["entities"]["planningProjectContexts"][string]["sourceRefs"][number]["kind"],
  objectId: string,
):
  | ({ readonly projectId: string; readonly revision: number; readonly updatedAt: string } & object)
  | undefined {
  const entities = snapshot.entities;
  if (kind === "project") return entities.projects[objectId];
  if (kind === "method") return entities.projectMethodSnapshots[objectId];
  if (kind === "stage") return entities.projectStages[objectId];
  if (kind === "milestone") return entities.projectMilestones[objectId];
  if (kind === "update") return entities.projectUpdates[objectId];
  if (kind === "work") return entities.projectWorks[objectId];
  return entities.projectActions[objectId];
}

function assertPlanningMemorySelections(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const identityKeys = new Set<string>();
  for (const selection of Object.values(entities.planningMemorySelections)) {
    try {
      assertPlanningMemorySelectionIntegrity(selection);
    } catch (error) {
      fail(
        `planningMemorySelection ${selection.planningMemorySelectionId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const identityKey = `${selection.productRunId}\0${selection.definitionNodeId}`;
    if (identityKeys.has(identityKey)) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} Run/Node重复`);
    }
    identityKeys.add(identityKey);
    const run = entities.runs[selection.productRunId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    const runSpec = entities.workflowRunSpecs[selection.workflowRunSpecId];
    const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
    if (
      run?.runKind !== "planning" ||
      session === undefined ||
      run.workflowRunSpecId !== selection.workflowRunSpecId ||
      runSpec?.productRunId !== selection.productRunId ||
      runSpec.sha256 !== selection.workflowRunSpecSha256 ||
      validated === undefined ||
      !validated.success
    ) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} Run/RunSpec绑定无效`);
    }
    const node = validated?.success
      ? validated.runSpec.nodeResolutions.find(
          (candidate) => candidate.definitionNodeId === selection.definitionNodeId,
        )
      : undefined;
    const maxItems = node?.config["maxItems"];
    if (
      node?.nodeType !== "context.memory" ||
      node.activation === "skipped" ||
      typeof maxItems !== "number" ||
      !Number.isInteger(maxItems) ||
      maxItems !== selection.maxItems
    ) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} Node/maxItems无效`);
    }
    const included = (validated?.success ? validated.runSpec.resourceResolutions : [])
      .flatMap((resource) =>
        resource.definitionNodeId === selection.definitionNodeId &&
        resource.resourceKind === "memory" &&
        resource.resolution === "included"
          ? [
              {
                memoryResultSnapshotId: resource.resourceId,
                revision: resource.expectedRevision,
                sha256: resource.expectedSha256,
              },
            ]
          : [],
      )
      .sort((left, right) =>
        left.memoryResultSnapshotId.localeCompare(right.memoryResultSnapshotId),
      );
    if (JSON.stringify(included) !== JSON.stringify(selection.selected)) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} 与RunSpec选择不一致`);
    }
    for (const selected of selection.selected) {
      const memory = entities.memoryResultSnapshots[selected.memoryResultSnapshotId];
      const query = memory === undefined ? undefined : entities.memoryQueries[memory.memoryQueryId];
      const sourceRun = query === undefined ? undefined : entities.runs[query.productRunId];
      const sourceOwner =
        sourceRun === undefined
          ? undefined
          : entities.sessions[sourceRun.sessionId]?.ownerPrincipalId;
      if (
        memory === undefined ||
        memory.revision !== selected.revision ||
        memory.sha256 !== selected.sha256 ||
        sourceOwner !== session?.ownerPrincipalId
      ) {
        fail(
          `planningMemorySelection ${selection.planningMemorySelectionId} Snapshot越权、悬空或Hash不一致`,
        );
      }
    }
    const nodeRun = Object.values(entities.workflowNodeRuns).find(
      (candidate) =>
        candidate.productRunId === selection.productRunId &&
        candidate.definitionNodeId === selection.definitionNodeId &&
        candidate.executionPath.length === 0 &&
        candidate.attemptNumber === 1,
    );
    const output =
      nodeRun?.outputManifestId === undefined
        ? undefined
        : entities.nodeValueManifests[nodeRun.outputManifestId];
    const transition = Object.values(entities.nodeRunTransitions).find(
      (candidate) =>
        candidate.workflowNodeRunId === nodeRun?.workflowNodeRunId &&
        candidate.relatedProductRef?.kind === "planning_memory_selection" &&
        candidate.relatedProductRef.id === selection.planningMemorySelectionId &&
        candidate.relatedProductRef.sha256 === selection.sha256,
    );
    if (
      nodeRun?.status !== "succeeded" ||
      output === undefined ||
      !output.slots.some((slot) =>
        slot.refs.some(
          (ref) =>
            ref.kind === "planning_memory_selection" &&
            ref.id === selection.planningMemorySelectionId &&
            ref.revision === selection.revision &&
            ref.sha256 === selection.sha256,
        ),
      ) ||
      transition === undefined
    ) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} 缺少原子Node终态证据`);
    }
  }
}

function assertWorkflowPolicyResolutions(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const candidateIds = new Set<string>();
  for (const resolution of Object.values(entities.workflowPolicyResolutions)) {
    try {
      assertWorkflowPolicyResolutionIntegrity(resolution);
    } catch (error) {
      fail(
        `workflowPolicyResolution ${resolution.workflowPolicyResolutionId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (candidateIds.has(resolution.noteCandidateId)) {
      fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} Candidate重复`);
    }
    candidateIds.add(resolution.noteCandidateId);
    const run = entities.runs[resolution.productRunId];
    const runSpec = entities.workflowRunSpecs[resolution.workflowRunSpecId];
    const candidate = entities.noteCandidates[resolution.noteCandidateId];
    const review = runSpec?.reviewResolutions.find(
      (item) => item.definitionNodeId === resolution.definitionNodeId,
    );
    if (
      run?.runKind !== "note_capture" ||
      run.workflowRunSpecId !== resolution.workflowRunSpecId ||
      runSpec?.productRunId !== resolution.productRunId ||
      runSpec.sha256 !== resolution.workflowRunSpecSha256 ||
      candidate?.productRunId !== resolution.productRunId ||
      candidate.sha256 !== resolution.candidateSha256 ||
      candidate.revision < resolution.candidateRevision ||
      review?.mode !== "auto_continue_if_policy_allows" ||
      review.actor !== "system_policy" ||
      review.policyRef?.resourceId !== NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID ||
      review.policyRef.revision !== NOTE_LOW_RISK_AUTO_POLICY_REVISION ||
      review.policyRef.sha256 !== NOTE_LOW_RISK_AUTO_POLICY_SHA256
    ) {
      fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 绑定证据无效`);
    }
    if (candidate !== undefined) {
      const expected = evaluateNoteLowRiskAutoPolicy(candidate);
      if (
        expected.outcome !== resolution.outcome ||
        expected.reasonCode !== resolution.reasonCode ||
        (resolution.outcome === "allowed" && candidate.status !== "confirmed")
      ) {
        fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 决策结果不一致`);
      }
    }
    if (
      resolution.outcome === "allowed" &&
      Object.values(entities.noteDecisions).some(
        (decision) => decision.noteCandidateId === resolution.noteCandidateId,
      )
    ) {
      fail(
        `workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 伪造或混入人工Decision`,
      );
    }
    const owningNode = Object.values(entities.workflowNodeRuns).find(
      (node) =>
        node.productRunId === resolution.productRunId &&
        node.definitionNodeId === resolution.definitionNodeId &&
        Object.values(entities.nodeRunTransitions).some(
          (transition) =>
            transition.workflowNodeRunId === node.workflowNodeRunId &&
            (resolution.outcome === "allowed"
              ? transition.relatedProductRef?.kind === "workflow_policy_resolution" &&
                transition.relatedProductRef.id === resolution.workflowPolicyResolutionId &&
                transition.relatedProductRef.revision === resolution.revision &&
                transition.relatedProductRef.sha256 === resolution.sha256
              : transition.toStatus === "waiting_human" &&
                transition.relatedProductRef?.kind === "note_candidate" &&
                transition.relatedProductRef.id === resolution.noteCandidateId),
        ),
    );
    const output =
      owningNode?.outputManifestId === undefined
        ? undefined
        : entities.nodeValueManifests[owningNode.outputManifestId];
    if (
      owningNode === undefined ||
      output === undefined ||
      !output.slots.some((slot) =>
        slot.refs.some(
          (ref) =>
            ref.kind === "workflow_policy_resolution" &&
            ref.id === resolution.workflowPolicyResolutionId &&
            ref.revision === resolution.revision &&
            ref.sha256 === resolution.sha256,
        ),
      )
    ) {
      fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 缺少Node证据`);
    }
  }
}

function assertRules(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const normalizedTagKeys = new Set<string>();
  for (const tag of Object.values(entities.ruleTags)) {
    const expectedKey = normalizeRuleTagKey(tag.name);
    const ownerKey = `${tag.ownerPrincipalId}\0${tag.normalizedKey}`;
    if (tag.normalizedKey !== expectedKey || normalizedTagKeys.has(ownerKey)) {
      fail(`ruleTag ${tag.ruleTagId} normalizedKey无效或Owner内重复`);
    }
    normalizedTagKeys.add(ownerKey);
  }

  const revisionsByRule = new Map<string, (typeof entities.ruleRevisions)[string][]>();
  for (const revision of Object.values(entities.ruleRevisions)) {
    try {
      assertRuleRevisionIntegrity(revision);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (entities.rules[revision.ruleId] === undefined) {
      fail(`ruleRevision ${revision.ruleRevisionId} 悬空Rule`);
    }
    const list = revisionsByRule.get(revision.ruleId) ?? [];
    list.push(revision);
    revisionsByRule.set(revision.ruleId, list);
  }

  for (const rule of Object.values(entities.rules)) {
    const revisions = (revisionsByRule.get(rule.ruleId) ?? []).sort(
      (left, right) => left.revision - right.revision,
    );
    const current = entities.ruleRevisions[rule.currentRevisionId];
    if (
      revisions.length === 0 ||
      current === undefined ||
      current.ruleId !== rule.ruleId ||
      current.revision !== rule.currentRevisionNumber ||
      current.sha256 !== rule.currentRevisionSha256 ||
      revisions.at(-1)?.ruleRevisionId !== current.ruleRevisionId
    ) {
      fail(`rule ${rule.ruleId} Current/Highest Revision绑定不一致`);
    }
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      if (revision?.revision !== index + 1) fail(`rule ${rule.ruleId} Revision号不连续`);
      if (index > 0) {
        try {
          assertRuleRevisionAppend({ current: revisions[index - 1]!, next: revision! });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }
      if (revision !== undefined) assertRuleRevisionReferences(snapshot, rule, revision, fail);
    }
    assertRuleDecisionChain(snapshot, rule, fail);
  }

  const selectionRunIds = new Set<string>();
  for (const selection of Object.values(entities.ruleSelections)) {
    if (selectionRunIds.has(selection.productRunId)) {
      fail(`ruleSelection ${selection.ruleSelectionId} Run重复`);
    }
    selectionRunIds.add(selection.productRunId);
    const run = entities.runs[selection.productRunId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    if (run?.runKind !== "planning" || session === undefined) {
      fail(`ruleSelection ${selection.ruleSelectionId} 必须绑定Planning Run`);
    }
    if (
      selection.context.projectId !== undefined &&
      entities.projects[selection.context.projectId]?.ownerPrincipalId !== session.ownerPrincipalId
    ) {
      fail(`ruleSelection ${selection.ruleSelectionId} Context Project越权`);
    }
    for (const tagId of selection.request.selectedTagIds) {
      if (entities.ruleTags[tagId]?.ownerPrincipalId !== session.ownerPrincipalId) {
        fail(`ruleSelection ${selection.ruleSelectionId} Tag越权或悬空`);
      }
    }
    const candidates = selection.candidates;
    for (const candidate of candidates) {
      const rule = entities.rules[candidate.ruleId];
      const revision = entities.ruleRevisions[candidate.ruleRevisionId];
      if (
        rule?.ownerPrincipalId !== session.ownerPrincipalId ||
        revision?.ruleId !== rule.ruleId ||
        revision.sha256 !== candidate.ruleRevisionSha256 ||
        revision.body.length !== candidate.contentCharacters ||
        JSON.stringify(revision.tagIds) !== JSON.stringify(candidate.tagIds) ||
        JSON.stringify(revision.scopes) !== JSON.stringify(candidate.scopes) ||
        JSON.stringify(revision.conflictsWithRuleIds) !==
          JSON.stringify(candidate.conflictsWithRuleIds)
      ) {
        fail(`ruleSelection ${selection.ruleSelectionId} Candidate引用或正文长度不一致`);
      }
    }
    let recomputed;
    try {
      recomputed = selectRules({
        candidates,
        request: {
          ...selection.request,
          context: selection.context,
          budget: selection.budget,
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (
      recomputed === undefined ||
      recomputed.sha256 !== selection.sha256 ||
      JSON.stringify(recomputed) !==
        JSON.stringify({
          status: selection.status,
          selected: selection.selected,
          excluded: selection.excluded,
          conflicts: selection.conflicts,
          diagnostics: selection.diagnostics,
          selectedContentCharacters: selection.selectedContentCharacters,
          sha256: selection.sha256,
        })
    ) {
      fail(`ruleSelection ${selection.ruleSelectionId} 选择算法结果或Hash不一致`);
    }
  }
}

function assertPromptFragments(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const revisionsByFragment = new Map<
    string,
    (typeof entities.promptFragmentRevisions)[string][]
  >();
  for (const revision of Object.values(entities.promptFragmentRevisions)) {
    try {
      assertPromptFragmentRevision(revision);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (entities.promptFragments[revision.promptFragmentId] === undefined) {
      fail(`promptFragmentRevision ${revision.promptFragmentRevisionId} 悬空Fragment`);
    }
    const list = revisionsByFragment.get(revision.promptFragmentId) ?? [];
    list.push(revision);
    revisionsByFragment.set(revision.promptFragmentId, list);
    if (revision.derivedFrom?.kind === "principal") {
      const source =
        entities.promptFragmentRevisions[revision.derivedFrom.promptFragmentRevisionId];
      const sourceAggregate =
        source === undefined ? undefined : entities.promptFragments[source.promptFragmentId];
      const owner = entities.promptFragments[revision.promptFragmentId]?.ownerPrincipalId;
      if (
        source === undefined ||
        sourceAggregate === undefined ||
        source.promptFragmentId !== revision.derivedFrom.promptFragmentId ||
        source.revision !== revision.derivedFrom.revision ||
        source.sha256 !== revision.derivedFrom.sha256 ||
        sourceAggregate.ownerPrincipalId !== owner
      ) {
        fail(`promptFragmentRevision ${revision.promptFragmentRevisionId} 用户派生来源非法`);
      }
    }
  }

  for (const fragment of Object.values(entities.promptFragments)) {
    const revisions = (revisionsByFragment.get(fragment.promptFragmentId) ?? []).sort(
      (left, right) => left.revision - right.revision,
    );
    const current = entities.promptFragmentRevisions[fragment.currentRevisionId];
    if (
      revisions.length === 0 ||
      current === undefined ||
      current.promptFragmentId !== fragment.promptFragmentId ||
      current.revision !== fragment.currentRevisionNumber ||
      current.sha256 !== fragment.currentRevisionSha256 ||
      revisions.at(-1)?.promptFragmentRevisionId !== current.promptFragmentRevisionId
    ) {
      fail(`promptFragment ${fragment.promptFragmentId} Current/Highest Revision绑定不一致`);
    }
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      if (revision?.revision !== index + 1) {
        fail(`promptFragment ${fragment.promptFragmentId} Revision号不连续`);
      }
      if (index === 0 || revision === undefined) continue;
      const previous = revisions[index - 1]!;
      if (
        revision.supersedesRevisionId !== previous.promptFragmentRevisionId ||
        revision.supersedesRevisionSha256 !== previous.sha256
      ) {
        fail(`promptFragment ${fragment.promptFragmentId} Revision链断裂`);
      }
    }
  }
}

function assertRuleRevisionReferences(
  snapshot: ProductSnapshot,
  rule: ProductSnapshot["entities"]["rules"][string],
  revision: ProductSnapshot["entities"]["ruleRevisions"][string],
  fail: Fail,
): void {
  const { entities } = snapshot;
  const originOwner =
    revision.origin.kind === "assistant_candidate"
      ? entities.sessions[entities.messages[revision.origin.sourceMessageId]?.sessionId ?? ""]
          ?.ownerPrincipalId
      : revision.origin.principalId;
  if (originOwner !== rule.ownerPrincipalId)
    fail(`ruleRevision ${revision.ruleRevisionId} Origin越权`);
  for (const tagId of revision.tagIds) {
    if (entities.ruleTags[tagId]?.ownerPrincipalId !== rule.ownerPrincipalId) {
      fail(`ruleRevision ${revision.ruleRevisionId} Tag越权或悬空`);
    }
  }
  for (const conflictId of revision.conflictsWithRuleIds) {
    if (entities.rules[conflictId]?.ownerPrincipalId !== rule.ownerPrincipalId) {
      fail(`ruleRevision ${revision.ruleRevisionId} 冲突Rule越权或悬空`);
    }
  }
  for (const scope of revision.scopes) {
    if (scope.kind === "contextual" && scope.projectId !== undefined) {
      const project = entities.projects[scope.projectId];
      const methodMatches =
        scope.projectMethodProfileId === undefined ||
        Object.values(entities.projectMethodSnapshots).some(
          (method) =>
            method.projectId === project?.projectId &&
            method.profileId === scope.projectMethodProfileId,
        );
      const stageMatches =
        scope.projectStageKey === undefined ||
        Object.values(entities.projectStages).some(
          (stage) => stage.projectId === project?.projectId && stage.key === scope.projectStageKey,
        );
      if (project?.ownerPrincipalId !== rule.ownerPrincipalId || !methodMatches || !stageMatches) {
        fail(`ruleRevision ${revision.ruleRevisionId} Scope Project/Method/Stage无效`);
      }
    }
  }
  for (const source of revision.sourceCases) {
    const owner =
      source.kind === "message"
        ? entities.sessions[entities.messages[source.messageId]?.sessionId ?? ""]?.ownerPrincipalId
        : source.kind === "product_run"
          ? entities.sessions[entities.runs[source.productRunId]?.sessionId ?? ""]?.ownerPrincipalId
          : entities.projects[entities.projectDecisions[source.projectDecisionId]?.projectId ?? ""]
              ?.ownerPrincipalId;
    if (owner !== rule.ownerPrincipalId) {
      fail(`ruleRevision ${revision.ruleRevisionId} Source Case越权或悬空`);
    }
  }
}

function assertRuleDecisionChain(
  snapshot: ProductSnapshot,
  rule: ProductSnapshot["entities"]["rules"][string],
  fail: Fail,
): void {
  const decisions = Object.values(snapshot.entities.ruleDecisions)
    .filter((decision) => decision.ruleId === rule.ruleId)
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  let lifecycle: ProductSnapshot["entities"]["rules"][string]["lifecycle"] = "candidate";
  let lastExpectedRevision = 0;
  for (const decision of decisions) {
    const revision = snapshot.entities.ruleRevisions[decision.boundRevisionId];
    if (
      revision?.ruleId !== rule.ruleId ||
      revision.sha256 !== decision.boundRevisionSha256 ||
      decision.fromLifecycle !== lifecycle ||
      decision.expectedRuleRevision <= lastExpectedRevision ||
      decision.expectedRuleRevision >= rule.revision ||
      (decision.actor.kind === "principal" && decision.actor.principalId !== rule.ownerPrincipalId)
    ) {
      fail(`ruleDecision ${decision.ruleDecisionId} 绑定/Actor/CAS无效`);
    }
    try {
      assertRuleLifecycleTransition({
        from: decision.fromLifecycle,
        to: decision.toLifecycle,
        enforcement: rule.enforcement,
        actor: decision.actor,
        reason: decision.reason,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    lifecycle = decision.toLifecycle;
    lastExpectedRevision = decision.expectedRuleRevision;
  }
  if (
    lifecycle !== rule.lifecycle ||
    (decisions.at(-1)?.ruleDecisionId ?? undefined) !== rule.latestDecisionId
  ) {
    fail(`rule ${rule.ruleId} Lifecycle/Latest Decision不一致`);
  }
}

function normalizeRuleTagKey(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/gu, "-");
}

function assertNotes(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const noteIdBySourceCandidateId = new Map<string, string>();
  for (const note of Object.values(entities.notes)) {
    const revisions = Object.values(entities.noteRevisions).filter(
      (revision) => revision.noteId === note.noteId,
    );
    try {
      assertNoteAggregateIntegrity({ note, revisions });
    } catch (error) {
      fail(`note ${note.noteId} ${error instanceof Error ? error.message : String(error)}`);
    }
    if (entities.sessions[note.ownerPrincipalId] !== undefined) {
      fail(`note ${note.noteId} ownerPrincipalId误用Session身份`);
    }
    const sourceCandidate = entities.noteCandidates[note.sourceCandidateId];
    if (sourceCandidate === undefined) {
      fail(`note ${note.noteId} 悬空sourceCandidateId`);
    }
    const previousNoteId = noteIdBySourceCandidateId.get(note.sourceCandidateId);
    if (previousNoteId !== undefined) {
      fail(`note ${note.noteId} 与 ${previousNoteId} 重复绑定同一Note Candidate`);
    }
    noteIdBySourceCandidateId.set(note.sourceCandidateId, note.noteId);
    if (sourceCandidate !== undefined) {
      if (sourceCandidate.status !== "confirmed") {
        fail(`note ${note.noteId} sourceCandidate未确认`);
      }
      const run = entities.runs[sourceCandidate.productRunId];
      const session = run === undefined ? undefined : entities.sessions[run.sessionId];
      if (run === undefined || run.runKind !== "note_capture") {
        fail(`note ${note.noteId} sourceCandidate未绑定Note Capture Run`);
      }
      if (session === undefined || session.ownerPrincipalId !== note.ownerPrincipalId) {
        fail(`note ${note.noteId} ownerPrincipalId与sourceCandidate Run owner不一致`);
      }
      const initialRevision = revisions.find((revision) => revision.noteRevision === 1);
      if (initialRevision === undefined) {
        fail(`note ${note.noteId} 缺少首个Revision`);
      } else {
        const revisionSourceHash = hashCanonical("note.initial-revision-source.v1", {
          title: initialRevision.title,
          kind: initialRevision.kind,
          contentMarkdown: initialRevision.contentMarkdown,
          tags: initialRevision.tags,
          sourceRefs: initialRevision.sourceRefs,
        });
        const candidateSourceHash = hashCanonical("note.initial-revision-source.v1", {
          title: sourceCandidate.proposed.title,
          kind: sourceCandidate.proposed.kind,
          contentMarkdown: sourceCandidate.proposed.contentMarkdown,
          tags: sourceCandidate.proposed.tags,
          sourceRefs: sourceCandidate.sourceRefs,
        });
        if (revisionSourceHash !== candidateSourceHash) {
          fail(`note ${note.noteId} 首版Revision与sourceCandidate内容或来源不一致`);
        }
      }
    }
  }
  for (const revision of Object.values(entities.noteRevisions)) {
    try {
      assertNoteRevisionIntegrity(revision);
    } catch (error) {
      fail(
        `noteRevision ${revision.noteRevisionId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const note = entities.notes[revision.noteId];
    if (note === undefined) fail(`noteRevision ${revision.noteRevisionId} 悬空noteId`);
    if (note !== undefined && note.ownerPrincipalId !== revision.createdByPrincipalId) {
      fail(`noteRevision ${revision.noteRevisionId} createdByPrincipalId与Note owner不一致`);
    }
    for (const sourceRef of revision.sourceRefs) {
      const message = entities.messages[sourceRef.sourceMessageId];
      if (message === undefined)
        fail(`noteRevision ${revision.noteRevisionId} 悬空sourceMessageId`);
    }
  }
  for (const candidate of Object.values(entities.noteCandidates)) {
    try {
      assertNoteCandidateIntegrity(candidate);
    } catch (error) {
      fail(
        `noteCandidate ${candidate.noteCandidateId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const run = entities.runs[candidate.productRunId];
    if (run === undefined || run.runKind !== "note_capture") {
      fail(`noteCandidate ${candidate.noteCandidateId} 未绑定Note Capture Run`);
    }
    if (
      candidate.supersedesCandidateId !== undefined &&
      entities.noteCandidates[candidate.supersedesCandidateId]?.productRunId !==
        candidate.productRunId
    ) {
      fail(`noteCandidate ${candidate.noteCandidateId} successor链跨Run或悬空`);
    }
    for (const sourceRef of candidate.sourceRefs) {
      if (entities.messages[sourceRef.sourceMessageId] === undefined) {
        fail(`noteCandidate ${candidate.noteCandidateId} 悬空sourceMessageId`);
      }
    }
  }
  for (const decision of Object.values(entities.noteDecisions)) {
    const candidate = entities.noteCandidates[decision.noteCandidateId];
    if (candidate === undefined) fail(`noteDecision ${decision.noteDecisionId} 悬空candidate`);
    if (candidate !== undefined) {
      try {
        const decisionCandidate = {
          ...candidate,
          status: "under_review" as const,
          revision: decision.candidateRevision,
        };
        assertNoteDecisionBinding({ candidate: decisionCandidate, decision });
      } catch (error) {
        fail(
          `noteDecision ${decision.noteDecisionId} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (candidate.productRunId !== decision.productRunId) {
        fail(`noteDecision ${decision.noteDecisionId} productRunId与Candidate不一致`);
      }
    }
  }
}

function assertWorkflowMemory(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const snapshotsByQuery = new Map<string, (typeof entities.workflowMemorySnapshots)[string][]>();

  for (const memorySnapshot of Object.values(entities.workflowMemorySnapshots)) {
    const query = entities.workflowMemoryQueries[memorySnapshot.workflowMemoryQueryId];
    if (
      query === undefined ||
      query.status !== "completed" ||
      query.providerId !== memorySnapshot.providerId
    ) {
      fail(`workflowMemorySnapshot ${memorySnapshot.workflowMemorySnapshotId} Query绑定无效`);
    }
    if (
      memorySnapshot.createdAt !== memorySnapshot.updatedAt ||
      memorySnapshot.createdAt !== query.completedAt ||
      new Set(memorySnapshot.externalObjectIds).size !== memorySnapshot.externalObjectIds.length ||
      new Set(memorySnapshot.labels).size !== memorySnapshot.labels.length
    ) {
      fail(`workflowMemorySnapshot ${memorySnapshot.workflowMemorySnapshotId} 不可变证据无效`);
    }
    const expectedSha256 = computeWorkflowMemorySnapshotSha256({
      providerId: memorySnapshot.providerId,
      externalObjectIds: memorySnapshot.externalObjectIds,
      title: memorySnapshot.title,
      category: memorySnapshot.category,
      content: memorySnapshot.content,
      labels: memorySnapshot.labels,
      ...(memorySnapshot.score !== undefined ? { score: memorySnapshot.score } : {}),
      ...(memorySnapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: memorySnapshot.sourceUpdatedAt }
        : {}),
    });
    if (expectedSha256 !== memorySnapshot.sha256) {
      fail(`workflowMemorySnapshot ${memorySnapshot.workflowMemorySnapshotId} Hash不一致`);
    }
    const values = snapshotsByQuery.get(memorySnapshot.workflowMemoryQueryId) ?? [];
    values.push(memorySnapshot);
    snapshotsByQuery.set(memorySnapshot.workflowMemoryQueryId, values);
  }

  for (const query of Object.values(entities.workflowMemoryQueries)) {
    const run = entities.runs[query.productRunId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    const message = entities.messages[query.sourceMessageId];
    const runSpec = entities.workflowRunSpecs[query.workflowRunSpecId];
    const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
    const node = validated?.success
      ? validated.runSpec.nodeResolutions.find(
          (candidate) => candidate.definitionNodeId === query.definitionNodeId,
        )
      : undefined;
    if (
      run?.runKind !== "planning" ||
      session === undefined ||
      message === undefined ||
      message.messageId !== run.sourceMessageId ||
      message.sessionId !== session.sessionId ||
      session.ownerPrincipalId !== query.requestedByPrincipalId ||
      run.workflowRunSpecId !== query.workflowRunSpecId ||
      runSpec?.productRunId !== query.productRunId ||
      runSpec.sha256 !== query.workflowRunSpecSha256 ||
      validated === undefined ||
      !validated.success ||
      node?.nodeType !== "memory.query" ||
      node.activation === "skipped"
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} Run/Node绑定无效`);
    }
    const configuredProvider = node?.config["providerId"];
    const configuredRequired = node?.config["required"];
    const configuredMaxResults = node?.config["maxResults"];
    const configuredMaxCharacters = node?.config["maxContextCharacters"];
    if (
      configuredProvider !== query.providerId ||
      configuredRequired !== (query.requirement === "required") ||
      configuredMaxResults !== query.maxResults ||
      configuredMaxCharacters !== query.maxContextCharacters ||
      query.operationId !== query.workflowMemoryQueryId ||
      query.providerDescriptor.providerId !== query.providerId ||
      computeMemoryProviderDescriptorSha256(query.providerDescriptor) !==
        query.providerDescriptorSha256 ||
      query.providerDescriptor.capabilities.query === null ||
      query.maxResults > query.providerDescriptor.capabilities.query.maxResults ||
      query.maxContextCharacters >
        query.providerDescriptor.capabilities.query.maxContextCharacters ||
      computeWorkflowMemoryMessageSha256(message) !== query.sourceMessageSha256 ||
      sha256Hex(message.content.text) !== query.querySha256
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 冻结请求证据无效`);
    }
    if (
      query.startedAt !== query.createdAt ||
      (query.status === "pending" &&
        (query.revision !== 1 || query.updatedAt !== query.createdAt)) ||
      (query.status !== "pending" &&
        (query.revision !== 2 ||
          query.updatedAt !== query.completedAt ||
          Date.parse(query.completedAt) < Date.parse(query.startedAt)))
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 时间线无效`);
    }
    const selected = (snapshotsByQuery.get(query.workflowMemoryQueryId) ?? []).sort((left, right) =>
      left.workflowMemorySnapshotId.localeCompare(right.workflowMemorySnapshotId),
    );
    if (query.status === "completed") {
      const sections = selected.map((item) => ({
        externalObjectIds: item.externalObjectIds,
        title: item.title,
        category: item.category,
        content: item.content,
        labels: item.labels,
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: item.sourceUpdatedAt } : {}),
      }));
      if (
        query.selectedCount !== selected.length ||
        query.hitCount < query.selectedCount ||
        query.selectedCharacters !==
          selected.reduce((sum, item) => sum + item.title.length + item.content.length, 0) ||
        computeWorkflowMemoryQueryResultSha256({
          externalQueryId: query.externalQueryId,
          hitCount: query.hitCount,
          sections,
        }) !== query.resultSetSha256
      ) {
        fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 结果证据无效`);
      }
    } else if (selected.length !== 0) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 非成功状态不能拥有Snapshot`);
    }
  }

  for (const context of Object.values(entities.workflowMemoryContexts)) {
    const run = entities.runs[context.productRunId];
    const runSpec = entities.workflowRunSpecs[context.workflowRunSpecId];
    if (
      run === undefined ||
      run.workflowRunSpecId !== context.workflowRunSpecId ||
      runSpec?.productRunId !== context.productRunId ||
      runSpec.sha256 !== context.workflowRunSpecSha256 ||
      context.createdAt !== context.updatedAt
    ) {
      fail(`workflowMemoryContext ${context.workflowMemoryContextId} RunSpec绑定无效`);
    }
    try {
      assertWorkflowMemoryContextOrder(context);
    } catch (error) {
      fail(
        `workflowMemoryContext ${context.workflowMemoryContextId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const ref of context.queries) {
      const query = entities.workflowMemoryQueries[ref.workflowMemoryQueryId];
      if (
        query === undefined ||
        query.productRunId !== context.productRunId ||
        query.workflowRunSpecId !== context.workflowRunSpecId ||
        query.revision !== ref.revision ||
        query.providerId !== ref.providerId ||
        (ref.outcome === "completed" &&
          (query.status !== "completed" || query.resultSetSha256 !== ref.resultSetSha256)) ||
        (ref.outcome === "optional_failed" &&
          (query.status !== "failed" ||
            query.requirement !== "optional" ||
            query.errorCode !== ref.errorCode))
      ) {
        fail(`workflowMemoryContext ${context.workflowMemoryContextId} Query引用无效`);
      }
    }
    let totalContentCharacters = 0;
    for (const ref of context.items) {
      const item = entities.workflowMemorySnapshots[ref.workflowMemorySnapshotId];
      const query =
        item === undefined ? undefined : entities.workflowMemoryQueries[item.workflowMemoryQueryId];
      if (
        item === undefined ||
        item.revision !== ref.revision ||
        item.sha256 !== ref.sha256 ||
        query?.productRunId !== context.productRunId ||
        !context.queries.some(
          (candidate) => candidate.workflowMemoryQueryId === item.workflowMemoryQueryId,
        )
      ) {
        fail(`workflowMemoryContext ${context.workflowMemoryContextId} Snapshot引用无效`);
      }
      totalContentCharacters += item.title.length + item.content.length;
    }
    if (
      totalContentCharacters !== context.totalContentCharacters ||
      computeWorkflowMemoryContextSha256({
        productRunId: context.productRunId,
        workflowRunSpecId: context.workflowRunSpecId,
        workflowRunSpecSha256: context.workflowRunSpecSha256,
        queries: context.queries,
        items: context.items,
        totalContentCharacters: context.totalContentCharacters,
      }) !== context.sha256
    ) {
      fail(`workflowMemoryContext ${context.workflowMemoryContextId} Hash或字符统计无效`);
    }
  }

  const resultCountByIntent = new Map<string, number>();
  const semanticDedupe = new Set<string>();
  for (const intent of Object.values(entities.memoryWriteIntents)) {
    const session = entities.sessions[intent.productSessionId];
    const message = entities.messages[intent.sourceSelection.sourceMessageId];
    const writeCapability = intent.providerDescriptor.capabilities.write;
    if (
      session === undefined ||
      message === undefined ||
      message.sessionId !== session.sessionId ||
      session.ownerPrincipalId !== intent.requestedByPrincipalId ||
      intent.operationId !== intent.memoryWriteIntentId ||
      intent.providerDescriptor.providerId !== intent.providerId ||
      computeMemoryProviderDescriptorSha256(intent.providerDescriptor) !==
        intent.providerDescriptorSha256 ||
      writeCapability === null ||
      intent.createdAt !== intent.updatedAt
    ) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 来源或Provider证据无效`);
    }
    let content: string;
    try {
      content = resolveMemoryWriteContent({
        message,
        selection: intent.sourceSelection,
        maxContentCharacters: writeCapability.maxContentCharacters,
      });
    } catch (error) {
      fail(
        `memoryWriteIntent ${intent.memoryWriteIntentId} 来源内容无效:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      computeMemoryWriteRequestSha256({
        operationId: intent.operationId,
        providerDescriptorSha256: intent.providerDescriptorSha256,
        contentType: intent.contentType,
        sourceSelection: intent.sourceSelection,
        contentSha256: sha256Hex(content),
      }) !== intent.requestSha256 ||
      computeMemoryWriteSemanticDedupeSha256({
        requestedByPrincipalId: intent.requestedByPrincipalId,
        productSessionId: intent.productSessionId,
        providerId: intent.providerId,
        sourceSelection: intent.sourceSelection,
      }) !== intent.semanticDedupeSha256 ||
      semanticDedupe.has(intent.semanticDedupeSha256)
    ) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 请求Hash或语义幂等无效`);
    }
    semanticDedupe.add(intent.semanticDedupeSha256);
  }

  for (const result of Object.values(entities.memoryWriteResults)) {
    const intent = entities.memoryWriteIntents[result.memoryWriteIntentId];
    if (intent === undefined || Date.parse(result.createdAt) < Date.parse(intent.createdAt)) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} Intent绑定或时间线无效`);
    }
    resultCountByIntent.set(
      result.memoryWriteIntentId,
      (resultCountByIntent.get(result.memoryWriteIntentId) ?? 0) + 1,
    );
    if (
      (["dispatching", "accepted", "materialized"].includes(result.status) &&
        result.dispatchAttempts < 1) ||
      result.reconcileAttempts > result.revision ||
      Date.parse(result.updatedAt) < Date.parse(result.createdAt)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} 计数或时间线无效`);
    }
    if (
      result.status === "queued" &&
      (result.dispatchAttempts !== 0 || result.reconcileAttempts !== 0 || result.revision !== 1)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} queued状态无效`);
    }
    if (
      result.status === "dispatching" &&
      (result.dispatchStartedAt !== result.updatedAt || result.dispatchAttempts < 1)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} dispatching状态无效`);
    }
    if (
      (result.status === "accepted" || result.status === "materialized") &&
      Date.parse(result.acceptedAt) < Date.parse(result.createdAt)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} accepted时间线无效`);
    }
    if (
      result.status === "materialized" &&
      Date.parse(result.materializedAt) < Date.parse(result.acceptedAt)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} materialized时间线无效`);
    }
    if (result.status === "failed" && result.failedAt !== result.updatedAt) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} failed时间线无效`);
    }
    if (
      result.status === "outcome_unknown" &&
      (Date.parse(result.unknownSince) > Date.parse(result.updatedAt) ||
        (result.lastReconciledAt !== undefined && result.lastReconciledAt !== result.updatedAt))
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} outcome_unknown时间线无效`);
    }
  }
  for (const intent of Object.values(entities.memoryWriteIntents)) {
    if ((resultCountByIntent.get(intent.memoryWriteIntentId) ?? 0) !== 1) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 必须恰有一个Result`);
    }
  }
}

function assertMemoryImports(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const resultCountByIntent = new Map<string, number>();
  const liveDedupe = new Set<string>();

  for (const intent of Object.values(entities.memoryImportIntents)) {
    const message = entities.messages[intent.sourceSelection.sourceMessageId];
    const session = message === undefined ? undefined : entities.sessions[message.sessionId];
    if (
      message === undefined ||
      session === undefined ||
      session.ownerPrincipalId !== intent.requestedByPrincipalId
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 来源Message/Principal不一致`);
    }
    if (
      intent.operationId !== intent.memoryImportIntentId ||
      intent.backendDescriptor.backendId !== intent.backendId ||
      !intent.backendDescriptor.configured ||
      intent.memoryLayer !== intent.backendDescriptor.capabilities.layers[0] ||
      intent.updatedAt !== intent.createdAt
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 冻结字段不一致`);
    }
    if (
      new Set(intent.tags).size !== intent.tags.length ||
      JSON.stringify([...intent.tags].sort()) !== JSON.stringify(intent.tags)
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 标签未规范化`);
    }
    try {
      const content = resolveMemoryImportContent({
        message,
        selection: intent.sourceSelection,
        maxContentChars: intent.backendDescriptor.capabilities.maxContentChars,
      });
      if (
        computeMemoryImportBackendDescriptorSha256(intent.backendDescriptor) !==
        intent.backendDescriptorSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Backend Hash不一致`);
      }
      if (
        computeMemoryImportRequestSha256(
          intent.backendDescriptor.kind === "tencent_memorycore"
            ? {
                kind: "tencent_conversation_capture",
                content,
                layer: "L0",
                turnId: message.messageId,
              }
            : {
                content,
                layer: "L2",
                title: intent.title,
                tags: intent.tags,
                turnId: message.messageId,
              },
        ) !== intent.requestSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Request Hash不一致`);
      }
      if (
        computeMemoryImportSemanticDedupeSha256({
          requestedByPrincipalId: intent.requestedByPrincipalId,
          sourceSelection: intent.sourceSelection,
          backendId: intent.backendId,
          title: intent.title,
          tags: intent.tags,
        }) !== intent.semanticDedupeSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Semantic Hash不一致`);
      }
    } catch (error) {
      fail(
        `memoryImportIntent ${intent.memoryImportIntentId} 内容证据无效:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const result of Object.values(entities.memoryImportResults)) {
    const intent = entities.memoryImportIntents[result.memoryImportIntentId];
    if (intent === undefined) {
      fail(`memoryImportResult ${result.memoryImportResultId} 悬空Intent`);
    }
    resultCountByIntent.set(
      result.memoryImportIntentId,
      (resultCountByIntent.get(result.memoryImportIntentId) ?? 0) + 1,
    );
    if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
      fail(`memoryImportResult ${result.memoryImportResultId} 时间线倒置`);
    }
    if (
      (result.status === "queued" &&
        (result.dispatchAttempts !== 0 || result.reconcileAttempts !== 0)) ||
      (result.status === "dispatching" &&
        (result.dispatchAttempts < 1 || result.dispatchStartedAt !== result.updatedAt)) ||
      (result.status === "accepted" &&
        (result.dispatchAttempts < 1 ||
          Date.parse(result.acceptedAt) > Date.parse(result.updatedAt))) ||
      (result.status === "materialized" &&
        (result.dispatchAttempts < 1 ||
          result.reconcileAttempts < 1 ||
          result.materializedAt !== result.updatedAt ||
          Date.parse(result.acceptedAt) > Date.parse(result.materializedAt))) ||
      (result.status === "failed" && result.failedAt !== result.updatedAt) ||
      (result.status === "outcome_unknown" &&
        (Date.parse(result.unknownSince) > Date.parse(result.updatedAt) ||
          (result.lastReconciledAt !== undefined && result.lastReconciledAt !== result.updatedAt)))
    ) {
      fail(`memoryImportResult ${result.memoryImportResultId} 状态时间或计数不一致`);
    }
    if (result.status !== "failed") {
      if (liveDedupe.has(intent.semanticDedupeSha256)) {
        fail(`memoryImportIntent semanticDedupeSha256重复`);
      }
      liveDedupe.add(intent.semanticDedupeSha256);
    }
  }

  for (const intent of Object.values(entities.memoryImportIntents)) {
    if ((resultCountByIntent.get(intent.memoryImportIntentId) ?? 0) !== 1) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 必须恰有一个Result`);
    }
  }
}

function assertSessionsAndMessages(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const session of Object.values(entities.sessions)) {
    const messages = Object.values(entities.messages)
      .filter((message) => message.sessionId === session.sessionId)
      .sort((a, b) => a.sessionSequence - b.sessionSequence);
    const sequences = new Set(messages.map((message) => message.sessionSequence));
    if (sequences.size !== messages.length) fail(`session ${session.sessionId} Message序号重复`);
    const maximum = messages.at(-1)?.sessionSequence ?? 0;
    if (maximum !== session.lastMessageSequence) {
      fail(`session ${session.sessionId} lastMessageSequence与消息不一致`);
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.sessionSequence !== index + 1) {
        fail(`session ${session.sessionId} Message序号不连续`);
      }
    }
  }

  for (const message of Object.values(entities.messages)) {
    if (entities.sessions[message.sessionId] === undefined) {
      fail(`message ${message.messageId} 悬空sessionId`);
    }
    if (message.role === "user" && message.sourceRunId !== undefined) {
      fail(`user message ${message.messageId} 不允许sourceRunId`);
    }
    if (message.role === "assistant" && message.sourceRunId === undefined) {
      fail(`assistant message ${message.messageId} 缺少sourceRunId`);
    }
    if (message.sourceRunId !== undefined) {
      const run = entities.runs[message.sourceRunId];
      if (run === undefined) fail(`message ${message.messageId} 悬空sourceRunId`);
      if (run.sessionId !== message.sessionId)
        fail(`message ${message.messageId} 与Run不属于同一Session`);
    }
  }
}

function assertAttempts(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const attempt of Object.values(entities.attempts)) {
    const run = entities.runs[attempt.productRunId];
    if (run === undefined) fail(`attempt ${attempt.attemptId} 悬空productRunId`);
    if (attempt.outcome === "failure" && attempt.errorCode === undefined) {
      fail(`attempt ${attempt.attemptId} failure缺少errorCode`);
    }
    if (attempt.outcome !== "failure" && attempt.errorCode !== undefined) {
      fail(`attempt ${attempt.attemptId} 非failure不允许errorCode`);
    }

    const versionEvidence = [
      attempt.inputManifestSha256,
      attempt.promptTemplateVersion,
      attempt.modelConfigVersion,
    ];
    if (attempt.kind === "planning") {
      if (
        attempt.planRevision === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.sourceMessageSha256 === undefined ||
        versionEvidence.some((value) => value === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} 缺少输入与版本证据`);
      }
      if (attempt.stepId !== undefined) fail(`planning attempt ${attempt.attemptId} 不允许stepId`);
      if (run.sourceMessageId === undefined)
        fail(`planning attempt ${attempt.attemptId} 缺少源消息`);
      const source = entities.messages[run.sourceMessageId];
      if (source === undefined) fail(`planning attempt ${attempt.attemptId} 源消息不存在`);
      const sourceHash = hashCanonical("message.v1", {
        messageId: source.messageId,
        sessionId: source.sessionId,
        sessionSequence: source.sessionSequence,
        role: source.role,
        content: source.content,
      });
      if (sourceHash !== attempt.sourceMessageSha256) {
        fail(`planning attempt ${attempt.attemptId} sourceMessageSha256不一致`);
      }
      const promptTemplateVersion = attempt.promptTemplateVersion;
      const modelConfigVersion = attempt.modelConfigVersion;
      if (promptTemplateVersion === undefined || modelConfigVersion === undefined) {
        fail(`planning attempt ${attempt.attemptId} 缺少输入版本证据`);
      }
      const prior =
        attempt.priorPlanRevisionId === undefined
          ? undefined
          : entities.plans[attempt.priorPlanRevisionId];
      const revisionInput =
        attempt.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[attempt.revisionInputId];
      const contextRequest = Object.values(entities.contextRequests).find(
        (candidate) => candidate.productRunId === attempt.productRunId,
      );
      const contextPackage =
        attempt.contextPackageId === undefined
          ? undefined
          : entities.contextPackages[attempt.contextPackageId];
      if (attempt.priorPlanRevisionId !== undefined && prior === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空priorPlanRevisionId`);
      }
      if (attempt.revisionInputId !== undefined && revisionInput === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空revisionInputId`);
      }
      if (
        (attempt.contextPackageId === undefined) !==
        (attempt.contextPackageSha256 === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} ContextPackage证据不成对`);
      }
      if (
        (attempt.planningMemorySelectionId === undefined) !==
          (attempt.planningMemorySelectionSha256 === undefined) ||
        (attempt.workflowMemoryContextId === undefined) !==
          (attempt.workflowMemoryContextSha256 === undefined) ||
        (attempt.planningProjectContextId === undefined) !==
          (attempt.planningProjectContextSha256 === undefined) ||
        (attempt.ruleSelectionId === undefined) !== (attempt.ruleSelectionSha256 === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} 高级Context证据不成对`);
      }
      const memorySelection =
        attempt.planningMemorySelectionId === undefined
          ? undefined
          : entities.planningMemorySelections[attempt.planningMemorySelectionId];
      if (
        attempt.planningMemorySelectionId !== undefined &&
        (memorySelection?.productRunId !== attempt.productRunId ||
          memorySelection.workflowRunSpecId !== run.workflowRunSpecId ||
          memorySelection.sha256 !== attempt.planningMemorySelectionSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Memory Selection引用不一致`);
      }
      const projectContext =
        attempt.planningProjectContextId === undefined
          ? undefined
          : entities.planningProjectContexts[attempt.planningProjectContextId];
      if (
        attempt.planningProjectContextId !== undefined &&
        (projectContext?.productRunId !== attempt.productRunId ||
          projectContext.sha256 !== attempt.planningProjectContextSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Project Context引用不一致`);
      }
      const workflowMemoryContext =
        attempt.workflowMemoryContextId === undefined
          ? undefined
          : entities.workflowMemoryContexts[attempt.workflowMemoryContextId];
      if (
        attempt.workflowMemoryContextId !== undefined &&
        (workflowMemoryContext?.productRunId !== attempt.productRunId ||
          workflowMemoryContext.workflowRunSpecId !== run.workflowRunSpecId ||
          workflowMemoryContext.sha256 !== attempt.workflowMemoryContextSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Workflow Memory Context引用不一致`);
      }
      const ruleSelection =
        attempt.ruleSelectionId === undefined
          ? undefined
          : entities.ruleSelections[attempt.ruleSelectionId];
      if (
        attempt.ruleSelectionId !== undefined &&
        (ruleSelection?.productRunId !== attempt.productRunId ||
          ruleSelection.sha256 !== attempt.ruleSelectionSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Rule Selection引用不一致`);
      }
      if (
        attempt.contextPackageId !== undefined &&
        (contextPackage === undefined ||
          contextPackage.productRunId !== attempt.productRunId ||
          contextPackage.sha256 !== attempt.contextPackageSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} ContextPackage引用不一致`);
      }
      if ((attempt.planRevision ?? 1) > 1 && (prior === undefined || revisionInput === undefined)) {
        fail(`planning attempt ${attempt.attemptId} 修订轮缺少上一版Plan或Revision Input`);
      }
      const manifest = computePlanningInputManifestSha256({
        productRunId: attempt.productRunId,
        planRevision: attempt.planRevision,
        sourceMessageRef: { messageId: source.messageId, sha256: sourceHash },
        ...(prior !== undefined
          ? {
              priorPlanRef: {
                planRevisionId: prior.planRevisionId,
                planId: prior.planId,
                planRevision: prior.planRevision,
                sha256: prior.sha256,
              },
            }
          : {}),
        ...(revisionInput !== undefined
          ? { revisionInputRef: { revisionInputId: revisionInput.revisionInputId } }
          : {}),
        ...(contextRequest?.schemaVersion === "run-context-request.v2"
          ? {
              workspaceInstructionsRef: {
                contextRequestId: contextRequest.contextRequestId,
                revision: 1 as const,
                sha256: contextRequest.workspaceInstructions.sha256,
              },
            }
          : {}),
        ...(contextPackage !== undefined
          ? {
              contextPackageRef: {
                contextPackageId: contextPackage.contextPackageId,
                revision: contextPackage.revision,
                sha256: contextPackage.sha256,
              },
            }
          : {}),
        ...(memorySelection !== undefined
          ? {
              planningMemorySelectionRef: {
                planningMemorySelectionId: memorySelection.planningMemorySelectionId,
                revision: memorySelection.revision,
                sha256: memorySelection.sha256,
              },
            }
          : {}),
        ...(workflowMemoryContext !== undefined
          ? {
              workflowMemoryContextRef: {
                workflowMemoryContextId: workflowMemoryContext.workflowMemoryContextId,
                revision: workflowMemoryContext.revision,
                sha256: workflowMemoryContext.sha256,
              },
            }
          : {}),
        ...(projectContext !== undefined
          ? {
              planningProjectContextRef: {
                planningProjectContextId: projectContext.planningProjectContextId,
                revision: projectContext.revision,
                sha256: projectContext.sha256,
              },
            }
          : {}),
        ...(ruleSelection !== undefined
          ? {
              ruleSelectionRef: {
                ruleSelectionId: ruleSelection.ruleSelectionId,
                revision: 1,
                sha256: ruleSelection.sha256,
              },
            }
          : {}),
        promptTemplateVersion,
        modelConfigVersion,
      });
      if (manifest !== attempt.inputManifestSha256) {
        fail(`planning attempt ${attempt.attemptId} inputManifestSha256不一致`);
      }
    } else if (attempt.kind === "execution") {
      if (attempt.stepId === undefined || versionEvidence.some((value) => value === undefined)) {
        fail(`execution attempt ${attempt.attemptId} 缺少stepId或输入版本证据`);
      }
      if (
        attempt.planRevision !== undefined ||
        attempt.inputRunRevision !== undefined ||
        attempt.sourceMessageSha256 !== undefined ||
        attempt.priorPlanRevisionId !== undefined ||
        attempt.revisionInputId !== undefined ||
        attempt.contextPackageId !== undefined ||
        attempt.contextPackageSha256 !== undefined ||
        attempt.planningMemorySelectionId !== undefined ||
        attempt.planningMemorySelectionSha256 !== undefined ||
        attempt.workflowMemoryContextId !== undefined ||
        attempt.workflowMemoryContextSha256 !== undefined ||
        attempt.planningProjectContextId !== undefined ||
        attempt.planningProjectContextSha256 !== undefined ||
        attempt.ruleSelectionId !== undefined ||
        attempt.ruleSelectionSha256 !== undefined
      ) {
        fail(`execution attempt ${attempt.attemptId} 不允许planning输入证据`);
      }
    } else if (attempt.kind === "direct_agent") {
      const source = run === undefined ? undefined : entities.messages[run.sourceMessageId];
      const runSpec =
        run?.runKind === "direct_agent"
          ? entities.workflowRunSpecs[run.workflowRunSpecId]
          : undefined;
      const promptTemplateVersion = attempt.promptTemplateVersion;
      const modelConfigVersion = attempt.modelConfigVersion;
      if (
        run?.runKind !== "direct_agent" ||
        source === undefined ||
        runSpec === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.sourceMessageSha256 === undefined ||
        attempt.inputManifestSha256 === undefined ||
        promptTemplateVersion === undefined ||
        modelConfigVersion === undefined
      ) {
        fail(`direct_agent attempt ${attempt.attemptId} 缺少Run、源消息或版本证据`);
      }
      if (
        attempt.stepId !== undefined ||
        attempt.planRevision !== undefined ||
        attempt.executionContractId !== undefined ||
        attempt.dependencyRefs !== undefined ||
        attempt.priorPlanRevisionId !== undefined ||
        attempt.revisionInputId !== undefined ||
        attempt.contextPackageId !== undefined ||
        attempt.contextPackageSha256 !== undefined ||
        attempt.planningMemorySelectionId !== undefined ||
        attempt.planningMemorySelectionSha256 !== undefined ||
        attempt.workflowMemoryContextId !== undefined ||
        attempt.workflowMemoryContextSha256 !== undefined ||
        attempt.planningProjectContextId !== undefined ||
        attempt.planningProjectContextSha256 !== undefined ||
        attempt.ruleSelectionId !== undefined ||
        attempt.ruleSelectionSha256 !== undefined
      ) {
        fail(`direct_agent attempt ${attempt.attemptId} 不允许Plan/Execution Contract证据`);
      }
      const sourceSha256 = hashCanonical("message.v1", {
        messageId: source.messageId,
        sessionId: source.sessionId,
        sessionSequence: source.sessionSequence,
        role: source.role,
        content: source.content,
      });
      if (sourceSha256 !== attempt.sourceMessageSha256) {
        fail(`direct_agent attempt ${attempt.attemptId} sourceMessageSha256不一致`);
      }
      const inputManifestSha256 = computeDirectAgentInputManifestSha256({
        productRunId: attempt.productRunId,
        inputRunRevision: attempt.inputRunRevision,
        workflowRunSpecId: runSpec.workflowRunSpecId,
        workflowRunSpecSha256: runSpec.sha256,
        sourceMessageId: source.messageId,
        sourceMessageSha256: sourceSha256,
        capabilityMode: "read_only",
        promptTemplateVersion,
        modelConfigVersion,
        limits: {
          maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
          activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
          tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
        },
      });
      if (inputManifestSha256 !== attempt.inputManifestSha256) {
        fail(`direct_agent attempt ${attempt.attemptId} inputManifestSha256不一致`);
      }
    } else if (
      attempt.stepId !== undefined ||
      attempt.planRevision !== undefined ||
      attempt.inputRunRevision !== undefined ||
      attempt.sourceMessageSha256 !== undefined ||
      attempt.priorPlanRevisionId !== undefined ||
      attempt.revisionInputId !== undefined ||
      attempt.contextPackageId !== undefined ||
      attempt.contextPackageSha256 !== undefined ||
      attempt.planningMemorySelectionId !== undefined ||
      attempt.planningMemorySelectionSha256 !== undefined ||
      attempt.workflowMemoryContextId !== undefined ||
      attempt.workflowMemoryContextSha256 !== undefined ||
      attempt.planningProjectContextId !== undefined ||
      attempt.planningProjectContextSha256 !== undefined ||
      attempt.ruleSelectionId !== undefined ||
      attempt.ruleSelectionSha256 !== undefined ||
      versionEvidence.some((value) => value !== undefined)
    ) {
      fail(`workflow attempt ${attempt.attemptId} 不允许节点输入证据`);
    }
  }
}

function assertLongTermContext(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const indexes = indexLongTermContext(entities);

  assertContextRequests(entities, indexes, fail);
  assertMemoryQueries(entities, indexes, fail);
  assertMemorySnapshots(entities, fail);
  assertContextPackages(entities, fail);
  assertMemoryAdoptions(entities, indexes, fail);
  assertLongTermContextCardinalityAndReuse(entities, indexes, fail);
}

type SnapshotEntities = ProductSnapshot["entities"];
type ContextRequestEntity = SnapshotEntities["contextRequests"][string];
type MemoryQueryEntity = SnapshotEntities["memoryQueries"][string];
type CompletedMemoryQueryEntity = Extract<MemoryQueryEntity, { status: "completed" }>;
type MemorySnapshotEntity = SnapshotEntities["memoryResultSnapshots"][string];
type MemoryAdoptionEntity = SnapshotEntities["memoryAdoptions"][string];
type PlanningAttemptEntity = SnapshotEntities["attempts"][string];

interface LongTermContextIndexes {
  readonly requestCountByRun: ReadonlyMap<string, number>;
  readonly requestByRun: ReadonlyMap<string, ContextRequestEntity>;
  readonly queryCountByRequest: ReadonlyMap<string, number>;
  readonly packageCountByQuery: ReadonlyMap<string, number>;
  readonly adoptionsByPackage: ReadonlyMap<string, readonly MemoryAdoptionEntity[]>;
  readonly packageItemCountBySnapshot: ReadonlyMap<string, number>;
  readonly adoptionCountBySnapshot: ReadonlyMap<string, number>;
  readonly planningAttemptsByRun: ReadonlyMap<string, readonly PlanningAttemptEntity[]>;
}

/** 多个基数不变量共享同一批索引，避免在完整性校验中反复扫描整张对象图。 */
function indexLongTermContext(entities: SnapshotEntities): LongTermContextIndexes {
  const requestCountByRun = new Map<string, number>();
  const requestByRun = new Map<string, ContextRequestEntity>();
  for (const request of Object.values(entities.contextRequests)) {
    requestCountByRun.set(
      request.productRunId,
      (requestCountByRun.get(request.productRunId) ?? 0) + 1,
    );
    if (!requestByRun.has(request.productRunId)) requestByRun.set(request.productRunId, request);
  }

  const queryCountByRequest = new Map<string, number>();
  for (const query of Object.values(entities.memoryQueries)) {
    queryCountByRequest.set(
      query.contextRequestId,
      (queryCountByRequest.get(query.contextRequestId) ?? 0) + 1,
    );
  }

  const packageCountByQuery = new Map<string, number>();
  const packageItemCountBySnapshot = new Map<string, number>();
  for (const contextPackage of Object.values(entities.contextPackages)) {
    packageCountByQuery.set(
      contextPackage.memoryQueryId,
      (packageCountByQuery.get(contextPackage.memoryQueryId) ?? 0) + 1,
    );
    for (const item of contextPackage.items) {
      packageItemCountBySnapshot.set(
        item.memoryResultSnapshotId,
        (packageItemCountBySnapshot.get(item.memoryResultSnapshotId) ?? 0) + 1,
      );
    }
  }

  const adoptionsByPackage = new Map<string, MemoryAdoptionEntity[]>();
  const adoptionCountBySnapshot = new Map<string, number>();
  for (const adoption of Object.values(entities.memoryAdoptions)) {
    const packageAdoptions = adoptionsByPackage.get(adoption.contextPackageId) ?? [];
    packageAdoptions.push(adoption);
    adoptionsByPackage.set(adoption.contextPackageId, packageAdoptions);
    adoptionCountBySnapshot.set(
      adoption.memoryResultSnapshotId,
      (adoptionCountBySnapshot.get(adoption.memoryResultSnapshotId) ?? 0) + 1,
    );
  }

  const planningAttemptsByRun = new Map<string, PlanningAttemptEntity[]>();
  for (const attempt of Object.values(entities.attempts)) {
    if (attempt.kind !== "planning") continue;
    const attempts = planningAttemptsByRun.get(attempt.productRunId) ?? [];
    attempts.push(attempt);
    planningAttemptsByRun.set(attempt.productRunId, attempts);
  }

  return {
    requestCountByRun,
    requestByRun,
    queryCountByRequest,
    packageCountByQuery,
    adoptionsByPackage,
    packageItemCountBySnapshot,
    adoptionCountBySnapshot,
    planningAttemptsByRun,
  };
}

function assertContextRequests(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const request of Object.values(entities.contextRequests)) {
    if (request.updatedAt !== request.createdAt) {
      fail(`contextRequest ${request.contextRequestId} 不可变时间戳不一致`);
    }
    if (
      request.memory !== undefined &&
      (new Set(request.memory.tags).size !== request.memory.tags.length ||
        new Set(request.memory.layers).size !== request.memory.layers.length)
    ) {
      fail(`contextRequest ${request.contextRequestId} Memory选择包含重复项`);
    }
    const run = entities.runs[request.productRunId];
    const message = entities.messages[request.sourceMessageId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    if (run === undefined) {
      fail(`contextRequest ${request.contextRequestId} 悬空productRunId`);
    }
    if (
      message === undefined ||
      message.messageId !== run.sourceMessageId ||
      message.role !== "user" ||
      session === undefined ||
      session.ownerPrincipalId !== request.requestedByPrincipalId
    ) {
      fail(`contextRequest ${request.contextRequestId} 与Message/Principal不一致`);
    }
    const sourceMessageSha256 = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    if (sourceMessageSha256 !== request.sourceMessageSha256) {
      fail(`contextRequest ${request.contextRequestId} sourceMessageSha256不一致`);
    }
    if (request.schemaVersion === "run-context-request.v2") {
      const totalContentCharacters = request.workspaceInstructions.items.reduce(
        (total, item) => total + item.content.length,
        0,
      );
      if (totalContentCharacters !== request.workspaceInstructions.totalContentCharacters) {
        fail(`contextRequest ${request.contextRequestId} Workspace指令长度证据不一致`);
      }
      for (const item of request.workspaceInstructions.items) {
        if (computeWorkspaceInstructionItemSha256(item.content) !== item.sha256) {
          fail(`contextRequest ${request.contextRequestId} Workspace指令内容Hash不一致`);
        }
      }
      if (
        computeWorkspaceInstructionsSha256({
          items: request.workspaceInstructions.items,
          totalContentCharacters,
        }) !== request.workspaceInstructions.sha256
      ) {
        fail(`contextRequest ${request.contextRequestId} Workspace指令快照Hash不一致`);
      }
    }
    const requestSha256 = computeRunContextRequestSha256({
      productRunId: request.productRunId,
      requestedByPrincipalId: request.requestedByPrincipalId,
      sourceMessageId: request.sourceMessageId,
      sourceMessageSha256: request.sourceMessageSha256,
      ...(request.memory !== undefined ? { memory: request.memory } : {}),
      ...(request.schemaVersion === "run-context-request.v2"
        ? { workspaceInstructions: request.workspaceInstructions }
        : {}),
    });
    if (requestSha256 !== request.sha256) {
      fail(`contextRequest ${request.contextRequestId} Hash不一致`);
    }
  }
  for (const run of Object.values(entities.runs)) {
    if ((indexes.requestCountByRun.get(run.productRunId) ?? 0) !== 1) {
      fail(`run ${run.productRunId} 必须恰有一个ContextRequest`);
    }
  }
}

function assertMemoryQueries(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const query of Object.values(entities.memoryQueries)) {
    const request = entities.contextRequests[query.contextRequestId];
    if (
      request === undefined ||
      request.memory === undefined ||
      request.productRunId !== query.productRunId ||
      request.memory.backendId !== query.backendId ||
      request.memory.requirement !== query.requirement ||
      JSON.stringify(request.memory.tags) !== JSON.stringify(query.tags) ||
      JSON.stringify(request.memory.layers) !== JSON.stringify(query.layers) ||
      request.memory.limit !== query.limit ||
      request.memory.contextBudget !== query.contextBudget
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 与ContextRequest不一致`);
    }
    const run = entities.runs[query.productRunId];
    const message = run === undefined ? undefined : entities.messages[run.sourceMessageId];
    if (message === undefined) fail(`memoryQuery ${query.memoryQueryId} 源消息不存在`);
    const sourceHash = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    if (sourceHash !== query.sourceMessageSha256) {
      fail(`memoryQuery ${query.memoryQueryId} sourceMessageSha256不一致`);
    }
    if (query.planRevision !== 1) {
      fail(`memoryQuery ${query.memoryQueryId} 必须在首版规划前冻结`);
    }
    if (
      query.backendDescriptor.backendId !== query.backendId ||
      computeMemoryBackendDescriptorSha256(query.backendDescriptor) !==
        query.backendDescriptorSha256
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 后端描述证据不一致`);
    }
    const capabilityLayers = new Set(query.backendDescriptor.capabilities.layers);
    if (
      capabilityLayers.size !== query.backendDescriptor.capabilities.layers.length ||
      query.layers.some((layer) => !capabilityLayers.has(layer)) ||
      query.limit > query.backendDescriptor.capabilities.maxLimit ||
      query.contextBudget > query.backendDescriptor.capabilities.maxContextBudget
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 查询选择超出后端能力`);
    }
    if (
      new Set(query.tags).size !== query.tags.length ||
      new Set(query.layers).size !== query.layers.length
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 查询条件包含重复项`);
    }
    if (
      query.startedAt !== query.createdAt ||
      Date.parse(query.createdAt) < Date.parse(request.createdAt) ||
      (query.status === "pending" && query.updatedAt !== query.createdAt) ||
      (query.status !== "pending" &&
        (Date.parse(query.completedAt) < Date.parse(query.startedAt) ||
          query.updatedAt !== query.completedAt))
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 时间线倒置`);
    }
    if (query.status === "completed" && query.hitCount < query.adoptedCount) {
      fail(`memoryQuery ${query.memoryQueryId} hitCount小于adoptedCount`);
    }
  }
  for (const request of Object.values(entities.contextRequests)) {
    const queryCount = indexes.queryCountByRequest.get(request.contextRequestId) ?? 0;
    if (queryCount > 1 || (request.memory === undefined && queryCount !== 0)) {
      fail(`contextRequest ${request.contextRequestId} 与Memory Query数量不一致`);
    }
  }
}

function assertMemorySnapshots(entities: SnapshotEntities, fail: Fail): void {
  for (const memorySnapshot of Object.values(entities.memoryResultSnapshots)) {
    const query = entities.memoryQueries[memorySnapshot.memoryQueryId];
    if (
      query === undefined ||
      query.status !== "completed" ||
      query.backendId !== memorySnapshot.backendId
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 与Query不一致`);
    }
    if (
      memorySnapshot.updatedAt !== memorySnapshot.createdAt ||
      memorySnapshot.createdAt !== query.completedAt
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 时间线不一致`);
    }
    if (
      new Set(memorySnapshot.externalObjectIds).size !== memorySnapshot.externalObjectIds.length ||
      new Set(memorySnapshot.tags).size !== memorySnapshot.tags.length
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 包含重复来源或标签`);
    }
    if (estimateMemorySectionTokens(memorySnapshot) !== memorySnapshot.tokenEstimate) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} Token估算不一致`);
    }
    const expected = computeMemoryResultSnapshotSha256({
      backendId: memorySnapshot.backendId,
      externalObjectIds: memorySnapshot.externalObjectIds,
      title: memorySnapshot.title,
      kind: memorySnapshot.kind,
      memoryLayer: memorySnapshot.memoryLayer,
      content: memorySnapshot.content,
      tags: memorySnapshot.tags,
      ...(memorySnapshot.score !== undefined ? { score: memorySnapshot.score } : {}),
      ...(memorySnapshot.tokenEstimate !== undefined
        ? { tokenEstimate: memorySnapshot.tokenEstimate }
        : {}),
      ...(memorySnapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: memorySnapshot.sourceUpdatedAt }
        : {}),
    });
    if (expected !== memorySnapshot.sha256) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} Hash不一致`);
    }
  }
}

function assertContextPackages(entities: SnapshotEntities, fail: Fail): void {
  for (const contextPackage of Object.values(entities.contextPackages)) {
    const request = entities.contextRequests[contextPackage.contextRequestId];
    const query = entities.memoryQueries[contextPackage.memoryQueryId];
    if (
      request === undefined ||
      query === undefined ||
      request.productRunId !== contextPackage.productRunId ||
      query.productRunId !== contextPackage.productRunId ||
      query.contextRequestId !== contextPackage.contextRequestId ||
      query.status === "pending" ||
      contextPackage.assembledForPlanRevision !== query.planRevision
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 血缘不一致`);
    }
    if (
      contextPackage.updatedAt !== contextPackage.createdAt ||
      contextPackage.createdAt !== query.completedAt
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 时间线不一致`);
    }
    const seenSnapshots = new Set<string>();
    for (const item of contextPackage.items) {
      const memorySnapshot = entities.memoryResultSnapshots[item.memoryResultSnapshotId];
      if (
        memorySnapshot === undefined ||
        memorySnapshot.memoryQueryId !== query.memoryQueryId ||
        memorySnapshot.revision !== item.revision ||
        memorySnapshot.sha256 !== item.sha256 ||
        seenSnapshots.has(item.memoryResultSnapshotId)
      ) {
        fail(`contextPackage ${contextPackage.contextPackageId} item引用不一致`);
      }
      seenSnapshots.add(item.memoryResultSnapshotId);
    }
    if (query.status === "completed") {
      assertCompletedContextPackage(contextPackage, query, entities, fail);
    } else if (
      query.requirement !== "optional" ||
      contextPackage.items.length !== 0 ||
      contextPackage.exclusions.length !== 1 ||
      contextPackage.exclusions[0]?.backendId !== query.backendId ||
      contextPackage.exclusions[0]?.reasonCode !== query.errorCode
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} optional失败投影不一致`);
    }
    const expected = computeContextPackageSha256({
      contextRequestId: contextPackage.contextRequestId,
      productRunId: contextPackage.productRunId,
      assembledForPlanRevision: contextPackage.assembledForPlanRevision,
      purpose: contextPackage.purpose,
      memoryQueryId: contextPackage.memoryQueryId,
      items: contextPackage.items,
      exclusions: contextPackage.exclusions,
    });
    if (expected !== contextPackage.sha256) {
      fail(`contextPackage ${contextPackage.contextPackageId} Hash不一致`);
    }
  }
}

/** 完成态Query必须能从冻结Snapshot逐字重算结果证据，不能信任外部服务摘要。 */
function assertCompletedContextPackage(
  contextPackage: SnapshotEntities["contextPackages"][string],
  query: CompletedMemoryQueryEntity,
  entities: SnapshotEntities,
  fail: Fail,
): void {
  if (
    contextPackage.exclusions.length !== 0 ||
    query.adoptedCount !== contextPackage.items.length ||
    contextPackage.items.length > query.limit
  ) {
    fail(`contextPackage ${contextPackage.contextPackageId} 完成结果数量不一致`);
  }
  const snapshots = contextPackage.items.map(
    (item) => entities.memoryResultSnapshots[item.memoryResultSnapshotId],
  );
  if (snapshots.some((snapshot) => snapshot === undefined)) {
    fail(`contextPackage ${contextPackage.contextPackageId} 缺少Memory Snapshot`);
  }
  const presentSnapshots = snapshots.filter(
    (snapshot): snapshot is MemorySnapshotEntity => snapshot !== undefined,
  );
  const tokenEstimate = presentSnapshots.reduce(
    (total, snapshot) => total + estimateMemorySectionTokens(snapshot),
    0,
  );
  if (tokenEstimate > query.tokenEstimate || query.tokenEstimate > query.contextBudget) {
    fail(`contextPackage ${contextPackage.contextPackageId} 超预算或Token估算不一致`);
  }
  const resultSetSha256 = computeMemoryQueryResultSha256({
    externalQueryId: query.externalQueryId,
    hitCount: query.hitCount,
    tokenEstimate: query.tokenEstimate,
    sections: presentSnapshots.map((snapshot) => ({
      externalObjectIds: snapshot.externalObjectIds,
      title: snapshot.title,
      kind: snapshot.kind,
      memoryLayer: snapshot.memoryLayer,
      content: snapshot.content,
      tags: snapshot.tags,
      ...(snapshot.score !== undefined ? { score: snapshot.score } : {}),
      tokenEstimate: snapshot.tokenEstimate,
      ...(snapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: snapshot.sourceUpdatedAt }
        : {}),
    })),
  });
  if (resultSetSha256 !== query.resultSetSha256) {
    fail(`memoryQuery ${query.memoryQueryId} resultSetSha256不一致`);
  }
  const sourceCount = new Set(
    presentSnapshots.flatMap((memorySnapshot) => memorySnapshot.externalObjectIds),
  ).size;
  if (sourceCount > query.hitCount) {
    fail(`memoryQuery ${query.memoryQueryId} hitCount小于结果来源数量`);
  }
}

function assertMemoryAdoptions(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const adoption of Object.values(entities.memoryAdoptions)) {
    const contextPackage = entities.contextPackages[adoption.contextPackageId];
    const memorySnapshot = entities.memoryResultSnapshots[adoption.memoryResultSnapshotId];
    if (
      contextPackage === undefined ||
      memorySnapshot === undefined ||
      contextPackage.productRunId !== adoption.productRunId ||
      !contextPackage.items.some(
        (item) => item.memoryResultSnapshotId === adoption.memoryResultSnapshotId,
      ) ||
      memorySnapshot.memoryQueryId !== contextPackage.memoryQueryId
    ) {
      fail(`memoryAdoption ${adoption.memoryAdoptionId} 绑定不一致`);
    }
    if (
      adoption.updatedAt !== adoption.createdAt ||
      adoption.createdAt !== contextPackage.createdAt ||
      adoption.createdAt !== memorySnapshot.createdAt
    ) {
      fail(`memoryAdoption ${adoption.memoryAdoptionId} 时间线不一致`);
    }
  }
  for (const contextPackage of Object.values(entities.contextPackages)) {
    const adoptions = indexes.adoptionsByPackage.get(contextPackage.contextPackageId) ?? [];
    const adoptedIds = new Set(adoptions.map((adoption) => adoption.memoryResultSnapshotId));
    if (
      adoptions.length !== contextPackage.items.length ||
      adoptedIds.size !== contextPackage.items.length ||
      contextPackage.items.some((item) => !adoptedIds.has(item.memoryResultSnapshotId))
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 与Adoption不是一一对应`);
    }
  }
}

function assertLongTermContextCardinalityAndReuse(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const memorySnapshot of Object.values(entities.memoryResultSnapshots)) {
    const itemCount = indexes.packageItemCountBySnapshot.get(memorySnapshot.memoryResultSnapshotId);
    const adoptionCount = indexes.adoptionCountBySnapshot.get(
      memorySnapshot.memoryResultSnapshotId,
    );
    if (itemCount !== 1 || adoptionCount !== 1) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 必须恰好被采用一次`);
    }
  }

  for (const query of Object.values(entities.memoryQueries)) {
    const expectedPackages =
      query.status === "completed" ||
      (query.status === "failed" && query.requirement === "optional")
        ? 1
        : 0;
    if ((indexes.packageCountByQuery.get(query.memoryQueryId) ?? 0) !== expectedPackages) {
      fail(`memoryQuery ${query.memoryQueryId} 与ContextPackage数量不一致`);
    }
  }

  for (const run of Object.values(entities.runs)) {
    const request = indexes.requestByRun.get(run.productRunId);
    const planningAttempts = indexes.planningAttemptsByRun.get(run.productRunId) ?? [];
    if (
      request?.memory !== undefined &&
      planningAttempts.some((attempt) => attempt.contextPackageId === undefined)
    ) {
      fail(`run ${run.productRunId} 有ContextRequest但Planning Attempt缺少ContextPackage`);
    }
    const packageIds = new Set(
      planningAttempts.flatMap((attempt) =>
        attempt.contextPackageId === undefined ? [] : [attempt.contextPackageId],
      ),
    );
    if (packageIds.size > 1) {
      fail(`run ${run.productRunId} M1修订轮未复用同一ContextPackage`);
    }
  }
}

function assertRuns(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const planningLegal = new Set([
    "pending/queued",
    "running/planning",
    "running/executing",
    "running/validating",
    "waiting_human/plan_review",
    "succeeded/completed",
    "failed/queued",
    "failed/planning",
    "failed/plan_review",
    "failed/executing",
    "failed/validating",
    "cancelled/queued",
    "cancelled/planning",
    "cancelled/executing",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/planning",
    "outcome_unknown/executing",
    "outcome_unknown/validating",
  ]);
  const noteCaptureLegal = new Set([
    "pending/queued",
    "running/extracting",
    "running/classifying",
    "waiting_human/note_review",
    "running/committing",
    "succeeded/completed",
    "failed/queued",
    "failed/extracting",
    "failed/classifying",
    "failed/note_review",
    "failed/committing",
    "cancelled/queued",
    "cancelled/note_review",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/extracting",
    "outcome_unknown/classifying",
    "outcome_unknown/committing",
  ]);
  const directAgentLegal = new Set([
    "pending/queued",
    "running/executing",
    "waiting_human/prompt_review",
    "succeeded/completed",
    "failed/queued",
    "failed/executing",
    "failed/prompt_review",
    "cancelled/queued",
    "cancelled/executing",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/executing",
  ]);
  for (const run of Object.values(entities.runs)) {
    const legal =
      run.runKind === "note_capture"
        ? noteCaptureLegal
        : run.runKind === "direct_agent"
          ? directAgentLegal
          : planningLegal;
    if (!legal.has(`${run.status}/${run.phase}`)) fail(`run ${run.productRunId} 生命周期组合非法`);
    const session = entities.sessions[run.sessionId];
    const source = entities.messages[run.sourceMessageId];
    if (session === undefined) fail(`run ${run.productRunId} 悬空sessionId`);
    if (source === undefined) fail(`run ${run.productRunId} 悬空sourceMessageId`);
    if (source.sessionId !== run.sessionId || source.role !== "user") {
      fail(`run ${run.productRunId} 源消息必须是同Session的User Message`);
    }
    if (entities.workflowViewDefinitions[run.workflowViewDefinitionId] === undefined) {
      fail(`run ${run.productRunId} 悬空workflowViewDefinitionId`);
    }
    const view = entities.workflowViewDefinitions[run.workflowViewDefinitionId];
    if (run.runKind === "direct_agent") {
      const runSpec = entities.workflowRunSpecs[run.workflowRunSpecId];
      if (
        run.runnerFamily !== "direct-agent.v1" ||
        runSpec?.productRunId !== run.productRunId ||
        runSpec.definitionRef.blueprintKey !== "direct" ||
        runSpec.businessInput?.kind !== "direct_agent_message" ||
        view?.source.kind !== "published_definition"
      ) {
        fail(`run ${run.productRunId} direct_agent runner/RunSpec/View绑定不一致`);
      }
      const currentReview =
        run.currentPromptReviewRequestId === undefined
          ? undefined
          : entities.promptReviewRequests[run.currentPromptReviewRequestId];
      if (run.status === "waiting_human") {
        if (
          run.phase !== "prompt_review" ||
          currentReview === undefined ||
          currentReview.productRunId !== run.productRunId ||
          currentReview.status !== "open"
        ) {
          fail(`run ${run.productRunId} waiting_human缺少open Prompt Review`);
        }
      } else if (run.currentPromptReviewRequestId !== undefined) {
        fail(`run ${run.productRunId} 非waiting_human仍保留活动Prompt Review引用`);
      }

      const candidates = Object.values(entities.directAgentCandidates).filter(
        (candidate) => candidate.productRunId === run.productRunId,
      );
      if (candidates.length > 1) {
        fail(`run ${run.productRunId} P1不允许多个Direct Agent Candidate`);
      }
      const currentCandidate =
        run.currentDirectAgentCandidateId === undefined
          ? undefined
          : entities.directAgentCandidates[run.currentDirectAgentCandidateId];
      const finalCandidate =
        run.finalDirectAgentCandidateId === undefined
          ? undefined
          : entities.directAgentCandidates[run.finalDirectAgentCandidateId];
      if (
        (run.currentDirectAgentCandidateId !== undefined &&
          currentCandidate?.productRunId !== run.productRunId) ||
        (run.finalDirectAgentCandidateId !== undefined &&
          finalCandidate?.productRunId !== run.productRunId)
      ) {
        fail(`run ${run.productRunId} Direct Agent Candidate引用悬空或跨Run`);
      }
      const finalMessage =
        run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
      if (run.status === "succeeded") {
        if (
          currentCandidate === undefined ||
          finalCandidate === undefined ||
          currentCandidate.directAgentCandidateId !== finalCandidate.directAgentCandidateId ||
          finalMessage === undefined ||
          finalMessage.role !== "assistant" ||
          finalMessage.sourceRunId !== run.productRunId ||
          finalMessage.content.text !== finalCandidate.output.text
        ) {
          fail(`run ${run.productRunId} succeeded缺少候选到正式Message的确定性提交`);
        }
      } else if (
        run.finalDirectAgentCandidateId !== undefined ||
        run.finalMessageId !== undefined
      ) {
        fail(`run ${run.productRunId} 非succeeded不允许最终Candidate或Message引用`);
      }
      if (run.status === "failed" || run.status === "outcome_unknown") {
        if (run.failure === undefined) fail(`run ${run.productRunId} 失败终态缺少failure`);
      } else if (run.failure !== undefined) {
        fail(`run ${run.productRunId} 非失败终态不允许failure`);
      }
      const promptReviews = Object.values(entities.promptReviewRequests).filter(
        (request) => request.productRunId === run.productRunId,
      );
      if (
        ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(run.status) &&
        promptReviews.some((request) =>
          ["open", "approved", "dispatching"].includes(request.status),
        )
      ) {
        fail(`run ${run.productRunId} 终态遗留未闭合Prompt Review`);
      }
      const workflowAttempts = Object.values(entities.attempts).filter(
        (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
      );
      if (workflowAttempts.length !== 1) {
        fail(`run ${run.productRunId} 必须恰有一个workflow Attempt`);
      }
      const directAttempts = Object.values(entities.attempts).filter(
        (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "direct_agent",
      );
      if (run.status === "pending" ? directAttempts.length > 1 : directAttempts.length !== 1) {
        fail(`run ${run.productRunId} Direct Agent Attempt数量无效`);
      }
      if (run.status === "succeeded" && directAttempts[0]?.outcome !== "success") {
        fail(`run ${run.productRunId} succeeded必须绑定成功Direct Agent Attempt`);
      }
      continue;
    }
    if (run.runKind === "note_capture") {
      if (
        run.runnerFamily !== "note-capture.v1" ||
        run.workflowRunSpecId === undefined ||
        entities.workflowRunSpecs[run.workflowRunSpecId]?.productRunId !== run.productRunId ||
        view?.source.kind !== "published_definition"
      ) {
        fail(`run ${run.productRunId} note_capture runner/RunSpec/View绑定不一致`);
      }
      if (run.status === "succeeded") {
        const final =
          run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
        if (
          final === undefined ||
          final.role !== "assistant" ||
          final.sourceRunId !== run.productRunId
        ) {
          fail(`run ${run.productRunId} note_capture succeeded缺少绑定的Assistant Message`);
        }
      }
      continue;
    }
    if (run.runnerFamily === "legacy-planning.v1") {
      if (run.workflowRunSpecId !== undefined || view?.source.kind !== "legacy_code") {
        fail(`run ${run.productRunId} legacy runner不得绑定RunSpec且必须使用legacy View`);
      }
    } else if (run.runnerFamily === "configurable-planning.v1") {
      if (
        run.workflowRunSpecId === undefined ||
        entities.workflowRunSpecs[run.workflowRunSpecId]?.productRunId !== run.productRunId ||
        view?.source.kind !== "published_definition"
      ) {
        fail(`run ${run.productRunId} configurable runner缺少RunSpec或Published View`);
      }
    } else {
      fail(`run ${run.productRunId} 使用非正式Runner family`);
    }
    const currentFields = [run.currentPlanId, run.currentPlanRevision];
    if (currentFields.filter((value) => value !== undefined).length === 1) {
      fail(`run ${run.productRunId} currentPlan引用不完整`);
    }
    const currentPlan = Object.values(entities.plans).find(
      (plan) =>
        plan.planId === run.currentPlanId &&
        plan.planRevision === run.currentPlanRevision &&
        plan.productRunId === run.productRunId,
    );
    if (run.currentPlanId !== undefined && currentPlan === undefined) {
      fail(`run ${run.productRunId} 悬空currentPlan引用`);
    }
    const currentApproval =
      run.currentApprovalRequestId === undefined
        ? undefined
        : entities.approvalRequests[run.currentApprovalRequestId];
    if (run.currentApprovalRequestId !== undefined && currentApproval === undefined) {
      fail(`run ${run.productRunId} 悬空currentApprovalRequestId`);
    }
    if (run.status === "waiting_human") {
      if (currentPlan?.status !== "under_review" || currentApproval?.status !== "open") {
        fail(`run ${run.productRunId} waiting_human缺少当前Plan/Approval`);
      }
      if (
        currentApproval.planId !== currentPlan.planId ||
        currentApproval.planRevision !== currentPlan.planRevision ||
        currentApproval.planSha256 !== currentPlan.sha256
      ) {
        fail(`run ${run.productRunId} 当前Approval与Plan不一致`);
      }
    } else if (run.currentApprovalRequestId !== undefined) {
      fail(`run ${run.productRunId} 非waiting_human仍保留活动Approval引用`);
    }
    if (
      (run.phase === "executing" || run.phase === "validating" || run.status === "succeeded") &&
      currentPlan?.status !== "approved"
    ) {
      fail(`run ${run.productRunId} 执行/验证/成功阶段缺少Approved Plan`);
    }
    const final =
      run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
    if (run.status === "succeeded") {
      if (
        final === undefined ||
        final.role !== "assistant" ||
        final.sourceRunId !== run.productRunId
      ) {
        fail(`run ${run.productRunId} succeeded缺少绑定的Assistant Message`);
      }
      const contracts = Object.values(entities.executionContracts).filter(
        (contract) => contract.productRunId === run.productRunId,
      );
      const candidates = Object.values(entities.executionCandidates).filter(
        (candidate) => candidate.productRunId === run.productRunId,
      );
      if (contracts.length !== 1 || candidates.length !== 1) {
        fail(`run ${run.productRunId} succeeded必须恰有一个Contract与Candidate`);
      }
      const contract = contracts[0];
      const candidate = candidates[0];
      const passValidations = Object.values(entities.validationResults).filter(
        (validation) =>
          validation.productRunId === run.productRunId &&
          validation.executionContractId === contract?.executionContractId &&
          validation.executionCandidateId === candidate?.executionCandidateId &&
          validation.outcome === "pass",
      );
      if (passValidations.length !== 1) {
        fail(`run ${run.productRunId} succeeded缺少唯一pass Validation`);
      }
      const expectedMarkdown = candidate?.finalOutput.sections
        .map((section) => `## ${section.heading}\n\n${section.body}`)
        .join("\n\n");
      if (final.content.text !== expectedMarkdown) {
        fail(`run ${run.productRunId} Assistant Message不是已验证Candidate的确定性渲染`);
      }
    } else if (run.finalMessageId !== undefined) {
      fail(`run ${run.productRunId} 非succeeded不允许finalMessageId`);
    }
    if (run.status === "failed" || run.status === "outcome_unknown") {
      if (run.failure === undefined) fail(`run ${run.productRunId} 失败终态缺少failure`);
    } else if (run.failure !== undefined) {
      fail(`run ${run.productRunId} 非失败终态不允许failure`);
    }
    const workflowAttempts = Object.values(entities.attempts).filter(
      (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
    );
    if (workflowAttempts.length !== 1) fail(`run ${run.productRunId} 必须恰有一个workflow Attempt`);
  }
}

function assertPlansAndReviews(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const grouped = new Map<string, (typeof entities.plans)[string][]>();
  for (const plan of Object.values(entities.plans)) {
    const run = entities.runs[plan.productRunId];
    if (run === undefined) fail(`plan ${plan.planRevisionId} 悬空productRunId`);
    const attempt = entities.attempts[plan.planningAttemptId];
    if (
      attempt === undefined ||
      attempt.productRunId !== plan.productRunId ||
      attempt.kind !== "planning" ||
      attempt.planRevision !== plan.planRevision ||
      attempt.outcome !== "success"
    ) {
      fail(`plan ${plan.planRevisionId} 与planning Attempt不一致`);
    }
    const recomputed = computePlanSha256({
      planId: plan.planId,
      productRunId: plan.productRunId,
      planRevision: plan.planRevision,
      content: plan.content,
    });
    if (recomputed !== plan.sha256) fail(`plan ${plan.planRevisionId} Hash不一致`);
    const plans = grouped.get(plan.productRunId) ?? [];
    plans.push(plan);
    grouped.set(plan.productRunId, plans);
  }
  for (const [runId, plans] of grouped) {
    plans.sort((a, b) => a.planRevision - b.planRevision);
    const planIds = new Set(plans.map((plan) => plan.planId));
    if (planIds.size !== 1) fail(`run ${runId} 的Plan revision使用了多个planId`);
    for (let index = 0; index < plans.length; index += 1) {
      if (plans[index]?.planRevision !== index + 1) fail(`run ${runId} 的Plan revision不连续`);
    }
  }

  for (const revisionInput of Object.values(entities.revisionInputs)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === revisionInput.planId &&
        candidate.planRevision === revisionInput.planRevision,
    );
    if (plan === undefined || plan.productRunId !== revisionInput.productRunId) {
      fail(`revisionInput ${revisionInput.revisionInputId} 与Plan/Run不一致`);
    }
  }

  for (const approval of Object.values(entities.approvalRequests)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === approval.planId && candidate.planRevision === approval.planRevision,
    );
    if (
      plan === undefined ||
      plan.productRunId !== approval.productRunId ||
      plan.sha256 !== approval.planSha256
    ) {
      fail(`approval ${approval.approvalRequestId} 与Plan/Run/Hash不一致`);
    }
    if (Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) {
      fail(`approval ${approval.approvalRequestId} expiresAt无效`);
    }
    if (approval.status === "open") {
      if (approval.decidedByDecisionId !== undefined || approval.expiredAt !== undefined) {
        fail(`approval ${approval.approvalRequestId} open状态字段冲突`);
      }
    } else if (approval.status === "decided") {
      if (approval.decidedByDecisionId === undefined || approval.expiredAt !== undefined) {
        fail(`approval ${approval.approvalRequestId} decided状态字段不完整`);
      }
    } else if (approval.expiredAt === undefined || approval.decidedByDecisionId !== undefined) {
      fail(`approval ${approval.approvalRequestId} expired状态字段不完整`);
    }
  }

  for (const decision of Object.values(entities.decisions)) {
    const approval = entities.approvalRequests[decision.approvalRequestId];
    if (
      approval === undefined ||
      approval.productRunId !== decision.productRunId ||
      approval.planId !== decision.planId ||
      approval.planRevision !== decision.planRevision ||
      approval.planSha256 !== decision.planSha256 ||
      approval.status !== "decided" ||
      approval.decidedByDecisionId !== decision.decisionId
    ) {
      fail(`decision ${decision.decisionId} 与Approval绑定不完整`);
    }
    if (decision.kind === "request_revision") {
      const revisionInput =
        decision.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[decision.revisionInputId];
      if (
        revisionInput === undefined ||
        revisionInput.productRunId !== decision.productRunId ||
        revisionInput.planId !== decision.planId ||
        revisionInput.planRevision !== decision.planRevision ||
        decision.reason !== undefined
      ) {
        fail(`decision ${decision.decisionId} request_revision字段不一致`);
      }
    } else if (decision.revisionInputId !== undefined) {
      fail(`decision ${decision.decisionId} 非request_revision不允许revisionInputId`);
    }
    if (decision.kind !== "reject" && decision.reason !== undefined) {
      fail(`decision ${decision.decisionId} 非reject不允许reason`);
    }
  }
}

function assertPromptReviews(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const byAttempt = new Map<string, (typeof entities.promptReviewRequests)[string][]>();

  for (const request of Object.values(entities.promptReviewRequests)) {
    const run = entities.runs[request.productRunId];
    const attempt = entities.attempts[request.directAgentAttemptId];
    if (
      run?.runKind !== "direct_agent" ||
      attempt === undefined ||
      attempt.kind !== "direct_agent" ||
      attempt.productRunId !== request.productRunId
    ) {
      fail(`promptReviewRequest ${request.promptReviewRequestId} Run/Attempt绑定不一致`);
    }
    let payloadSha256: string;
    try {
      payloadSha256 = computePromptReviewPayloadSha256(request.canonicalPayloadJson);
    } catch (error) {
      fail(
        `promptReviewRequest ${request.promptReviewRequestId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (payloadSha256 !== request.payloadSha256) {
      fail(`promptReviewRequest ${request.promptReviewRequestId} Payload Hash不一致`);
    }
    const reviewSha256 = computePromptReviewSha256({
      promptReviewRequestId: request.promptReviewRequestId,
      productRunId: request.productRunId,
      directAgentAttemptId: request.directAgentAttemptId,
      requestIndex: request.requestIndex,
      requestKind: request.requestKind,
      providerId: request.providerId,
      modelId: request.modelId,
      endpointHost: request.endpointHost,
      requestRevision: request.requestRevision,
      payloadSha256: request.payloadSha256,
      rendererVersion: request.rendererVersion,
    });
    if (reviewSha256 !== request.reviewSha256) {
      fail(`promptReviewRequest ${request.promptReviewRequestId} Review Hash不一致`);
    }

    const decision =
      request.decidedByPromptReviewDecisionId === undefined
        ? undefined
        : entities.promptReviewDecisions[request.decidedByPromptReviewDecisionId];
    if (request.status === "open") {
      if (decision !== undefined || request.decidedByPromptReviewDecisionId !== undefined) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} open不得绑定Decision`);
      }
    } else if (request.status === "cancelled") {
      if (
        (request.decidedByPromptReviewDecisionId === undefined) !== (decision === undefined) ||
        (decision !== undefined &&
          (decision.kind !== "approve" ||
            decision.promptReviewRequestId !== request.promptReviewRequestId ||
            decision.productRunId !== request.productRunId ||
            decision.requestRevision !== request.requestRevision ||
            decision.reviewSha256 !== request.reviewSha256 ||
            decision.payloadSha256 !== request.payloadSha256))
      ) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} cancelled Decision绑定不完整`);
      }
    } else {
      if (
        decision === undefined ||
        decision.promptReviewRequestId !== request.promptReviewRequestId ||
        decision.productRunId !== request.productRunId ||
        decision.requestRevision !== request.requestRevision ||
        decision.reviewSha256 !== request.reviewSha256 ||
        decision.payloadSha256 !== request.payloadSha256
      ) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} Decision绑定不完整`);
      }
      if (
        (request.status === "rejected" && decision.kind !== "reject") ||
        (request.status !== "rejected" && decision.kind !== "approve")
      ) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} 状态与Decision不一致`);
      }
    }

    const requests = byAttempt.get(request.directAgentAttemptId) ?? [];
    requests.push(request);
    byAttempt.set(request.directAgentAttemptId, requests);
  }

  for (const [attemptId, requests] of byAttempt) {
    try {
      assertPromptReviewRequestIndexes(requests);
    } catch (error) {
      fail(
        `directAgentAttempt ${attemptId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const decision of Object.values(entities.promptReviewDecisions)) {
    const request = entities.promptReviewRequests[decision.promptReviewRequestId];
    const session =
      request === undefined
        ? undefined
        : entities.sessions[entities.runs[request.productRunId]?.sessionId ?? ""];
    if (
      request === undefined ||
      request.decidedByPromptReviewDecisionId !== decision.promptReviewDecisionId ||
      request.status === "open" ||
      decision.productRunId !== request.productRunId ||
      decision.requestRevision !== request.requestRevision ||
      decision.reviewSha256 !== request.reviewSha256 ||
      decision.payloadSha256 !== request.payloadSha256 ||
      session?.ownerPrincipalId !== decision.principalId
    ) {
      fail(`promptReviewDecision ${decision.promptReviewDecisionId} Request/Principal绑定不完整`);
    }
  }
}

function assertDirectAgentCandidates(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const candidate of Object.values(entities.directAgentCandidates)) {
    const run = entities.runs[candidate.productRunId];
    const attempt = entities.attempts[candidate.directAgentAttemptId];
    if (
      run?.runKind !== "direct_agent" ||
      attempt === undefined ||
      attempt.kind !== "direct_agent" ||
      attempt.productRunId !== candidate.productRunId ||
      attempt.outcome !== "success"
    ) {
      fail(`directAgentCandidate ${candidate.directAgentCandidateId} Run/Attempt绑定不一致`);
    }
    const sha256 = computeDirectAgentCandidateSha256({
      directAgentCandidateId: candidate.directAgentCandidateId,
      productRunId: candidate.productRunId,
      directAgentAttemptId: candidate.directAgentAttemptId,
      output: candidate.output,
    });
    if (sha256 !== candidate.sha256) {
      fail(`directAgentCandidate ${candidate.directAgentCandidateId} Hash不一致`);
    }
  }
}

function assertExecution(snapshot: ProductSnapshot, fail: Fail): void {
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

function assertReceiptsAndOutbox(snapshot: ProductSnapshot, fail: Fail): void {
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
    // SubmitUserMessage在下方按Run保存的runner family区分历史/正式configurable形状。
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
    CommitRejectedRun: ["productRunId"],
    ExpireApproval: ["status"],
    CommitRunFailure: ["productRunId"],
    UpdateOutboxStatus: [],
    FailOutboxAndRun: ["productRunId"],
    CommitRunOutcomeUnknown: ["productRunId"],
    TransitionConfigurablePlanningNode: ["workflowNodeRunId"],
    CopyWorkflowDefinition: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    SaveWorkflowDefinitionDraft: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    PublishWorkflowDefinition: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    ChangeWorkflowDefinitionArchiveStatus: ["workflowDefinitionId", "workflowDefinitionRevisionId"],
    SettleIncompatibleWorkflowRun: ["productRunId"],
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
    ChangePromptFragmentArchiveStatus: ["promptFragmentId", "promptFragmentRevisionId"],
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
      receipt.commandType === "SubmitUserMessage"
        ? receiptRun?.runnerFamily === "legacy-planning.v1"
          ? ["messageId", "productRunId"]
          : ["messageId", "productRunId", "workflowRunSpecId"]
        : receipt.commandType === "SubmitPlanDecision"
          ? receipt.resultRefs["approvalExpired"] === "true"
            ? ["approvalExpired", "productRunId"]
            : ["decisionId", "productRunId"]
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
                            : key === "promptReviewRequestId"
                              ? entities.promptReviewRequests[value] !== undefined
                              : key === "promptReviewDecisionId"
                                ? entities.promptReviewDecisions[value] !== undefined
                                : key === "directAgentCandidateId"
                                  ? entities.directAgentCandidates[value] !== undefined
                                  : key === "promptFragmentId"
                                    ? entities.promptFragments[value] !== undefined
                                    : key === "promptFragmentRevisionId"
                                      ? entities.promptFragmentRevisions[value] !== undefined
                                      : key === "executionContractId"
                                        ? entities.executionContracts[value] !== undefined
                                        : key === "executionCandidateId"
                                          ? entities.executionCandidates[value] !== undefined
                                          : key === "validationResultId"
                                            ? entities.validationResults[value] !== undefined
                                            : key === "workflowNodeRunId"
                                              ? entities.workflowNodeRuns[value] !== undefined
                                              : key === "memoryQueryId"
                                                ? entities.memoryQueries[value] !== undefined
                                                : key === "contextRequestId"
                                                  ? entities.contextRequests[value] !== undefined
                                                  : key === "contextPackageId"
                                                    ? entities.contextPackages[value] !== undefined
                                                    : key === "memoryImportIntentId"
                                                      ? entities.memoryImportIntents[value] !==
                                                        undefined
                                                      : key === "memoryImportResultId"
                                                        ? entities.memoryImportResults[value] !==
                                                          undefined
                                                        : key === "workflowMemoryQueryId"
                                                          ? entities.workflowMemoryQueries[
                                                              value
                                                            ] !== undefined
                                                          : key === "workflowMemoryContextId"
                                                            ? entities.workflowMemoryContexts[
                                                                value
                                                              ] !== undefined
                                                            : key === "memoryWriteIntentId"
                                                              ? entities.memoryWriteIntents[
                                                                  value
                                                                ] !== undefined
                                                              : key === "memoryWriteResultId"
                                                                ? entities.memoryWriteResults[
                                                                    value
                                                                  ] !== undefined
                                                                : key === "outboxId" ||
                                                                    key === "recoveryOutboxId"
                                                                  ? snapshot.outbox[value] !==
                                                                    undefined
                                                                  : key === "projectId"
                                                                    ? entities.projects[value] !==
                                                                      undefined
                                                                    : key === "projectCandidateId"
                                                                      ? entities.projectCandidates[
                                                                          value
                                                                        ] !== undefined
                                                                      : key === "projectStageId"
                                                                        ? entities.projectStages[
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
                                                                              ] !== undefined
                                                                            : key ===
                                                                                "projectDecisionId"
                                                                              ? entities
                                                                                  .projectDecisions[
                                                                                  value
                                                                                ] !== undefined
                                                                              : key ===
                                                                                  "projectStateTransitionId"
                                                                                ? entities
                                                                                    .projectStateTransitions[
                                                                                    value
                                                                                  ] !== undefined
                                                                                : key ===
                                                                                    "projectContributionId"
                                                                                  ? entities
                                                                                      .projectContributions[
                                                                                      value
                                                                                    ] !== undefined
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
    if (receipt.commandType === "SubmitUserMessage") {
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
  for (const entry of Object.values(snapshot.outbox)) {
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
