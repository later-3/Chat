import {
  noteCandidateSchema,
  workflowPolicyResolutionIdSchema,
  workflowPolicyResolutionSchema,
  type NoteCandidate,
  type ProductEntities,
  type ProductRunId,
  type WorkflowPolicyResolution,
  type WorkflowRunSpec,
} from "@chat/contracts";
import {
  assertNoteCandidateTransition,
  assertWorkflowPolicyResolutionIntegrity,
  computeNoteSourceMessageSha256,
  computeWorkflowPolicyResolutionSha256,
  evaluateNoteLowRiskAutoPolicy,
  hashCanonical,
  NOTE_LOW_RISK_AUTO_POLICY_REVISION,
  NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID,
  NOTE_LOW_RISK_AUTO_POLICY_SHA256,
  NOTE_LOW_RISK_AUTO_POLICY_VERSION,
  resolveNoteSourceText,
} from "@chat/domain";
import { ApplicationError, revisionConflict } from "./errors.js";
import type { NoteCaptureProductRun } from "./product-run-kind.js";

/**
 * Candidate来源与Policy解析都是已冻结RunSpec上的确定性计算；调用方仍在自己的
 * Product Store事务中提交Candidate、Resolution、Run与Node事实。
 */
export function deriveCandidateSourceRefsFromRunSpec(
  entities: ProductEntities,
  run: NoteCaptureProductRun,
): NoteCandidate["sourceRefs"] {
  return [deriveNoteCaptureInputFromRunSpec(entities, run).source];
}

export function deriveNoteCaptureInputFromRunSpec(
  entities: ProductEntities,
  run: NoteCaptureProductRun,
) {
  if (run.workflowRunSpecId === undefined) {
    throw revisionConflict("Note Capture运行缺少Workflow RunSpec绑定");
  }
  const runSpec = entities.workflowRunSpecs[run.workflowRunSpecId];
  if (runSpec === undefined || runSpec.productRunId !== run.productRunId) {
    throw revisionConflict("Note Capture RunSpec绑定无效");
  }
  if (
    runSpec.runner.runnerFamily !== run.runnerFamily ||
    runSpec.runner.runnerBundleVersion !== run.runnerBundleVersion
  ) {
    throw revisionConflict("Note Capture RunSpec Runner证据与Run不一致");
  }
  const businessInput = runSpec.businessInput;
  if (businessInput?.kind !== "note_capture") {
    throw revisionConflict("Note Capture RunSpec缺少业务输入");
  }
  const sourceRef = businessInput.source;
  if (sourceRef.sourceMessageId !== run.sourceMessageId) {
    throw revisionConflict("Note来源Message必须绑定当前Product Run");
  }
  const message = entities.messages[sourceRef.sourceMessageId];
  if (message === undefined || message.sessionId !== run.sessionId || message.role !== "user") {
    throw revisionConflict("Note来源Message不存在或不属于当前会话");
  }
  try {
    const text = resolveNoteSourceText({ message, sourceRef });
    if (
      sourceRef.kind === "full_message" &&
      sourceRef.sourceMessageSha256 !== computeNoteSourceMessageSha256(message)
    ) {
      throw new Error("source_hash_mismatch");
    }
    if (sourceRef.kind === "utf16_range" && text.length === 0) {
      throw new Error("source_selection_empty");
    }
  } catch {
    throw revisionConflict("Note来源Message/选区Hash与RunSpec不一致");
  }
  return {
    source: { ...sourceRef },
    sourceText: resolveNoteSourceText({ message, sourceRef }),
    defaultKind: businessInput.defaultKind,
    suggestedTagLabels: businessInput.suggestedTags.map((tag) => tag.label),
  };
}

export function latestCandidate(
  entities: ProductEntities,
  productRunId: ProductRunId,
  status: NoteCandidate["status"],
): NoteCandidate | undefined {
  return Object.values(entities.noteCandidates)
    .filter((candidate) => candidate.productRunId === productRunId && candidate.status === status)
    .sort((left, right) => right.candidateSequence - left.candidateSequence)[0];
}

export function findNoteNodeResolution(
  runSpec: WorkflowRunSpec,
  nodeType: "human.note_review" | "note.commit",
) {
  const node = runSpec.nodeResolutions.find((candidate) => candidate.nodeType === nodeType);
  if (node === undefined || node.activation === "skipped") {
    throw revisionConflict(`Note RunSpec缺少可执行节点:${nodeType}`);
  }
  return node;
}

export function resolveNoteReviewMode(runSpec: WorkflowRunSpec):
  | { readonly mode: "manual" }
  | {
      readonly mode: "auto_continue_if_policy_allows";
      readonly definitionNodeId: string;
    } {
  const node = findNoteNodeResolution(runSpec, "human.note_review");
  const resolution = runSpec.reviewResolutions.find(
    (candidate) => candidate.definitionNodeId === node.definitionNodeId,
  );
  const policyRef = resolution?.policyRef;
  if (resolution?.mode === "manual" && resolution.actor === "user") return { mode: "manual" };
  if (
    resolution?.mode === "auto_continue_if_policy_allows" &&
    resolution.actor === "system_policy" &&
    policyRef !== undefined &&
    policyRef.resourceId === NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID &&
    policyRef.revision === NOTE_LOW_RISK_AUTO_POLICY_REVISION &&
    policyRef.sha256 === NOTE_LOW_RISK_AUTO_POLICY_SHA256
  ) {
    return { mode: resolution.mode, definitionNodeId: node.definitionNodeId };
  }
  throw revisionConflict("Note Review Resolution不存在或策略证据已损坏");
}

export function assertNoteClassifyTagPolicy(
  runSpec: WorkflowRunSpec,
  proposedTags: readonly { readonly key: string }[],
): void {
  const resolution = runSpec.nodeResolutions.find(
    (candidate) => candidate.nodeType === "note.classify",
  );
  const allowCustomTags = resolution?.config["allowCustomTags"];
  if (
    resolution === undefined ||
    resolution.activation === "skipped" ||
    typeof allowCustomTags !== "boolean"
  ) {
    throw revisionConflict("Note Classify冻结配置不存在或已损坏");
  }
  if (allowCustomTags) return;
  if (runSpec.businessInput?.kind !== "note_capture") {
    throw revisionConflict("Note Classify缺少Note业务输入");
  }
  const allowedKeys = new Set(runSpec.businessInput.suggestedTags.map((tag) => tag.key));
  if (proposedTags.some((tag) => !allowedKeys.has(tag.key))) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "当前Workflow不允许Candidate添加建议集合之外的自定义标签",
    });
  }
}

export function applyNoteLowRiskPolicy(input: {
  readonly candidate: NoteCandidate;
  readonly runSpec: WorkflowRunSpec;
  readonly definitionNodeId: string;
  readonly policyAt: string;
}): {
  readonly policyCandidate: NoteCandidate;
  readonly resolution: WorkflowPolicyResolution;
} {
  const policyOutcome = evaluateNoteLowRiskAutoPolicy(input.candidate);
  const policyCandidate: NoteCandidate =
    policyOutcome.outcome === "allowed"
      ? noteCandidateSchema.parse({
          ...input.candidate,
          status: "confirmed",
          revision: input.candidate.revision + 1,
          updatedAt: input.policyAt,
        })
      : input.candidate;
  if (policyOutcome.outcome === "allowed") {
    assertNoteCandidateTransition({ current: input.candidate, next: policyCandidate });
  }
  const workflowPolicyResolutionId = workflowPolicyResolutionIdSchema.parse(
    `wpr_${hashCanonical("id.workflow-policy-resolution.v1", {
      productRunId: input.runSpec.productRunId,
      workflowRunSpecId: input.runSpec.workflowRunSpecId,
      definitionNodeId: input.definitionNodeId,
      noteCandidateId: input.candidate.noteCandidateId,
    }).slice(0, 32)}`,
  );
  const resolutionInput = {
    productRunId: input.runSpec.productRunId,
    workflowRunSpecId: input.runSpec.workflowRunSpecId,
    workflowRunSpecSha256: input.runSpec.sha256,
    definitionNodeId: input.definitionNodeId,
    noteCandidateId: policyCandidate.noteCandidateId,
    candidateRevision: policyCandidate.revision,
    candidateSha256: policyCandidate.sha256,
    reviewMode: "auto_continue_if_policy_allows" as const,
    policyVersion: NOTE_LOW_RISK_AUTO_POLICY_VERSION,
    policySha256: NOTE_LOW_RISK_AUTO_POLICY_SHA256,
    ...policyOutcome,
  };
  const resolution = workflowPolicyResolutionSchema.parse({
    schemaVersion: "workflow-policy-resolution.v1",
    workflowPolicyResolutionId,
    ...resolutionInput,
    sha256: computeWorkflowPolicyResolutionSha256(resolutionInput),
    revision: 1,
    createdAt: input.policyAt,
    updatedAt: input.policyAt,
  });
  assertWorkflowPolicyResolutionIntegrity(resolution);
  return { policyCandidate, resolution };
}
