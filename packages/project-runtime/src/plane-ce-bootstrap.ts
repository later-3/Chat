import type {
  ProjectManagementBootstrapPort,
  ProjectManagementProvisionResult,
} from "@chat/application";
import {
  planeCeProjectIdSchema,
  planeCeWorkspaceSlugSchema,
  projectBootstrapProposalSchema,
} from "@chat/contracts";
import { z } from "zod";

const PLANE_CE_VERSION = "1.4.1";
const workspaceConfigSchema = z
  .array(
    z
      .object({
        slug: planeCeWorkspaceSlugSchema,
        displayName: z.string().min(1).max(160),
      })
      .strict(),
  )
  .min(1)
  .max(20);

const planeProjectSchema = z
  .object({
    id: planeCeProjectIdSchema,
    name: z.string().min(1),
    identifier: z.string().min(1),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();

const planeModuleSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    external_source: z.string().nullish(),
    external_id: z.string().nullish(),
  })
  .loose();

const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ results: z.array(item), next_page_results: z.boolean() }).loose();

interface PlaneWorkspaceConfig {
  readonly slug: string;
  readonly displayName: string;
}

export class PlaneCeBootstrapError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(code);
    this.name = "PlaneCeBootstrapError";
  }
}

export interface PlaneCeBootstrapOptions {
  readonly baseUrl: URL;
  readonly apiToken: string;
  readonly workspaces: readonly PlaneWorkspaceConfig[];
  readonly fetchFn?: typeof fetch;
}

export function createPlaneCeProjectBootstrap(
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof fetch,
): ProjectManagementBootstrapPort | undefined {
  const baseUrlValue = env.CHAT_PLANE_CE_BASE_URL;
  const token = env.CHAT_PLANE_CE_API_TOKEN;
  const workspacesValue = env.CHAT_PLANE_CE_WORKSPACES_JSON;
  if (
    (baseUrlValue === undefined || baseUrlValue.trim() === "") &&
    (token === undefined || token.trim() === "") &&
    (workspacesValue === undefined || workspacesValue.trim() === "")
  ) {
    return undefined;
  }
  if (
    baseUrlValue === undefined ||
    token === undefined ||
    token.trim() === "" ||
    workspacesValue === undefined
  ) {
    throw new PlaneCeBootstrapError("plane_ce_config_incomplete", false);
  }
  let baseUrl: URL;
  let workspaces: z.infer<typeof workspaceConfigSchema>;
  try {
    baseUrl = new URL(baseUrlValue);
    assertAllowedBaseUrl(baseUrl);
    workspaces = workspaceConfigSchema.parse(JSON.parse(workspacesValue));
  } catch {
    throw new PlaneCeBootstrapError("plane_ce_config_invalid", false);
  }
  if (new Set(workspaces.map((item) => item.slug)).size !== workspaces.length) {
    throw new PlaneCeBootstrapError("plane_ce_config_invalid", false);
  }
  return new PlaneCeProjectBootstrap({
    baseUrl,
    apiToken: token,
    workspaces,
    ...(fetchFn === undefined ? {} : { fetchFn }),
  });
}

export class PlaneCeProjectBootstrap implements ProjectManagementBootstrapPort {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: PlaneCeBootstrapOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  describe() {
    return {
      providerKind: "plane_ce" as const,
      providerVersion: PLANE_CE_VERSION,
      providerWebBaseUrl: this.options.baseUrl.origin,
      allowedWorkspaceSlugs: this.options.workspaces.map((item) => item.slug),
    };
  }

  async preflight(input: {
    readonly workspaceSlug: string;
    readonly projectIdentifier: string;
    readonly projectName: string;
  }) {
    const workspace = this.requireWorkspace(input.workspaceSlug);
    const existing = await this.findProject(
      input.workspaceSlug,
      (project) =>
        project.identifier.toUpperCase() === input.projectIdentifier.toUpperCase() ||
        project.name === input.projectName,
    );
    if (existing !== undefined) {
      throw new PlaneCeBootstrapError("plane_project_name_or_identifier_taken", false);
    }
    return { planeProjectLabel: `${workspace.displayName}/${input.projectIdentifier}` };
  }

  async provision(input: Parameters<ProjectManagementBootstrapPort["provision"]>[0]) {
    const proposal = projectBootstrapProposalSchema.parse(input.proposal);
    this.requireWorkspace(proposal.planeWorkspaceSlug);
    const externalId = input.operationId;
    let project = await this.findProject(
      proposal.planeWorkspaceSlug,
      (candidate) => candidate.external_source === "chat" && candidate.external_id === externalId,
    );
    try {
      if (project === undefined) {
        await input.writeFence.assertCurrent("plane.project.create");
        const response = await this.request(
          `/api/v1/workspaces/${encodeURIComponent(proposal.planeWorkspaceSlug)}/projects/`,
          {
            method: "POST",
            body: {
              name: proposal.name,
              identifier: proposal.planeProjectIdentifier,
              description: proposal.objective,
              external_source: "chat",
              external_id: externalId,
              module_view: proposal.initialModules.length > 0,
              cycle_view: false,
            },
            write: true,
          },
        );
        project = planeProjectSchema.parse(response);
      }
      await this.ensureModules(project.id, input.operationId, proposal, input.writeFence);
      return { status: "completed" as const, planeProjectId: project.id };
    } catch (error) {
      if (error instanceof PlaneCeBootstrapError) {
        if (error.outcomeUnknown) {
          return { status: "outcome_unknown" as const, errorCode: error.code };
        }
        return {
          status: project === undefined ? ("failed" as const) : ("needs_attention" as const),
          errorCode: error.code,
          ...(project === undefined ? {} : { planeProjectId: project.id }),
        } satisfies ProjectManagementProvisionResult;
      }
      return { status: "outcome_unknown" as const, errorCode: "plane_ce_contract_invalid" };
    }
  }

  async reconcile(input: Parameters<ProjectManagementBootstrapPort["reconcile"]>[0]) {
    const proposal = projectBootstrapProposalSchema.parse(input.proposal);
    this.requireWorkspace(proposal.planeWorkspaceSlug);
    try {
      const project = await this.findProject(
        proposal.planeWorkspaceSlug,
        (candidate) =>
          candidate.external_source === "chat" && candidate.external_id === input.operationId,
      );
      if (project === undefined) {
        return { status: "failed" as const, errorCode: "plane_project_not_found" };
      }
      const modules = await this.listModules(proposal.planeWorkspaceSlug, project.id);
      const expectedExternalIds = proposal.initialModules.map(
        (_name, index) => `${input.operationId}:module:${String(index + 1)}`,
      );
      if (
        !expectedExternalIds.every((externalId) =>
          modules.some(
            (module) => module.external_source === "chat" && module.external_id === externalId,
          ),
        )
      ) {
        return {
          status: "needs_attention" as const,
          errorCode: "plane_project_modules_incomplete",
          planeProjectId: project.id,
        };
      }
      return { status: "completed" as const, planeProjectId: project.id };
    } catch (error) {
      return {
        status:
          error instanceof PlaneCeBootstrapError && !error.outcomeUnknown
            ? "failed"
            : "outcome_unknown",
        errorCode:
          error instanceof PlaneCeBootstrapError
            ? error.code
            : "plane_ce_reconcile_contract_invalid",
      } as ProjectManagementProvisionResult;
    }
  }

  private requireWorkspace(slug: string): PlaneWorkspaceConfig {
    const workspace = this.options.workspaces.find((item) => item.slug === slug);
    if (workspace === undefined)
      throw new PlaneCeBootstrapError("plane_workspace_not_allowed", false);
    return workspace;
  }

  private async ensureModules(
    projectId: z.infer<typeof planeCeProjectIdSchema>,
    operationId: string,
    proposal: z.infer<typeof projectBootstrapProposalSchema>,
    writeFence: Parameters<ProjectManagementBootstrapPort["provision"]>[0]["writeFence"],
  ) {
    const existing = await this.listModules(proposal.planeWorkspaceSlug, projectId);
    for (const [index, name] of proposal.initialModules.entries()) {
      const externalId = `${operationId}:module:${String(index + 1)}`;
      if (
        existing.some(
          (module) => module.external_source === "chat" && module.external_id === externalId,
        )
      ) {
        continue;
      }
      await writeFence.assertCurrent(`plane.module.create.${String(index + 1)}`);
      const response = await this.request(
        `/api/v1/workspaces/${encodeURIComponent(proposal.planeWorkspaceSlug)}/projects/${projectId}/modules/`,
        {
          method: "POST",
          body: {
            name,
            description: `${proposal.name} · ${name}`,
            external_source: "chat",
            external_id: externalId,
          },
          write: true,
        },
      );
      planeModuleSchema.parse(response);
    }
  }

  private async listModules(workspaceSlug: string, projectId: string) {
    const response = await this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${projectId}/modules/?per_page=1000`,
      { method: "GET", write: false },
    );
    return pageSchema(planeModuleSchema).parse(response).results;
  }

  private async findProject(
    workspaceSlug: string,
    predicate: (project: z.infer<typeof planeProjectSchema>) => boolean,
  ) {
    const response = await this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/?per_page=1000`,
      { method: "GET", write: false },
    );
    return pageSchema(planeProjectSchema).parse(response).results.find(predicate);
  }

  private async request(
    path: string,
    input: {
      readonly method: "GET" | "POST" | "PATCH";
      readonly body?: unknown;
      readonly write: boolean;
    },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, this.options.baseUrl), {
        method: input.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.options.apiToken,
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new PlaneCeBootstrapError(
        input.write ? "plane_ce_write_outcome_unknown" : "plane_ce_query_failed",
        input.write,
      );
    }
    if (!response.ok) {
      throw new PlaneCeBootstrapError(
        `plane_ce_http_${String(response.status)}`,
        input.write && response.status >= 500,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new PlaneCeBootstrapError(
        input.write ? "plane_ce_write_response_invalid" : "plane_ce_query_response_invalid",
        input.write,
      );
    }
  }
}

function assertAllowedBaseUrl(url: URL) {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plane CE必须使用HTTPS；本机loopback测试可用HTTP");
  }
  if (url.username !== "" || url.password !== "") throw new Error("Plane CE URL不能携带凭据");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Plane CE URL必须是无路径、Query和Fragment的Origin");
  }
}
