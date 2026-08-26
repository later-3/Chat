import {
  commandIdSchema,
  planeProjectBindingSchema,
  planeProviderExternalIdSchema,
  planeProjectOperationInputIntentSchema,
  planeProjectOperationIntentSchema,
  planeProjectOperationManualDispositionKindSchema,
  planeProjectOperationManualDispositionReasonSchema,
  planeProjectOperationSchema,
  planeProjectSnapshotSchema,
  planeWorkItemCommentsSnapshotSchema,
  projectDecisionSchema,
  projectEventSchema,
  projectInboundChangeSchema,
  projectProviderBindingSchema,
  projectProviderProjectionSchema,
  type CommandId,
  type PlaneProjectBinding,
  type PlaneProjectOperation,
  type PlaneProjectOperationInputIntent,
  type PlaneProjectOperationIntent,
  type PlaneProjectOperationStatus,
  type PlaneProjectSnapshot,
  type PlaneWorkItemCommentsSnapshot,
  type PrincipalId,
  type ProductSnapshot,
  type ProjectCoordinationOperationId,
  type ProjectInboundChange,
  type ProjectInboundChangeId,
  type ProjectProviderBinding,
  type ProjectProviderBindingId,
  type ProjectProviderProjection,
  type ProjectWork,
} from "@chat/contracts";
import {
  assertPlaneProjectOperationIdentityUniqueness,
  assertPlaneProjectOperationTransition,
  canonicalJsonStringify,
  computePlaneProjectOperationRequestSha256,
  hashCanonical,
  normalizePlaneProjectOperationIntent,
  PlaneProjectCoordinationInvariantError,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import {
  ApplicationError,
  CommandIdReusedError,
  StoreCorruptedError,
  forbidden,
  notFound,
  revisionConflict,
} from "./errors.js";
import type {
  PlaneProjectCoordinationPort,
  PlaneProviderCommentIntent,
  PlaneProviderCommentResult,
  PlaneProviderProjectSnapshot,
  PlaneProviderTransitionIntent,
  PlaneProviderWorkItem,
  PlaneProviderWorkItemResult,
} from "./plane-project-coordination-ports.js";
import { decideProjectWorkTransition } from "./project-coordination-use-cases.js";

interface CoordinationCapability {
  readonly port: PlaneProjectCoordinationPort;
  readonly ids: NonNullable<ApplicationDeps["planeProjectCoordinationIds"]>;
}

interface ProviderOperationOutcome {
  readonly status: "completed" | "failed" | "needs_attention" | "outcome_unknown";
  readonly errorCode?: string | undefined;
  readonly workItem?: PlaneProviderWorkItem | undefined;
  readonly commentId?: string | undefined;
}

function providerOutcomeIdentity(outcome: ProviderOperationOutcome): Record<string, string> {
  return {
    status: outcome.status,
    ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    ...(outcome.workItem === undefined ? {} : { workItemId: outcome.workItem.id }),
    ...(outcome.commentId === undefined ? {} : { commentId: outcome.commentId }),
  };
}

interface ProviderWorkSummary {
  readonly name: string;
  readonly description?: string | undefined;
  readonly priority: "none" | "urgent" | "high" | "medium" | "low";
  readonly stateId: string;
  readonly stateName: string;
  readonly stateGroup: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  readonly updatedAt: string;
  readonly moduleIds: readonly string[];
  readonly labelIds: readonly string[];
}

function requireCoordination(deps: ApplicationDeps): CoordinationCapability {
  if (
    deps.planeProjectCoordination === undefined ||
    deps.planeProjectCoordinationIds === undefined
  ) {
    throw new ApplicationError({
      code: "revision_conflict",
      httpStatus: 409,
      message: "部署未配置受管Plane项目协作能力",
      recoveryAction: "contact_support",
    });
  }
  return { port: deps.planeProjectCoordination, ids: deps.planeProjectCoordinationIds };
}

function requireProjectIds(deps: ApplicationDeps) {
  if (
    deps.projectIds?.providerBinding === undefined ||
    deps.projectIds.providerProjection === undefined
  ) {
    throw revisionConflict("部署缺少Project Provider身份分配器");
  }
  return deps.projectIds;
}

function strictlyAfter(previous: string, candidate: string): string {
  if (candidate > previous) return candidate;
  return new Date(Date.parse(previous) + 1).toISOString();
}

function requireActiveWorkspaceRoot(binding: ProjectProviderBinding): string {
  if (binding.status !== "active" || binding.workspaceRootId === undefined) {
    throw revisionConflict("Plane项目Binding不是可执行的active Root绑定");
  }
  return binding.workspaceRootId;
}

function planeReadUnavailable(): ApplicationError {
  return new ApplicationError({
    code: "provider_timeout",
    httpStatus: 503,
    message: "Plane项目管理服务暂时不可读取",
    retryable: true,
    recoveryAction: "rehydrate_and_retry",
  });
}

function providerExternalId(binding: ProjectProviderBinding, work: ProjectWork): string {
  const candidate = `chat-work:${binding.projectKey}:${work.workKey}`;
  const parsed = planeProviderExternalIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw revisionConflict("Chat Project Key与Work Key组合超过Plane CE external_id合同");
  }
  return parsed.data;
}

function toBindingView(binding: ProjectProviderBinding): PlaneProjectBinding {
  return planeProjectBindingSchema.parse({
    schemaVersion: "plane-project-coordination.v2",
    planeProjectBindingId: binding.projectProviderBindingId,
    projectId: binding.projectId,
    ownerPrincipalId: binding.ownerPrincipalId,
    projectKey: binding.projectKey,
    ...(binding.workspaceRootId === undefined ? {} : { workspaceRootId: binding.workspaceRootId }),
    ...(binding.coordinationAgentParticipantId === undefined
      ? {}
      : { coordinationAgentParticipantId: binding.coordinationAgentParticipantId }),
    humanActorExternalIds: binding.humanActorExternalIds,
    providerKind: binding.providerKind,
    providerVersion: binding.providerVersion,
    planeWorkspaceSlug: binding.externalWorkspaceId,
    planeProjectId: binding.externalProjectId,
    planeProjectIdentifier: binding.externalProjectIdentifier,
    status: binding.status,
    revision: binding.revision,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  });
}

function stateMapping(binding: ProjectProviderBinding, work: ProjectWork) {
  const matches = binding.stateMappings.filter(
    (mapping) => mapping.workKind === work.kind && mapping.chatState === work.status,
  );
  if (matches.length !== 1) {
    throw revisionConflict("当前Chat Work状态没有唯一Plane State映射");
  }
  return matches[0]!;
}

function workPlacement(
  snapshot: ProductSnapshot,
  binding: ProjectProviderBinding,
  work: ProjectWork,
): {
  readonly moduleIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly managedLabelIds: readonly string[];
} {
  const moduleKey =
    work.kind === "content_delivery"
      ? `platform:${work.content.targetPlatforms[0]}`
      : work.kind === "workflow_improvement"
        ? "work-kind:workflow_improvement"
        : "work-kind:generic";
  const module = binding.moduleMappings.find((mapping) => mapping.mappingKey === moduleKey);
  if (binding.moduleMappings.length > 0 && module === undefined) {
    throw revisionConflict(`Chat Work缺少受管Plane Module映射：${moduleKey}`);
  }

  const labelKeys: string[] = [];
  if (work.kind === "content_delivery") {
    labelKeys.push(
      "kind:content",
      ...work.content.targetPlatforms.map((item) => `platform:${item}`),
    );
    if (work.content.seriesKey !== undefined) labelKeys.push(`series:${work.content.seriesKey}`);
  } else if (work.kind === "workflow_improvement") {
    labelKeys.push("kind:practice");
  } else {
    labelKeys.push("kind:generic");
  }
  if (work.activeClaimId !== undefined) {
    const claim = snapshot.entities.projectWorkClaims[work.activeClaimId];
    const participant =
      claim === undefined ? undefined : snapshot.entities.projectParticipants[claim.participantId];
    if (participant?.kind === "agent" && participant.status === "active") {
      const executor = participant.displayName
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
      if (executor !== "") labelKeys.push(`executor:${executor}`);
    }
  }
  const labelIds = labelKeys.map((key) => {
    const mapping = binding.labelMappings.find((candidate) => candidate.mappingKey === key);
    if (mapping === undefined) {
      if (binding.labelMappings.length === 0) return undefined;
      throw revisionConflict(`Chat Work缺少受管Plane Label映射：${key}`);
    }
    return mapping.providerLabelId;
  });
  return {
    moduleIds: module === undefined ? [] : [module.providerModuleId],
    labelIds: labelIds.filter((id): id is string => id !== undefined),
    managedLabelIds: binding.labelMappings.map((mapping) => mapping.providerLabelId),
  };
}

function providerSummary(item: PlaneProviderWorkItem): ProviderWorkSummary {
  if (item.stateName === undefined || item.stateGroup === undefined) {
    throw revisionConflict("Plane Work Item缺少经校验的State名称或group");
  }
  return {
    name: item.name,
    ...(item.description === undefined ? {} : { description: item.description }),
    priority: item.priority,
    stateId: item.stateId,
    stateName: item.stateName,
    stateGroup: item.stateGroup,
    updatedAt: item.updatedAt,
    moduleIds: [...item.moduleIds].sort(),
    labelIds: [...item.labelIds].sort(),
  };
}

function providerFingerprint(item: PlaneProviderWorkItem): string {
  return hashCanonical("plane-work-item-projection.v1", providerSummary(item));
}

function semanticIntent(intent: PlaneProjectOperationIntent): unknown {
  if (
    intent.kind !== "block" &&
    intent.kind !== "request_review" &&
    intent.kind !== "progress" &&
    intent.kind !== "evidence"
  ) {
    return intent;
  }
  const semantic = { ...intent } as Record<string, unknown>;
  delete semantic.commentExternalId;
  return semantic;
}

function materializeIntent(input: {
  readonly operationId: ProjectCoordinationOperationId;
  readonly requested: PlaneProjectOperationInputIntent;
  readonly work: ProjectWork;
  readonly binding: ProjectProviderBinding;
  readonly projection?: ProjectProviderProjection | undefined;
  readonly placement: ReturnType<typeof workPlacement>;
}): PlaneProjectOperationIntent {
  const parsed = planeProjectOperationInputIntentSchema.parse(input.requested);
  const mapping = stateMapping(input.binding, input.work);
  if (parsed.externalId !== input.work.workKey) {
    throw revisionConflict("Plane external key必须精确匹配Chat Work Key");
  }
  const expectedTaskKey = input.work.workKey
    .toLowerCase()
    .replaceAll(":", "-")
    .replace(/[^a-z0-9._-]/gu, "-")
    .slice(0, 120);
  if (parsed.taskKey !== expectedTaskKey) {
    throw revisionConflict("Plane taskKey必须由Chat Work Key确定性派生");
  }

  let candidate: unknown;
  if (parsed.kind === "ensure_work_item") {
    candidate = {
      ...parsed,
      name: input.work.title,
      description: input.work.objective,
      priority: input.work.priority ?? "none",
      stateName: mapping.providerStateName,
      stateGroup: mapping.providerStateGroup,
      moduleIds: input.placement.moduleIds,
      labelIds: input.placement.labelIds,
    };
  } else {
    if (input.projection === undefined) {
      throw revisionConflict("Chat Work尚未建立唯一Plane Projection");
    }
    if (
      input.projection.providerObjectType !== "work_item" ||
      input.projection.objectType !== "work" ||
      input.projection.objectId !== input.work.projectWorkId ||
      input.projection.providerObjectId !== parsed.planeWorkItemId ||
      input.projection.syncStatus !== "healthy"
    ) {
      throw revisionConflict("Plane Work Item与Chat Work Projection不一致或尚未收敛");
    }
    if (
      (parsed.kind === "start" || parsed.kind === "block" || parsed.kind === "request_review") &&
      (parsed.stateName !== mapping.providerStateName ||
        parsed.stateGroup !== mapping.providerStateGroup)
    ) {
      throw revisionConflict("Plane目标State必须投影当前Chat Work权威状态");
    }
    candidate =
      parsed.kind === "block" ||
      parsed.kind === "request_review" ||
      parsed.kind === "progress" ||
      parsed.kind === "evidence"
        ? {
            ...parsed,
            commentExternalId: `later-comment:${hashCanonical("project-coordination-comment.v1", {
              projectCoordinationOperationId: input.operationId,
            }).slice(0, 48)}`,
          }
        : parsed;
    if (parsed.kind === "start") {
      candidate = {
        ...parsed,
        labelIds: input.placement.labelIds,
        managedLabelIds: input.placement.managedLabelIds,
      };
    }
  }
  return planeProjectOperationIntentSchema.parse(
    normalizePlaneProjectOperationIntent(candidate as PlaneProjectOperationIntent),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderComment(intent: PlaneProjectOperationIntent): string {
  if (
    intent.kind !== "block" &&
    intent.kind !== "request_review" &&
    intent.kind !== "progress" &&
    intent.kind !== "evidence"
  ) {
    throw revisionConflict("该Plane Operation没有评论正文");
  }
  const evidence = [
    { label: "Branch (reported)", value: intent.branch },
    {
      label: "Commit (Git verified)",
      value: "commitSha" in intent ? intent.commitSha : undefined,
    },
    {
      label: "Reported tests (unverified)",
      value: "testSummary" in intent ? intent.testSummary : undefined,
    },
    {
      label: "Chat Evidence",
      value: intent.evidenceIds.length === 0 ? undefined : intent.evidenceIds.join(", "),
    },
  ]
    .filter((item): item is { readonly label: string; readonly value: string } =>
      Boolean(item.value),
    )
    .map((item) => `<li><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</li>`)
    .join("");
  const html = `<p>${escapeHtml(intent.message)}</p><ul>${evidence}</ul>`;
  if (html.length > 10_000) throw revisionConflict("Plane评论在安全转义后超过长度上限");
  return html;
}

async function verifyEvidenceAndGit(input: {
  readonly deps: ApplicationDeps;
  readonly binding: ProjectProviderBinding;
  readonly work: ProjectWork;
  readonly intent: PlaneProjectOperationIntent;
}): Promise<void> {
  const { snapshot } = await input.deps.store.read({ kind: "committedSnapshot" });
  const evidenceIds =
    input.intent.kind === "block" ||
    input.intent.kind === "request_review" ||
    input.intent.kind === "progress" ||
    input.intent.kind === "evidence"
      ? input.intent.evidenceIds
      : [];
  for (const evidenceId of evidenceIds) {
    const evidence = snapshot.entities.projectEvidence[evidenceId];
    if (
      evidence === undefined ||
      evidence.projectId !== input.binding.projectId ||
      evidence.workId !== input.work.projectWorkId
    ) {
      throw revisionConflict("Plane评论引用的Chat Evidence不属于当前Work");
    }
  }
  const commitSha =
    input.intent.kind === "request_review" ||
    input.intent.kind === "progress" ||
    input.intent.kind === "evidence"
      ? input.intent.commitSha
      : undefined;
  if (commitSha === undefined) return;
  const branch =
    input.intent.kind === "request_review" ||
    input.intent.kind === "progress" ||
    input.intent.kind === "evidence"
      ? input.intent.branch
      : undefined;
  if (branch === undefined) throw revisionConflict("Git Evidence缺少branch");
  if (input.deps.projectRoots?.verifyGitEvidence === undefined) {
    throw revisionConflict("部署缺少绑定仓库的Git证据验证能力");
  }
  await input.deps.projectRoots.verifyGitEvidence({
    rootId: requireActiveWorkspaceRoot(input.binding),
    branch,
    commitSha,
  });
}

async function readBindingRecord(
  deps: ApplicationDeps,
  bindingId: ProjectProviderBindingId | string,
): Promise<ProjectProviderBinding> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const binding = snapshot.entities.projectProviderBindings[bindingId];
  if (binding === undefined) throw notFound("Plane项目绑定不存在");
  return binding;
}

async function readOperation(
  deps: ApplicationDeps,
  operationId: ProjectCoordinationOperationId | string,
): Promise<PlaneProjectOperation> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const operation = snapshot.entities.projectCoordinationOperations[operationId];
  if (operation === undefined) throw notFound("Plane项目协作Operation不存在");
  return operation;
}

function findProjection(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  binding: ProjectProviderBinding,
  work: ProjectWork,
): ProjectProviderProjection | undefined {
  const matches = Object.values(snapshot.entities.projectProviderProjections).filter(
    (projection) =>
      projection.bindingId === binding.projectProviderBindingId &&
      projection.objectType === "work" &&
      projection.objectId === work.projectWorkId,
  );
  if (matches.length > 1) throw new StoreCorruptedError("同一Chat Work存在重复Plane Projection");
  return matches[0];
}

async function readProviderSnapshot(
  port: PlaneProjectCoordinationPort,
  binding: ProjectProviderBinding,
): Promise<PlaneProviderProjectSnapshot> {
  try {
    const observed = await port.readProjectSnapshot({
      workspaceSlug: binding.externalWorkspaceId,
      projectId: binding.externalProjectId,
    });
    if (
      observed.project.id !== binding.externalProjectId ||
      observed.project.identifier !== binding.externalProjectIdentifier
    ) {
      throw revisionConflict("Plane Project身份与Chat Binding不一致");
    }
    return observed;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw planeReadUnavailable();
  }
}

export async function adoptExistingPlaneProject(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly projectKey: string;
    readonly workspaceRootId: string;
    readonly coordinationAgentParticipantId: string;
    readonly humanActorExternalIds: readonly string[];
    readonly planeWorkspaceSlug: string;
    readonly planeProjectIdentifier: string;
    readonly stateMappings: readonly {
      readonly workKind: "generic" | "content_delivery" | "workflow_improvement";
      readonly chatState: string;
      readonly providerStateId: string;
      readonly providerStateName: string;
      readonly providerStateGroup: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
    }[];
    readonly moduleMappings: readonly {
      readonly mappingKey: string;
      readonly providerModuleId: string;
      readonly providerModuleName: string;
    }[];
    readonly labelMappings: readonly {
      readonly mappingKey: string;
      readonly providerLabelId: string;
      readonly providerLabelName: string;
    }[];
  },
): Promise<{ readonly binding: PlaneProjectBinding; readonly snapshot: PlaneProjectSnapshot }> {
  const capability = requireCoordination(deps);
  const ids = requireProjectIds(deps);
  if (!deps.projectRoots?.list().some((root) => root.rootId === input.workspaceRootId)) {
    throw revisionConflict("仓库Root未配置或未授权");
  }
  if (!capability.port.describe().allowedWorkspaceSlugs.includes(input.planeWorkspaceSlug)) {
    throw forbidden("Plane Workspace不在服务端白名单");
  }
  let providerProject;
  try {
    providerProject = await capability.port.findProjectByIdentifier({
      workspaceSlug: input.planeWorkspaceSlug,
      projectIdentifier: input.planeProjectIdentifier,
    });
  } catch {
    throw planeReadUnavailable();
  }
  if (providerProject === undefined) throw notFound("Plane Project不存在");
  const observed = await capability.port.readProjectSnapshot({
    workspaceSlug: input.planeWorkspaceSlug,
    projectId: providerProject.id,
  });
  for (const mapping of input.stateMappings) {
    const state = observed.states.find((candidate) => candidate.id === mapping.providerStateId);
    if (
      state === undefined ||
      state.name !== mapping.providerStateName ||
      state.group !== mapping.providerStateGroup
    ) {
      throw revisionConflict("Plane State映射与实时CE对象不一致");
    }
  }
  const stateMappingDirections = new Set<string>();
  const providerMappingDirections = new Set<string>();
  for (const mapping of input.stateMappings) {
    const chatKey = `${mapping.workKind}\0${mapping.chatState}`;
    const providerKey = `${mapping.workKind}\0${mapping.providerStateId}`;
    if (stateMappingDirections.has(chatKey) || providerMappingDirections.has(providerKey)) {
      throw revisionConflict("Plane State映射在Chat或Provider方向不唯一");
    }
    stateMappingDirections.add(chatKey);
    providerMappingDirections.add(providerKey);
  }
  for (const mapping of input.moduleMappings) {
    const module = observed.modules.find((candidate) => candidate.id === mapping.providerModuleId);
    if (module === undefined || module.name !== mapping.providerModuleName) {
      throw revisionConflict("Plane Module映射与实时CE对象不一致");
    }
  }
  for (const mapping of input.labelMappings) {
    const label = observed.labels.find((candidate) => candidate.id === mapping.providerLabelId);
    if (label === undefined || label.name !== mapping.providerLabelName) {
      throw revisionConflict("Plane Label映射与实时CE对象不一致");
    }
  }
  if (
    new Set(input.moduleMappings.map((mapping) => mapping.mappingKey)).size !==
      input.moduleMappings.length ||
    new Set(input.moduleMappings.map((mapping) => mapping.providerModuleId)).size !==
      input.moduleMappings.length ||
    new Set(input.labelMappings.map((mapping) => mapping.mappingKey)).size !==
      input.labelMappings.length ||
    new Set(input.labelMappings.map((mapping) => mapping.providerLabelId)).size !==
      input.labelMappings.length
  ) {
    throw revisionConflict("Plane Module或Label映射必须双向唯一");
  }

  const bindingId = ids.providerBinding!();
  const now = deps.now();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "AdoptExistingPlaneProject",
    requestSha256: hashCanonical("command.adopt-existing-plane-project.v2", input),
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined || project.ownerPrincipalId !== input.principalId) {
        throw notFound("Chat Project不存在");
      }
      const resource = Object.values(draft.entities.projectResources).find(
        (item) => item.projectId === project.projectId && item.rootId === input.workspaceRootId,
      );
      if (resource === undefined) throw revisionConflict("Root不属于当前Chat Project");
      const agent = draft.entities.projectParticipants[input.coordinationAgentParticipantId];
      if (
        agent?.projectId !== project.projectId ||
        agent.kind !== "agent" ||
        agent.status !== "active"
      ) {
        throw revisionConflict("Binding协调Agent必须是当前Project的活动Agent Participant");
      }
      const existing = Object.values(draft.entities.projectProviderBindings).find(
        (item) =>
          item.ownerPrincipalId === input.principalId &&
          item.projectKey === input.projectKey &&
          item.status !== "archived",
      );
      if (existing !== undefined) {
        if (
          existing.projectId !== project.projectId ||
          existing.externalWorkspaceId !== input.planeWorkspaceSlug ||
          existing.externalProjectId !== providerProject.id ||
          existing.externalProjectIdentifier !== providerProject.identifier
        ) {
          throw revisionConflict("Project Key已经绑定另一Chat或Plane Project");
        }
        return { resultRefs: { projectProviderBindingId: existing.projectProviderBindingId } };
      }
      const conflict = Object.values(draft.entities.projectProviderBindings).find(
        (item) =>
          item.status !== "archived" &&
          (item.projectId === project.projectId ||
            (item.externalWorkspaceId === input.planeWorkspaceSlug &&
              item.externalProjectId === providerProject.id)),
      );
      if (conflict !== undefined) throw revisionConflict("Chat或Plane Project已有活动Binding");
      const legacy = Object.values(draft.entities.projectWorkspaceBindings).find(
        (item) =>
          item.ownerPrincipalId === input.principalId &&
          item.workspaceRootId === input.workspaceRootId &&
          item.planeWorkspaceSlug === input.planeWorkspaceSlug &&
          item.planeProjectId === providerProject.id,
      );
      const binding = projectProviderBindingSchema.parse({
        schemaVersion: "project-provider-binding.v2",
        projectProviderBindingId: bindingId,
        projectId: project.projectId,
        ownerPrincipalId: input.principalId,
        projectKey: input.projectKey,
        workspaceRootId: input.workspaceRootId,
        coordinationAgentParticipantId: input.coordinationAgentParticipantId,
        humanActorExternalIds: input.humanActorExternalIds,
        providerKind: "plane_ce",
        providerVersion: capability.port.describe().providerVersion,
        externalWorkspaceId: input.planeWorkspaceSlug,
        externalProjectId: providerProject.id,
        externalProjectIdentifier: providerProject.identifier,
        syncPolicyVersion: "content-lab-plane-mapping.v1",
        stateMappings: input.stateMappings,
        moduleMappings: input.moduleMappings,
        labelMappings: input.labelMappings,
        ...(legacy === undefined
          ? {}
          : { reconciledWorkspaceBindingId: legacy.projectWorkspaceBindingId }),
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.projectProviderBindings[binding.projectProviderBindingId] = binding;
      return { resultRefs: { projectProviderBindingId: binding.projectProviderBindingId } };
    },
  });
  const raw = await readBindingRecord(
    deps,
    transaction.resultRefs["projectProviderBindingId"] ?? bindingId,
  );
  const binding = toBindingView(raw);
  return {
    binding,
    snapshot: await readPlaneProjectSnapshot(deps, capability.port, raw),
  };
}

export async function getPlaneProjectBinding(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly planeProjectBindingId: ProjectProviderBindingId;
  },
): Promise<PlaneProjectBinding> {
  const binding = await readBindingRecord(deps, input.planeProjectBindingId);
  if (binding.ownerPrincipalId !== input.principalId) throw notFound("Plane项目绑定不存在");
  return toBindingView(binding);
}

export async function listPlaneProjectBindings(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly status?: "active" | "needs_attention" | "archived";
    readonly cursor?: string;
    readonly limit: number;
  },
): Promise<{ readonly bindings: PlaneProjectBinding[]; readonly nextCursor?: string }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const ordered = Object.values(snapshot.entities.projectProviderBindings)
    .filter(
      (binding) =>
        binding.ownerPrincipalId === input.principalId &&
        (input.status === undefined || binding.status === input.status),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.projectProviderBindingId.localeCompare(right.projectProviderBindingId),
    );
  const start =
    input.cursor === undefined
      ? 0
      : (() => {
          const index = ordered.findIndex(
            (binding) => binding.projectProviderBindingId === input.cursor,
          );
          if (index < 0) throw revisionConflict("Plane项目Binding分页游标已失效");
          return index + 1;
        })();
  const page = ordered.slice(start, start + input.limit);
  return {
    bindings: page.map(toBindingView),
    ...(ordered[start + input.limit] === undefined || page.length === 0
      ? {}
      : { nextCursor: page[page.length - 1]!.projectProviderBindingId }),
  };
}

export async function getPlaneProjectSnapshot(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly planeProjectBindingId: ProjectProviderBindingId;
  },
): Promise<PlaneProjectSnapshot> {
  const capability = requireCoordination(deps);
  const binding = await readBindingRecord(deps, input.planeProjectBindingId);
  if (binding.ownerPrincipalId !== input.principalId) throw notFound("Plane项目绑定不存在");
  if (binding.status !== "active") throw revisionConflict("Plane项目Binding不是active");
  return readPlaneProjectSnapshot(deps, capability.port, binding);
}

/**
 * 读取人类与Agent在Plane留下的评论摘要。评论仍是Provider拥有的外部输入：
 * Application只允许读取已经由健康Projection绑定的Chat Work，不持久化、不自动执行。
 */
export async function listPlaneWorkItemComments(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly planeProjectBindingId: ProjectProviderBindingId;
    readonly planeWorkItemId: string;
    readonly limit: number;
  },
): Promise<PlaneWorkItemCommentsSnapshot> {
  const capability = requireCoordination(deps);
  const binding = await readBindingRecord(deps, input.planeProjectBindingId);
  if (binding.ownerPrincipalId !== input.principalId) {
    throw notFound("Plane项目Binding不存在");
  }
  if (binding.status !== "active") throw revisionConflict("Plane项目Binding不是active");

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const matches = Object.values(snapshot.entities.projectProviderProjections).filter(
    (projection) =>
      projection.bindingId === binding.projectProviderBindingId &&
      projection.providerObjectType === "work_item" &&
      projection.providerObjectId === input.planeWorkItemId &&
      projection.objectType === "work" &&
      projection.syncStatus === "healthy",
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw notFound("Plane Work Item没有唯一健康Chat Projection");
  }
  const projection = matches[0];
  const work = snapshot.entities.projectWorks[projection.objectId];
  if (work === undefined || work.projectId !== binding.projectId) {
    throw new StoreCorruptedError("Plane Work Item Projection引用无效Chat Work");
  }

  let page;
  try {
    page = await capability.port.readWorkItemComments({
      workspaceSlug: binding.externalWorkspaceId,
      projectId: binding.externalProjectId,
      workItemId: input.planeWorkItemId,
      workItemExternalId: providerExternalId(binding, work),
      limit: input.limit,
    });
  } catch {
    throw planeReadUnavailable();
  }

  return planeWorkItemCommentsSnapshotSchema.parse({
    schemaVersion: "plane-project-coordination.v2",
    planeProjectBindingId: binding.projectProviderBindingId,
    planeWorkItemId: input.planeWorkItemId,
    comments: page.comments.map((comment) => ({
      planeCommentId: comment.id,
      planeWorkItemId: comment.workItemId,
      excerpt: comment.excerpt,
      origin: comment.origin,
      ...(comment.actorExternalId === undefined
        ? {}
        : { actorExternalId: comment.actorExternalId }),
      ...(comment.externalId === undefined ? {} : { externalId: comment.externalId }),
      ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
    })),
    totalCommentCount: page.totalCommentCount,
    truncated: page.truncated,
    capturedAt: deps.now(),
  });
}

export async function preparePlaneProjectOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectBindingId: ProjectProviderBindingId;
    readonly expectedBindingRevision?: number;
    readonly intent: PlaneProjectOperationInputIntent;
  },
): Promise<PlaneProjectOperation> {
  const capability = requireCoordination(deps);
  const projectIds = requireProjectIds(deps);
  const operationId = capability.ids.operation();
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const binding = snapshot.entities.projectProviderBindings[input.planeProjectBindingId];
  if (binding === undefined || binding.ownerPrincipalId !== input.principalId) {
    throw notFound("Plane项目绑定不存在");
  }
  if (
    binding.status !== "active" ||
    (input.expectedBindingRevision !== undefined &&
      binding.revision !== input.expectedBindingRevision)
  ) {
    throw revisionConflict("Plane项目Binding状态或revision已经变化");
  }
  const work = Object.values(snapshot.entities.projectWorks).find(
    (candidate) =>
      candidate.projectId === binding.projectId && candidate.workKey === input.intent.externalId,
  );
  if (work === undefined) {
    throw notFound("external key没有对应已授权Chat Work；P5不会据此制造Backlog");
  }
  const participant =
    binding.coordinationAgentParticipantId === undefined
      ? undefined
      : snapshot.entities.projectParticipants[binding.coordinationAgentParticipantId];
  if (
    participant === undefined ||
    participant.projectId !== binding.projectId ||
    participant.kind !== "agent" ||
    participant.status !== "active"
  ) {
    throw revisionConflict("Plane Binding缺少活动协调Agent Participant");
  }
  const projection = findProjection(snapshot, binding, work);
  const operationProjectionId =
    projection?.projectProviderProjectionId ?? projectIds.providerProjection!();
  const intent = materializeIntent({
    operationId,
    requested: input.intent,
    work,
    binding,
    placement: workPlacement(snapshot, binding, work),
    ...(projection === undefined ? {} : { projection }),
  });
  if (
    intent.kind === "block" ||
    intent.kind === "request_review" ||
    intent.kind === "progress" ||
    intent.kind === "evidence"
  ) {
    renderComment(intent);
  }
  await verifyEvidenceAndGit({ deps, binding, work, intent });

  if (intent.kind !== "ensure_work_item") {
    const observed = await readProviderSnapshot(capability.port, binding);
    const matches = observed.workItems.filter(
      (item) =>
        item.id === intent.planeWorkItemId &&
        item.externalSource === "later-agent" &&
        item.externalId === providerExternalId(binding, work),
    );
    const item = matches[0];
    if (matches.length !== 1 || item === undefined) {
      throw revisionConflict("Plane Work Item外部身份或Projection已经漂移");
    }
    if (projection === undefined || providerFingerprint(item) !== projection.providerFingerprint) {
      throw revisionConflict("Plane Work Item已被人修改；必须先执行入站同步");
    }
  }

  const requestSha256 = hashCanonical("command.prepare-plane-project-operation.v2", {
    principalId: input.principalId,
    planeProjectBindingId: input.planeProjectBindingId,
    ...(input.expectedBindingRevision === undefined
      ? {}
      : { expectedBindingRevision: input.expectedBindingRevision }),
    intent: semanticIntent(intent),
  });
  const replay = await replayPrepareReceipt(deps, input, requestSha256);
  if (replay !== undefined) return replay;
  const preparedAt = deps.now();

  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PreparePlaneProjectOperation",
    requestSha256,
    mutate: (draft) => {
      const currentBinding = draft.entities.projectProviderBindings[input.planeProjectBindingId];
      const currentWork = draft.entities.projectWorks[work.projectWorkId];
      if (
        currentBinding?.revision !== binding.revision ||
        currentBinding.status !== "active" ||
        currentWork?.revision !== work.revision
      ) {
        throw revisionConflict("Binding或Work在Operation准备期间发生变化");
      }
      const existing = Object.values(draft.entities.projectCoordinationOperations).filter(
        (operation) => operation.planeProjectBindingId === binding.projectProviderBindingId,
      );
      try {
        assertPlaneProjectOperationIdentityUniqueness([
          ...existing,
          {
            planeProjectOperationId: operationId,
            planeProjectBindingId: binding.projectProviderBindingId,
            intent,
            ...(projection?.providerObjectId === undefined
              ? {}
              : { planeWorkItemId: projection.providerObjectId }),
          },
        ]);
      } catch (error) {
        if (error instanceof PlaneProjectCoordinationInvariantError) {
          throw revisionConflict(error.message);
        }
        throw error;
      }
      const semanticHash = hashCanonical("plane-project-operation-semantic.v2", {
        bindingId: binding.projectProviderBindingId,
        workId: work.projectWorkId,
        workRevision: work.revision,
        intent: semanticIntent(intent),
      });
      const duplicate = existing.find(
        (operation) =>
          operation.status !== "failed" &&
          hashCanonical("plane-project-operation-semantic.v2", {
            bindingId: operation.planeProjectBindingId,
            workId: operation.projectWorkId,
            workRevision: operation.boundWorkRevision,
            intent: semanticIntent(operation.intent),
          }) === semanticHash,
      );
      if (duplicate !== undefined) {
        return {
          resultRefs: { projectCoordinationOperationId: duplicate.planeProjectOperationId },
        };
      }
      const base = {
        planeProjectOperationId: operationId,
        planeProjectBindingId: binding.projectProviderBindingId,
        projectId: binding.projectId,
        projectWorkId: work.projectWorkId,
        boundWorkRevision: work.revision,
        projectProviderProjectionId: operationProjectionId,
        ownerPrincipalId: input.principalId,
        actorParticipantId: participant.projectParticipantId,
        kind: intent.kind,
        intent,
        providerExternalId: providerExternalId(binding, work),
      } as const;
      const operation = planeProjectOperationSchema.parse({
        schemaVersion: "plane-project-coordination.v2",
        ...base,
        requestSha256: computePlaneProjectOperationRequestSha256(base),
        status: "queued",
        revision: 1,
        createdAt: preparedAt,
        updatedAt: preparedAt,
      });
      draft.entities.projectCoordinationOperations[operation.planeProjectOperationId] = operation;
      return { resultRefs: { projectCoordinationOperationId: operation.planeProjectOperationId } };
    },
  });
  return readOperation(
    deps,
    transaction.resultRefs["projectCoordinationOperationId"] ?? operationId,
  );
}

async function replayPrepareReceipt(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectBindingId: ProjectProviderBindingId;
  },
  requestSha256: string,
): Promise<PlaneProjectOperation | undefined> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const receipt = snapshot.commandReceipts[input.commandId];
  if (receipt === undefined) return undefined;
  if (
    receipt.commandType !== "PreparePlaneProjectOperation" ||
    receipt.requestSha256 !== requestSha256
  ) {
    throw new CommandIdReusedError(input.commandId);
  }
  const id = receipt.resultRefs["projectCoordinationOperationId"];
  const operation =
    id === undefined ? undefined : snapshot.entities.projectCoordinationOperations[id];
  if (
    operation === undefined ||
    operation.ownerPrincipalId !== input.principalId ||
    operation.planeProjectBindingId !== input.planeProjectBindingId
  ) {
    throw new StoreCorruptedError("Plane准备Receipt引用无效Operation");
  }
  return operation;
}

export async function executePlaneProjectOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectOperationId: ProjectCoordinationOperationId;
    readonly expectedOperationRevision?: number;
  },
): Promise<PlaneProjectOperation> {
  const capability = requireCoordination(deps);
  const claimedAt = deps.now();
  const claim = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ClaimPlaneProjectOperation",
    requestSha256: hashCanonical("command.claim-plane-project-operation.v2", {
      principalId: input.principalId,
      commandId: input.commandId,
      planeProjectOperationId: input.planeProjectOperationId,
      ...(input.expectedOperationRevision === undefined
        ? {}
        : { expectedOperationRevision: input.expectedOperationRevision }),
    }),
    mutate: (draft) => {
      const current = draft.entities.projectCoordinationOperations[input.planeProjectOperationId];
      if (current === undefined || current.ownerPrincipalId !== input.principalId) {
        throw notFound("Plane项目协作Operation不存在");
      }
      if (
        input.expectedOperationRevision !== undefined &&
        current.revision !== input.expectedOperationRevision
      ) {
        throw revisionConflict("Plane Operation revision已经变化");
      }
      if (current.status !== "queued") {
        throw revisionConflict(
          current.status === "outcome_unknown"
            ? "Plane写入结果未知，只能查询对账"
            : "Plane Operation不在queued状态",
        );
      }
      const binding = draft.entities.projectProviderBindings[current.planeProjectBindingId];
      const work = draft.entities.projectWorks[current.projectWorkId];
      if (binding?.status !== "active") throw revisionConflict("Plane Binding不是active");
      if (work?.revision !== current.boundWorkRevision) {
        const next = planeProjectOperationSchema.parse({
          ...current,
          status: "needs_attention",
          errorCode: "chat_work_revision_changed",
          revision: current.revision + 1,
          updatedAt: strictlyAfter(current.updatedAt, claimedAt),
        });
        assertPlaneProjectOperationTransition({ current, next });
        draft.entities.projectCoordinationOperations[current.planeProjectOperationId] = next;
        return { resultRefs: { projectCoordinationOperationId: current.planeProjectOperationId } };
      }
      const next = planeProjectOperationSchema.parse({
        ...current,
        status: "dispatching",
        revision: current.revision + 1,
        updatedAt: strictlyAfter(current.updatedAt, claimedAt),
      });
      assertPlaneProjectOperationTransition({ current, next });
      draft.entities.projectCoordinationOperations[current.planeProjectOperationId] = next;
      return { resultRefs: { projectCoordinationOperationId: current.planeProjectOperationId } };
    },
  });
  const current = await readOperation(deps, input.planeProjectOperationId);
  if (current.status === "needs_attention") return current;
  if (claim.replayed && current.status !== "dispatching") return current;
  const binding = await readBindingRecord(deps, current.planeProjectBindingId);
  let outcome: ProviderOperationOutcome;
  try {
    outcome = await runProviderOperation(capability.port, binding, current, claim.replayed);
  } catch {
    outcome = {
      status: "outcome_unknown",
      errorCode: claim.replayed
        ? "plane_operation_reconcile_unknown"
        : "plane_operation_dispatch_unknown",
    };
  }
  return finalizeOperation(deps, current, outcome);
}

export async function reconcilePlaneProjectOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectOperationId: ProjectCoordinationOperationId;
    readonly expectedPlaneProjectBindingId?: ProjectProviderBindingId;
    readonly expectedOperationRevision?: number;
  },
): Promise<PlaneProjectOperation> {
  const requestSha256 = hashCanonical("command.reconcile-plane-project-operation.v2", {
    principalId: input.principalId,
    commandId: input.commandId,
    planeProjectOperationId: input.planeProjectOperationId,
    ...(input.expectedPlaneProjectBindingId === undefined
      ? {}
      : { expectedPlaneProjectBindingId: input.expectedPlaneProjectBindingId }),
    ...(input.expectedOperationRevision === undefined
      ? {}
      : { expectedOperationRevision: input.expectedOperationRevision }),
  });
  const replay = await replayReconcileReceipt(deps, input, requestSha256);
  if (replay !== undefined) return replay;
  const capability = requireCoordination(deps);
  const current = await readOperation(deps, input.planeProjectOperationId);
  if (
    current.ownerPrincipalId !== input.principalId ||
    (input.expectedPlaneProjectBindingId !== undefined &&
      current.planeProjectBindingId !== input.expectedPlaneProjectBindingId)
  ) {
    throw notFound("Plane项目协作Operation不存在");
  }
  if (
    input.expectedOperationRevision !== undefined &&
    current.revision !== input.expectedOperationRevision
  ) {
    throw revisionConflict("Plane Operation revision已经变化");
  }
  if (current.status === "completed" || current.status === "failed") {
    return acceptReconcileWithoutChange(deps, input, current, requestSha256);
  }
  if (
    current.status !== "dispatching" &&
    current.status !== "outcome_unknown" &&
    current.status !== "needs_attention"
  ) {
    throw revisionConflict("Plane Operation尚不能对账");
  }
  const binding = await readBindingRecord(deps, current.planeProjectBindingId);
  let outcome: ProviderOperationOutcome;
  try {
    outcome = await runProviderOperation(capability.port, binding, current, true);
  } catch {
    if (current.status !== "dispatching") {
      return acceptReconcileWithoutChange(deps, input, current, requestSha256);
    }
    outcome = { status: "outcome_unknown", errorCode: "plane_operation_reconcile_unknown" };
  }
  if (
    (outcome.status === "outcome_unknown" && current.status !== "dispatching") ||
    (outcome.status === "needs_attention" && current.status === "needs_attention")
  ) {
    return acceptReconcileWithoutChange(deps, input, current, requestSha256);
  }
  return finalizeOperation(deps, current, outcome, {
    commandId: input.commandId,
    requestSha256,
  });
}

async function replayReconcileReceipt(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectOperationId: ProjectCoordinationOperationId;
    readonly expectedPlaneProjectBindingId?: ProjectProviderBindingId;
  },
  requestSha256: string,
): Promise<PlaneProjectOperation | undefined> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const receipt = snapshot.commandReceipts[input.commandId];
  if (receipt === undefined) return undefined;
  if (
    receipt.commandType !== "ReconcilePlaneProjectOperation" ||
    receipt.requestSha256 !== requestSha256 ||
    receipt.resultRefs["projectCoordinationOperationId"] !== input.planeProjectOperationId
  ) {
    throw new CommandIdReusedError(input.commandId);
  }
  const operation = snapshot.entities.projectCoordinationOperations[input.planeProjectOperationId];
  if (
    operation === undefined ||
    operation.ownerPrincipalId !== input.principalId ||
    (input.expectedPlaneProjectBindingId !== undefined &&
      operation.planeProjectBindingId !== input.expectedPlaneProjectBindingId)
  ) {
    throw new StoreCorruptedError("Plane对账Receipt引用无效Operation");
  }
  return operation;
}

async function acceptReconcileWithoutChange(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectOperationId: ProjectCoordinationOperationId;
    readonly expectedPlaneProjectBindingId?: ProjectProviderBindingId;
  },
  observed: PlaneProjectOperation,
  requestSha256: string,
): Promise<PlaneProjectOperation> {
  const terminal = observed.status === "completed" || observed.status === "failed";
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ReconcilePlaneProjectOperation",
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.projectCoordinationOperations[input.planeProjectOperationId];
      if (current?.revision !== observed.revision) {
        throw revisionConflict("Plane Operation在对账期间发生变化");
      }
      if (!terminal) {
        const next = planeProjectOperationSchema.parse({
          ...current,
          revision: current.revision + 1,
          updatedAt: strictlyAfter(current.updatedAt, now),
        });
        assertPlaneProjectOperationTransition({ current, next });
        draft.entities.projectCoordinationOperations[current.planeProjectOperationId] = next;
      }
      return { resultRefs: { projectCoordinationOperationId: current.planeProjectOperationId } };
    },
  });
  return readOperation(deps, input.planeProjectOperationId);
}

export async function manuallyDisposePlaneProjectOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectOperationId: ProjectCoordinationOperationId;
    readonly expectedOperationRevision: number;
    readonly disposition: "confirmed_absent";
    readonly reason: string;
  },
): Promise<PlaneProjectOperation> {
  const disposition = planeProjectOperationManualDispositionKindSchema.parse(input.disposition);
  const reason = planeProjectOperationManualDispositionReasonSchema.parse(input.reason);
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ManuallyDisposePlaneProjectOperation",
    requestSha256: hashCanonical("command.manually-dispose-plane-project-operation.v2", {
      ...input,
      disposition,
      reason,
    }),
    mutate: (draft) => {
      const current = draft.entities.projectCoordinationOperations[input.planeProjectOperationId];
      if (
        current === undefined ||
        current.ownerPrincipalId !== input.principalId ||
        current.revision !== input.expectedOperationRevision
      ) {
        throw revisionConflict("Plane Operation身份或revision已经变化");
      }
      if (current.status !== "outcome_unknown" && current.status !== "needs_attention") {
        throw revisionConflict("只有未决Plane Operation允许人工处置");
      }
      if (current.planeCommentId !== undefined) {
        throw revisionConflict("已知Comment UUID时不能确认外部写完全未发生");
      }
      const disposedAt = strictlyAfter(current.updatedAt, now);
      const next = planeProjectOperationSchema.parse({
        ...current,
        status: "failed",
        errorCode: "plane_operation_manual_confirmed_absent",
        manualDisposition: {
          disposition,
          actorPrincipalId: input.principalId,
          disposedAt,
          reason,
        },
        revision: current.revision + 1,
        updatedAt: disposedAt,
      });
      assertPlaneProjectOperationTransition({ current, next });
      draft.entities.projectCoordinationOperations[current.planeProjectOperationId] = next;
      return { resultRefs: { projectCoordinationOperationId: current.planeProjectOperationId } };
    },
  });
  return readOperation(deps, input.planeProjectOperationId);
}

export async function getPlaneProjectOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly planeProjectOperationId: ProjectCoordinationOperationId;
  },
): Promise<PlaneProjectOperation> {
  const operation = await readOperation(deps, input.planeProjectOperationId);
  if (operation.ownerPrincipalId !== input.principalId) {
    throw notFound("Plane项目协作Operation不存在");
  }
  return operation;
}

export async function listPlaneProjectOperations(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly planeProjectBindingId?: ProjectProviderBindingId;
    readonly status?: PlaneProjectOperationStatus;
    readonly cursor?: ProjectCoordinationOperationId;
    readonly limit: number;
  },
): Promise<{ readonly operations: PlaneProjectOperation[]; readonly nextCursor?: string }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  if (input.planeProjectBindingId !== undefined) {
    const binding = snapshot.entities.projectProviderBindings[input.planeProjectBindingId];
    if (binding === undefined || binding.ownerPrincipalId !== input.principalId) {
      throw notFound("Plane项目Binding不存在");
    }
  }
  const ordered = Object.values(snapshot.entities.projectCoordinationOperations)
    .filter(
      (operation) =>
        operation.ownerPrincipalId === input.principalId &&
        (input.planeProjectBindingId === undefined ||
          operation.planeProjectBindingId === input.planeProjectBindingId) &&
        (input.status === undefined || operation.status === input.status),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.planeProjectOperationId.localeCompare(right.planeProjectOperationId),
    );
  const start =
    input.cursor === undefined
      ? 0
      : (() => {
          const index = ordered.findIndex(
            (operation) => operation.planeProjectOperationId === input.cursor,
          );
          if (index < 0) throw revisionConflict("Plane Operation分页游标已失效");
          return index + 1;
        })();
  const operations = ordered.slice(start, start + input.limit);
  return {
    operations,
    ...(ordered[start + input.limit] === undefined || operations.length === 0
      ? {}
      : { nextCursor: operations[operations.length - 1]!.planeProjectOperationId }),
  };
}

export async function listPlaneProjectInboundChanges(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly planeProjectBindingId?: ProjectProviderBindingId;
    readonly status?: ProjectInboundChange["status"];
    readonly cursor?: ProjectInboundChangeId;
    readonly limit: number;
  },
): Promise<{
  readonly inboundChanges: readonly ProjectInboundChange[];
  readonly nextCursor?: ProjectInboundChangeId;
}> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  if (input.planeProjectBindingId !== undefined) {
    const binding = snapshot.entities.projectProviderBindings[input.planeProjectBindingId];
    if (binding === undefined || binding.ownerPrincipalId !== input.principalId) {
      throw notFound("Plane项目Binding不存在");
    }
  }
  const ordered = Object.values(snapshot.entities.projectInboundChanges)
    .filter((change) => {
      const binding = snapshot.entities.projectProviderBindings[change.bindingId];
      return (
        binding?.ownerPrincipalId === input.principalId &&
        (input.planeProjectBindingId === undefined ||
          change.bindingId === input.planeProjectBindingId) &&
        (input.status === undefined || change.status === input.status)
      );
    })
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.projectInboundChangeId.localeCompare(right.projectInboundChangeId),
    );
  const start =
    input.cursor === undefined
      ? 0
      : (() => {
          const index = ordered.findIndex(
            (change) => change.projectInboundChangeId === input.cursor,
          );
          if (index < 0) throw revisionConflict("Plane入站Change分页游标已失效");
          return index + 1;
        })();
  const inboundChanges = ordered.slice(start, start + input.limit);
  return {
    inboundChanges,
    ...(ordered[start + input.limit] === undefined || inboundChanges.length === 0
      ? {}
      : { nextCursor: inboundChanges[inboundChanges.length - 1]!.projectInboundChangeId }),
  };
}

/** 人类Owner显式选择后才解决Candidate；调用前仍需回读同一Provider fingerprint。 */
export async function resolvePlaneProjectInboundChange(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectInboundChangeId: ProjectInboundChangeId;
    readonly expectedRevision: number;
    readonly disposition: "adopt_plane" | "keep_chat";
    readonly rationale: string;
  },
): Promise<ProjectInboundChange> {
  const capability = requireCoordination(deps);
  const ids = requireProjectIds(deps);
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const change = before.snapshot.entities.projectInboundChanges[input.projectInboundChangeId];
  const binding =
    change === undefined
      ? undefined
      : before.snapshot.entities.projectProviderBindings[change.bindingId];
  const work =
    change === undefined ? undefined : before.snapshot.entities.projectWorks[change.workId];
  const projection =
    change === undefined
      ? undefined
      : before.snapshot.entities.projectProviderProjections[change.projectionId];
  if (
    change === undefined ||
    binding?.ownerPrincipalId !== input.principalId ||
    work === undefined ||
    projection === undefined
  ) {
    throw notFound("Plane入站Change不存在");
  }
  if (
    !["candidate", "needs_attention"].includes(change.status) ||
    change.revision !== input.expectedRevision ||
    work.revision !== change.observedWorkRevision
  ) {
    throw revisionConflict("Plane入站Change或Chat Work revision已经变化");
  }
  if (
    input.disposition === "adopt_plane" &&
    (change.classification !== "candidate_required" || change.after.description === undefined)
  ) {
    throw revisionConflict("只有描述Candidate允许显式采用Plane内容");
  }
  const observed = await readProviderSnapshot(capability.port, binding);
  const providerItem = observed.workItems.find((item) => item.id === change.providerObjectId);
  if (providerItem === undefined || providerFingerprint(providerItem) !== change.afterFingerprint) {
    throw revisionConflict("Plane对象在用户处置前再次变化，请先重新同步");
  }
  const human = Object.values(before.snapshot.entities.projectParticipants).find(
    (participant) =>
      participant.projectId === change.projectId &&
      participant.kind === "human" &&
      participant.principalId === input.principalId &&
      participant.status === "active",
  );
  if (human === undefined) throw revisionConflict("当前Owner缺少活动Human Participant");

  const decisionId = ids.decision();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ResolvePlaneProjectInboundChange",
    requestSha256: hashCanonical("command.resolve-plane-project-inbound-change.v1", input),
    mutate: (draft) => {
      const current = draft.entities.projectInboundChanges[input.projectInboundChangeId];
      const currentBinding =
        current === undefined
          ? undefined
          : draft.entities.projectProviderBindings[current.bindingId];
      const currentProjection =
        current === undefined
          ? undefined
          : draft.entities.projectProviderProjections[current.projectionId];
      const currentWork =
        current === undefined ? undefined : draft.entities.projectWorks[current.workId];
      const project =
        current === undefined ? undefined : draft.entities.projects[current.projectId];
      if (
        current?.revision !== input.expectedRevision ||
        currentBinding?.ownerPrincipalId !== input.principalId ||
        currentProjection?.revision !== projection.revision ||
        currentWork?.revision !== current.observedWorkRevision ||
        project === undefined
      ) {
        throw revisionConflict("Plane入站Change处置期间事实发生变化");
      }
      const question = `如何处理Plane入站变更 ${current.projectInboundChangeId}？`;
      const options = ["采用Plane", "保留Chat"];
      const choice = input.disposition === "adopt_plane" ? "采用Plane" : "保留Chat";
      const decision = projectDecisionSchema.parse({
        schemaVersion: "project-decision.v2",
        projectDecisionId: decisionId,
        projectId: current.projectId,
        question,
        options,
        choice,
        rationale: input.rationale,
        decidedByParticipantId: human.projectParticipantId,
        boundProjectRevision: project.revision,
        boundWorkId: currentWork.projectWorkId,
        boundWorkRevision: currentWork.revision,
        payloadSha256: hashCanonical("project-decision-payload.v1", {
          projectId: current.projectId,
          boundProjectRevision: project.revision,
          boundWorkId: currentWork.projectWorkId,
          boundWorkRevision: currentWork.revision,
          question,
          options,
          choice,
          rationale: input.rationale,
        }),
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.projectDecisions[decisionId] = decision;
      const nextWorkRevision =
        input.disposition === "adopt_plane" ? currentWork.revision + 1 : currentWork.revision;
      if (input.disposition === "adopt_plane") {
        const nextWork = {
          ...currentWork,
          ...(current.after.name === undefined ? {} : { title: current.after.name }),
          objective: current.after.description!,
          ...(current.after.priority === undefined ? {} : { priority: current.after.priority }),
          revision: nextWorkRevision,
          updatedAt: strictlyAfter(currentWork.updatedAt, now),
        };
        draft.entities.projectWorks[currentWork.projectWorkId] = nextWork;
        const projectEventId = `pev_${hashCanonical("id.project-coordination-event.v1", {
          commandId: input.commandId,
          projectId: current.projectId,
          eventType: "work.provider-metadata-adopted",
          subject: { kind: "work", objectId: currentWork.projectWorkId },
        }).slice(0, 24)}`;
        draft.entities.projectEvents[projectEventId] = projectEventSchema.parse({
          schemaVersion: "project-event.v1",
          projectEventId,
          projectId: current.projectId,
          eventType: "work.provider-metadata-adopted",
          subject: { kind: "work", objectId: currentWork.projectWorkId },
          source: {
            kind: "user",
            principalId: input.principalId,
            participantId: human.projectParticipantId,
          },
          occurredAt: now,
          observedAt: now,
          recordedAt: now,
          beforeRevision: currentWork.revision,
          afterRevision: nextWork.revision,
          payloadSha256: hashCanonical("project-coordination-event-payload.v1", {
            changeId: current.projectInboundChangeId,
            decisionId,
            title: nextWork.title,
            objective: nextWork.objective,
            priority: nextWork.priority,
          }),
          evidenceIds: [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      draft.entities.projectProviderProjections[currentProjection.projectProviderProjectionId] =
        projectProviderProjectionSchema.parse({
          ...currentProjection,
          chatObjectRevision: nextWorkRevision,
          providerFingerprint: current.afterFingerprint,
          providerSnapshot: providerSummary(providerItem),
          syncStatus: "healthy",
          lastSyncedAt: now,
          revision: currentProjection.revision + 1,
          updatedAt: now,
        });
      draft.entities.projectInboundChanges[current.projectInboundChangeId] =
        projectInboundChangeSchema.parse({
          ...current,
          status: input.disposition === "adopt_plane" ? "adopted" : "ignored",
          resolutionDecisionId: decisionId,
          reason: `${current.reason}；用户已显式${
            input.disposition === "adopt_plane" ? "采用Plane" : "保留Chat"
          }。`,
          revision: current.revision + 1,
          updatedAt: now,
        });
      return { resultRefs: { projectInboundChangeId: current.projectInboundChangeId } };
    },
  });
  const after = await deps.store.read({ kind: "committedSnapshot" });
  const resolved = after.snapshot.entities.projectInboundChanges[input.projectInboundChangeId];
  if (resolved === undefined) throw new StoreCorruptedError("处置后的Plane入站Change丢失");
  return resolved;
}

async function runProviderOperation(
  port: PlaneProjectCoordinationPort,
  binding: ProjectProviderBinding,
  operation: PlaneProjectOperation,
  reconcile: boolean,
): Promise<ProviderOperationOutcome> {
  const intent = operation.intent;
  const location = {
    planeWorkspaceSlug: binding.externalWorkspaceId,
    planeProjectId: binding.externalProjectId,
  } as const;
  if (intent.kind === "ensure_work_item") {
    const providerInput = {
      ...location,
      externalId: operation.providerExternalId,
      name: intent.name,
      description: intent.description,
      priority: intent.priority,
      stateName: intent.stateName,
      stateGroup: intent.stateGroup,
      moduleIds: intent.moduleIds,
      labelIds: intent.labelIds,
    };
    return workItemOutcome(
      reconcile
        ? await port.reconcileEnsureWorkItem(providerInput)
        : await port.ensureWorkItem(providerInput),
    );
  }

  const transitionInput: PlaneProviderTransitionIntent | undefined =
    intent.kind === "start" || intent.kind === "block" || intent.kind === "request_review"
      ? {
          ...location,
          workItemId: intent.planeWorkItemId,
          workItemExternalId: operation.providerExternalId,
          expectedStateId: intent.expectedPlaneStateId,
          stateName: intent.stateName,
          stateGroup: intent.stateGroup,
          ...(intent.kind === "start"
            ? { labelIds: intent.labelIds, managedLabelIds: intent.managedLabelIds }
            : {}),
        }
      : undefined;
  const commentInput: PlaneProviderCommentIntent | undefined =
    intent.kind === "block" ||
    intent.kind === "request_review" ||
    intent.kind === "progress" ||
    intent.kind === "evidence"
      ? {
          ...location,
          workItemId: intent.planeWorkItemId,
          workItemExternalId: operation.providerExternalId,
          kind: intent.kind,
          commentExternalId: intent.commentExternalId,
          commentHtml: renderComment(intent),
        }
      : undefined;

  if (commentInput === undefined) {
    if (transitionInput === undefined) throw new Error("unsupported Plane operation");
    return workItemOutcome(
      reconcile
        ? await port.reconcileWorkItemStateTransition(transitionInput)
        : await port.transitionWorkItemState(transitionInput),
    );
  }

  if (!reconcile && transitionInput !== undefined) {
    const compound = await port.applyCommentedWorkItemStateTransition({
      transition: transitionInput,
      comment: commentInput,
    });
    if (compound.phase === "preflight") return workItemOutcome(compound.outcome);
    if (compound.phase === "comment") return commentOutcome(compound.outcome);
    const state = workItemOutcome(compound.outcome);
    return state.status === "completed"
      ? { ...state, commentId: compound.comment.id }
      : {
          ...state,
          status: state.status === "failed" ? "needs_attention" : state.status,
          commentId: compound.comment.id,
        };
  }

  const comment = reconcile
    ? await port.reconcileWorkItemComment(commentInput)
    : await port.appendWorkItemComment(commentInput);
  const commentResult = commentOutcome(comment);
  if (commentResult.status !== "completed") return commentResult;
  if (transitionInput !== undefined) {
    const state = workItemOutcome(
      reconcile
        ? await port.reconcileWorkItemStateTransition(transitionInput)
        : await port.transitionWorkItemState(transitionInput),
    );
    return state.status === "completed"
      ? { ...state, commentId: commentResult.commentId }
      : {
          ...state,
          status: state.status === "failed" ? "needs_attention" : state.status,
          commentId: commentResult.commentId,
        };
  }
  const snapshot = await port.readProjectSnapshot({
    workspaceSlug: binding.externalWorkspaceId,
    projectId: binding.externalProjectId,
  });
  const workItem = snapshot.workItems.find(
    (item) =>
      item.id === commentInput.workItemId &&
      item.externalSource === "later-agent" &&
      item.externalId === operation.providerExternalId,
  );
  if (workItem === undefined) {
    return {
      status: "needs_attention",
      errorCode: "plane_comment_work_item_missing_after_write",
      commentId: commentResult.commentId,
    };
  }
  return { status: "completed", workItem, commentId: commentResult.commentId };
}

function workItemOutcome(result: PlaneProviderWorkItemResult): ProviderOperationOutcome {
  if (result.status === "completed") return { status: "completed", workItem: result.workItem };
  return {
    status: result.status,
    errorCode: result.errorCode,
    ...(result.workItem === undefined ? {} : { workItem: result.workItem }),
  };
}

function commentOutcome(result: PlaneProviderCommentResult): ProviderOperationOutcome {
  if (result.status === "completed") {
    return { status: "completed", commentId: result.comment.id };
  }
  return {
    status: result.status,
    errorCode: result.errorCode,
    ...(result.comment === undefined ? {} : { commentId: result.comment.id }),
  };
}

async function finalizeOperation(
  deps: ApplicationDeps,
  claimed: PlaneProjectOperation,
  outcome: ProviderOperationOutcome,
  requested?: { readonly commandId: CommandId; readonly requestSha256: string },
): Promise<PlaneProjectOperation> {
  const commandId =
    requested?.commandId ??
    commandIdSchema.parse(
      `cmd_${hashCanonical("project-coordination-finalize.v1", {
        operationId: claimed.planeProjectOperationId,
        revision: claimed.revision,
        outcome: providerOutcomeIdentity(outcome),
      }).slice(0, 48)}`,
    );
  const now = deps.now();
  await deps.store.transact({
    commandId,
    commandType:
      requested === undefined ? "FinalizePlaneProjectOperation" : "ReconcilePlaneProjectOperation",
    requestSha256:
      requested?.requestSha256 ??
      hashCanonical("command.finalize-plane-project-operation.v2", {
        operationId: claimed.planeProjectOperationId,
        expectedRevision: claimed.revision,
        ...providerOutcomeIdentity(outcome),
      }),
    mutate: (draft) => {
      const current = draft.entities.projectCoordinationOperations[claimed.planeProjectOperationId];
      if (current?.revision !== claimed.revision) {
        throw revisionConflict("Plane Operation在Provider调用期间发生变化");
      }
      const work = draft.entities.projectWorks[current.projectWorkId];
      if (work === undefined) throw new StoreCorruptedError("Operation引用的Chat Work不存在");
      const { errorCode: _oldError, ...withoutError } = current;
      void _oldError;
      const fingerprint =
        outcome.workItem === undefined ? undefined : providerFingerprint(outcome.workItem);
      const next = planeProjectOperationSchema.parse({
        ...withoutError,
        status: outcome.status,
        ...(outcome.workItem === undefined
          ? {}
          : {
              planeWorkItemId: outcome.workItem.id,
              providerFingerprint: fingerprint,
            }),
        ...(outcome.commentId === undefined ? {} : { planeCommentId: outcome.commentId }),
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        revision: current.revision + 1,
        updatedAt: strictlyAfter(current.updatedAt, now),
      });
      assertPlaneProjectOperationTransition({ current, next });
      draft.entities.projectCoordinationOperations[current.planeProjectOperationId] = next;

      if (outcome.status === "completed" && outcome.workItem !== undefined) {
        const projectionId = current.projectProviderProjectionId;
        if (projectionId === undefined) {
          throw new StoreCorruptedError("完成的Work投影Operation缺少Projection ID");
        }
        const existing = draft.entities.projectProviderProjections[projectionId];
        const summary = providerSummary(outcome.workItem);
        const healthy = work.revision === current.boundWorkRevision;
        const projection = projectProviderProjectionSchema.parse({
          schemaVersion: "project-provider-projection.v2",
          projectProviderProjectionId: projectionId,
          projectId: current.projectId,
          bindingId: current.planeProjectBindingId,
          objectType: "work",
          objectId: current.projectWorkId,
          providerObjectType: "work_item",
          providerObjectId: outcome.workItem.id,
          externalKey: work.workKey,
          chatObjectRevision: current.boundWorkRevision,
          providerFingerprint: fingerprint,
          providerSnapshot: summary,
          syncStatus: healthy ? "healthy" : "needs_attention",
          lastSyncedAt: now,
          revision: existing === undefined ? 1 : existing.revision + 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        draft.entities.projectProviderProjections[projectionId] = projection;
      } else if (
        current.projectProviderProjectionId !== undefined &&
        (outcome.status === "needs_attention" || outcome.status === "outcome_unknown")
      ) {
        const existing =
          draft.entities.projectProviderProjections[current.projectProviderProjectionId];
        if (existing !== undefined) {
          draft.entities.projectProviderProjections[existing.projectProviderProjectionId] = {
            ...existing,
            syncStatus: outcome.status,
            revision: existing.revision + 1,
            updatedAt: now,
          };
        }
      }
      return { resultRefs: { projectCoordinationOperationId: current.planeProjectOperationId } };
    },
  });
  return readOperation(deps, claimed.planeProjectOperationId);
}

async function readPlaneProjectSnapshot(
  deps: ApplicationDeps,
  port: PlaneProjectCoordinationPort,
  binding: ProjectProviderBinding,
): Promise<PlaneProjectSnapshot> {
  const observed = await readProviderSnapshot(port, binding);
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const states = observed.states.map((state) => ({
    planeStateId: state.id,
    name: state.name,
    group: state.group,
  }));
  const stateById = new Map(states.map((state) => [state.planeStateId, state]));
  const projections = Object.values(snapshot.entities.projectProviderProjections).filter(
    (projection) =>
      projection.bindingId === binding.projectProviderBindingId &&
      projection.providerObjectType === "work_item",
  );
  const projectionByProviderId = new Map(
    projections.map((projection) => [projection.providerObjectId, projection]),
  );
  const totalWorkItemCount = observed.workItems.length;
  const unresolvedOperationCount = Object.values(
    snapshot.entities.projectCoordinationOperations,
  ).filter(
    (operation) =>
      operation.planeProjectBindingId === binding.projectProviderBindingId &&
      !["completed", "failed"].includes(operation.status),
  ).length;
  const pendingInboundChangeCount = Object.values(snapshot.entities.projectInboundChanges).filter(
    (change) =>
      change.bindingId === binding.projectProviderBindingId &&
      ["observed", "candidate", "needs_attention"].includes(change.status),
  ).length;

  return planeProjectSnapshotSchema.parse({
    schemaVersion: "plane-project-coordination.v2",
    planeProjectBindingId: binding.projectProviderBindingId,
    bindingRevision: binding.revision,
    projectId: binding.projectId,
    projectKey: binding.projectKey,
    workspaceRootId: requireActiveWorkspaceRoot(binding),
    planeWorkspaceSlug: binding.externalWorkspaceId,
    project: {
      planeProjectId: observed.project.id,
      identifier: observed.project.identifier,
      name: observed.project.name,
    },
    states,
    modules: observed.modules.map((module) => ({
      planeModuleId: module.id,
      name: module.name,
      status: module.status,
      totalWorkItems: module.totalWorkItems,
      completedWorkItems: module.completedWorkItems,
      cancelledWorkItems: module.cancelledWorkItems,
      startedWorkItems: module.startedWorkItems,
      unstartedWorkItems: module.unstartedWorkItems,
      backlogWorkItems: module.backlogWorkItems,
    })),
    labels: observed.labels.map((label) => ({
      planeLabelId: label.id,
      name: label.name,
      color: label.color,
    })),
    workItems: observed.workItems.slice(0, 500).map((item) => {
      const state = stateById.get(item.stateId);
      if (
        state === undefined ||
        (item.stateName !== undefined && item.stateName !== state.name) ||
        (item.stateGroup !== undefined && item.stateGroup !== state.group)
      ) {
        throw revisionConflict("Plane Work Item引用未知或竞争变化的State");
      }
      const projection = projectionByProviderId.get(item.id);
      const work =
        projection?.objectType === "work"
          ? snapshot.entities.projectWorks[projection.objectId]
          : undefined;
      return {
        planeWorkItemId: item.id,
        sequenceId: item.sequenceId,
        ...(work === undefined
          ? {}
          : { projectWorkId: work.projectWorkId, workRevision: work.revision }),
        name: item.name,
        ...(item.description === undefined ? {} : { description: item.description }),
        priority: item.priority,
        moduleIds: item.moduleIds,
        labelIds: item.labelIds,
        state,
        ...(work === undefined ? {} : { externalSource: "later-agent", externalId: work.workKey }),
        providerFingerprint: providerFingerprint(item),
        updatedAt: item.updatedAt,
      };
    }),
    totalWorkItemCount,
    unresolvedOperationCount,
    pendingInboundChangeCount,
    truncated: totalWorkItemCount > 500,
    capturedAt: deps.now(),
  });
}

export async function syncPlaneProject(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly planeProjectBindingId: ProjectProviderBindingId;
  },
): Promise<{
  readonly snapshot: PlaneProjectSnapshot;
  readonly inboundChanges: readonly ReturnType<typeof projectInboundChangeSchema.parse>[];
}> {
  const capability = requireCoordination(deps);
  const binding = await readBindingRecord(deps, input.planeProjectBindingId);
  if (binding.ownerPrincipalId !== input.principalId) throw notFound("Plane项目Binding不存在");
  if (binding.status !== "active") throw revisionConflict("Plane项目Binding不是active");
  const observed = await readProviderSnapshot(capability.port, binding);
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const projections = Object.values(before.snapshot.entities.projectProviderProjections).filter(
    (projection) =>
      projection.bindingId === binding.projectProviderBindingId &&
      projection.providerObjectType === "work_item",
  );
  const observedById = new Map(observed.workItems.map((item) => [item.id, item]));
  const createdIds: string[] = [];

  for (const projection of projections) {
    const item = observedById.get(projection.providerObjectId);
    const afterFingerprint =
      item === undefined
        ? hashCanonical("plane-work-item-deleted.v1", {
            providerObjectId: projection.providerObjectId,
          })
        : providerFingerprint(item);
    if (afterFingerprint === projection.providerFingerprint) continue;
    const existing = Object.values(before.snapshot.entities.projectInboundChanges).find(
      (change) =>
        change.projectionId === projection.projectProviderProjectionId &&
        change.afterFingerprint === afterFingerprint &&
        !["resolved", "ignored"].includes(change.status),
    );
    if (existing !== undefined) {
      createdIds.push(existing.projectInboundChangeId);
      continue;
    }
    const changeId = capability.ids.inboundChange();
    const commandId = commandIdSchema.parse(
      `cmd_${hashCanonical("project-inbound-change-record.v1", {
        syncCommandId: input.commandId,
        projectionId: projection.projectProviderProjectionId,
        afterFingerprint,
      }).slice(0, 48)}`,
    );
    const now = deps.now();
    await deps.store.transact({
      commandId,
      commandType: "RecordProjectInboundChange",
      requestSha256: hashCanonical("command.record-project-inbound-change.v1", {
        bindingId: binding.projectProviderBindingId,
        projectionId: projection.projectProviderProjectionId,
        beforeFingerprint: projection.providerFingerprint,
        afterFingerprint,
      }),
      mutate: (draft) => {
        const current =
          draft.entities.projectProviderProjections[projection.projectProviderProjectionId];
        const work = draft.entities.projectWorks[projection.objectId];
        if (current?.providerFingerprint !== projection.providerFingerprint || work === undefined) {
          throw revisionConflict("Projection或Work在入站同步期间发生变化");
        }
        const nextSummary = item === undefined ? undefined : providerSummary(item);
        const prior = projection.providerSnapshot;
        const changedFields =
          item === undefined || prior === undefined
            ? ["unknown"]
            : (
                ["name", "description", "priority", "stateId", "moduleIds", "labelIds"] as const
              ).filter((field) => {
                if (nextSummary === undefined) return true;
                if (field === "stateId") return prior.stateId !== nextSummary.stateId;
                if (field === "moduleIds" || field === "labelIds") {
                  return (
                    canonicalJsonStringify(prior[field]) !==
                    canonicalJsonStringify(nextSummary[field])
                  );
                }
                return prior[field] !== nextSummary[field];
              });
        const stateChanged = changedFields.includes("stateId");
        const actorAllowed =
          item?.updatedById !== undefined &&
          binding.humanActorExternalIds.includes(item.updatedById);
        const targetMapping =
          item === undefined
            ? undefined
            : binding.stateMappings.find(
                (mapping) =>
                  mapping.workKind === work.kind &&
                  mapping.providerStateId === item.stateId &&
                  mapping.providerStateName === item.stateName &&
                  mapping.providerStateGroup === item.stateGroup,
              );
        const safeNonTerminal =
          !stateChanged ||
          ["selected", "producing", "experimenting"].includes(targetMapping?.chatState ?? "");
        const onlyDirectlyAdoptableFields = changedFields.every(
          (field) =>
            changedFields.length > 0 &&
            (field === "name" || field === "priority" || field === "stateId"),
        );
        const adoptable =
          onlyDirectlyAdoptableFields &&
          actorAllowed &&
          safeNonTerminal &&
          work.revision === projection.chatObjectRevision;
        const classification =
          item === undefined || prior === undefined
            ? "forbidden_conflict"
            : changedFields.length === 0
              ? "display_only"
              : adoptable
                ? "adoptable"
                : changedFields.some(
                      (field) =>
                        field === "description" || field === "moduleIds" || field === "labelIds",
                    )
                  ? "candidate_required"
                  : "forbidden_conflict";
        const status =
          classification === "display_only"
            ? "resolved"
            : adoptable
              ? "observed"
              : classification === "candidate_required"
                ? "candidate"
                : "needs_attention";
        const change = projectInboundChangeSchema.parse({
          schemaVersion: "project-inbound-change.v1",
          projectInboundChangeId: changeId,
          projectId: binding.projectId,
          bindingId: binding.projectProviderBindingId,
          projectionId: projection.projectProviderProjectionId,
          workId: work.projectWorkId,
          observedWorkRevision: work.revision,
          providerObjectId: projection.providerObjectId,
          ...(item?.updatedById === undefined ? {} : { actorExternalId: item.updatedById }),
          beforeFingerprint: projection.providerFingerprint,
          afterFingerprint,
          changeKind:
            item === undefined
              ? "deleted"
              : changedFields.length === 1
                ? changedFields[0] === "stateId"
                  ? "state"
                  : changedFields[0]
                : "multiple",
          classification,
          status,
          before:
            prior === undefined
              ? {}
              : {
                  providerStateId: prior.stateId,
                  providerStateName: prior.stateName,
                  name: prior.name,
                  ...(prior.description === undefined ? {} : { description: prior.description }),
                  priority: prior.priority,
                  moduleIds: prior.moduleIds,
                  labelIds: prior.labelIds,
                  updatedAt: prior.updatedAt,
                },
          after:
            item === undefined
              ? {}
              : {
                  providerStateId: nextSummary!.stateId,
                  providerStateName: nextSummary!.stateName,
                  name: nextSummary!.name,
                  ...(nextSummary!.description === undefined
                    ? {}
                    : { description: nextSummary!.description }),
                  priority: nextSummary!.priority,
                  moduleIds: nextSummary!.moduleIds,
                  labelIds: nextSummary!.labelIds,
                  updatedAt: nextSummary!.updatedAt,
                },
          reason:
            classification === "display_only"
              ? "Plane仅更新时间戳等展示字段；已刷新Projection，不改变Chat Work"
              : adoptable
                ? "已验证人类Actor、可采用字段/非终态State和双方revision，可转Chat Command"
                : classification === "candidate_required"
                  ? "Plane修改需要形成用户Candidate，不能静默覆盖Chat Work"
                  : "缺少Actor、旧Snapshot或存在删除/多字段/并发冲突，停止出站写",
          commandId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        draft.entities.projectInboundChanges[changeId] = change;
        draft.entities.projectProviderProjections[current.projectProviderProjectionId] =
          projectProviderProjectionSchema.parse({
            ...current,
            ...(classification === "display_only"
              ? {
                  providerFingerprint: afterFingerprint,
                  providerSnapshot: nextSummary,
                  lastSyncedAt: now,
                }
              : {}),
            syncStatus:
              classification === "display_only"
                ? "healthy"
                : status === "needs_attention"
                  ? "needs_attention"
                  : "pending",
            revision: current.revision + 1,
            updatedAt: now,
          });
        return { resultRefs: { projectInboundChangeId: changeId } };
      },
    });
    createdIds.push(changeId);
  }

  for (const changeId of createdIds) {
    const state = await deps.store.read({ kind: "committedSnapshot" });
    const change = state.snapshot.entities.projectInboundChanges[changeId];
    if (change?.classification !== "adoptable" || change.status !== "observed") continue;
    const work = state.snapshot.entities.projectWorks[change.workId];
    const human = Object.values(state.snapshot.entities.projectParticipants).find(
      (participant) =>
        participant.projectId === change.projectId &&
        participant.kind === "human" &&
        participant.principalId === input.principalId &&
        participant.status === "active",
    );
    const stateChanged = change.before.providerStateId !== change.after.providerStateId;
    const nameChanged = change.before.name !== change.after.name;
    const priorityChanged = change.before.priority !== change.after.priority;
    const mapping = stateChanged
      ? binding.stateMappings.find(
          (candidate) =>
            candidate.workKind === work?.kind &&
            candidate.providerStateId === change.after.providerStateId &&
            candidate.providerStateName === change.after.providerStateName,
        )
      : undefined;
    if (
      work === undefined ||
      human === undefined ||
      (stateChanged &&
        (mapping === undefined ||
          !["selected", "producing", "experimenting"].includes(mapping.chatState))) ||
      (nameChanged && change.after.name === undefined) ||
      (priorityChanged && change.after.priority === undefined)
    ) {
      continue;
    }
    try {
      let expectedWorkRevision = change.observedWorkRevision;
      if (nameChanged || priorityChanged) {
        const metadataCommandId = commandIdSchema.parse(
          `cmd_${hashCanonical("project-inbound-change-adopt-metadata.v1", { changeId }).slice(0, 48)}`,
        );
        const metadataAt = deps.now();
        await deps.store.transact({
          commandId: metadataCommandId,
          commandType: "AdoptPlaneProjectWorkMetadata",
          requestSha256: hashCanonical("command.adopt-plane-project-work-metadata.v1", {
            changeId,
            expectedWorkRevision,
            ...(nameChanged ? { title: change.after.name } : {}),
            ...(priorityChanged ? { priority: change.after.priority } : {}),
          }),
          mutate: (draft) => {
            const current = draft.entities.projectWorks[change.workId];
            if (current?.revision !== expectedWorkRevision) {
              throw revisionConflict("Plane元数据采用期间Work revision发生变化");
            }
            const nextWork = {
              ...current,
              ...(nameChanged ? { title: change.after.name! } : {}),
              ...(priorityChanged ? { priority: change.after.priority! } : {}),
              revision: current.revision + 1,
              updatedAt: strictlyAfter(current.updatedAt, metadataAt),
            };
            draft.entities.projectWorks[change.workId] = nextWork;
            const projectEventId = `pev_${hashCanonical("id.project-coordination-event.v1", {
              commandId: metadataCommandId,
              projectId: change.projectId,
              eventType: "work.provider-metadata-adopted",
              subject: { kind: "work", objectId: current.projectWorkId },
            }).slice(0, 24)}`;
            draft.entities.projectEvents[projectEventId] = projectEventSchema.parse({
              schemaVersion: "project-event.v1",
              projectEventId,
              projectId: change.projectId,
              eventType: "work.provider-metadata-adopted",
              subject: { kind: "work", objectId: current.projectWorkId },
              source: {
                kind: "user",
                principalId: input.principalId,
                participantId: human.projectParticipantId,
              },
              occurredAt: metadataAt,
              observedAt: metadataAt,
              recordedAt: metadataAt,
              beforeRevision: current.revision,
              afterRevision: nextWork.revision,
              payloadSha256: hashCanonical("project-coordination-event-payload.v1", {
                changeId,
                title: nextWork.title,
                priority: nextWork.priority,
              }),
              evidenceIds: [],
              revision: 1,
              createdAt: metadataAt,
              updatedAt: metadataAt,
            });
            return { resultRefs: { projectWorkId: current.projectWorkId } };
          },
        });
        expectedWorkRevision += 1;
      }

      let decisionId: string | undefined;
      if (stateChanged) {
        const targetState = mapping!.chatState as "selected" | "producing" | "experimenting";
        const adoptCommandId = commandIdSchema.parse(
          `cmd_${hashCanonical("project-inbound-change-adopt-state.v1", { changeId }).slice(0, 48)}`,
        );
        await decideProjectWorkTransition(deps, {
          principalId: input.principalId,
          commandId: adoptCommandId,
          projectId: change.projectId,
          workId: change.workId,
          expectedWorkRevision,
          payload: {
            decidedByParticipantId: human.projectParticipantId,
            targetState,
            rationale: "采用已验证Plane人类Actor在允许非终态图内的State修改。",
            evidenceIds: [],
          },
        });
        const stateAdopted = await deps.store.read({ kind: "committedSnapshot" });
        decisionId = Object.values(stateAdopted.snapshot.entities.projectDecisions).find(
          (candidate) => candidate.commandId === adoptCommandId,
        )?.projectDecisionId;
        if (decisionId === undefined) {
          throw new StoreCorruptedError("Plane State采用后缺少Decision");
        }
      }
      const adopted = await deps.store.read({ kind: "committedSnapshot" });
      const currentWork = adopted.snapshot.entities.projectWorks[change.workId];
      const currentProjection =
        adopted.snapshot.entities.projectProviderProjections[change.projectionId];
      const item = observedById.get(change.providerObjectId);
      if (currentWork === undefined || currentProjection === undefined || item === undefined) {
        throw new StoreCorruptedError("入站采用后缺少Decision、Work、Projection或Provider对象");
      }
      const resolveCommandId = commandIdSchema.parse(
        `cmd_${hashCanonical("project-inbound-change-resolve.v1", { changeId }).slice(0, 48)}`,
      );
      const resolvedAt = deps.now();
      await deps.store.transact({
        commandId: resolveCommandId,
        commandType: "AdoptProjectInboundChange",
        requestSha256: hashCanonical("command.adopt-project-inbound-change.v1", {
          changeId,
          ...(decisionId === undefined ? {} : { decisionId }),
          workRevision: currentWork.revision,
          afterFingerprint: change.afterFingerprint,
        }),
        mutate: (draft) => {
          const currentChange = draft.entities.projectInboundChanges[changeId];
          const projection = draft.entities.projectProviderProjections[change.projectionId];
          if (
            currentChange?.status !== "observed" ||
            projection?.revision !== currentProjection.revision
          ) {
            throw revisionConflict("入站Change或Projection在采用期间发生变化");
          }
          draft.entities.projectInboundChanges[changeId] = projectInboundChangeSchema.parse({
            ...currentChange,
            status: "adopted",
            ...(decisionId === undefined ? {} : { resolutionDecisionId: decisionId }),
            revision: currentChange.revision + 1,
            updatedAt: resolvedAt,
          });
          draft.entities.projectProviderProjections[projection.projectProviderProjectionId] =
            projectProviderProjectionSchema.parse({
              ...projection,
              chatObjectRevision: currentWork.revision,
              providerFingerprint: change.afterFingerprint,
              providerSnapshot: providerSummary(item),
              syncStatus: "healthy",
              lastSyncedAt: resolvedAt,
              revision: projection.revision + 1,
              updatedAt: resolvedAt,
            });
          return { resultRefs: { projectInboundChangeId: changeId } };
        },
      });
    } catch (error) {
      if (error instanceof StoreCorruptedError) throw error;
      const failedAt = deps.now();
      const failCommandId = commandIdSchema.parse(
        `cmd_${hashCanonical("project-inbound-change-adopt-failed.v1", { changeId }).slice(0, 48)}`,
      );
      await deps.store.transact({
        commandId: failCommandId,
        commandType: "FailProjectInboundChangeAdoption",
        requestSha256: hashCanonical("command.fail-project-inbound-change-adoption.v1", {
          changeId,
        }),
        mutate: (draft) => {
          const current = draft.entities.projectInboundChanges[changeId];
          const projection = draft.entities.projectProviderProjections[change.projectionId];
          if (current === undefined || projection === undefined) {
            throw new StoreCorruptedError("入站采用失败时Change或Projection不存在");
          }
          draft.entities.projectInboundChanges[changeId] = {
            ...current,
            status: "needs_attention",
            reason: `${current.reason}；Chat状态转换门拒绝自动采用。`,
            revision: current.revision + 1,
            updatedAt: failedAt,
          };
          draft.entities.projectProviderProjections[projection.projectProviderProjectionId] = {
            ...projection,
            syncStatus: "needs_attention",
            revision: projection.revision + 1,
            updatedAt: failedAt,
          };
          return { resultRefs: { projectInboundChangeId: changeId } };
        },
      });
    }
  }

  await deps.store.transact({
    commandId: input.commandId,
    commandType: "SyncPlaneProject",
    requestSha256: hashCanonical("command.sync-plane-project.v1", input),
    mutate: () => ({ resultRefs: { projectProviderBindingId: binding.projectProviderBindingId } }),
  });
  const after = await deps.store.read({ kind: "committedSnapshot" });
  return {
    snapshot: await readPlaneProjectSnapshot(deps, capability.port, binding),
    inboundChanges: createdIds
      .map((id) => after.snapshot.entities.projectInboundChanges[id])
      .filter((change) => change !== undefined),
  };
}

export function samePlaneOperationIntent(
  left: PlaneProjectOperationIntent,
  right: PlaneProjectOperationIntent,
): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}
