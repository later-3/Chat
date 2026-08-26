import { type ProductSnapshot } from "@chat/contracts";
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
  hashCanonical,
  assertWorkflowNodeRunTimestamps,
  assertPersistedWorkflowNodeTransition,
  assertWorkflowViewDefinition,
  computeNodeValueManifestSha256,
  workflowNodeRunIdentityKey,
  computeWorkflowProjectResourceSha256,
  computePromptReviewDecisionSha256,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertWorkflowDefinitions(snapshot: ProductSnapshot, fail: Fail): void {
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

export function assertWorkflowProjection(snapshot: ProductSnapshot, fail: Fail): void {
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
          strictEvidence: target.strictEvidence,
          governanceReview: target.governanceReview,
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
