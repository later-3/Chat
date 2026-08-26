import type { ZodType } from "zod";
import {
  workflowExecutionTraceDtoSchema,
  workflowDefinitionsDtoSchema,
  workflowDefinitionCommandResultDtoSchema,
  type WorkflowExecutionTraceDto,
  promptRegionsDtoSchema,
  promptFragmentPageDtoSchema,
  promptFragmentDetailDtoSchema,
  promptFragmentRevisionDetailDtoSchema,
  promptFragmentCommandResultDtoSchema,
  promptWorkspacesDtoSchema,
  promptAssemblyPreviewDtoSchema,
  promptConfigurationPreviewDtoSchema,
  promptTurnPreviewDtoSchema,
  agentProfilesDtoSchema,
  agentProfileDtoSchema,
  type PromptRegionsDto,
  type PromptFragmentPageDto,
  type PromptFragmentDetailDto,
  type PromptFragmentRevisionDetailDto,
  type PromptFragmentCommandResultDto,
  type PromptWorkspacesDto,
  type PromptAssemblyPreviewDto,
  type PromptConfigurationPreviewDto,
  type PromptTurnPreviewDto,
  type PreviewPromptTurnPayload,
  type AgentProfilesDto,
  type AgentProfileDto,
  type AgentKey,
  type CreateAgentVersionPayload,
  type ReviseAgentPromptPayload,
  type RestoreAgentPromptPayload,
  type SaveWorkflowAgentNodeConfigurationPayload,
  type PreviewPromptConfigurationPayload,
  type PreviewPromptAssemblyPayload,
  type PromptTurnSelectionInput,
  type CreatePromptFragmentPayload,
  type CopyPromptFragmentPayload,
  type RevisePromptFragmentPayload,
  type ChangePromptFragmentArchiveStatusPayload,
  projectBootstrapConfigurationSchema,
  currentProjectBootstrapResponseSchema,
  projectBootstrapDecisionResponseSchema,
  projectBootstrapReviewResponseSchema,
  projectBootstrapOperationSchema,
  toolExecutionsResponseSchema,
  type ProjectBootstrapConfiguration,
  type ProjectBootstrapCandidate,
  type ProjectBootstrapOperation,
  type ProjectBootstrapReviewResponse,
  projectAgentOpeningPacketV2ResponseSchema,
  type ProjectAgentOpeningPacketV2,
  projectHomeDtoSchema,
  projectObjectQueryResultDtoSchema,
  projectSummaryV3DtoSchema,
  projectTimelineItemDtoSchema,
  projectWorkspaceV3DtoSchema,
  type ProjectHomeDto,
  type ProjectObjectQuery,
  type ProjectObjectQueryResultDto,
  type ProjectSummaryDto,
  type ProjectTimelineItemDto,
  type ProjectWorkspaceDto,
} from "@chat/contracts/public";
import { z } from "zod";
import {
  approvalResponseSchema,
  createSessionResponseSchema,
  currentPromptReviewResponseSchema,
  decisionResponseSchema,
  exactMessageResponseSchema,
  lifeosWorkflowOptionSchema,
  messagesPageResponseSchema,
  noteCandidateResponseSchema,
  noteDecisionResponseSchema,
  promptReviewDecisionResponseSchema,
  toolExecutionDecisionResponseSchema,
  plansResponseSchema,
  problemSchema,
  runResponseSchema,
  submitMessageResponseSchema,
  startSessionMessageResponseSchema,
  type ChatApproval,
  type ChatMessage,
  type ChatNoteCandidate,
  type ChatPlan,
  type ChatRun,
  type ChatPromptReview,
  type ChatSession,
  type DecisionRequest,
  type NoteDecisionRequest,
  type PromptReviewDecisionRequest,
  type ToolExecutionDecisionRequest,
  type ChatToolExecutions,
  type LifeosWorkflowOption,
  type WorkflowSelection,
  type BridgeChatDispatchPlan,
} from "./contracts.ts";
import type {
  PendingDecision,
  PendingNoteDecision,
  PendingPromptReviewDecision,
  PendingToolExecutionDecision,
} from "./state-store.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** GET /api/workflow/definitions 的外层信封；内层DTO权威在@chat/contracts/public。 */
const workflowDefinitionsResponseSchema = z
  .object({ definitions: workflowDefinitionsDtoSchema })
  .strict();

const projectsResponseSchema = z.object({ projects: z.array(projectSummaryV3DtoSchema) }).strict();
const projectHomeResponseSchema = z.object({ projectHome: projectHomeDtoSchema }).strict();
const projectWorkspaceResponseSchema = z.object({ project: projectWorkspaceV3DtoSchema }).strict();
const projectTimelineResponseSchema = z
  .object({ items: z.array(projectTimelineItemDtoSchema) })
  .strict();
const projectObjectQueryResponseSchema = z
  .object({ result: projectObjectQueryResultDtoSchema })
  .strict();

function withSignal(signal: AbortSignal | undefined): Pick<RequestInit, "signal"> | object {
  return signal === undefined ? {} : { signal };
}

export class ChatProductApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly recoveryAction: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChatProductApiError";
  }
}

function responseContractMismatch(message: string): never {
  throw new ChatProductApiError(
    200,
    "chat_api_contract_mismatch",
    false,
    "inspect_chat_api",
    message,
  );
}

/**
 * Zod只证明单个DTO合法；Message Command还必须证明三个对象来自同一次提交。
 * 该检查同时供真实Client与Adapter mock边界复用，避免测试替身绕过产品身份合同。
 */
export function assertFirstMessageResponseBinding(response: {
  readonly session: ChatSession;
  readonly message: ChatMessage;
  readonly run: ChatRun;
}): void {
  if (
    response.session.sessionId !== response.message.sessionId ||
    (response.run.sessionId !== undefined &&
      response.message.sessionId !== response.run.sessionId) ||
    (response.run.sourceMessageId !== undefined &&
      response.run.sourceMessageId !== response.message.messageId)
  ) {
    responseContractMismatch("Chat first-message response contained conflicting object identities");
  }
}

export function assertExistingSessionMessageResponseBinding(
  productSessionId: string,
  response: { readonly message: ChatMessage; readonly run: ChatRun },
): void {
  if (
    response.message.sessionId !== productSessionId ||
    (response.run.sessionId !== undefined && response.run.sessionId !== productSessionId) ||
    (response.run.sourceMessageId !== undefined &&
      response.run.sourceMessageId !== response.message.messageId)
  ) {
    responseContractMismatch(
      "Chat existing-session message response contained conflicting object identities",
    );
  }
}

export function parseChatApiBaseUrl(raw: string | undefined): URL {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CHAT_API_BASE_URL is required for @chat/dsh-lifeos-bridge");
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CHAT_API_BASE_URL must use http: or https:");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("CHAT_API_BASE_URL must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("CHAT_API_BASE_URL must be an origin without a path");
  }
  url.pathname = "/";
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error(`Chat API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Chat API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(result.value);
  }
  if (size === 0) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class ChatProductClient {
  constructor(
    readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getSession(sessionId: string, signal?: AbortSignal): Promise<ChatSession> {
    const value = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      createSessionResponseSchema,
      withSignal(signal),
    );
    return value.session;
  }

  async listProjects(signal?: AbortSignal): Promise<ProjectSummaryDto[]> {
    return (await this.request("/api/projects", projectsResponseSchema, withSignal(signal)))
      .projects;
  }

  async getProjectHome(projectId: string, signal?: AbortSignal): Promise<ProjectHomeDto> {
    return (
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/home`,
        projectHomeResponseSchema,
        withSignal(signal),
      )
    ).projectHome;
  }

  async getProjectWorkspace(projectId: string, signal?: AbortSignal): Promise<ProjectWorkspaceDto> {
    return (
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}`,
        projectWorkspaceResponseSchema,
        withSignal(signal),
      )
    ).project;
  }

  async getProjectTimeline(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectTimelineItemDto[]> {
    return (
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/timeline`,
        projectTimelineResponseSchema,
        withSignal(signal),
      )
    ).items;
  }

  async queryProjectObjects(
    projectId: string,
    query: ProjectObjectQuery,
    signal?: AbortSignal,
  ): Promise<ProjectObjectQueryResultDto> {
    const params = new URLSearchParams({
      view: query.view,
      limit: String(query.limit),
    });
    if (query.q !== undefined) params.set("q", query.q);
    if (query.kind !== undefined) params.set("kind", query.kind);
    if (query.status !== undefined) params.set("status", query.status);
    return (
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/objects?${params.toString()}`,
        projectObjectQueryResponseSchema,
        withSignal(signal),
      )
    ).result;
  }

  async getProjectBootstrapConfiguration(
    signal?: AbortSignal,
  ): Promise<ProjectBootstrapConfiguration> {
    return this.request(
      "/api/project-bootstrap/configuration",
      projectBootstrapConfigurationSchema,
      withSignal(signal),
    );
  }

  async getCurrentProjectBootstrap(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof currentProjectBootstrapResponseSchema>["projectBootstrap"]> {
    try {
      const response = await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/project-bootstrap/current`,
        currentProjectBootstrapResponseSchema,
        withSignal(signal),
      );
      return response.projectBootstrap;
    } catch (error) {
      if (error instanceof ChatProductApiError && error.status === 404) return null;
      throw error;
    }
  }

  async decideProjectBootstrap(
    candidate: {
      readonly projectBootstrapCandidateId: string;
      readonly revision: number;
      readonly sha256: string;
    },
    commandId: string,
    kind: "confirm" | "reject",
    reason?: string,
    signal?: AbortSignal,
  ): Promise<{ candidate: ProjectBootstrapCandidate; operation?: ProjectBootstrapOperation }> {
    const response = await this.request(
      `/api/project-bootstrap/candidates/${encodeURIComponent(candidate.projectBootstrapCandidateId)}/decision`,
      projectBootstrapDecisionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          commandId,
          payload: {
            projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
            candidateRevision: candidate.revision,
            candidateSha256: candidate.sha256,
            kind,
            ...(reason === undefined ? {} : { reason }),
          },
        }),
        ...withSignal(signal),
      },
    );
    return {
      candidate: response.candidate,
      ...(response.operation === undefined ? {} : { operation: response.operation }),
    };
  }

  async requestProjectBootstrapRetry(
    operationId: string,
    expectedOperationRevision: number,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<ProjectBootstrapOperation> {
    const response = await this.request(
      `/api/project-bootstrap/operations/${encodeURIComponent(operationId)}/retry`,
      z.object({ operation: projectBootstrapOperationSchema }).strict(),
      {
        method: "POST",
        body: JSON.stringify({
          commandId,
          payload: {
            projectBootstrapOperationId: operationId,
            expectedOperationRevision,
          },
        }),
        ...withSignal(signal),
      },
    );
    return response.operation;
  }

  async getProjectBootstrapReview(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ProjectBootstrapReviewResponse> {
    return this.request(
      `/api/project-bootstrap/operations/${encodeURIComponent(operationId)}`,
      projectBootstrapReviewResponseSchema,
      withSignal(signal),
    );
  }

  async getMessages(
    sessionId: string,
    cursor: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ items: ChatMessage[]; nextCursor?: string | undefined }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) params.set("cursor", cursor);
    return await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
      messagesPageResponseSchema,
      withSignal(signal),
    );
  }

  async submitMessage(
    sessionId: string,
    commandId: string,
    text: string,
    signal?: AbortSignal,
    workflowSelection?: WorkflowSelection,
    promptSelection?: PromptTurnSelectionInput,
  ): Promise<{ message: ChatMessage; run: ChatRun }> {
    return await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      submitMessageResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          commandId,
          payload: {
            text,
            ...(workflowSelection !== undefined
              ? {
                  workflowSelection: {
                    kind: "published_revision",
                    workflowDefinitionRevisionId: workflowSelection.workflowDefinitionRevisionId,
                    definitionSha256: workflowSelection.definitionSha256,
                    runConfiguration: workflowSelection.runConfiguration,
                  },
                }
              : {}),
            ...(promptSelection === undefined ? {} : { promptSelection }),
          },
        }),
        ...withSignal(signal),
      },
    );
  }

  async submitMessageFromDispatch(
    sessionId: string,
    command: BridgeChatDispatchPlan["submitMessage"],
    signal?: AbortSignal,
  ): Promise<{ message: ChatMessage; run: ChatRun }> {
    const ordinaryPath = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
    const bootstrapPath = `/api/sessions/${encodeURIComponent(sessionId)}/project-bootstrap/messages`;
    if (command.path !== ordinaryPath && command.path !== bootstrapPath) {
      throw new Error("Bridge dispatch session-message path mismatch");
    }
    const response = await this.request(command.path, submitMessageResponseSchema, {
      method: command.method,
      body: command.bodyJson,
      ...withSignal(signal),
    });
    assertExistingSessionMessageResponseBinding(sessionId, response);
    return response;
  }

  async submitFirstMessageFromDispatch(
    command: BridgeChatDispatchPlan["submitMessage"],
    signal?: AbortSignal,
  ): Promise<{ session: ChatSession; message: ChatMessage; run: ChatRun }> {
    if (command.path !== "/api/messages" && command.path !== "/api/project-bootstrap/messages") {
      throw new Error("Bridge dispatch first-message path mismatch");
    }
    const response = await this.request(command.path, startSessionMessageResponseSchema, {
      method: command.method,
      body: command.bodyJson,
      ...withSignal(signal),
    });
    assertFirstMessageResponseBinding(response);
    return response;
  }

  async listWorkflows(signal?: AbortSignal): Promise<readonly LifeosWorkflowOption[]> {
    const value = await this.request(
      "/api/workflow/definitions",
      workflowDefinitionsResponseSchema,
      withSignal(signal),
    );
    return value.definitions.definitions.map((definition) =>
      lifeosWorkflowOptionSchema.parse({
        workflowDefinitionId: definition.workflowDefinitionId,
        workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
        definitionSha256: definition.definitionSha256,
        title: definition.title,
        description: definition.description,
        blueprintKey: definition.blueprintKey,
        ownerKind: definition.ownerKind,
        isDefault: definition.isDefault,
        configurableNodes: definition.nodes.flatMap((node) =>
          node.runConfigFields.length === 0
            ? []
            : [
                {
                  definitionNodeId: node.definitionNodeId,
                  title: node.displayName,
                  fields: node.runConfigFields,
                },
              ],
        ),
        agentNodes: definition.nodes.flatMap((node) =>
          node.agentBinding !== undefined
            ? [
                {
                  definitionNodeId: node.definitionNodeId,
                  nodeType: node.nodeType,
                  title: node.displayName,
                  agentKey: node.agentBinding.agentKey,
                  profileVersion: node.agentBinding.profileVersion,
                  bindingKind: node.agentBinding.bindingKind,
                  agentVersionId: node.agentBinding.agentVersionId,
                  agentVersionSha256: node.agentBinding.agentVersionSha256,
                  promptPolicy: node.agentBinding.promptPolicy,
                  promptSource: node.agentBinding.promptSource,
                  promptOverrideMarkdown: node.agentBinding.promptOverrideMarkdown,
                  toolPolicy: node.agentBinding.toolPolicy,
                },
              ]
            : [],
        ),
      }),
    );
  }

  async saveWorkflowAgentNodeConfiguration(
    commandId: string,
    payload: SaveWorkflowAgentNodeConfigurationPayload,
    signal?: AbortSignal,
  ) {
    return this.request(
      "/api/workflow/definitions/agent-node-configurations",
      workflowDefinitionCommandResultDtoSchema,
      {
        method: "POST",
        body: JSON.stringify({ commandId, payload }),
        ...withSignal(signal),
      },
    );
  }

  async getRun(productRunId: string, signal?: AbortSignal): Promise<ChatRun> {
    const value = await this.request(
      `/api/runs/${encodeURIComponent(productRunId)}`,
      runResponseSchema,
      withSignal(signal),
    );
    return value.run;
  }

  async getWorkflowExecutionTrace(
    productRunId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowExecutionTraceDto> {
    return await this.request(
      `/api/runs/${encodeURIComponent(productRunId)}/workflow-execution-trace`,
      workflowExecutionTraceDtoSchema,
      withSignal(signal),
    );
  }

  async getPlans(productRunId: string, signal?: AbortSignal): Promise<ChatPlan[]> {
    const value = await this.request(
      `/api/runs/${encodeURIComponent(productRunId)}/plans`,
      plansResponseSchema,
      withSignal(signal),
    );
    return value.items;
  }

  async getApproval(productRunId: string, signal?: AbortSignal): Promise<ChatApproval | null> {
    const value = await this.request(
      `/api/runs/${encodeURIComponent(productRunId)}/approvals/current`,
      approvalResponseSchema,
      withSignal(signal),
    );
    return value.approval;
  }

  async getNoteCandidate(
    productRunId: string,
    signal?: AbortSignal,
  ): Promise<ChatNoteCandidate | null> {
    try {
      return await this.request(
        `/api/runs/${encodeURIComponent(productRunId)}/note-candidates/current`,
        noteCandidateResponseSchema,
        withSignal(signal),
      );
    } catch (error) {
      if (error instanceof ChatProductApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getCurrentPromptReview(
    productRunId: string,
    signal?: AbortSignal,
  ): Promise<ChatPromptReview | null> {
    const value = await this.request(
      `/api/runs/${encodeURIComponent(productRunId)}/prompt-reviews/current`,
      currentPromptReviewResponseSchema,
      withSignal(signal),
    );
    return value.promptReview;
  }

  async getToolExecutions(productRunId: string, signal?: AbortSignal): Promise<ChatToolExecutions> {
    return this.request(
      `/api/runs/${encodeURIComponent(productRunId)}/tool-executions`,
      toolExecutionsResponseSchema,
      withSignal(signal),
    );
  }

  async getMessage(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ChatMessage | null> {
    const value = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
      exactMessageResponseSchema,
      withSignal(signal),
    );
    return value.message;
  }

  async submitDecision(
    pending: PendingDecision,
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<ChatRun> {
    const payload = {
      approvalRequestId: pending.approvalRequestId,
      planId: pending.planId,
      planRevision: pending.planRevision,
      planSha256: pending.planSha256,
      kind: pending.request.kind,
      ...(pending.request.kind === "request_revision"
        ? { revisionInstruction: request.explanation }
        : pending.request.kind === "reject" && request.explanation !== undefined
          ? { reason: request.explanation }
          : {}),
    };
    const value = await this.request(
      `/api/runs/${encodeURIComponent(pending.productRunId)}/decisions`,
      decisionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: pending.commandId,
          expectedRevision: pending.expectedRunRevision,
          payload,
        }),
        ...withSignal(signal),
      },
    );
    return value.run;
  }

  async submitNoteDecision(
    pending: PendingNoteDecision,
    request: NoteDecisionRequest,
    signal?: AbortSignal,
  ): Promise<ChatNoteCandidate> {
    const payload = {
      productRunId: pending.productRunId,
      noteCandidateId: pending.noteCandidateId,
      candidateRevision: pending.candidateRevision,
      candidateSha256: pending.candidateSha256,
      kind: pending.request.kind,
      ...(pending.request.kind === "request_revision"
        ? { revisionInstruction: request.explanation }
        : pending.request.kind === "reject" && request.explanation !== undefined
          ? { reason: request.explanation }
          : {}),
    };
    const value = await this.request(
      `/api/runs/${encodeURIComponent(pending.productRunId)}/note-decisions`,
      noteDecisionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: pending.commandId,
          expectedRevision: pending.expectedRunRevision,
          payload,
        }),
        ...withSignal(signal),
      },
    );
    return value.candidate;
  }

  async submitPromptReviewDecision(
    pending: PendingPromptReviewDecision,
    request: PromptReviewDecisionRequest,
    signal?: AbortSignal,
  ): Promise<ChatRun> {
    const value = await this.request(
      `/api/runs/${encodeURIComponent(pending.productRunId)}/prompt-review-decisions`,
      promptReviewDecisionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: pending.commandId,
          expectedRevision: pending.expectedRunRevision,
          payload: {
            promptReviewRequestId: pending.promptReviewRequestId,
            requestRevision: pending.requestRevision,
            reviewSha256: pending.reviewSha256,
            payloadSha256: pending.payloadSha256,
            kind: pending.request.kind,
            ...(pending.request.kind === "reject" && request.explanation !== undefined
              ? { reason: request.explanation }
              : {}),
          },
        }),
        ...withSignal(signal),
      },
    );
    return value.run;
  }

  async submitToolExecutionDecision(
    pending: PendingToolExecutionDecision,
    request: ToolExecutionDecisionRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = await this.request(
      `/api/runs/${encodeURIComponent(pending.productRunId)}/tool-execution-decisions`,
      toolExecutionDecisionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: pending.commandId,
          expectedRevision: pending.intentRevision,
          payload: {
            toolExecutionIntentId: pending.toolExecutionIntentId,
            intentRevision: pending.intentRevision,
            capabilityDescriptorSha256: pending.capabilityDescriptorSha256,
            inputSha256: pending.inputSha256,
            scopeRef: pending.scopeRef,
            kind: pending.request.kind,
            ...(pending.request.kind === "reject" && request.explanation !== undefined
              ? { explanation: request.explanation }
              : {}),
          },
        }),
        ...withSignal(signal),
      },
    );
    if (
      value.decision.toolExecutionIntentId !== pending.toolExecutionIntentId ||
      value.decision.productRunId !== pending.productRunId ||
      value.decision.intentRevision !== pending.intentRevision ||
      value.decision.capabilityDescriptorSha256 !== pending.capabilityDescriptorSha256 ||
      value.decision.inputSha256 !== pending.inputSha256 ||
      JSON.stringify(value.decision.scopeRef) !== JSON.stringify(pending.scopeRef) ||
      value.decision.kind !== pending.kind ||
      value.intent.toolExecutionIntentId !== pending.toolExecutionIntentId ||
      value.intent.productRunId !== pending.productRunId ||
      value.intent.revision !== pending.intentRevision + 1 ||
      value.intent.status !== (pending.kind === "approve" ? "approved" : "rejected") ||
      value.intent.capability.ref.descriptorSha256 !== pending.capabilityDescriptorSha256 ||
      value.intent.inputSha256 !== pending.inputSha256 ||
      JSON.stringify(value.intent.scopeRef) !== JSON.stringify(pending.scopeRef)
    ) {
      throw new Error("lifeos_tool_decision_response_binding_mismatch");
    }
  }

  async getPromptRegions(signal?: AbortSignal): Promise<PromptRegionsDto> {
    return this.request("/api/prompt-regions", promptRegionsDtoSchema, withSignal(signal));
  }

  async getAgentProfiles(
    workspaceRootId?: string,
    signal?: AbortSignal,
  ): Promise<AgentProfilesDto> {
    const suffix =
      workspaceRootId === undefined
        ? ""
        : `?workspaceRootId=${encodeURIComponent(workspaceRootId)}`;
    return this.request(`/api/agent-profiles${suffix}`, agentProfilesDtoSchema, withSignal(signal));
  }

  async getProjectAgentOpeningPacket(
    query: {
      readonly projectId?: string;
      readonly productSessionId?: string;
      readonly workspaceRootId?: string;
      readonly workKey?: string;
      readonly participantId?: string;
      readonly includeResourceContext?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<ProjectAgentOpeningPacketV2> {
    const params = new URLSearchParams();
    if (query.projectId !== undefined) params.set("projectId", query.projectId);
    if (query.productSessionId !== undefined)
      params.set("productSessionId", query.productSessionId);
    if (query.workspaceRootId !== undefined) params.set("workspaceRootId", query.workspaceRootId);
    if (query.workKey !== undefined) params.set("workKey", query.workKey);
    if (query.participantId !== undefined) params.set("participantId", query.participantId);
    params.set("includeResourceContext", String(query.includeResourceContext ?? false));
    const response = await this.request(
      `/api/project-agent/opening-packet?${params.toString()}`,
      projectAgentOpeningPacketV2ResponseSchema,
      withSignal(signal),
    );
    return response.packet;
  }

  async reviseAgentPrompt(
    agentKey: AgentKey,
    commandId: string,
    payload: ReviseAgentPromptPayload,
    signal?: AbortSignal,
  ): Promise<AgentProfileDto> {
    return this.request(
      `/api/agent-profiles/${encodeURIComponent(agentKey)}/prompt-revisions`,
      agentProfileDtoSchema,
      {
        method: "POST",
        body: JSON.stringify({ commandId, payload }),
        ...withSignal(signal),
      },
    );
  }

  async createAgentVersion(
    agentKey: AgentKey,
    commandId: string,
    payload: CreateAgentVersionPayload,
    signal?: AbortSignal,
  ): Promise<AgentProfileDto> {
    return this.request(
      `/api/agent-profiles/${encodeURIComponent(agentKey)}/versions`,
      agentProfileDtoSchema,
      {
        method: "POST",
        body: JSON.stringify({ commandId, payload }),
        ...withSignal(signal),
      },
    );
  }

  async restoreAgentPrompt(
    agentKey: AgentKey,
    commandId: string,
    payload: RestoreAgentPromptPayload,
    signal?: AbortSignal,
  ): Promise<AgentProfileDto> {
    return this.request(
      `/api/agent-profiles/${encodeURIComponent(agentKey)}/restore-default`,
      agentProfileDtoSchema,
      {
        method: "POST",
        body: JSON.stringify({ commandId, payload }),
        ...withSignal(signal),
      },
    );
  }

  async getPromptWorkspaces(signal?: AbortSignal): Promise<PromptWorkspacesDto> {
    return this.request("/api/prompt-workspaces", promptWorkspacesDtoSchema, withSignal(signal));
  }

  async previewPromptAssembly(
    payload: PreviewPromptAssemblyPayload,
    signal?: AbortSignal,
  ): Promise<PromptAssemblyPreviewDto> {
    return this.request("/api/prompt-assembly-previews", promptAssemblyPreviewDtoSchema, {
      method: "POST",
      body: JSON.stringify(payload),
      ...withSignal(signal),
    });
  }

  async previewPromptConfiguration(
    payload: PreviewPromptConfigurationPayload,
    signal?: AbortSignal,
  ): Promise<PromptConfigurationPreviewDto> {
    return this.request("/api/prompt-configuration-previews", promptConfigurationPreviewDtoSchema, {
      method: "POST",
      body: JSON.stringify(payload),
      ...withSignal(signal),
    });
  }

  async previewPromptTurn(
    payload: PreviewPromptTurnPayload,
    signal?: AbortSignal,
  ): Promise<PromptTurnPreviewDto> {
    return this.request("/api/prompt-turn-previews", promptTurnPreviewDtoSchema, {
      method: "POST",
      body: JSON.stringify(payload),
      ...withSignal(signal),
    });
  }

  async listPromptFragments(
    query: {
      cursor?: string;
      limit?: number;
      regionKey?: string;
      ownerKind?: string;
      status?: string;
      scopeKind?: string;
      workspaceRootId?: string;
    },
    signal?: AbortSignal,
  ): Promise<PromptFragmentPageDto> {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.regionKey !== undefined) params.set("regionKey", query.regionKey);
    if (query.ownerKind !== undefined) params.set("ownerKind", query.ownerKind);
    if (query.status !== undefined) params.set("status", query.status);
    if (query.scopeKind !== undefined) params.set("scopeKind", query.scopeKind);
    if (query.workspaceRootId !== undefined) params.set("workspaceRootId", query.workspaceRootId);
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request(
      `/api/prompt-fragments${suffix}`,
      promptFragmentPageDtoSchema,
      withSignal(signal),
    );
  }

  async getPromptFragment(
    promptFragmentId: string,
    signal?: AbortSignal,
  ): Promise<PromptFragmentDetailDto> {
    return this.request(
      `/api/prompt-fragments/${encodeURIComponent(promptFragmentId)}`,
      promptFragmentDetailDtoSchema,
      withSignal(signal),
    );
  }

  async getPromptFragmentRevision(
    promptFragmentRevisionId: string,
    signal?: AbortSignal,
  ): Promise<PromptFragmentRevisionDetailDto> {
    return this.request(
      `/api/prompt-fragment-revisions/${encodeURIComponent(promptFragmentRevisionId)}`,
      promptFragmentRevisionDetailDtoSchema,
      withSignal(signal),
    );
  }

  async createPromptFragment(
    commandId: string,
    payload: CreatePromptFragmentPayload,
    signal?: AbortSignal,
  ): Promise<PromptFragmentCommandResultDto> {
    return this.request("/api/prompt-fragments", promptFragmentCommandResultDtoSchema, {
      method: "POST",
      body: JSON.stringify({ commandId, payload }),
      ...withSignal(signal),
    });
  }

  async copyPromptFragment(
    commandId: string,
    payload: CopyPromptFragmentPayload,
    signal?: AbortSignal,
  ): Promise<PromptFragmentCommandResultDto> {
    return this.request("/api/prompt-fragments/copies", promptFragmentCommandResultDtoSchema, {
      method: "POST",
      body: JSON.stringify({ commandId, payload }),
      ...withSignal(signal),
    });
  }

  async revisePromptFragment(
    promptFragmentId: string,
    commandId: string,
    expectedRevision: number,
    payload: RevisePromptFragmentPayload,
    signal?: AbortSignal,
  ): Promise<PromptFragmentCommandResultDto> {
    return this.request(
      `/api/prompt-fragments/${encodeURIComponent(promptFragmentId)}/revisions`,
      promptFragmentCommandResultDtoSchema,
      {
        method: "POST",
        body: JSON.stringify({ commandId, expectedRevision, payload }),
        ...withSignal(signal),
      },
    );
  }

  async changePromptFragmentArchiveStatus(
    promptFragmentId: string,
    commandId: string,
    expectedRevision: number,
    payload: ChangePromptFragmentArchiveStatusPayload,
    signal?: AbortSignal,
  ): Promise<PromptFragmentCommandResultDto> {
    return this.request(
      `/api/prompt-fragments/${encodeURIComponent(promptFragmentId)}/archive-status`,
      promptFragmentCommandResultDtoSchema,
      {
        method: "POST",
        body: JSON.stringify({ commandId, expectedRevision, payload }),
        ...withSignal(signal),
      },
    );
  }

  private async request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, headers });
    } catch (error) {
      if (init.signal?.aborted === true) throw error;
      throw new ChatProductApiError(
        503,
        "chat_api_unreachable",
        true,
        "retry_same_command",
        "Chat API is unreachable",
        { cause: error },
      );
    }
    let json: unknown;
    try {
      json = await boundedJson(response);
    } catch (error) {
      throw new ChatProductApiError(
        response.status,
        "chat_api_invalid_response",
        false,
        "inspect_chat_api",
        "Chat API returned an invalid or oversized JSON response",
        { cause: error },
      );
    }
    if (!response.ok) {
      const parsed = problemSchema.safeParse(json);
      const problem = parsed.success ? parsed.data : undefined;
      throw new ChatProductApiError(
        response.status,
        problem?.code ?? "chat_api_request_failed",
        problem?.retryable ?? response.status >= 500,
        problem?.recoveryAction,
        problem?.detail ?? problem?.title ?? `Chat API returned HTTP ${response.status}`,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ChatProductApiError(
        response.status,
        "chat_api_contract_mismatch",
        false,
        "inspect_chat_api",
        "Chat API response did not match the public product contract",
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }
}
