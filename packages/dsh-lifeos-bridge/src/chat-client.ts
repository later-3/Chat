import type { ZodType } from "zod";
import {
  executionTraceDtoSchema,
  workflowDefinitionsDtoSchema,
  type ExecutionTraceDto,
} from "@chat/contracts/public";
import { z } from "zod";
import {
  approvalResponseSchema,
  createSessionResponseSchema,
  decisionResponseSchema,
  exactMessageResponseSchema,
  lifeosWorkflowOptionSchema,
  plansResponseSchema,
  problemSchema,
  runResponseSchema,
  submitMessageResponseSchema,
  type ChatApproval,
  type ChatMessage,
  type ChatPlan,
  type ChatRun,
  type ChatSession,
  type DecisionRequest,
  type LifeosWorkflowOption,
  type WorkflowSelection,
} from "./contracts.ts";
import type { PendingDecision } from "./state-store.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** GET /api/workflow/definitions 的外层信封；内层DTO权威在@chat/contracts/public。 */
const workflowDefinitionsResponseSchema = z
  .object({ definitions: workflowDefinitionsDtoSchema })
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

  async createSession(commandId: string, signal?: AbortSignal): Promise<ChatSession> {
    const value = await this.request("/api/sessions", createSessionResponseSchema, {
      method: "POST",
      body: JSON.stringify({ commandId, payload: { title: "DeepSeek Harness" } }),
      ...withSignal(signal),
    });
    return value.session;
  }

  async submitMessage(
    sessionId: string,
    commandId: string,
    text: string,
    signal?: AbortSignal,
    workflowSelection?: WorkflowSelection,
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
                  },
                }
              : {}),
          },
        }),
        ...withSignal(signal),
      },
    );
  }

  async listWorkflows(signal?: AbortSignal): Promise<readonly LifeosWorkflowOption[]> {
    const value = await this.request(
      "/api/workflow/definitions",
      workflowDefinitionsResponseSchema,
      withSignal(signal),
    );
    return value.definitions.definitions.map((definition) =>
      lifeosWorkflowOptionSchema.parse({
        workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
        definitionSha256: definition.definitionSha256,
        title: definition.title,
        description: definition.description,
        blueprintKey: definition.blueprintKey,
        ownerKind: definition.ownerKind,
        isDefault: definition.isDefault,
      }),
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

  async getExecutionTrace(productRunId: string, signal?: AbortSignal): Promise<ExecutionTraceDto> {
    return await this.request(
      `/api/runs/${encodeURIComponent(productRunId)}/execution-trace`,
      executionTraceDtoSchema,
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
