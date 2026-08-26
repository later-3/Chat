import { z } from "zod";
import type {
  PlaneProjectCoordinationPort,
  PlaneProviderCommentIntent,
  PlaneProviderEnsureWorkItemIntent,
  PlaneProviderTransitionIntent,
} from "@chat/application";
import {
  PlaneCeClient,
  PlaneCeClientError,
  type PlaneCeClientOptions,
  readPlaneCeEnvironmentConfig,
} from "./plane-ce-client.js";

export const PLANE_CE_AGENT_EXTERNAL_SOURCE = "later-agent";

const uuidSchema = z.uuid();
const workspaceSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u)
  .max(80);
const externalIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u)
  .max(255);
const prioritySchema = z.enum(["none", "urgent", "high", "medium", "low"]);
const stateGroupSchema = z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]);

const locationShape = {
  workspaceSlug: workspaceSlugSchema,
  projectId: uuidSchema,
} as const;

const workItemIdentityShape = {
  workItemId: uuidSchema,
  workItemExternalId: externalIdSchema,
} as const;

export const planeCeEnsureWorkItemIntentSchema = z
  .object({
    ...locationShape,
    externalId: externalIdSchema,
    name: z.string().min(1).max(255),
    description: z.string().min(1).max(10_000),
    priority: prioritySchema,
    stateName: z.string().min(1).max(255),
    stateGroup: z.enum(["backlog", "unstarted", "started"]),
    moduleIds: z.array(uuidSchema).max(1).default([]),
    labelIds: z.array(uuidSchema).max(100).default([]),
  })
  .strict();

export const planeCeWorkItemStateTransitionIntentSchema = z
  .object({
    ...locationShape,
    ...workItemIdentityShape,
    expectedStateId: uuidSchema,
    stateName: z.string().min(1).max(255),
    stateGroup: z.literal("started"),
    labelIds: z.array(uuidSchema).max(100).optional(),
    managedLabelIds: z.array(uuidSchema).max(200).optional(),
  })
  .strict();

export const planeCeAppendWorkItemCommentIntentSchema = z
  .object({
    ...locationShape,
    ...workItemIdentityShape,
    kind: z.enum(["progress", "block", "request_review", "evidence"]),
    commentExternalId: externalIdSchema,
    commentHtml: z.string().min(1).max(10_000),
  })
  .strict();

const projectResponseSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    identifier: z.string().min(1),
    description: z.string(),
    archived_at: z.iso.datetime().nullish(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();

const stateResponseSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    color: z.string().min(1),
    group: stateGroupSchema,
    sequence: z.number().finite(),
  })
  .loose();

const moduleResponseSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    status: z.enum(["backlog", "planned", "in-progress", "paused", "completed", "cancelled"]),
    total_issues: z.number().int().nonnegative(),
    completed_issues: z.number().int().nonnegative(),
    cancelled_issues: z.number().int().nonnegative(),
    started_issues: z.number().int().nonnegative(),
    unstarted_issues: z.number().int().nonnegative(),
    backlog_issues: z.number().int().nonnegative(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();

const labelResponseSchema = z
  .object({ id: uuidSchema, name: z.string().min(1), color: z.string().min(1) })
  .loose();

const workItemResponseSchema = z
  .object({
    id: uuidSchema,
    sequence_id: z.number().int().positive(),
    name: z.string().min(1),
    description_html: z.string(),
    priority: prioritySchema,
    module_ids: z.array(uuidSchema).optional(),
    label_ids: z.array(uuidSchema).optional(),
    labels: z.array(uuidSchema).optional(),
    state: uuidSchema,
    updated_at: z.iso.datetime(),
    updated_by: uuidSchema.nullish(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose()
  .superRefine((item, context) => {
    if (
      item.label_ids !== undefined &&
      item.labels !== undefined &&
      !sameStringSet(item.label_ids, item.labels)
    ) {
      context.addIssue({ code: "custom", message: "Plane Work Item Label投影冲突" });
    }
  })
  .transform((item) => ({
    ...item,
    module_ids_observed: item.module_ids !== undefined,
    module_ids: item.module_ids ?? [],
    label_ids: item.label_ids ?? item.labels ?? [],
  }));
const moduleIssueAssignmentResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ results: z.array(z.unknown()) }).loose(),
]);

const commentResponseSchema = z
  .object({
    id: uuidSchema,
    issue: uuidSchema,
    comment_html: z.string(),
    access: z.enum(["INTERNAL", "EXTERNAL"]),
    created_at: z.iso.datetime().nullish(),
    updated_at: z.iso.datetime().nullish(),
    created_by: uuidSchema.nullish(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();

const locationSchema = z.object(locationShape).strict();
const projectIdentifierLookupSchema = z
  .object({
    workspaceSlug: workspaceSlugSchema,
    identifier: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{0,11}$/u)
      .max(12),
  })
  .strict();
const workItemLookupSchema = z.object({ ...locationShape, externalId: externalIdSchema }).strict();
const workItemByIdSchema = z.object({ ...locationShape, workItemId: uuidSchema }).strict();
const workItemCommentsLookupSchema = z
  .object({
    ...locationShape,
    ...workItemIdentityShape,
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export type PlaneCeEnsureWorkItemIntent = z.infer<typeof planeCeEnsureWorkItemIntentSchema>;
export type PlaneCeWorkItemStateTransitionIntent = z.infer<
  typeof planeCeWorkItemStateTransitionIntentSchema
>;
export type PlaneCeAppendWorkItemCommentIntent = z.infer<
  typeof planeCeAppendWorkItemCommentIntentSchema
>;

type ProviderProjectLookup = Parameters<PlaneProjectCoordinationPort["findProjectByIdentifier"]>[0];
type ProviderSnapshotLookup = Parameters<PlaneProjectCoordinationPort["readProjectSnapshot"]>[0];

export interface PlaneCeProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly identifier: string;
  readonly description: string;
  readonly archivedAt?: string;
  readonly externalSource?: string;
  readonly externalId?: string;
}

export interface PlaneCeStateSnapshot {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly group: z.infer<typeof stateGroupSchema>;
  readonly sequence: number;
}

export interface PlaneCeModuleSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: z.infer<typeof moduleResponseSchema>["status"];
  readonly totalWorkItems: number;
  readonly completedWorkItems: number;
  readonly cancelledWorkItems: number;
  readonly startedWorkItems: number;
  readonly unstartedWorkItems: number;
  readonly backlogWorkItems: number;
  readonly externalSource?: string;
  readonly externalId?: string;
}

export interface PlaneCeWorkItemSnapshot {
  readonly id: string;
  readonly sequenceId: number;
  readonly name: string;
  readonly descriptionHtml: string;
  readonly description: string;
  readonly priority: z.infer<typeof prioritySchema>;
  readonly moduleIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly stateId: string;
  readonly updatedAt: string;
  readonly updatedById?: string;
  readonly stateName?: string;
  readonly stateGroup?: z.infer<typeof stateGroupSchema>;
  readonly externalSource?: string;
  readonly externalId?: string;
}

export interface PlaneCeCommentSnapshot {
  readonly id: string;
  readonly workItemId: string;
  readonly commentHtml: string;
  readonly access: "INTERNAL" | "EXTERNAL";
  readonly externalSource?: string;
  readonly externalId?: string;
}

export type PlaneCeWorkItemWriteResult =
  | { readonly status: "completed"; readonly workItem: PlaneCeWorkItemSnapshot }
  | {
      readonly status: "failed" | "needs_attention" | "outcome_unknown";
      readonly errorCode: string;
      readonly workItem?: PlaneCeWorkItemSnapshot;
    };

export type PlaneCeCommentWriteResult =
  | { readonly status: "completed"; readonly comment: PlaneCeCommentSnapshot }
  | {
      readonly status: "failed" | "needs_attention" | "outcome_unknown";
      readonly errorCode: string;
      readonly comment?: PlaneCeCommentSnapshot;
    };

export class PlaneCeCoordinationError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(code);
    this.name = "PlaneCeCoordinationError";
  }
}

export function createPlaneCeProjectCoordination(
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof fetch,
): PlaneCeProjectCoordination | undefined {
  try {
    const config = readPlaneCeEnvironmentConfig(env);
    if (config === undefined) return undefined;
    return new PlaneCeProjectCoordination({
      ...config,
      ...(fetchFn === undefined ? {} : { fetchFn }),
    });
  } catch (error) {
    throw coordinationError(error);
  }
}

/**
 * Plane只拥有看板对象；本Provider提供Agent日常推进所需的窄读写，不暴露DELETE、任意PATCH或通用HTTP。
 */
export class PlaneCeProjectCoordination implements PlaneProjectCoordinationPort {
  readonly #client: PlaneCeClient;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(options: PlaneCeClientOptions) {
    try {
      this.#client = new PlaneCeClient(options);
    } catch (error) {
      throw coordinationError(error);
    }
  }

  describe() {
    return {
      ...this.#client.describe(),
      externalSource: PLANE_CE_AGENT_EXTERNAL_SOURCE as "later-agent",
      capabilities: [
        "project.read",
        "state.read",
        "module.read",
        "label.read",
        "active_work_item.read",
        "work_item.comment.read",
        "work_item.ensure",
        "work_item.transition_started",
        "work_item.comment.append",
      ] as const,
    };
  }

  toJSON() {
    return this.describe();
  }

  async getProject(input: { readonly workspaceSlug: string; readonly projectId: string }) {
    const location = this.parseReadInput(locationSchema, input);
    this.#client.requireWorkspace(location.workspaceSlug);
    const response = await this.#client.get(projectPath(location), projectResponseSchema);
    return projectSnapshot(response);
  }

  async findProjectByIdentifier(
    input: ProviderProjectLookup | { readonly workspaceSlug: string; readonly identifier: string },
  ): Promise<PlaneCeProjectSnapshot | undefined> {
    const lookup = this.parseReadInput(
      projectIdentifierLookupSchema,
      "projectIdentifier" in input
        ? { workspaceSlug: input.workspaceSlug, identifier: input.projectIdentifier }
        : input,
    );
    this.#client.requireWorkspace(lookup.workspaceSlug);
    const projects = await this.#client.listAll(
      `/api/v1/workspaces/${encodeURIComponent(lookup.workspaceSlug)}/projects/`,
      projectResponseSchema,
    );
    const matches = projects.filter((project) => project.identifier === lookup.identifier);
    if (matches.length > 1) {
      throw new PlaneCeCoordinationError("plane_project_identifier_ambiguous", false);
    }
    const project = matches[0];
    if (project === undefined) return undefined;
    if (project.archived_at != null) {
      throw new PlaneCeCoordinationError("plane_project_archived", false);
    }
    return projectSnapshot(project);
  }

  async readProjectByIdentifier(input: {
    readonly workspaceSlug: string;
    readonly identifier: string;
  }): Promise<PlaneCeProjectSnapshot> {
    const project = await this.findProjectByIdentifier(input);
    if (project === undefined) {
      throw new PlaneCeCoordinationError("plane_project_not_found", false);
    }
    return project;
  }

  async readProjectSnapshot(input: ProviderSnapshotLookup) {
    const location = this.parseReadInput(locationSchema, input);
    this.#client.requireWorkspace(location.workspaceSlug);
    const [project, states, modules, labels, workItems] = await Promise.all([
      this.#client.get(projectPath(location), projectResponseSchema),
      this.listRawStates(location),
      this.listRawModules(location),
      this.listRawLabels(location),
      this.listRawWorkItems(location, true),
    ]);
    return {
      project: projectSnapshot(project),
      states: states.map(stateSnapshot),
      modules: modules.map(moduleSnapshot),
      labels: labels.map(labelSnapshot),
      workItems: activeWorkItemSnapshots(states, workItems),
    };
  }

  async listStates(input: { readonly workspaceSlug: string; readonly projectId: string }) {
    const location = this.parseReadInput(locationSchema, input);
    this.#client.requireWorkspace(location.workspaceSlug);
    const states = await this.listRawStates(location);
    return states.map(stateSnapshot);
  }

  async listModules(input: { readonly workspaceSlug: string; readonly projectId: string }) {
    const location = this.parseReadInput(locationSchema, input);
    this.#client.requireWorkspace(location.workspaceSlug);
    const modules = await this.listRawModules(location);
    return modules.map(moduleSnapshot);
  }

  async listActiveWorkItems(input: { readonly workspaceSlug: string; readonly projectId: string }) {
    const location = this.parseReadInput(locationSchema, input);
    this.#client.requireWorkspace(location.workspaceSlug);
    const [states, workItems] = await Promise.all([
      this.listRawStates(location),
      this.listRawWorkItems(location, true),
    ]);
    return activeWorkItemSnapshots(states, workItems);
  }

  async findWorkItemByExternalKey(input: {
    readonly workspaceSlug: string;
    readonly projectId: string;
    readonly externalId: string;
  }): Promise<PlaneCeWorkItemSnapshot | undefined> {
    const lookup = this.parseReadInput(workItemLookupSchema, input);
    this.#client.requireWorkspace(lookup.workspaceSlug);
    const workItem = await this.findRawWorkItemByExternalKey(lookup, true);
    return workItem === undefined ? undefined : workItemSnapshot(workItem);
  }

  /**
   * 评论是Provider拥有的不可信输入。这里先验证Work Item的UUID与Chat external key，
   * 再只返回有界纯文本摘要；不返回HTML，也不把评论解释为可执行命令。
   */
  async readWorkItemComments(input: {
    readonly workspaceSlug: string;
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemExternalId: string;
    readonly limit: number;
  }) {
    const lookup = this.parseReadInput(workItemCommentsLookupSchema, input);
    this.#client.requireWorkspace(lookup.workspaceSlug);
    await this.requireMatchingWorkItem(lookup);
    const comments = await this.#client.listAll(
      `${projectPath(lookup)}work-items/${encodeURIComponent(lookup.workItemId)}/comments/`,
      commentResponseSchema,
    );
    const ordered = [...comments].sort(
      (left, right) =>
        (right.updated_at ?? right.created_at ?? "").localeCompare(
          left.updated_at ?? left.created_at ?? "",
        ) || right.id.localeCompare(left.id),
    );
    const selected = ordered.slice(0, lookup.limit);
    return {
      comments: selected.map((comment) => ({
        id: comment.id,
        workItemId: comment.issue,
        excerpt: commentExcerpt(comment.comment_html),
        origin:
          comment.external_source === PLANE_CE_AGENT_EXTERNAL_SOURCE
            ? ("later_agent" as const)
            : ("human_or_other" as const),
        ...(comment.created_by == null ? {} : { actorExternalId: comment.created_by }),
        ...(comment.external_id == null ? {} : { externalId: comment.external_id }),
        ...(comment.created_at == null ? {} : { createdAt: comment.created_at }),
        ...(comment.updated_at == null ? {} : { updatedAt: comment.updated_at }),
      })),
      totalCommentCount: ordered.length,
      truncated: ordered.length > selected.length,
    };
  }

  async ensureWorkItem(
    input: PlaneCeEnsureWorkItemIntent | PlaneProviderEnsureWorkItemIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    const intent = normalizeEnsureInput(input);
    return this.#withWriteLock(
      `ensure:${intent.workspaceSlug}:${intent.projectId}:${intent.externalId}`,
      () => this.ensureWorkItemUnlocked(input),
    );
  }

  private async ensureWorkItemUnlocked(
    input: PlaneCeEnsureWorkItemIntent | PlaneProviderEnsureWorkItemIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    let intent: PlaneCeEnsureWorkItemIntent;
    let crossedWriteBoundary = false;
    try {
      intent = planeCeEnsureWorkItemIntentSchema.parse(normalizeEnsureInput(input));
      this.#client.requireWorkspace(intent.workspaceSlug);
      await this.validatePlacement(intent, intent.moduleIds, intent.labelIds);
      const state = await this.resolveState(intent, intent.stateName, intent.stateGroup);
      const existing = await this.findRawWorkItemByExternalKey(
        {
          workspaceSlug: intent.workspaceSlug,
          projectId: intent.projectId,
          externalId: intent.externalId,
        },
        intent.moduleIds.length > 0,
      );
      if (existing !== undefined) return ensureResult(existing, intent, state);

      try {
        const created = await this.#client.post(
          `${projectPath(intent)}work-items/`,
          {
            name: intent.name,
            description_html: descriptionHtml(intent.description),
            priority: intent.priority,
            state: state.id,
            labels: intent.labelIds,
            external_source: PLANE_CE_AGENT_EXTERNAL_SOURCE,
            external_id: intent.externalId,
          },
          workItemResponseSchema,
        );
        crossedWriteBoundary = true;
        if (intent.moduleIds[0] !== undefined) {
          await this.#client.post(
            `${projectPath(intent)}modules/${encodeURIComponent(intent.moduleIds[0])}/module-issues/`,
            { issues: [created.id] },
            moduleIssueAssignmentResponseSchema,
          );
        }
        const observed = await this.findRawWorkItemByExternalKey(
          {
            workspaceSlug: intent.workspaceSlug,
            projectId: intent.projectId,
            externalId: intent.externalId,
          },
          intent.moduleIds.length > 0,
        );
        if (observed === undefined) {
          return { status: "outcome_unknown", errorCode: "plane_work_item_reconcile_pending" };
        }
        return ensureResult(observed, intent, state);
      } catch (error) {
        if (!(error instanceof PlaneCeClientError) || error.httpStatus !== 409) {
          return workItemFailure(error, "plane_work_item_ensure_failed", crossedWriteBoundary);
        }
        return await this.reconcileEnsureAfterConflict(intent, state);
      }
    } catch (error) {
      return workItemFailure(error, "plane_work_item_ensure_failed", crossedWriteBoundary);
    }
  }

  async reconcileEnsureWorkItem(
    input: PlaneCeEnsureWorkItemIntent | PlaneProviderEnsureWorkItemIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    try {
      const intent = planeCeEnsureWorkItemIntentSchema.parse(normalizeEnsureInput(input));
      this.#client.requireWorkspace(intent.workspaceSlug);
      await this.validatePlacement(intent, intent.moduleIds, intent.labelIds);
      const state = await this.resolveState(intent, intent.stateName, intent.stateGroup);
      const existing = await this.findRawWorkItemByExternalKey(
        {
          workspaceSlug: intent.workspaceSlug,
          projectId: intent.projectId,
          externalId: intent.externalId,
        },
        intent.moduleIds.length > 0,
      );
      if (existing === undefined) {
        return { status: "outcome_unknown", errorCode: "plane_work_item_reconcile_pending" };
      }
      return ensureResult(existing, intent, state);
    } catch (error) {
      return reconcileWorkItemFailure(error, "plane_work_item_ensure_reconcile_failed");
    }
  }

  async transitionWorkItemState(
    input: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    const intent = normalizeTransitionInput(input);
    return this.#withWriteLock(
      `work-item:${intent.workspaceSlug}:${intent.projectId}:${intent.workItemId}`,
      () => this.transitionWorkItemStateUnlocked(input),
    );
  }

  async preflightWorkItemStateTransition(
    input: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    const intent = normalizeTransitionInput(input);
    return this.#withWriteLock(
      `work-item:${intent.workspaceSlug}:${intent.projectId}:${intent.workItemId}`,
      () => this.preflightWorkItemStateTransitionUnlocked(input),
    );
  }

  async applyCommentedWorkItemStateTransition(input: {
    readonly transition: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent;
    readonly comment: PlaneCeAppendWorkItemCommentIntent | PlaneProviderCommentIntent;
  }) {
    const transition = normalizeTransitionInput(input.transition);
    const comment = normalizeCommentInput(input.comment);
    if (
      transition.workspaceSlug !== comment.workspaceSlug ||
      transition.projectId !== comment.projectId ||
      transition.workItemId !== comment.workItemId ||
      transition.workItemExternalId !== comment.workItemExternalId
    ) {
      return {
        phase: "preflight" as const,
        outcome: workItemFailure(
          new PlaneCeCoordinationError("plane_composite_operation_binding_mismatch", false),
          "plane_composite_operation_binding_mismatch",
        ),
      };
    }
    return this.#withWriteLock(
      `work-item:${transition.workspaceSlug}:${transition.projectId}:${transition.workItemId}`,
      async () => {
        const preflight = await this.preflightWorkItemStateTransitionUnlocked(transition);
        if (preflight.status !== "completed") {
          return { phase: "preflight" as const, outcome: preflight };
        }
        const commentOutcome = await this.appendWorkItemCommentUnlocked(comment);
        if (commentOutcome.status !== "completed") {
          return { phase: "comment" as const, outcome: commentOutcome };
        }
        const transitionOutcome = await this.transitionWorkItemStateUnlocked(transition);
        return {
          phase: "transition" as const,
          comment: commentOutcome.comment,
          outcome: transitionOutcome,
        };
      },
    );
  }

  private async preflightWorkItemStateTransitionUnlocked(
    input: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    try {
      const parsed = planeCeWorkItemStateTransitionIntentSchema.parse(
        normalizeTransitionInput(input),
      );
      this.#client.requireWorkspace(parsed.workspaceSlug);
      const [workItem, targetState] = await Promise.all([
        this.requireMatchingWorkItem(parsed),
        this.resolveState(parsed, parsed.stateName, parsed.stateGroup),
        this.validatePlacement(parsed, [], parsed.labelIds ?? []),
      ]);
      if (workItem.state !== parsed.expectedStateId) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_competed",
          workItem: workItemSnapshot(workItem),
        };
      }
      const sourceState = await this.findStateById(parsed, workItem.state);
      if (
        sourceState === undefined ||
        sourceState.group === "completed" ||
        sourceState.group === "cancelled"
      ) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_terminal_state_protected",
          workItem: workItemSnapshot(workItem, sourceState),
        };
      }
      if (!isAllowedAgentTransitionSource(targetState.name, sourceState)) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_source_forbidden",
          workItem: workItemSnapshot(workItem, sourceState),
        };
      }
      return { status: "completed", workItem: workItemSnapshot(workItem, sourceState) };
    } catch (error) {
      return workItemFailure(error, "plane_work_item_transition_preflight_failed", false);
    }
  }

  private async transitionWorkItemStateUnlocked(
    input: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    let crossedWriteBoundary = false;
    try {
      const intent = planeCeWorkItemStateTransitionIntentSchema.parse(
        normalizeTransitionInput(input),
      );
      this.#client.requireWorkspace(intent.workspaceSlug);
      const [workItem, state] = await Promise.all([
        this.requireMatchingWorkItem(intent),
        this.resolveState(intent, intent.stateName, intent.stateGroup),
        this.validatePlacement(intent, [], intent.labelIds ?? []),
      ]);
      if (
        workItem.state === state.id &&
        managedLabelsMatch(workItem.label_ids, intent.managedLabelIds, intent.labelIds)
      ) {
        return { status: "completed", workItem: workItemSnapshot(workItem, state) };
      }
      if (workItem.state !== intent.expectedStateId) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_competed",
          workItem: workItemSnapshot(workItem),
        };
      }
      const sourceState = await this.findStateById(intent, workItem.state);
      if (
        sourceState === undefined ||
        sourceState.group === "completed" ||
        sourceState.group === "cancelled"
      ) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_terminal_state_protected",
          workItem: workItemSnapshot(workItem, sourceState),
        };
      }
      if (!isAllowedAgentTransitionSource(state.name, sourceState)) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_source_forbidden",
          workItem: workItemSnapshot(workItem, sourceState),
        };
      }

      // Plane CE 1.4.1的Work Item PATCH没有ETag/expected-revision条件。再次读取只能缩短
      // GET→PATCH窗口；Chat单API进程内的keyed lock可串行Agent写，但无法把人类编辑变成
      // 原子CAS。若人在最后一次GET与PATCH之间修改，写后读会报告竞争，却不能撤销覆盖。
      const latest = await this.requireMatchingWorkItem(intent);
      if (latest.state !== intent.expectedStateId) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_competed",
          workItem: workItemSnapshot(latest),
        };
      }

      const labelIds = reconcileManagedLabelIds(
        latest.label_ids,
        intent.managedLabelIds,
        intent.labelIds,
      );
      await this.#client.patch(
        `${projectPath(intent)}work-items/${encodeURIComponent(intent.workItemId)}/`,
        { state: state.id, ...(labelIds === undefined ? {} : { labels: labelIds }) },
        workItemResponseSchema,
      );
      crossedWriteBoundary = true;
      const observed = await this.requireMatchingWorkItem(intent);
      if (
        observed.state !== state.id ||
        (labelIds !== undefined && !sameStringSet(observed.label_ids, labelIds))
      ) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_competed",
          workItem: workItemSnapshot(observed),
        };
      }
      return { status: "completed", workItem: workItemSnapshot(observed, state) };
    } catch (error) {
      return workItemFailure(error, "plane_work_item_transition_failed", crossedWriteBoundary);
    }
  }

  async reconcileWorkItemStateTransition(
    input: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent,
  ): Promise<PlaneCeWorkItemWriteResult> {
    try {
      const intent = planeCeWorkItemStateTransitionIntentSchema.parse(
        normalizeTransitionInput(input),
      );
      this.#client.requireWorkspace(intent.workspaceSlug);
      const [workItem, state] = await Promise.all([
        this.requireMatchingWorkItem(intent),
        this.resolveState(intent, intent.stateName, intent.stateGroup),
        this.validatePlacement(intent, [], intent.labelIds ?? []),
      ]);
      if (
        workItem.state !== state.id ||
        !managedLabelsMatch(workItem.label_ids, intent.managedLabelIds, intent.labelIds)
      ) {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_state_competed",
          workItem: workItemSnapshot(workItem),
        };
      }
      return { status: "completed", workItem: workItemSnapshot(workItem, state) };
    } catch (error) {
      return reconcileWorkItemFailure(error, "plane_work_item_transition_reconcile_failed");
    }
  }

  async appendWorkItemComment(
    input: PlaneCeAppendWorkItemCommentIntent | PlaneProviderCommentIntent,
  ): Promise<PlaneCeCommentWriteResult> {
    const intent = normalizeCommentInput(input);
    return this.#withWriteLock(
      `work-item:${intent.workspaceSlug}:${intent.projectId}:${intent.workItemId}`,
      () => this.appendWorkItemCommentUnlocked(input),
    );
  }

  private async appendWorkItemCommentUnlocked(
    input: PlaneCeAppendWorkItemCommentIntent | PlaneProviderCommentIntent,
  ): Promise<PlaneCeCommentWriteResult> {
    try {
      const intent = planeCeAppendWorkItemCommentIntentSchema.parse(normalizeCommentInput(input));
      this.#client.requireWorkspace(intent.workspaceSlug);
      const workItem = await this.requireMatchingWorkItem(intent);
      const existing = await this.findRawCommentByExternalKey(intent);
      if (existing !== undefined) return commentResult(existing, intent);
      const state = await this.findStateById(intent, workItem.state);
      if (state === undefined) {
        return { status: "needs_attention", errorCode: "plane_work_item_state_unknown" };
      }
      if (state.group === "completed" || state.group === "cancelled") {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_terminal_state_protected",
        };
      }

      try {
        const created = await this.#client.post(
          `${projectPath(intent)}work-items/${encodeURIComponent(intent.workItemId)}/comments/`,
          {
            comment_html: intent.commentHtml,
            access: "INTERNAL",
            external_source: PLANE_CE_AGENT_EXTERNAL_SOURCE,
            external_id: intent.commentExternalId,
          },
          commentResponseSchema,
        );
        return commentResult(created, intent);
      } catch (error) {
        if (!(error instanceof PlaneCeClientError) || error.httpStatus !== 409) {
          return commentFailure(error, "plane_work_item_comment_append_failed");
        }
        return await this.reconcileCommentAfterConflict(intent);
      }
    } catch (error) {
      return commentFailure(error, "plane_work_item_comment_append_failed");
    }
  }

  async reconcileWorkItemComment(
    input: PlaneCeAppendWorkItemCommentIntent | PlaneProviderCommentIntent,
  ): Promise<PlaneCeCommentWriteResult> {
    try {
      const intent = planeCeAppendWorkItemCommentIntentSchema.parse(normalizeCommentInput(input));
      this.#client.requireWorkspace(intent.workspaceSlug);
      const workItem = await this.requireMatchingWorkItem(intent);
      const existing = await this.findRawCommentByExternalKey(intent);
      if (existing !== undefined) return commentResult(existing, intent);
      const state = await this.findStateById(intent, workItem.state);
      if (state === undefined) {
        return { status: "needs_attention", errorCode: "plane_work_item_state_unknown" };
      }
      if (state.group === "completed" || state.group === "cancelled") {
        return {
          status: "needs_attention",
          errorCode: "plane_work_item_terminal_state_protected",
        };
      }
      return {
        status: "outcome_unknown",
        errorCode: "plane_work_item_comment_reconcile_pending",
      };
    } catch (error) {
      return reconcileCommentFailure(error, "plane_work_item_comment_reconcile_failed");
    }
  }

  private parseReadInput<T>(schema: z.ZodType<T>, input: unknown): T {
    try {
      return schema.parse(input);
    } catch {
      throw new PlaneCeCoordinationError("plane_ce_input_invalid", false);
    }
  }

  private listRawStates(location: { readonly workspaceSlug: string; readonly projectId: string }) {
    return this.#client.listAll(`${projectPath(location)}states/`, stateResponseSchema);
  }

  private listRawModules(location: { readonly workspaceSlug: string; readonly projectId: string }) {
    return this.#client.listAll(`${projectPath(location)}modules/`, moduleResponseSchema);
  }

  private listRawLabels(location: { readonly workspaceSlug: string; readonly projectId: string }) {
    return this.#client.listAll(`${projectPath(location)}labels/`, labelResponseSchema);
  }

  private async listRawWorkItems(
    location: {
      readonly workspaceSlug: string;
      readonly projectId: string;
    },
    includeModules = false,
  ) {
    const [workItems, modules] = await Promise.all([
      this.#client.listAll(`${projectPath(location)}work-items/`, workItemResponseSchema),
      includeModules ? this.listRawModules(location) : Promise.resolve([]),
    ]);
    if (!includeModules || workItems.every((workItem) => workItem.module_ids_observed)) {
      return workItems;
    }
    const moduleWorkItems = await Promise.all(
      modules.map(async (module) => ({
        moduleId: module.id,
        workItems: await this.#client.listAll(
          `${projectPath(location)}modules/${encodeURIComponent(module.id)}/module-issues/`,
          workItemResponseSchema,
        ),
      })),
    );
    const moduleIdsByWorkItem = new Map<string, string[]>();
    for (const assignment of moduleWorkItems) {
      for (const workItem of assignment.workItems) {
        const ids = moduleIdsByWorkItem.get(workItem.id) ?? [];
        ids.push(assignment.moduleId);
        moduleIdsByWorkItem.set(workItem.id, ids);
      }
    }
    return workItems.map((workItem) => ({
      ...workItem,
      module_ids: [...(moduleIdsByWorkItem.get(workItem.id) ?? [])].sort(),
    }));
  }

  private async findRawWorkItemByExternalKey(
    input: {
      readonly workspaceSlug: string;
      readonly projectId: string;
      readonly externalId: string;
      readonly workItemId?: string;
    },
    includeModules = false,
  ) {
    const workItems = await this.listRawWorkItems(input, includeModules);
    const matches = workItems.filter(
      (workItem) =>
        workItem.external_source === PLANE_CE_AGENT_EXTERNAL_SOURCE &&
        workItem.external_id === input.externalId,
    );
    if (matches.length > 1) {
      throw new PlaneCeCoordinationError("plane_work_item_external_key_ambiguous", false);
    }
    if (
      matches.length === 0 &&
      input.workItemId !== undefined &&
      workItems.some((workItem) => workItem.id === input.workItemId)
    ) {
      throw new PlaneCeCoordinationError("plane_work_item_external_key_mismatch", false);
    }
    return matches[0];
  }

  private async getRawWorkItemById(input: {
    readonly workspaceSlug: string;
    readonly projectId: string;
    readonly workItemId: string;
  }) {
    const parsed = workItemByIdSchema.parse({
      workspaceSlug: input.workspaceSlug,
      projectId: input.projectId,
      workItemId: input.workItemId,
    });
    return this.#client.getOptional(
      `${projectPath(parsed)}work-items/${encodeURIComponent(parsed.workItemId)}/`,
      workItemResponseSchema,
    );
  }

  /** UUID与external key必须同时指向同一对象，避免陈旧Binding把Agent写入别的人工任务。 */
  private async requireMatchingWorkItem(input: {
    readonly workspaceSlug: string;
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemExternalId: string;
  }) {
    const [byId, byExternalKey] = await Promise.all([
      this.getRawWorkItemById(input),
      this.findRawWorkItemByExternalKey({
        workspaceSlug: input.workspaceSlug,
        projectId: input.projectId,
        externalId: input.workItemExternalId,
        workItemId: input.workItemId,
      }),
    ]);
    if (byId === undefined || byExternalKey === undefined) {
      throw new PlaneCeCoordinationError("plane_work_item_not_found", false);
    }
    if (byId.id !== byExternalKey.id || byId.id !== input.workItemId) {
      throw new PlaneCeCoordinationError("plane_work_item_binding_mismatch", false);
    }
    return byId;
  }

  private async resolveState(
    location: { readonly workspaceSlug: string; readonly projectId: string },
    stateName: string,
    expectedGroup: "backlog" | "unstarted" | "started",
  ) {
    const states = await this.#client.listAll(
      `${projectPath(location)}states/`,
      stateResponseSchema,
    );
    const matches = states.filter((state) => state.name === stateName);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new PlaneCeCoordinationError("plane_state_not_found_or_ambiguous", false);
    }
    const state = matches[0];
    if (state.group !== expectedGroup) {
      throw new PlaneCeCoordinationError("plane_state_group_mismatch", false);
    }
    return state;
  }

  private async findStateById(
    location: { readonly workspaceSlug: string; readonly projectId: string },
    stateId: string,
  ) {
    const states = await this.listRawStates(location);
    return states.find((state) => state.id === stateId);
  }

  private async validatePlacement(
    location: { readonly workspaceSlug: string; readonly projectId: string },
    moduleIds: readonly string[],
    labelIds: readonly string[],
  ): Promise<void> {
    if (
      new Set(moduleIds).size !== moduleIds.length ||
      new Set(labelIds).size !== labelIds.length
    ) {
      throw new PlaneCeCoordinationError("plane_work_item_placement_duplicate", false);
    }
    const [modules, labels] = await Promise.all([
      moduleIds.length === 0 ? Promise.resolve([]) : this.listRawModules(location),
      labelIds.length === 0 ? Promise.resolve([]) : this.listRawLabels(location),
    ]);
    if (
      moduleIds.some((id) => !modules.some((module) => module.id === id)) ||
      labelIds.some((id) => !labels.some((label) => label.id === id))
    ) {
      throw new PlaneCeCoordinationError("plane_work_item_placement_not_found", false);
    }
  }

  private async findRawCommentByExternalKey(intent: PlaneCeAppendWorkItemCommentIntent) {
    const comments = await this.#client.listAll(
      `${projectPath(intent)}work-items/${encodeURIComponent(intent.workItemId)}/comments/`,
      commentResponseSchema,
    );
    const matches = comments.filter(
      (comment) =>
        comment.external_source === PLANE_CE_AGENT_EXTERNAL_SOURCE &&
        comment.external_id === intent.commentExternalId,
    );
    if (matches.length > 1) {
      throw new PlaneCeCoordinationError("plane_work_item_comment_external_key_ambiguous", false);
    }
    return matches[0];
  }

  private async reconcileEnsureAfterConflict(
    intent: PlaneCeEnsureWorkItemIntent,
    state: z.infer<typeof stateResponseSchema>,
  ): Promise<PlaneCeWorkItemWriteResult> {
    try {
      const existing = await this.findRawWorkItemByExternalKey(
        {
          workspaceSlug: intent.workspaceSlug,
          projectId: intent.projectId,
          externalId: intent.externalId,
        },
        intent.moduleIds.length > 0,
      );
      if (existing === undefined) {
        return { status: "outcome_unknown", errorCode: "plane_work_item_reconcile_pending" };
      }
      return ensureResult(existing, intent, state);
    } catch (error) {
      return reconcileWorkItemFailure(error, "plane_work_item_conflict_reconcile_failed");
    }
  }

  private async reconcileCommentAfterConflict(
    intent: PlaneCeAppendWorkItemCommentIntent,
  ): Promise<PlaneCeCommentWriteResult> {
    try {
      const existing = await this.findRawCommentByExternalKey(intent);
      if (existing === undefined) {
        return {
          status: "outcome_unknown",
          errorCode: "plane_work_item_comment_reconcile_pending",
        };
      }
      return commentResult(existing, intent);
    } catch (error) {
      return reconcileCommentFailure(error, "plane_work_item_comment_conflict_reconcile_failed");
    }
  }

  /** 单API进程内按外部对象串行化find→write，避免两个Agent并发制造重复或相互覆盖。 */
  async #withWriteLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#writeTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#writeTails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#writeTails.get(key) === tail) this.#writeTails.delete(key);
    }
  }
}

/**
 * expected State只防读后竞态；本矩阵另外防止Agent在已经看见人工审核态后主动回退。
 * 目标名称由Contracts冻结，来源同时校验语义name与group，不依赖Codex本地配置。
 */
function isAllowedAgentTransitionSource(
  targetStateName: string,
  source: z.infer<typeof stateResponseSchema>,
): boolean {
  if (targetStateName === "Ready") return false;
  if (targetStateName === "Needs Review") {
    return (
      source.group === "started" &&
      source.name !== "Blocked" &&
      source.name !== "Needs Review" &&
      source.name !== "Ready"
    );
  }
  if (targetStateName === "Blocked") {
    return (
      source.group === "backlog" ||
      source.group === "unstarted" ||
      (source.group === "started" && source.name !== "Blocked")
    );
  }
  // 其他started目标来自Binding的已验证状态映射，例如软件项目的In Progress、
  // Content Lab内容的Producing或方法实验的Experimenting。Provider不再硬编码项目词汇。
  return (
    source.group === "backlog" ||
    source.group === "unstarted" ||
    (source.group === "started" && source.name === "Blocked")
  );
}

type ProjectResponse = z.infer<typeof projectResponseSchema>;
type StateResponse = z.infer<typeof stateResponseSchema>;
type ModuleResponse = z.infer<typeof moduleResponseSchema>;
type LabelResponse = z.infer<typeof labelResponseSchema>;
type WorkItemResponse = z.infer<typeof workItemResponseSchema>;
type CommentResponse = z.infer<typeof commentResponseSchema>;

function projectPath(input: {
  readonly workspaceSlug: string;
  readonly projectId: string;
}): string {
  return `/api/v1/workspaces/${encodeURIComponent(input.workspaceSlug)}/projects/${encodeURIComponent(input.projectId)}/`;
}

function normalizeEnsureInput(
  input: PlaneCeEnsureWorkItemIntent | PlaneProviderEnsureWorkItemIntent,
): PlaneCeEnsureWorkItemIntent {
  if (!("planeWorkspaceSlug" in input)) return input;
  return {
    workspaceSlug: input.planeWorkspaceSlug,
    projectId: input.planeProjectId,
    externalId: input.externalId,
    name: input.name,
    description: input.description,
    priority: input.priority,
    stateName: input.stateName,
    stateGroup: input.stateGroup,
    moduleIds: [...input.moduleIds],
    labelIds: [...input.labelIds],
  };
}

function normalizeTransitionInput(
  input: PlaneCeWorkItemStateTransitionIntent | PlaneProviderTransitionIntent,
): PlaneCeWorkItemStateTransitionIntent {
  if (!("planeWorkspaceSlug" in input)) return input;
  return {
    workspaceSlug: input.planeWorkspaceSlug,
    projectId: input.planeProjectId,
    workItemId: input.workItemId,
    workItemExternalId: input.workItemExternalId,
    expectedStateId: input.expectedStateId,
    stateName: input.stateName,
    stateGroup: input.stateGroup,
    ...(input.labelIds === undefined ? {} : { labelIds: [...input.labelIds] }),
    ...(input.managedLabelIds === undefined ? {} : { managedLabelIds: [...input.managedLabelIds] }),
  };
}

function normalizeCommentInput(
  input: PlaneCeAppendWorkItemCommentIntent | PlaneProviderCommentIntent,
): PlaneCeAppendWorkItemCommentIntent {
  if (!("planeWorkspaceSlug" in input)) return input;
  return {
    workspaceSlug: input.planeWorkspaceSlug,
    projectId: input.planeProjectId,
    workItemId: input.workItemId,
    workItemExternalId: input.workItemExternalId,
    kind: input.kind,
    commentExternalId: input.commentExternalId,
    commentHtml: input.commentHtml,
  };
}

function projectSnapshot(project: ProjectResponse): PlaneCeProjectSnapshot {
  return {
    id: project.id,
    name: project.name,
    identifier: project.identifier,
    description: project.description,
    ...(project.archived_at == null ? {} : { archivedAt: project.archived_at }),
    ...(project.external_source == null ? {} : { externalSource: project.external_source }),
    ...(project.external_id == null ? {} : { externalId: project.external_id }),
  };
}

function stateSnapshot(state: StateResponse): PlaneCeStateSnapshot {
  return {
    id: state.id,
    name: state.name,
    color: state.color,
    group: state.group,
    sequence: state.sequence,
  };
}

function moduleSnapshot(module: ModuleResponse): PlaneCeModuleSnapshot {
  return {
    id: module.id,
    name: module.name,
    status: module.status,
    totalWorkItems: module.total_issues,
    completedWorkItems: module.completed_issues,
    cancelledWorkItems: module.cancelled_issues,
    startedWorkItems: module.started_issues,
    unstartedWorkItems: module.unstarted_issues,
    backlogWorkItems: module.backlog_issues,
    ...(module.external_source == null ? {} : { externalSource: module.external_source }),
    ...(module.external_id == null ? {} : { externalId: module.external_id }),
  };
}

function labelSnapshot(label: LabelResponse) {
  return { id: label.id, name: label.name, color: label.color };
}

function workItemSnapshot(
  workItem: WorkItemResponse,
  state?: StateResponse,
): PlaneCeWorkItemSnapshot {
  return {
    id: workItem.id,
    sequenceId: workItem.sequence_id,
    name: workItem.name,
    descriptionHtml: workItem.description_html,
    description: workItem.description_html,
    priority: workItem.priority,
    moduleIds: workItem.module_ids,
    labelIds: workItem.label_ids,
    stateId: workItem.state,
    updatedAt: workItem.updated_at,
    ...(workItem.updated_by === null || workItem.updated_by === undefined
      ? {}
      : { updatedById: workItem.updated_by }),
    ...(state === undefined ? {} : { stateName: state.name, stateGroup: state.group }),
    ...(workItem.external_source == null ? {} : { externalSource: workItem.external_source }),
    ...(workItem.external_id == null ? {} : { externalId: workItem.external_id }),
  };
}

function activeWorkItemSnapshots(
  states: readonly StateResponse[],
  workItems: readonly WorkItemResponse[],
): readonly PlaneCeWorkItemSnapshot[] {
  const statesById = new Map(states.map((state) => [state.id, state]));
  return workItems.flatMap((workItem) => {
    const state = statesById.get(workItem.state);
    if (state === undefined) {
      throw new PlaneCeCoordinationError("plane_work_item_state_reference_invalid", false);
    }
    if (state.group === "completed" || state.group === "cancelled") return [];
    return [workItemSnapshot(workItem, state)];
  });
}

function commentSnapshot(comment: CommentResponse): PlaneCeCommentSnapshot {
  return {
    id: comment.id,
    workItemId: comment.issue,
    commentHtml: comment.comment_html,
    access: comment.access,
    ...(comment.external_source == null ? {} : { externalSource: comment.external_source }),
    ...(comment.external_id == null ? {} : { externalId: comment.external_id }),
  };
}

/** Plane comment_html只作为外部文本展示；实体解码保持窄而确定，不尝试执行富文本。 */
function commentExcerpt(commentHtml: string): string {
  return commentHtml
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, 500);
}

function ensureResult(
  workItem: WorkItemResponse,
  intent: PlaneCeEnsureWorkItemIntent,
  state: StateResponse,
): PlaneCeWorkItemWriteResult {
  const snapshot = workItemSnapshot(workItem, state);
  if (
    workItem.external_source !== PLANE_CE_AGENT_EXTERNAL_SOURCE ||
    workItem.external_id !== intent.externalId ||
    workItem.name !== intent.name ||
    workItem.description_html !== descriptionHtml(intent.description) ||
    workItem.priority !== intent.priority ||
    !sameStringSet(workItem.module_ids, intent.moduleIds) ||
    !sameStringSet(workItem.label_ids, intent.labelIds) ||
    workItem.state !== state.id
  ) {
    return {
      status: "needs_attention",
      errorCode: "plane_work_item_intent_conflict",
      workItem: snapshot,
    };
  }
  return { status: "completed", workItem: snapshot };
}

function commentResult(
  comment: CommentResponse,
  intent: PlaneCeAppendWorkItemCommentIntent,
): PlaneCeCommentWriteResult {
  const snapshot = commentSnapshot(comment);
  if (
    comment.issue !== intent.workItemId ||
    comment.access !== "INTERNAL" ||
    comment.external_source !== PLANE_CE_AGENT_EXTERNAL_SOURCE ||
    comment.external_id !== intent.commentExternalId ||
    comment.comment_html !== intent.commentHtml
  ) {
    return {
      status: "needs_attention",
      errorCode: "plane_work_item_comment_intent_conflict",
      comment: snapshot,
    };
  }
  return { status: "completed", comment: snapshot };
}

function descriptionHtml(description: string): string {
  return `<p>${description
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</p>`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function reconcileManagedLabelIds(
  current: readonly string[],
  managed: readonly string[] | undefined,
  desired: readonly string[] | undefined,
): readonly string[] | undefined {
  if (managed === undefined || desired === undefined) return undefined;
  const managedSet = new Set(managed);
  return [...new Set([...current.filter((id) => !managedSet.has(id)), ...desired])].sort();
}

function managedLabelsMatch(
  current: readonly string[],
  managed: readonly string[] | undefined,
  desired: readonly string[] | undefined,
): boolean {
  if (managed === undefined || desired === undefined) return true;
  const managedSet = new Set(managed);
  return sameStringSet(
    current.filter((id) => managedSet.has(id)),
    desired,
  );
}

function workItemFailure(
  error: unknown,
  fallbackCode: string,
  crossedWriteBoundary = false,
): PlaneCeWorkItemWriteResult {
  const normalized = resultError(error, fallbackCode, crossedWriteBoundary);
  return { status: normalized.status, errorCode: normalized.code };
}

function reconcileWorkItemFailure(
  error: unknown,
  fallbackCode: string,
): PlaneCeWorkItemWriteResult {
  const normalized = resultError(error, fallbackCode, true);
  return { status: normalized.status, errorCode: normalized.code };
}

function commentFailure(error: unknown, fallbackCode: string): PlaneCeCommentWriteResult {
  const normalized = resultError(error, fallbackCode, false);
  return { status: normalized.status, errorCode: normalized.code };
}

function reconcileCommentFailure(error: unknown, fallbackCode: string): PlaneCeCommentWriteResult {
  const normalized = resultError(error, fallbackCode, true);
  return { status: normalized.status, errorCode: normalized.code };
}

function resultError(
  error: unknown,
  fallbackCode: string,
  unresolvedReadOrPriorWrite: boolean,
): {
  readonly status: "failed" | "needs_attention" | "outcome_unknown";
  readonly code: string;
} {
  if (error instanceof z.ZodError) {
    return { code: "plane_ce_input_invalid", status: "failed" };
  }
  if (error instanceof PlaneCeCoordinationError) {
    return {
      code: error.code,
      status: error.outcomeUnknown
        ? "outcome_unknown"
        : error.code === "plane_work_item_binding_mismatch" ||
            error.code === "plane_work_item_comment_external_key_ambiguous"
          ? "needs_attention"
          : unresolvedReadOrPriorWrite && error.code.includes("not_found")
            ? "outcome_unknown"
            : "failed",
    };
  }
  if (error instanceof PlaneCeClientError) {
    return {
      code: error.code,
      status: error.outcomeUnknown || unresolvedReadOrPriorWrite ? "outcome_unknown" : "failed",
    };
  }
  return {
    code: fallbackCode,
    status: unresolvedReadOrPriorWrite ? "outcome_unknown" : "failed",
  };
}

function coordinationError(error: unknown): PlaneCeCoordinationError {
  if (error instanceof PlaneCeCoordinationError) return error;
  if (error instanceof PlaneCeClientError) {
    return new PlaneCeCoordinationError(error.code, error.outcomeUnknown);
  }
  return new PlaneCeCoordinationError("plane_ce_config_invalid", false);
}
