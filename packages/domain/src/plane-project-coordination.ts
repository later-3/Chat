import { canonicalJsonStringify, hashCanonical } from "./canonical-hash.js";

export type PlaneProjectOperationKindShape =
  "ensure_work_item" | "start" | "block" | "request_review" | "progress" | "evidence";

export type PlaneProjectOperationStatusShape =
  "queued" | "dispatching" | "completed" | "failed" | "needs_attention" | "outcome_unknown";

interface PlaneIntentIdentityShape {
  readonly externalSource: "later-agent";
  readonly externalId: string;
  readonly taskKey: string;
}

export type PlaneProjectOperationIntentShape =
  | (PlaneIntentIdentityShape & {
      readonly kind: "ensure_work_item";
      readonly name: string;
      readonly description: string;
      readonly priority: "none" | "urgent" | "high" | "medium" | "low";
      readonly stateName: string;
      readonly stateGroup: "backlog" | "unstarted" | "started";
      readonly moduleIds?: readonly string[] | undefined;
      readonly labelIds?: readonly string[] | undefined;
    })
  | (PlaneIntentIdentityShape & {
      readonly kind: "start";
      readonly planeWorkItemId: string;
      readonly expectedPlaneStateId: string;
      readonly stateName: string;
      readonly stateGroup: "started";
      readonly branch: string;
      readonly labelIds?: readonly string[] | undefined;
      readonly managedLabelIds?: readonly string[] | undefined;
    })
  | (PlaneIntentIdentityShape & {
      readonly kind: "block";
      readonly planeWorkItemId: string;
      readonly expectedPlaneStateId: string;
      readonly stateName: string;
      readonly stateGroup: "started";
      readonly commentExternalId: string;
      readonly message: string;
      readonly branch: string;
      readonly evidenceIds: readonly string[];
    })
  | (PlaneIntentIdentityShape & {
      readonly kind: "request_review";
      readonly planeWorkItemId: string;
      readonly expectedPlaneStateId: string;
      readonly stateName: string;
      readonly stateGroup: "started";
      readonly commentExternalId: string;
      readonly message: string;
      readonly branch: string;
      readonly commitSha?: string | undefined;
      readonly testSummary?: string | undefined;
      readonly evidenceIds: readonly string[];
    })
  | (PlaneIntentIdentityShape & {
      readonly kind: "progress";
      readonly planeWorkItemId: string;
      readonly commentExternalId: string;
      readonly message: string;
      readonly branch: string;
      readonly commitSha?: string | undefined;
      readonly testSummary?: string | undefined;
      readonly evidenceIds: readonly string[];
    })
  | (PlaneIntentIdentityShape & {
      readonly kind: "evidence";
      readonly planeWorkItemId: string;
      readonly commentExternalId: string;
      readonly message: string;
      readonly branch: string;
      readonly commitSha?: string | undefined;
      readonly testSummary?: string | undefined;
      readonly evidenceIds: readonly string[];
    });

export interface PlaneProjectBindingShape {
  readonly planeProjectBindingId: string;
  readonly ownerPrincipalId: string;
  readonly projectKey: string;
  readonly workspaceRootId?: string | undefined;
  readonly planeWorkspaceSlug: string;
  readonly planeProjectId: string;
  readonly status: "active" | "needs_attention" | "archived";
}

export interface PlaneProjectOperationShape {
  readonly planeProjectOperationId: string;
  readonly planeProjectBindingId: string;
  readonly projectId: string;
  readonly projectWorkId: string;
  readonly boundWorkRevision: number;
  readonly projectProviderProjectionId?: string | undefined;
  readonly ownerPrincipalId: string;
  readonly actorParticipantId: string;
  readonly kind: PlaneProjectOperationKindShape;
  readonly intent: PlaneProjectOperationIntentShape;
  readonly providerExternalId: string;
  readonly requestSha256: string;
  readonly status: PlaneProjectOperationStatusShape;
  readonly planeWorkItemId?: string | undefined;
  readonly planeCommentId?: string | undefined;
  readonly providerFingerprint?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly manualDisposition?:
    | {
        readonly disposition: "confirmed_absent";
        readonly actorPrincipalId: string;
        readonly disposedAt: string;
        readonly reason: string;
      }
    | undefined;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlaneProjectOperationIdentityShape = Pick<
  PlaneProjectOperationShape,
  "planeProjectOperationId" | "planeProjectBindingId" | "intent" | "planeWorkItemId"
>;

export class PlaneProjectCoordinationInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlaneProjectCoordinationInvariantError";
    this.code = code;
  }
}

/**
 * 同一Owner下，人类可读projectKey和获授权workspaceRoot各自只能指向一个活动绑定；
 * 同一个Plane Project也不能被别名重复认领。归档历史不抢占活动唯一性。
 */
export function assertPlaneProjectBindingUniqueness(input: {
  readonly candidate: PlaneProjectBindingShape;
  readonly existing: readonly PlaneProjectBindingShape[];
}): void {
  if (input.candidate.status !== "active") return;
  if (input.candidate.workspaceRootId === undefined) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.binding.workspace_root_missing",
      "活动Plane Binding必须绑定唯一Workspace Root",
    );
  }

  for (const binding of input.existing) {
    if (binding.planeProjectBindingId === input.candidate.planeProjectBindingId) {
      if (
        binding.ownerPrincipalId !== input.candidate.ownerPrincipalId ||
        binding.projectKey !== input.candidate.projectKey ||
        binding.workspaceRootId !== input.candidate.workspaceRootId ||
        binding.planeWorkspaceSlug !== input.candidate.planeWorkspaceSlug ||
        binding.planeProjectId !== input.candidate.planeProjectId
      ) {
        throw new PlaneProjectCoordinationInvariantError(
          "plane.binding.identity_reused",
          "Plane Binding ID不能被复用于另一个Owner、Root或外部Project",
        );
      }
      continue;
    }
    if (binding.status !== "active") continue;
    if (
      binding.planeWorkspaceSlug === input.candidate.planeWorkspaceSlug &&
      binding.planeProjectId === input.candidate.planeProjectId
    ) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.binding.external_project_conflict",
        "同一个Plane Project不能被重复建立活动绑定",
      );
    }
    if (binding.ownerPrincipalId !== input.candidate.ownerPrincipalId) continue;
    if (binding.projectKey === input.candidate.projectKey) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.binding.project_key_conflict",
        "同一Owner下projectKey只能有一个活动Plane绑定",
      );
    }
    if (binding.workspaceRootId === input.candidate.workspaceRootId) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.binding.workspace_root_conflict",
        "同一Owner下workspaceRoot只能有一个活动Plane绑定",
      );
    }
  }
}

/**
 * Plane没有external_id唯一约束；整个Product Journal必须共同形成任务身份双射。
 * 这既用于prepare候选，也用于Store启动完整性，不能只在写路径做临时检查。
 */
export function assertPlaneProjectOperationIdentityUniqueness(
  operations: readonly PlaneProjectOperationIdentityShape[],
): void {
  const taskToExternal = new Map<string, string>();
  const externalToTask = new Map<string, string>();
  const workItemToIdentity = new Map<string, string>();
  const externalToWorkItem = new Map<string, string>();
  const commentToOperation = new Map<string, string>();

  for (const operation of operations) {
    const scope = operation.planeProjectBindingId;
    const taskKey = `${scope}\u0000${operation.intent.taskKey}`;
    const externalKey = `${scope}\u0000${operation.intent.externalId}`;
    const identity = `${operation.intent.externalId}\u0000${operation.intent.taskKey}`;
    const priorExternal = taskToExternal.get(taskKey);
    if (priorExternal !== undefined && priorExternal !== operation.intent.externalId) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.task_key_identity_conflict",
        "Plane taskKey已经绑定到另一个externalId",
      );
    }
    taskToExternal.set(taskKey, operation.intent.externalId);
    const priorTask = externalToTask.get(externalKey);
    if (priorTask !== undefined && priorTask !== operation.intent.taskKey) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.external_id_identity_conflict",
        "Plane externalId已经绑定到另一个taskKey",
      );
    }
    externalToTask.set(externalKey, operation.intent.taskKey);

    const workItemId =
      operation.intent.kind === "ensure_work_item"
        ? operation.planeWorkItemId
        : operation.intent.planeWorkItemId;
    if (workItemId !== undefined) {
      const workItemKey = `${scope}\u0000${workItemId}`;
      const priorIdentity = workItemToIdentity.get(workItemKey);
      if (priorIdentity !== undefined && priorIdentity !== identity) {
        throw new PlaneProjectCoordinationInvariantError(
          "plane.operation.work_item_identity_conflict",
          "Plane Work Item UUID已经绑定到另一组任务身份",
        );
      }
      workItemToIdentity.set(workItemKey, identity);
      const priorWorkItem = externalToWorkItem.get(externalKey);
      if (priorWorkItem !== undefined && priorWorkItem !== workItemId) {
        throw new PlaneProjectCoordinationInvariantError(
          "plane.operation.external_id_work_item_conflict",
          "Plane externalId已经绑定到另一个Work Item UUID",
        );
      }
      externalToWorkItem.set(externalKey, workItemId);
    }

    if (
      operation.intent.kind === "block" ||
      operation.intent.kind === "request_review" ||
      operation.intent.kind === "progress" ||
      operation.intent.kind === "evidence"
    ) {
      const commentKey = `${scope}\u0000${operation.intent.commentExternalId}`;
      const priorOperation = commentToOperation.get(commentKey);
      if (priorOperation !== undefined && priorOperation !== operation.planeProjectOperationId) {
        throw new PlaneProjectCoordinationInvariantError(
          "plane.operation.comment_identity_conflict",
          "Plane commentExternalId不能跨Operation复用",
        );
      }
      commentToOperation.set(commentKey, operation.planeProjectOperationId);
    }
  }
}

const forbiddenAgentStateNames = new Set([
  "done",
  "completed",
  "complete",
  "closed",
  "cancelled",
  "canceled",
  "published",
  "adopted",
  "dropped",
  "rejected",
  "完成",
  "已完成",
  "关闭",
  "已关闭",
  "取消",
  "已取消",
]);

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function normalizeSingleLine(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/** 规范化后再Hash，避免换行风格或首尾空白制造不同的外部写入身份。 */
export function normalizePlaneProjectOperationIntent(
  intent: PlaneProjectOperationIntentShape,
): PlaneProjectOperationIntentShape {
  if (intent.externalSource !== "later-agent") {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.external_source_invalid",
      "Agent Plane写入来源必须固定为later-agent",
    );
  }
  const identity = {
    externalSource: "later-agent" as const,
    externalId: intent.externalId.trim(),
    taskKey: intent.taskKey.trim().toLowerCase(),
  };

  switch (intent.kind) {
    case "ensure_work_item":
      return {
        ...identity,
        kind: intent.kind,
        name: normalizeSingleLine(intent.name),
        description: normalizeLineEndings(intent.description),
        priority: intent.priority,
        stateName: normalizeSingleLine(intent.stateName),
        stateGroup: intent.stateGroup,
        moduleIds: [...(intent.moduleIds ?? [])].sort(),
        labelIds: [...(intent.labelIds ?? [])].sort(),
      };
    case "start":
      return {
        ...identity,
        kind: intent.kind,
        planeWorkItemId: intent.planeWorkItemId.trim(),
        expectedPlaneStateId: intent.expectedPlaneStateId.trim(),
        stateName: normalizeSingleLine(intent.stateName),
        stateGroup: intent.stateGroup,
        branch: intent.branch.trim(),
        labelIds: [...(intent.labelIds ?? [])].sort(),
        managedLabelIds: [...(intent.managedLabelIds ?? [])].sort(),
      };
    case "block":
      return {
        ...identity,
        kind: intent.kind,
        planeWorkItemId: intent.planeWorkItemId.trim(),
        expectedPlaneStateId: intent.expectedPlaneStateId.trim(),
        stateName: normalizeSingleLine(intent.stateName),
        stateGroup: intent.stateGroup,
        commentExternalId: intent.commentExternalId.trim(),
        message: normalizeLineEndings(intent.message),
        branch: intent.branch.trim(),
        evidenceIds: [...intent.evidenceIds].sort(),
      };
    case "request_review":
      return {
        ...identity,
        kind: intent.kind,
        planeWorkItemId: intent.planeWorkItemId.trim(),
        expectedPlaneStateId: intent.expectedPlaneStateId.trim(),
        stateName: normalizeSingleLine(intent.stateName),
        stateGroup: intent.stateGroup,
        commentExternalId: intent.commentExternalId.trim(),
        message: normalizeLineEndings(intent.message),
        branch: intent.branch.trim(),
        ...(intent.commitSha === undefined
          ? {}
          : { commitSha: intent.commitSha.trim().toLowerCase() }),
        ...(intent.testSummary === undefined
          ? {}
          : { testSummary: normalizeLineEndings(intent.testSummary) }),
        evidenceIds: [...intent.evidenceIds].sort(),
      };
    case "progress":
      return {
        ...identity,
        kind: intent.kind,
        planeWorkItemId: intent.planeWorkItemId.trim(),
        commentExternalId: intent.commentExternalId.trim(),
        message: normalizeLineEndings(intent.message),
        branch: intent.branch.trim(),
        ...(intent.commitSha === undefined
          ? {}
          : { commitSha: intent.commitSha.trim().toLowerCase() }),
        ...(intent.testSummary === undefined
          ? {}
          : { testSummary: normalizeLineEndings(intent.testSummary) }),
        evidenceIds: [...intent.evidenceIds].sort(),
      };
    case "evidence":
      return {
        ...identity,
        kind: intent.kind,
        planeWorkItemId: intent.planeWorkItemId.trim(),
        commentExternalId: intent.commentExternalId.trim(),
        message: normalizeLineEndings(intent.message),
        branch: intent.branch.trim(),
        ...(intent.commitSha === undefined
          ? {}
          : { commitSha: intent.commitSha.trim().toLowerCase() }),
        ...(intent.testSummary === undefined
          ? {}
          : { testSummary: normalizeLineEndings(intent.testSummary) }),
        evidenceIds: [...intent.evidenceIds].sort(),
      };
  }
}

function assertAgentWritableState(input: {
  readonly stateName: string;
  readonly stateGroup: "backlog" | "unstarted" | "started";
}): void {
  if (
    forbiddenAgentStateNames.has(normalizeSingleLine(input.stateName).toLocaleLowerCase("en-US"))
  ) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.completion_forbidden",
      "Agent首期不能完成、关闭或取消Plane Work Item",
    );
  }
}

/**
 * Adapter从Plane按名称解析State后必须回传真实group做本检查；不能只相信Agent写入的名称，
 * 否则自定义名称可能把完成状态伪装成普通推进状态。
 */
export function assertPlaneProjectOperationStateSelection(input: {
  readonly intent: PlaneProjectOperationIntentShape;
  readonly actualState?:
    | {
        readonly name: string;
        readonly group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
      }
    | undefined;
}): void {
  if (input.intent.kind === "progress" || input.intent.kind === "evidence") return;
  assertAgentWritableState(input.intent);
  if (input.actualState === undefined) return;
  if (
    normalizeSingleLine(input.actualState.name) !== normalizeSingleLine(input.intent.stateName) ||
    input.actualState.group !== input.intent.stateGroup
  ) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.state_mismatch",
      "Plane State名称或group与受管Agent意图不一致",
    );
  }
}

export function computePlaneProjectOperationRequestSha256(input: {
  readonly planeProjectOperationId: string;
  readonly planeProjectBindingId: string;
  readonly projectId: string;
  readonly projectWorkId: string;
  readonly boundWorkRevision: number;
  readonly ownerPrincipalId: string;
  readonly actorParticipantId: string;
  readonly kind: PlaneProjectOperationKindShape;
  readonly intent: PlaneProjectOperationIntentShape;
  readonly providerExternalId: string;
}): string {
  if (input.kind !== input.intent.kind) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.kind_mismatch",
      "Operation kind必须与Intent kind一致",
    );
  }
  const intent = normalizePlaneProjectOperationIntent(input.intent);
  assertPlaneProjectOperationStateSelection({ intent });
  return hashCanonical("plane-project-operation-request.v1", {
    planeProjectOperationId: input.planeProjectOperationId,
    planeProjectBindingId: input.planeProjectBindingId,
    projectId: input.projectId,
    projectWorkId: input.projectWorkId,
    boundWorkRevision: input.boundWorkRevision,
    ownerPrincipalId: input.ownerPrincipalId,
    actorParticipantId: input.actorParticipantId,
    kind: input.kind,
    intent,
    providerExternalId: input.providerExternalId,
  });
}

const legalOperationTransitions: Readonly<
  Record<PlaneProjectOperationStatusShape, readonly PlaneProjectOperationStatusShape[]>
> = {
  queued: ["dispatching", "failed", "needs_attention"],
  dispatching: ["completed", "failed", "needs_attention", "outcome_unknown"],
  // 只读对账仍未收敛时，以同状态+revision递增留下可重放Attempt；没有外部写重试边。
  outcome_unknown: ["outcome_unknown", "completed", "failed", "needs_attention"],
  needs_attention: ["needs_attention", "completed", "failed"],
  completed: [],
  failed: [],
};

const commentKinds = new Set<PlaneProjectOperationKindShape>([
  "block",
  "request_review",
  "progress",
  "evidence",
]);

export function assertPlaneProjectOperationIntegrity(operation: PlaneProjectOperationShape): void {
  if (operation.kind !== operation.intent.kind) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.kind_mismatch",
      "Operation kind必须与Intent kind一致",
    );
  }
  const normalizedIntent = normalizePlaneProjectOperationIntent(operation.intent);
  if (canonicalJsonStringify(normalizedIntent) !== canonicalJsonStringify(operation.intent)) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.intent_not_normalized",
      "Plane Operation Intent必须先规范化再持久化",
    );
  }
  assertPlaneProjectOperationStateSelection({ intent: operation.intent });
  const expectedHash = computePlaneProjectOperationRequestSha256(operation);
  if (operation.requestSha256 !== expectedHash) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.request_hash_mismatch",
      "Plane Operation requestSha256与受管Intent不一致",
    );
  }
  const hasError = operation.errorCode !== undefined;
  const errorStatus = ["failed", "needs_attention", "outcome_unknown"].includes(operation.status);
  if (hasError !== errorStatus) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.error_state_invalid",
      "Plane Operation错误状态与errorCode不一致",
    );
  }
  if (operation.intent.kind !== "ensure_work_item") {
    if (
      operation.planeWorkItemId !== undefined &&
      operation.planeWorkItemId !== operation.intent.planeWorkItemId
    ) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.work_item_mismatch",
        "Plane Operation结果不能指向另一个Work Item",
      );
    }
  }
  if (operation.planeCommentId !== undefined && !commentKinds.has(operation.kind)) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.comment_forbidden",
      "该类Plane Operation不允许产生Comment",
    );
  }
  if (operation.status === "completed") {
    if (operation.planeWorkItemId === undefined || operation.providerFingerprint === undefined) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.work_item_missing",
        "完成的Plane Operation必须记录Work Item UUID",
      );
    }
    if (commentKinds.has(operation.kind) && operation.planeCommentId === undefined) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.comment_missing",
        "完成的评论类Plane Operation必须记录Comment UUID",
      );
    }
  }
  if (operation.manualDisposition !== undefined) {
    if (
      operation.status !== "failed" ||
      operation.errorCode !== "plane_operation_manual_confirmed_absent"
    ) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.manual_disposition_state_invalid",
        "人工确认未发生只能把未决Operation终止为受审计failed",
      );
    }
    if (operation.manualDisposition.actorPrincipalId !== operation.ownerPrincipalId) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.manual_disposition_actor_invalid",
        "Plane人工处置人必须是Operation Owner",
      );
    }
    if (operation.planeCommentId !== undefined) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.manual_disposition_evidence_conflict",
        "已知Comment UUID时不能确认外部写完全未发生",
      );
    }
    if (operation.manualDisposition.disposedAt !== operation.updatedAt) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.manual_disposition_time_invalid",
        "Plane人工处置审计时间必须与终止Operation的更新时间一致",
      );
    }
  }
}

/**
 * `outcome_unknown`没有“重试写”边；它只能由同一Operation的只读对账收敛。
 * 转换同时冻结Owner、Binding、Intent和requestSha256，防止对账时偷换正文或目标。
 */
export function assertPlaneProjectOperationTransition(input: {
  readonly current: PlaneProjectOperationShape;
  readonly next: PlaneProjectOperationShape;
}): void {
  assertPlaneProjectOperationIntegrity(input.current);
  assertPlaneProjectOperationIntegrity(input.next);
  if (!legalOperationTransitions[input.current.status].includes(input.next.status)) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.transition_invalid",
      `不允许${input.current.status} -> ${input.next.status}`,
    );
  }
  if (
    input.next.planeProjectOperationId !== input.current.planeProjectOperationId ||
    input.next.planeProjectBindingId !== input.current.planeProjectBindingId ||
    input.next.projectId !== input.current.projectId ||
    input.next.projectWorkId !== input.current.projectWorkId ||
    input.next.boundWorkRevision !== input.current.boundWorkRevision ||
    input.next.ownerPrincipalId !== input.current.ownerPrincipalId ||
    input.next.actorParticipantId !== input.current.actorParticipantId ||
    input.next.kind !== input.current.kind ||
    input.next.providerExternalId !== input.current.providerExternalId ||
    input.next.requestSha256 !== input.current.requestSha256 ||
    input.next.createdAt !== input.current.createdAt ||
    canonicalJsonStringify(input.next.intent) !== canonicalJsonStringify(input.current.intent) ||
    input.next.revision !== input.current.revision + 1
  ) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.immutable_fields_changed",
      "Plane Operation转换破坏了不可变身份、Intent、Hash或revision",
    );
  }
  if (
    Date.parse(input.next.updatedAt) < Date.parse(input.current.updatedAt) ||
    (input.current.planeWorkItemId !== undefined &&
      input.next.planeWorkItemId !== input.current.planeWorkItemId) ||
    (input.current.planeCommentId !== undefined &&
      input.next.planeCommentId !== input.current.planeCommentId)
  ) {
    throw new PlaneProjectCoordinationInvariantError(
      "plane.operation.evidence_regressed",
      "Plane Operation转换不能回退时间或改写已知外部UUID",
    );
  }
  if (input.current.manualDisposition !== undefined) {
    if (
      canonicalJsonStringify(input.next.manualDisposition) !==
      canonicalJsonStringify(input.current.manualDisposition)
    ) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.manual_disposition_changed",
        "Plane人工处置事实一旦写入就不可修改或删除",
      );
    }
  } else if (input.next.manualDisposition !== undefined) {
    if (
      (input.current.status !== "outcome_unknown" && input.current.status !== "needs_attention") ||
      input.next.status !== "failed" ||
      input.next.manualDisposition.disposedAt !== input.next.updatedAt
    ) {
      throw new PlaneProjectCoordinationInvariantError(
        "plane.operation.manual_disposition_transition_invalid",
        "只有未决Operation可以由Owner以同一审计时间人工终止",
      );
    }
  }
}
