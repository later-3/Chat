import { z } from "zod";
import type {
  PlaneProjectRolloutInspection,
  PlaneProjectRolloutInspectionPort,
} from "@chat/application";
import {
  PlaneCeClient,
  PlaneCeClientError,
  type PlaneCeClientOptions,
  readPlaneCeEnvironmentConfig,
} from "./plane-ce-client.js";

const uuidSchema = z.uuid();
const workspaceSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
const projectIdentifierSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,11}$/u);
const stateGroupSchema = z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]);

const projectSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    identifier: projectIdentifierSchema,
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
  .object({ id: uuidSchema, name: z.string().min(1), color: z.string().min(1) })
  .loose();
const viewSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    description: z.string().nullish(),
    filters: z.record(z.string(), z.unknown()).default({}),
    display_filters: z.record(z.string(), z.unknown()).default({}),
    archived_at: z.iso.datetime().nullish(),
  })
  .loose();
const pageSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    access: z.number().int(),
    is_locked: z.boolean(),
    archived_at: z.string().nullish(),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();
const intakeSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    description: z.string().nullish(),
    is_default: z.boolean(),
  })
  .loose();
const workItemSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();

const lookupSchema = z
  .object({ workspaceSlug: workspaceSlugSchema, projectIdentifier: projectIdentifierSchema })
  .strict();

export function createPlaneCeProjectRolloutInspection(
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof fetch,
): PlaneCeProjectRolloutInspection | undefined {
  const config = readPlaneCeEnvironmentConfig(env);
  if (config === undefined) return undefined;
  return new PlaneCeProjectRolloutInspection({
    ...config,
    ...(fetchFn === undefined ? {} : { fetchFn }),
  });
}

/** Plane CE 1.4.1管理员预检只有GET能力；执行器必须是后续独立Port。 */
export class PlaneCeProjectRolloutInspection implements PlaneProjectRolloutInspectionPort {
  readonly #client: PlaneCeClient;

  constructor(options: PlaneCeClientOptions) {
    this.#client = new PlaneCeClient(options);
  }

  describe() {
    return {
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1" as const,
      allowedWorkspaceSlugs: this.#client.describe().allowedWorkspaceSlugs,
    };
  }

  toJSON() {
    return this.describe();
  }

  async inspectProject(input: {
    readonly workspaceSlug: string;
    readonly projectIdentifier: string;
  }): Promise<PlaneProjectRolloutInspection> {
    const lookup = lookupSchema.parse(input);
    this.#client.requireWorkspace(lookup.workspaceSlug);
    const projects = await this.#client.listAll(
      `/api/v1/workspaces/${encodeURIComponent(lookup.workspaceSlug)}/projects/`,
      projectSchema,
    );
    const matches = projects.filter((project) => project.identifier === lookup.projectIdentifier);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new PlaneCeClientError(
        matches.length === 0 ? "plane_project_not_found" : "plane_project_identifier_ambiguous",
        false,
      );
    }
    const project = await this.#client.get(
      projectPath(lookup.workspaceSlug, matches[0].id),
      projectSchema,
    );
    if (project.archived_at != null) {
      throw new PlaneCeClientError("plane_project_archived", false);
    }
    const base = projectPath(lookup.workspaceSlug, project.id);
    const [states, modules, labels, viewsResult, pagesResult, intakesResult, workItems] =
      await Promise.all([
        this.#client.listAll(`${base}states/`, stateSchema),
        this.#client.listAll(`${base}modules/`, moduleSchema),
        this.#client.listAll(`${base}labels/`, labelSchema),
        this.listOptionalSurface(`${base}views/`, viewSchema),
        this.listOptionalSurface(`${base}pages/`, pageSchema),
        this.listOptionalSurface(`${base}intakes/`, intakeSchema),
        this.#client.listAll(`${base}work-items/`, workItemSchema),
      ]);
    return {
      project: {
        id: project.id,
        name: project.name,
        identifier: project.identifier,
        description: project.description ?? "",
        network: project.network,
        moduleView: project.module_view,
        cycleView: project.cycle_view,
        issueViewsView: project.issue_views_view,
        pageView: project.page_view,
        intakeView: project.intake_view,
      },
      states: states.map((state) => ({
        id: state.id,
        name: state.name,
        group: state.group,
        color: state.color,
        sequence: state.sequence,
      })),
      surfaceAvailability: {
        views: viewsResult.available ? "available" : "unavailable",
        pages: pagesResult.available ? "available" : "unavailable",
        intakes: intakesResult.available ? "available" : "unavailable",
      },
      modules: modules.map((module) => ({
        id: module.id,
        name: module.name,
        description: module.description ?? "",
        ...(module.external_source == null ? {} : { externalSource: module.external_source }),
        ...(module.external_id == null ? {} : { externalId: module.external_id }),
      })),
      labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
      views: viewsResult.items.map((view) => ({
        id: view.id,
        name: view.name,
        description: view.description ?? "",
        filtersJson: canonicalJson(view.filters),
        displayFiltersJson: canonicalJson(view.display_filters),
        archived: view.archived_at != null,
      })),
      pages: pagesResult.items.map((page) => ({
        id: page.id,
        name: page.name,
        access: page.access,
        locked: page.is_locked,
        archived: page.archived_at != null,
        ...(page.external_source == null ? {} : { externalSource: page.external_source }),
        ...(page.external_id == null ? {} : { externalId: page.external_id }),
      })),
      intakes: intakesResult.items.map((intake) => ({
        id: intake.id,
        name: intake.name,
        description: intake.description ?? "",
        isDefault: intake.is_default,
      })),
      workItems: workItems.map((workItem) => ({
        id: workItem.id,
        name: workItem.name,
        ...(workItem.external_source == null ? {} : { externalSource: workItem.external_source }),
        ...(workItem.external_id == null ? {} : { externalId: workItem.external_id }),
      })),
    };
  }

  private async listOptionalSurface<T>(path: string, schema: z.ZodType<T>) {
    try {
      return { available: true as const, items: await this.#client.listAll(path, schema) };
    } catch (error) {
      if (error instanceof PlaneCeClientError && error.httpStatus === 404) {
        return { available: false as const, items: [] as readonly T[] };
      }
      throw error;
    }
  }
}

function projectPath(workspaceSlug: string, projectId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
