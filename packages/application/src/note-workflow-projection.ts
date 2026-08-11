import {
  nodeRunTransitionSchema,
  nodeValueManifestSchema,
  workflowExecutionPathSegmentSchema,
  workflowNodeRunSchema,
  type NodeProductRef,
  type NodeValueManifestSlot,
  type NoteCandidate,
  type NoteDecision,
  type NoteRevision,
  type ProductRunId,
  type WorkflowNodeRun,
  type WorkflowNodeRunStatus,
  type WorkflowPolicyResolution,
  type WorkflowRunSpec,
} from "@chat/contracts";
import {
  computeNodeValueManifestSha256,
  createNodeValueManifest,
  createWorkflowNodeRun,
  hashCanonical,
  transitionWorkflowNodeRun,
  workflowNodeRunIdentityKey,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { revisionConflict } from "./errors.js";
import { findNoteNodeResolution } from "./note-candidate-policy.js";
import type { NoteCaptureProductRun } from "./product-run-kind.js";

type DraftSnapshot = Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0];

/**
 * Note产品事实到NodeRun/Manifest的唯一投影边界。它只修改调用方事务传入的draft，
 * 不打开第二个事务；因此Candidate、Decision、Revision与节点证据仍能整体提交或整体回滚。
 */
export function noteCandidateRef(candidate: NoteCandidate): NodeProductRef {
  return {
    kind: "note_candidate",
    id: candidate.noteCandidateId,
    revision: candidate.revision,
    sha256: candidate.sha256,
    label: `Note候选 #${String(candidate.candidateSequence)}`,
  };
}

function noteDecisionSha256(decision: NoteDecision): string {
  return hashCanonical("note-decision.v1", {
    productRunId: decision.productRunId,
    noteCandidateId: decision.noteCandidateId,
    candidateRevision: decision.candidateRevision,
    candidateSha256: decision.candidateSha256,
    kind: decision.kind,
    ...(decision.kind === "request_revision"
      ? { revisionInstruction: decision.revisionInstruction }
      : {}),
    ...(decision.kind === "reject" && decision.reason !== undefined
      ? { reason: decision.reason }
      : {}),
    principalId: decision.principalId,
    commandId: decision.commandId,
  });
}

export function noteDecisionRef(decision: NoteDecision): NodeProductRef {
  return {
    kind: "note_decision",
    id: decision.noteDecisionId,
    revision: decision.revision,
    sha256: noteDecisionSha256(decision),
    label:
      decision.kind === "confirm"
        ? "已确认Note候选"
        : decision.kind === "request_revision"
          ? "要求修订Note候选"
          : "已拒绝Note候选",
  };
}

export function workflowPolicyResolutionRef(resolution: WorkflowPolicyResolution): NodeProductRef {
  return {
    kind: "workflow_policy_resolution",
    id: resolution.workflowPolicyResolutionId,
    revision: resolution.revision,
    sha256: resolution.sha256,
    label: resolution.outcome === "allowed" ? "系统策略允许自动继续" : "系统策略要求人工审核",
  };
}

export function noteRevisionRef(revision: NoteRevision): NodeProductRef {
  return {
    kind: "note_revision",
    id: revision.noteRevisionId,
    revision: revision.noteRevision,
    sha256: revision.sha256,
    label: `已保存Note v${String(revision.noteRevision)}`,
  };
}

function deriveNoteNodeRunId(input: {
  readonly productRunId: ProductRunId;
  readonly definitionNodeId: string;
  readonly executionPath: WorkflowNodeRun["executionPath"];
  readonly attemptNumber: number;
}): string {
  return `wnr_${workflowNodeRunIdentityKey(input).slice(0, 32)}`;
}

function deriveNoteTransitionId(workflowNodeRunId: string, sequence: number): string {
  return `wnt_${hashCanonical("id.node-transition.v1", { workflowNodeRunId, sequence }).slice(0, 32)}`;
}

function deriveNoteManifestId(workflowNodeRunId: string, direction: "input" | "output"): string {
  return `wvm_${hashCanonical("id.node-value-manifest.v1", { workflowNodeRunId, direction }).slice(0, 32)}`;
}

function noteTransitionReason(status: WorkflowNodeRunStatus, current: WorkflowNodeRunStatus) {
  if (status === "running") return current === "waiting_human" ? "resumed" : "started";
  if (status === "waiting_human") return "waiting_human";
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "outcome_unknown";
}

function transitionCount(draft: DraftSnapshot, nodeRunId: string): number {
  return Object.values(draft.entities.nodeRunTransitions).filter(
    (transition) => transition.workflowNodeRunId === nodeRunId,
  ).length;
}

function upsertNoteManifest(
  draft: DraftSnapshot,
  nodeRun: WorkflowNodeRun,
  direction: "input" | "output",
  slots: readonly NodeValueManifestSlot[],
  at: string,
): string | undefined {
  if (slots.length === 0) return undefined;
  const nodeValueManifestId = deriveNoteManifestId(nodeRun.workflowNodeRunId, direction);
  const copiedSlots = slots.map((slot) => ({
    ...slot,
    refs: slot.refs.map((ref) => ({ ...ref })),
  }));
  const existing = draft.entities.nodeValueManifests[nodeValueManifestId];
  if (existing === undefined) {
    draft.entities.nodeValueManifests[nodeValueManifestId] = nodeValueManifestSchema.parse(
      createNodeValueManifest({
        nodeValueManifestId,
        workflowNodeRunId: nodeRun.workflowNodeRunId,
        direction,
        slots: copiedSlots,
        at,
      }),
    );
  } else {
    const sha256 = computeNodeValueManifestSha256({
      workflowNodeRunId: nodeRun.workflowNodeRunId,
      direction,
      slots: copiedSlots,
    });
    if (existing.sha256 !== sha256) {
      throw revisionConflict("Note Node Manifest已冻结且内容不同");
    }
  }
  return nodeValueManifestId;
}

function findNoteNodeExecutionPath(
  runSpec: WorkflowRunSpec,
  definitionNodeId: string,
  iteration: number,
): WorkflowNodeRun["executionPath"] {
  const stack: {
    readonly sequence: WorkflowRunSpec["semanticRoot"];
    readonly path: WorkflowNodeRun["executionPath"];
  }[] = [{ sequence: runSpec.semanticRoot, path: [] }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    for (let index = frame.sequence.elements.length - 1; index >= 0; index -= 1) {
      const element = frame.sequence.elements[index];
      if (element === undefined) continue;
      if (element.kind === "task" || element.kind === "composite") {
        if (element.definitionNodeId === definitionNodeId) return frame.path;
      } else if (element.kind === "sequence") {
        stack.push({ sequence: element, path: frame.path });
      } else if (element.kind === "choice") {
        for (let branchIndex = element.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const branch = element.branches[branchIndex];
          if (branch !== undefined) stack.push({ sequence: branch.body, path: frame.path });
        }
      } else {
        if (iteration > element.maxIterations) {
          throw revisionConflict("Note候选修订轮次超过Workflow定义上限");
        }
        stack.push({
          sequence: element.body,
          path: [
            ...frame.path,
            workflowExecutionPathSegmentSchema.parse({
              containerNodeId: `${element.outcomeFromDefinitionNodeId}.loop`,
              iteration,
            }),
          ],
        });
      }
    }
  }
  throw revisionConflict(`Note RunSpec节点路径不存在:${definitionNodeId}`);
}

export function projectNoteNode(
  draft: DraftSnapshot,
  input: {
    readonly run: NoteCaptureProductRun;
    readonly nodeType: "human.note_review" | "note.commit";
    readonly iteration: number;
    readonly toStatus: Extract<WorkflowNodeRunStatus, "waiting_human" | "succeeded" | "cancelled">;
    readonly outcomeCode?: string;
    readonly publicSummary: string;
    readonly inputSlots: readonly NodeValueManifestSlot[];
    readonly outputSlots: readonly NodeValueManifestSlot[];
    readonly relatedProductRef?: NodeProductRef;
    readonly at: string;
  },
): WorkflowNodeRun {
  const workflowRunSpecId = input.run.workflowRunSpecId;
  if (workflowRunSpecId === undefined) throw revisionConflict("Note Run缺少Workflow RunSpec");
  const runSpec = draft.entities.workflowRunSpecs[workflowRunSpecId];
  if (
    runSpec === undefined ||
    runSpec.productRunId !== input.run.productRunId ||
    runSpec.businessInput?.kind !== "note_capture"
  ) {
    throw revisionConflict("Note RunSpec绑定不一致");
  }
  const node = findNoteNodeResolution(runSpec, input.nodeType);
  const executionPath = findNoteNodeExecutionPath(runSpec, node.definitionNodeId, input.iteration);
  const workflowNodeRunId = deriveNoteNodeRunId({
    productRunId: input.run.productRunId,
    definitionNodeId: node.definitionNodeId,
    executionPath,
    attemptNumber: 1,
  });
  let nodeRun: WorkflowNodeRun | undefined = draft.entities.workflowNodeRuns[workflowNodeRunId];
  if (nodeRun === undefined) {
    const initial = createWorkflowNodeRun({
      nodeRun: {
        workflowNodeRunId,
        productRunId: input.run.productRunId,
        workflowViewDefinitionId: input.run.workflowViewDefinitionId,
        definitionNodeId: node.definitionNodeId,
        nodeType: node.nodeType,
        nodeSchemaVersion: String(node.schemaVersion),
        executionPath,
        attemptNumber: 1,
      },
      transitionId: deriveNoteTransitionId(workflowNodeRunId, 1),
      at: input.at,
      projectionSource: "runtime",
    });
    nodeRun = workflowNodeRunSchema.parse(initial.nodeRun);
    draft.entities.workflowNodeRuns[workflowNodeRunId] = nodeRun;
    draft.entities.nodeRunTransitions[initial.transition.nodeRunTransitionId] =
      nodeRunTransitionSchema.parse(initial.transition);
  }
  let currentNodeRun = nodeRun;
  const apply = (
    toStatus: WorkflowNodeRunStatus,
    relatedProductRef: NodeProductRef | undefined,
  ) => {
    if (currentNodeRun.status === toStatus) return;
    const sequence = transitionCount(draft, currentNodeRun.workflowNodeRunId) + 1;
    const transitioned = transitionWorkflowNodeRun(currentNodeRun, {
      transitionId: deriveNoteTransitionId(currentNodeRun.workflowNodeRunId, sequence),
      nodeSequence: sequence,
      toStatus,
      reasonKind: noteTransitionReason(toStatus, currentNodeRun.status),
      at: input.at,
      ...(toStatus === input.toStatus && input.outcomeCode !== undefined
        ? { outcomeCode: input.outcomeCode }
        : {}),
      ...(toStatus === input.toStatus ? { publicSummary: input.publicSummary } : {}),
      ...(relatedProductRef !== undefined ? { relatedProductRef } : {}),
    });
    draft.entities.nodeRunTransitions[transitioned.transition.nodeRunTransitionId] =
      nodeRunTransitionSchema.parse(transitioned.transition);
    currentNodeRun = workflowNodeRunSchema.parse(transitioned.nodeRun);
    draft.entities.workflowNodeRuns[currentNodeRun.workflowNodeRunId] = currentNodeRun;
  };
  if (
    currentNodeRun.status === "queued" &&
    !["running", "skipped", "cancelled", "failed"].includes(input.toStatus)
  ) {
    apply("running", undefined);
  }
  if (
    currentNodeRun.status === "waiting_human" &&
    input.toStatus === "succeeded" &&
    input.relatedProductRef !== undefined
  ) {
    apply("running", input.relatedProductRef);
  }
  apply(input.toStatus, input.relatedProductRef);
  const inputManifestId = upsertNoteManifest(
    draft,
    currentNodeRun,
    "input",
    input.inputSlots,
    input.at,
  );
  const outputManifestId = upsertNoteManifest(
    draft,
    currentNodeRun,
    "output",
    input.outputSlots,
    input.at,
  );
  const manifestsChanged =
    currentNodeRun.inputManifestId !== inputManifestId ||
    currentNodeRun.outputManifestId !== outputManifestId;
  const withManifests = workflowNodeRunSchema.parse({
    ...currentNodeRun,
    ...(inputManifestId !== undefined ? { inputManifestId } : {}),
    ...(outputManifestId !== undefined ? { outputManifestId } : {}),
    revision: manifestsChanged ? currentNodeRun.revision + 1 : currentNodeRun.revision,
    updatedAt: manifestsChanged ? input.at : currentNodeRun.updatedAt,
  });
  draft.entities.workflowNodeRuns[withManifests.workflowNodeRunId] = withManifests;
  return withManifests;
}
