import { z } from "zod";
import type {
  PlaneProjectRolloutExecutionIntent,
  PlaneProjectRolloutExecutionOutcome,
  PlaneProjectRolloutExecutionPort,
} from "@chat/application";
import {
  PlaneCeClient,
  PlaneCeClientError,
  type PlaneCeClientOptions,
  readPlaneCeEnvironmentConfig,
} from "./plane-ce-client.js";
import { PlaneCeProjectCoordination } from "./plane-ce-coordination.js";

const uuidSchema = z.uuid();
const stateGroupSchema = z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]);
const stableKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,254}$/u);
const externalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const executionIntentSchema = z
  .object({
    workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
    projectId: uuidSchema,
    approvedDryRunSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    project: z
      .object({
        stableKey: z.literal("project:content-lab"),
        displayName: z.string().min(1).max(255),
        description: z.string().min(1).max(10_000),
        network: z.union([z.literal(0), z.literal(2)]),
        moduleView: z.literal(true),
        cycleView: z.literal(false),
        issueViewsView: z.literal(false),
        pageView: z.literal(true),
        intakeView: z.literal(false),
      })
      .strict(),
    states: z
      .array(
        z
          .object({
            stableKey: stableKeySchema,
            name: z.string().min(1).max(255),
            group: stateGroupSchema,
            color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
            sequence: z.number().finite(),
          })
          .strict(),
      )
      .length(12),
    modules: z
      .array(
        z
          .object({
            stableKey: stableKeySchema,
            name: z.string().min(1).max(255),
            description: z.string().min(1).max(10_000),
            externalId: externalIdSchema,
          })
          .strict(),
      )
      .length(3),
    labels: z
      .array(
        z
          .object({
            stableKey: stableKeySchema,
            name: z.string().min(1).max(255),
            color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
            externalId: externalIdSchema,
          })
          .strict(),
      )
      .length(10),
    workItems: z
      .array(
        z
          .object({
            targetKind: z.enum(["history_work", "workflow_improvement"]),
            stableKey: stableKeySchema,
            name: z.string().min(1).max(255),
            description: z.string().min(1).max(10_000),
            externalId: externalIdSchema,
            stateName: z.enum(["Intake", "Proposed", "Needs Review", "Ready", "Blocked"]),
            stateGroup: z.enum(["backlog", "started"]),
            moduleName: z.string().min(1).max(255),
            labelNames: z.array(z.string().min(1).max(255)).min(1).max(20),
            priority: z.literal("medium"),
          })
          .strict(),
      )
      .length(5),
  })
  .strict();

const projectSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    identifier: z.string().min(1),
    description: z.string().nullish(),
    network: z.number().int(),
    module_view: z.boolean(),
    cycle_view: z.boolean(),
    issue_views_view: z.boolean(),
    page_view: z.boolean(),
    intake_view: z.boolean(),
    archived_at: z.iso.datetime().nullish(),
  })
  .loose();
const stateSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    group: stateGroupSchema,
    color: z.string().min(1),
    sequence: z.number().finite(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();
const moduleSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    description: z.string().nullish(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();
const labelSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    color: z.string().min(1),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();
const workItemSchema = z
  .object({
    id: uuidSchema,
    sequence_id: z.number().int().positive(),
    name: z.string().min(1),
    description_html: z.string(),
    priority: z.enum(["none", "urgent", "high", "medium", "low"]),
    module_ids: z.array(uuidSchema).default([]),
    label_ids: z.array(uuidSchema).default([]),
    state: uuidSchema,
    updated_at: z.iso.datetime(),
    updated_by: uuidSchema.nullish(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();
const moduleIssueAssignmentResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ results: z.array(z.unknown()) }).loose(),
]);

type ExecutionIntent = z.infer<typeof executionIntentSchema>;
type ExecutionObject = PlaneProjectRolloutExecutionOutcome["objects"][number];

export class PlaneCeRolloutExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(code);
    this.name = "PlaneCeRolloutExecutionError";
  }
}

export function createPlaneCeProjectRolloutExecution(
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof fetch,
): PlaneCeProjectRolloutExecution | undefined {
  const config = readPlaneCeEnvironmentConfig(env);
  if (config === undefined) return undefined;
  return new PlaneCeProjectRolloutExecution({
    ...config,
    ...(fetchFn === undefined ? {} : { fetchFn }),
  });
}

/** 一次性P8管理员写面：固定29个非破坏性变更，逐项预检、写后回读和未知结果对账。 */
export class PlaneCeProjectRolloutExecution implements PlaneProjectRolloutExecutionPort {
  readonly #client: PlaneCeClient;
  readonly #coordination: PlaneCeProjectCoordination;

  constructor(options: PlaneCeClientOptions) {
    this.#client = new PlaneCeClient(options);
    this.#coordination = new PlaneCeProjectCoordination(options);
  }

  describe() {
    const description = this.#client.describe();
    return {
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1" as const,
      allowedWorkspaceSlugs: description.allowedWorkspaceSlugs,
    };
  }

  toJSON() {
    return this.describe();
  }

  async executeApprovedRollout(
    rawInput: PlaneProjectRolloutExecutionIntent,
  ): Promise<PlaneProjectRolloutExecutionOutcome> {
    const input = executionIntentSchema.parse(rawInput);
    this.#client.requireWorkspace(input.workspaceSlug);
    assertUnique(input.states, "state");
    assertUnique(input.modules, "module");
    assertUnique(input.labels, "label");
    assertUnique(input.workItems, "work_item");

    const objects: ExecutionObject[] = [];
    let writes = 0;
    const projectResult = await this.ensureProject(input);
    objects.push(projectResult.object);
    writes += projectResult.writes;

    for (const desired of input.states) {
      const result = await this.ensureState(input, desired);
      objects.push(result.object);
      writes += result.writes;
    }
    for (const desired of input.modules) {
      const result = await this.ensureModule(input, desired);
      objects.push(result.object);
      writes += result.writes;
    }
    for (const desired of input.labels) {
      const result = await this.ensureLabel(input, desired);
      objects.push(result.object);
      writes += result.writes;
    }
    for (const desired of input.workItems) {
      const result = await this.ensureWorkItem(input, desired);
      objects.push(result.object);
      writes += result.writes;
    }
    return { objects, writes };
  }

  private async ensureProject(input: ExecutionIntent) {
    const path = projectPath(input);
    const before = await this.#client.get(path, projectSchema);
    if (before.id !== input.projectId || before.archived_at != null) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_project_identity_invalid", false);
    }
    if (projectMatches(before, input.project)) {
      return resultObject("project_configuration", input.project, before.id, "reused", 0);
    }
    const body = {
      description: input.project.description,
      network: input.project.network,
      module_view: input.project.moduleView,
      cycle_view: input.project.cycleView,
      issue_views_view: input.project.issueViewsView,
      page_view: input.project.pageView,
      intake_view: input.project.intakeView,
    };
    try {
      await this.#client.patch(path, body, projectSchema);
    } catch (error) {
      await this.reconcileUnknown(error, async () =>
        projectMatches(await this.#client.get(path, projectSchema), input.project),
      );
    }
    const after = await this.#client.get(path, projectSchema);
    if (!projectMatches(after, input.project)) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_project_write_mismatch", false);
    }
    return resultObject("project_configuration", input.project, after.id, "updated", 1);
  }

  private async ensureState(input: ExecutionIntent, desired: ExecutionIntent["states"][number]) {
    const list = () => this.#client.listAll(`${projectPath(input)}states/`, stateSchema);
    const before = await list();
    const match = uniqueNamed(before, desired.name, "plane_rollout_state_ambiguous");
    if (match !== undefined) {
      if (match.group !== desired.group) {
        throw new PlaneCeRolloutExecutionError("plane_rollout_state_group_conflict", false);
      }
      return resultObject("state", desired, match.id, "reused", 0);
    }
    const externalId = rolloutExternalId(input, desired.stableKey);
    try {
      await this.#client.post(
        `${projectPath(input)}states/`,
        {
          name: desired.name,
          group: desired.group,
          color: desired.color,
          sequence: desired.sequence,
          external_source: "chat",
          external_id: externalId,
        },
        stateSchema,
      );
    } catch (error) {
      await this.reconcileUnknownOrConflict(error, async () => {
        const found = uniqueNamed(await list(), desired.name, "plane_rollout_state_ambiguous");
        return found?.group === desired.group;
      });
    }
    const after = uniqueNamed(await list(), desired.name, "plane_rollout_state_ambiguous");
    if (after === undefined || after.group !== desired.group) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_state_write_mismatch", false);
    }
    return resultObject("state", desired, after.id, "created", 1, externalId);
  }

  private async ensureModule(input: ExecutionIntent, desired: ExecutionIntent["modules"][number]) {
    const list = () => this.#client.listAll(`${projectPath(input)}modules/`, moduleSchema);
    const before = await list();
    const match = uniqueExternalOrNamed(before, desired, "plane_rollout_module_ambiguous");
    if (match !== undefined) return resultObject("module", desired, match.id, "reused", 0);
    try {
      await this.#client.post(
        `${projectPath(input)}modules/`,
        {
          name: desired.name,
          description: desired.description,
          external_source: "chat",
          external_id: desired.externalId,
        },
        moduleSchema,
      );
    } catch (error) {
      await this.reconcileUnknownOrConflict(error, async () =>
        Boolean(uniqueExternalOrNamed(await list(), desired, "plane_rollout_module_ambiguous")),
      );
    }
    const after = uniqueExternalOrNamed(await list(), desired, "plane_rollout_module_ambiguous");
    if (after === undefined) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_module_write_mismatch", false);
    }
    return resultObject("module", desired, after.id, "created", 1, desired.externalId);
  }

  private async ensureLabel(input: ExecutionIntent, desired: ExecutionIntent["labels"][number]) {
    const list = () => this.#client.listAll(`${projectPath(input)}labels/`, labelSchema);
    const before = await list();
    const match = uniqueExternalOrNamed(before, desired, "plane_rollout_label_ambiguous");
    if (match !== undefined) return resultObject("label", desired, match.id, "reused", 0);
    try {
      await this.#client.post(
        `${projectPath(input)}labels/`,
        {
          name: desired.name,
          color: desired.color,
          description: `Content Lab · ${desired.name}`,
          external_source: "chat",
          external_id: desired.externalId,
        },
        labelSchema,
      );
    } catch (error) {
      await this.reconcileUnknownOrConflict(error, async () =>
        Boolean(uniqueExternalOrNamed(await list(), desired, "plane_rollout_label_ambiguous")),
      );
    }
    const after = uniqueExternalOrNamed(await list(), desired, "plane_rollout_label_ambiguous");
    if (after === undefined) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_label_write_mismatch", false);
    }
    return resultObject("label", desired, after.id, "created", 1, desired.externalId);
  }

  private async ensureWorkItem(
    input: ExecutionIntent,
    desired: ExecutionIntent["workItems"][number],
  ) {
    const snapshot = await this.#coordination.readProjectSnapshot({
      workspaceSlug: input.workspaceSlug,
      projectId: input.projectId,
    });
    const module = uniqueByName(
      snapshot.modules,
      desired.moduleName,
      "plane_rollout_module_ambiguous",
    );
    const labels = desired.labelNames.map((name) =>
      uniqueByName(snapshot.labels, name, "plane_rollout_label_ambiguous"),
    );
    const existing = snapshot.workItems.find(
      (workItem) =>
        workItem.externalSource === "later-agent" && workItem.externalId === desired.externalId,
    );
    if (existing !== undefined) {
      if (
        existing.name !== desired.name ||
        existing.description !== descriptionHtml(desired.description) ||
        existing.priority !== desired.priority ||
        existing.stateName !== desired.stateName ||
        existing.labelIds.some((id) => !labels.some((label) => label.id === id)) ||
        existing.moduleIds.some((id) => id !== module.id)
      ) {
        throw new PlaneCeRolloutExecutionError("plane_rollout_work_item_conflict", false);
      }
      let writes = 0;
      const expectedLabelIds = labels.map((label) => label.id);
      if (!sameStringSet(existing.labelIds, expectedLabelIds)) {
        try {
          await this.#client.patch(
            `${projectPath(input)}work-items/${encodeURIComponent(existing.id)}/`,
            { labels: expectedLabelIds },
            workItemSchema,
          );
        } catch (error) {
          await this.reconcileUnknown(error, async () => {
            const observed = await this.findManagedWorkItem(input, desired.externalId);
            return observed !== undefined && sameStringSet(observed.labelIds, expectedLabelIds);
          });
        }
        writes += 1;
      }
      if (!sameStringSet(existing.moduleIds, [module.id])) {
        try {
          await this.#client.post(
            `${projectPath(input)}modules/${encodeURIComponent(module.id)}/module-issues/`,
            { issues: [existing.id] },
            moduleIssueAssignmentResponseSchema,
          );
        } catch (error) {
          await this.reconcileUnknown(error, async () => {
            const observed = await this.findManagedWorkItem(input, desired.externalId);
            return observed !== undefined && sameStringSet(observed.moduleIds, [module.id]);
          });
        }
        writes += 1;
      }
      const observed = await this.findManagedWorkItem(input, desired.externalId);
      if (
        observed === undefined ||
        !sameStringSet(observed.labelIds, expectedLabelIds) ||
        !sameStringSet(observed.moduleIds, [module.id])
      ) {
        throw new PlaneCeRolloutExecutionError("plane_rollout_work_item_write_mismatch", false);
      }
      return resultObject(
        desired.targetKind,
        desired,
        observed.id,
        writes === 0 ? "reused" : "updated",
        writes,
        desired.externalId,
      );
    }
    let outcome = await this.#coordination.ensureWorkItem({
      workspaceSlug: input.workspaceSlug,
      projectId: input.projectId,
      externalId: desired.externalId,
      name: desired.name,
      description: desired.description,
      priority: desired.priority,
      stateName: desired.stateName,
      stateGroup: desired.stateGroup,
      moduleIds: [module.id],
      labelIds: labels.map((label) => label.id),
    });
    if (outcome.status === "outcome_unknown") {
      outcome = await this.#coordination.reconcileEnsureWorkItem({
        workspaceSlug: input.workspaceSlug,
        projectId: input.projectId,
        externalId: desired.externalId,
        name: desired.name,
        description: desired.description,
        priority: desired.priority,
        stateName: desired.stateName,
        stateGroup: desired.stateGroup,
        moduleIds: [module.id],
        labelIds: labels.map((label) => label.id),
      });
    }
    if (outcome.status !== "completed") {
      throw new PlaneCeRolloutExecutionError(
        outcome.errorCode,
        outcome.status === "outcome_unknown",
      );
    }
    return resultObject(
      desired.targetKind,
      desired,
      outcome.workItem.id,
      "created",
      2,
      desired.externalId,
    );
  }

  private async findManagedWorkItem(input: ExecutionIntent, externalId: string) {
    const snapshot = await this.#coordination.readProjectSnapshot({
      workspaceSlug: input.workspaceSlug,
      projectId: input.projectId,
    });
    const matches = snapshot.workItems.filter(
      (workItem) => workItem.externalSource === "later-agent" && workItem.externalId === externalId,
    );
    if (matches.length > 1) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_work_item_ambiguous", false);
    }
    return matches[0];
  }

  private async reconcileUnknown(error: unknown, check: () => Promise<boolean>) {
    if (!(error instanceof PlaneCeClientError) || !error.outcomeUnknown) throw error;
    if (!(await check())) {
      throw new PlaneCeRolloutExecutionError("plane_rollout_write_outcome_unknown", true);
    }
  }

  private async reconcileUnknownOrConflict(error: unknown, check: () => Promise<boolean>) {
    if (
      !(error instanceof PlaneCeClientError) ||
      (!error.outcomeUnknown && error.httpStatus !== 409)
    ) {
      throw error;
    }
    if (!(await check())) {
      throw new PlaneCeRolloutExecutionError(
        error.outcomeUnknown
          ? "plane_rollout_write_outcome_unknown"
          : "plane_rollout_write_conflict",
        error.outcomeUnknown,
      );
    }
  }
}

function projectPath(input: { readonly workspaceSlug: string; readonly projectId: string }) {
  return `/api/v1/workspaces/${encodeURIComponent(input.workspaceSlug)}/projects/${encodeURIComponent(input.projectId)}/`;
}

function projectMatches(
  project: z.infer<typeof projectSchema>,
  desired: ExecutionIntent["project"],
) {
  return (
    project.name === desired.displayName &&
    project.description === desired.description &&
    project.network === desired.network &&
    project.module_view === desired.moduleView &&
    project.cycle_view === desired.cycleView &&
    project.issue_views_view === desired.issueViewsView &&
    project.page_view === desired.pageView &&
    project.intake_view === desired.intakeView
  );
}

function rolloutExternalId(input: ExecutionIntent, stableKey: string) {
  return `content-lab-plane-rollout:${input.approvedDryRunSha256.slice(0, 16)}:${stableKey}`;
}

function uniqueNamed<T extends { readonly name: string }>(
  items: readonly T[],
  name: string,
  errorCode: string,
): T | undefined {
  const matches = items.filter((item) => item.name === name);
  if (matches.length > 1) throw new PlaneCeRolloutExecutionError(errorCode, false);
  return matches[0];
}

function uniqueExternalOrNamed<
  T extends {
    readonly id: string;
    readonly name: string;
    readonly external_source?: string | null | undefined;
    readonly external_id?: string | null | undefined;
  },
>(
  items: readonly T[],
  desired: { readonly name: string; readonly externalId: string },
  code: string,
) {
  const external = items.filter(
    (item) => item.external_source === "chat" && item.external_id === desired.externalId,
  );
  const named = items.filter((item) => item.name === desired.name);
  if (external.length > 1 || named.length > 1) {
    throw new PlaneCeRolloutExecutionError(code, false);
  }
  const match = external[0] ?? named[0];
  if (external[0] !== undefined && named[0] !== undefined && external[0] !== named[0]) {
    throw new PlaneCeRolloutExecutionError(code, false);
  }
  return match;
}

function uniqueByName<T extends { readonly name: string }>(
  items: readonly T[],
  name: string,
  code: string,
): T {
  const match = uniqueNamed(items, name, code);
  if (match === undefined) throw new PlaneCeRolloutExecutionError(`${code}_missing`, false);
  return match;
}

function assertUnique(
  items: readonly {
    readonly stableKey: string;
    readonly name?: string;
    readonly externalId?: string;
  }[],
  kind: string,
) {
  for (const field of ["stableKey", "name", "externalId"] as const) {
    const values = items.flatMap((item) => (item[field] === undefined ? [] : [item[field]]));
    if (new Set(values).size !== values.length) {
      throw new PlaneCeRolloutExecutionError(`plane_rollout_${kind}_${field}_duplicate`, false);
    }
  }
}

function resultObject(
  targetKind: ExecutionObject["targetKind"],
  desired: { readonly stableKey: string; readonly name?: string; readonly displayName?: string },
  providerObjectId: string,
  outcome: ExecutionObject["outcome"],
  writes: number,
  externalId?: string,
) {
  return {
    object: {
      targetKind,
      stableKey: desired.stableKey,
      displayName: desired.displayName ?? desired.name ?? desired.stableKey,
      ...(externalId === undefined ? {} : { externalId }),
      providerObjectId,
      outcome,
    } satisfies ExecutionObject,
    writes,
  };
}

function descriptionHtml(description: string): string {
  return `<p>${description
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</p>`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
