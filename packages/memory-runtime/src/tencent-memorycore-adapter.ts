import {
  MemoryBackendError,
  MemoryImportBackendError,
  type MemoryBackendHealth,
  type MemoryBackendPort,
  type MemoryBackendProfile,
  type MemoryImportAccepted,
  type MemoryImportBackendPort,
  type MemoryImportBackendProfile,
  type MemoryImportInput,
  type MemoryImportReconcileInput,
  type MemoryImportReconcileOutput,
  type MemoryQueryInput,
  type MemoryQueryOutput,
  type MemoryQuerySection,
} from "@chat/application";
import { memoryBackendIdSchema, type MemoryBackendId } from "@chat/contracts";
import {
  computeMemoryImportRequestSha256,
  estimateMemorySectionTokens,
  hashCanonical,
} from "@chat/domain";
import { z } from "zod";

export const TENCENT_MEMORYCORE_BACKEND_ID: MemoryBackendId =
  memoryBackendIdSchema.parse("mbk_tencentmemorycore");
export const TENCENT_MEMORYCORE_DEFAULT_BASE_URL = "http://127.0.0.1:18970";

const MAX_RESPONSE_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const provenanceSchema = z
  .object({
    provenance_id: z.string(),
    record_id: z.string(),
    layer: z.enum(["L0", "L1", "L2", "L3"]),
    action: z.string(),
    reason_code: z.string(),
    reason: z.string(),
    attribution: z.enum(["exact", "declared", "input_set", "session", "none"]),
    source_ids: z.array(z.string()),
    supersedes_ids: z.array(z.string()),
    team_id: z.string().optional(),
    agent_id: z.string().optional(),
    user_id: z.string().optional(),
    task_id: z.string().optional(),
    session_id: z.string().optional(),
    version: z.number().int(),
    created_at_ms: z.number(),
    request_id: z.string().optional(),
    pipeline_task_id: z.string().optional(),
    trace_id: z.string().optional(),
    // MemoryCore 的安全 provenance metadata 只在信任边界校验后丢弃。
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const conversationAddRequestSchema = z
  .object({
    team_id: z.string().min(1),
    agent_id: z.string().min(1),
    user_id: z.string().min(1),
    session_id: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.literal("user"),
            content: z.string().min(1).max(8_192),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

const conversationAddDataSchema = z
  .object({
    accepted_ids: z.array(z.string().min(1)).length(1),
    accepted_versions: z.array(z.string().min(1)).length(1),
    total_count: z.literal(1),
  })
  .strict();

const conversationItemSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: z.iso.datetime().optional(),
    session_id: z.string().optional(),
    team_id: z.string().optional(),
    user_id: z.string().optional(),
    agent_id: z.string().optional(),
    task_id: z.string().optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const conversationQueryDataSchema = z
  .object({
    messages: z.array(conversationItemSchema).max(100),
    total: z.number().int().nonnegative(),
  })
  .strict();

const atomicDetailFields = {
  id: z.string().min(1).max(200),
  version: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
  type: z.string().min(1).max(100),
  background: z.string().max(50_000).optional(),
  content: z.string().min(1).max(50_000),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  team_id: z.string().optional(),
  agent_id: z.string().optional(),
  user_id: z.string().optional(),
  task_id: z.string().optional(),
};

const atomicSearchHitSchema = z
  .object({ ...atomicDetailFields, score: z.number().finite() })
  .strict();

const atomicSearchDataSchema = z
  .object({ items: z.array(atomicSearchHitSchema).max(100) })
  .strict();

const atomicQueryItemSchema = z
  .object({
    ...atomicDetailFields,
    session_id: z.string().optional(),
    timestamp_start: z.string().optional(),
    timestamp_end: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const atomicQueryDataSchema = z
  .object({
    items: z.array(atomicQueryItemSchema).max(100),
    total: z.number().int().nonnegative(),
  })
  .strict();

const envelopeBase = {
  code: z.number().int(),
  message: z.string(),
  request_id: z.string().min(1).max(200),
};

function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ ...envelopeBase, code: z.literal(0), data }).strict();
}

const errorEnvelopeSchema = z
  .object({ ...envelopeBase, data: z.record(z.string(), z.unknown()).optional() })
  .strict();

export interface TencentMemoryCoreAdapterOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly serviceId?: string;
  readonly teamId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly configurationRevision?: string;
  readonly credentialRevision?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface ResolvedConfiguration {
  readonly token: string;
  readonly serviceId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly credentialRevision: string;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MemoryBackendError({
      code: "memory.backend.configuration_invalid",
      message: "Tencent MemoryCore endpoint无效",
      retryable: false,
    });
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new MemoryBackendError({
      code: "memory.backend.configuration_invalid",
      message: "远端Tencent MemoryCore必须使用HTTPS",
      retryable: false,
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MemoryBackendError({
      code: "memory.backend.configuration_invalid",
      message: "Tencent MemoryCore endpoint不能携带凭据或查询参数",
      retryable: false,
    });
  }
  return url.toString().replace(/\/$/u, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveConfiguration(
  options: TencentMemoryCoreAdapterOptions,
): ResolvedConfiguration | undefined {
  const token = nonEmpty(options.token);
  const serviceId = nonEmpty(options.serviceId);
  const teamId = nonEmpty(options.teamId);
  const userId = nonEmpty(options.userId);
  const agentId = nonEmpty(options.agentId);
  const credentialRevision = nonEmpty(options.credentialRevision);
  if (
    token === undefined ||
    serviceId === undefined ||
    teamId === undefined ||
    userId === undefined ||
    agentId === undefined ||
    credentialRevision === undefined ||
    credentialRevision === "none"
  ) {
    return undefined;
  }
  return { token, serviceId, teamId, userId, agentId, credentialRevision };
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function readJsonBounded(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > maxBytes) throw new Error("response too large");
  if (response.body === null) throw new Error("response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function queryStatusError(status: number): MemoryBackendError {
  const code =
    status === 401
      ? "memory.backend.unauthorized"
      : status === 403
        ? "memory.backend.forbidden"
        : status === 429
          ? "memory.backend.rate_limited"
          : status >= 500
            ? "memory.backend.unavailable"
            : "memory.backend.request_rejected";
  return new MemoryBackendError({
    code,
    message: `Tencent MemoryCore返回HTTP ${String(status)}`,
    retryable: status === 429 || status >= 500,
  });
}

function stableImportSession(operationId: string): string {
  return `chat-import:${operationId}`;
}

function chatSession(productSessionId: string): string {
  return `chat-session:${productSessionId}`;
}

function mappedKind(type: string): MemoryQuerySection["kind"] {
  if (type === "instruction" || type === "work_method") return "policy";
  if (type === "persona") return "world_model";
  return "trace";
}

export class TencentMemoryCoreAdapter implements MemoryBackendPort, MemoryImportBackendPort {
  private readonly baseUrl: string;
  private readonly configuration: ResolvedConfiguration | undefined;
  private readonly configurationFingerprint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TencentMemoryCoreAdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.configuration = resolveConfiguration(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new MemoryBackendError({
        code: "memory.backend.configuration_invalid",
        message: "Tencent MemoryCore timeout无效",
        retryable: false,
      });
    }
    this.configurationFingerprint = hashCanonical("tencent-memorycore-adapter-configuration.v1", {
      baseUrl: this.baseUrl,
      configurationRevision: nonEmpty(options.configurationRevision) ?? "unconfigured",
      credentialRevision: this.configuration?.credentialRevision ?? "unconfigured",
      serviceId: this.configuration?.serviceId ?? "unconfigured",
      teamId: this.configuration?.teamId ?? "unconfigured",
      userId: this.configuration?.userId ?? "unconfigured",
      agentId: this.configuration?.agentId ?? "unconfigured",
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe(): MemoryBackendProfile {
    return {
      backendId: TENCENT_MEMORYCORE_BACKEND_ID,
      displayName: "Tencent MemoryCore",
      kind: "tencent_memorycore",
      adapterContractVersion: "tencent-memorycore-http-query.v1",
      configured: this.configuration !== undefined,
      authMode: "bearer",
      credentialRevision: this.configuration?.credentialRevision ?? "unconfigured",
      configurationFingerprint: this.configurationFingerprint,
      capabilities: {
        query: true,
        tags: false,
        layers: ["L1"],
        maxLimit: 20,
        maxContextBudget: 8_192,
      },
    };
  }

  describeImport(): MemoryImportBackendProfile {
    return {
      descriptor: {
        backendId: TENCENT_MEMORYCORE_BACKEND_ID,
        displayName: "Tencent MemoryCore",
        kind: "tencent_memorycore",
        adapterContractVersion: "tencent-memorycore-http-import.v1",
        configured: this.configuration !== undefined,
        authMode: "bearer",
        credentialRevision: this.configuration?.credentialRevision ?? "unconfigured",
        configurationFingerprint: this.configurationFingerprint,
        capabilities: {
          mode: "conversation_capture",
          layers: ["L0"],
          title: false,
          tags: false,
          maxContentChars: 8_192,
        },
      },
    };
  }

  async health(): Promise<MemoryBackendHealth> {
    if (this.configuration === undefined) {
      return { status: "unavailable", errorCode: "memory.backend.not_configured" };
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok)
        return { status: "unavailable", errorCode: queryStatusError(response.status).code };
      const raw = await readJsonBounded(response, 256_000);
      const parsed = z
        .object({
          status: z.enum(["ok", "degraded"]),
          version: z.string().min(1),
          uptime: z.number().nonnegative(),
          stores: z
            .object({
              vectorStore: z.boolean(),
              embeddingService: z.boolean(),
            })
            .strict(),
          services: z
            .object({
              timerScanner: z.unknown().nullable(),
              pipelineWorker: z.unknown().nullable(),
              stateBackend: z.enum(["connected", "none"]),
            })
            .strict(),
        })
        .strict()
        .parse(raw);
      return parsed.status === "ok" && parsed.stores.vectorStore
        ? { status: "ready" }
        : { status: "unavailable", errorCode: "memory.backend.degraded" };
    } catch (error) {
      return {
        status: "unavailable",
        errorCode: isTimeoutError(error)
          ? "memory.backend.timeout"
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? "memory.backend.contract_invalid"
            : "memory.backend.unavailable",
      };
    }
  }

  async query(input: MemoryQueryInput): Promise<MemoryQueryOutput> {
    const config = this.requireConfiguration("query");
    if (input.tags.length > 0 || input.layers.some((layer) => layer !== "L1")) {
      throw new MemoryBackendError({
        code: "memory.backend.capability_unsupported",
        message: "Tencent MemoryCore只支持无标签的L1查询",
        retryable: false,
      });
    }
    const body = {
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
      query: input.query,
      limit: input.limit,
    };
    const parsed = await this.postQuery(
      "/v3/atomic/search",
      body,
      atomicSearchDataSchema,
      chatSession(input.productSessionId),
    );
    const sections: MemoryQuerySection[] = [];
    let tokenEstimate = 0;
    for (const item of parsed.data.items) {
      const section: MemoryQuerySection = {
        externalObjectIds: [item.id],
        title: (item.background?.trim() || `MemoryCore ${item.type}`).slice(0, 200),
        kind: mappedKind(item.type),
        memoryLayer: "L1",
        content: item.content,
        tags: [],
        score: item.score,
        sourceUpdatedAt: item.updated_at,
      };
      const estimate = estimateMemorySectionTokens(section);
      if (tokenEstimate + estimate > input.contextBudget) continue;
      tokenEstimate += estimate;
      sections.push({ ...section, tokenEstimate: estimate });
    }
    return {
      externalQueryId: parsed.request_id,
      hitCount: parsed.data.items.length,
      tokenEstimate,
      sections,
    };
  }

  async import(input: MemoryImportInput): Promise<MemoryImportAccepted> {
    const config = this.requireImportConfiguration();
    this.assertImportInput(input);
    const sessionId = stableImportSession(input.operationId);
    const request = conversationAddRequestSchema.parse({
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
      session_id: sessionId,
      messages: [{ role: "user", content: input.content }],
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v3/conversation/add`, {
        method: "POST",
        headers: this.headers(config, sessionId),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MemoryImportBackendError({
        code: isTimeoutError(error) ? "memory.import.timeout" : "memory.import.connection_lost",
        message: "Tencent MemoryCore导入结果未知",
        phase: "write_outcome_unknown",
      });
    }
    if (!response.ok) {
      const rejected = [400, 401, 403, 404, 409, 422, 429].includes(response.status);
      throw new MemoryImportBackendError({
        code: `memory.import.http_${String(response.status)}`,
        message: "Tencent MemoryCore拒绝导入请求",
        phase: rejected ? "rejected_before_write" : "write_outcome_unknown",
      });
    }
    try {
      const envelope = successEnvelope(conversationAddDataSchema).parse(
        await readJsonBounded(response, 256_000),
      );
      const acceptedVersion = envelope.data.accepted_versions[0];
      if (acceptedVersion === undefined) throw new Error("accepted version missing");
      return {
        externalObjectId: sessionId,
        externalObjectVersion: acceptedVersion,
        externalStatus: "l0_accepted",
        responseSha256: hashCanonical("tencent-memorycore-conversation-add-response.v1", {
          requestSha256: input.requestSha256,
          requestId: envelope.request_id,
          data: envelope.data,
        }),
      };
    } catch {
      throw new MemoryImportBackendError({
        code: "memory.import.response_invalid",
        message: "Tencent MemoryCore可能已写入但响应合同无效",
        phase: "write_outcome_unknown",
      });
    }
  }

  async reconcile(input: MemoryImportReconcileInput): Promise<MemoryImportReconcileOutput> {
    const config = this.requireImportConfiguration();
    try {
      this.assertImportInput(input);
    } catch (error) {
      return {
        status: "failed",
        errorCode:
          error instanceof MemoryImportBackendError ? error.code : "memory.import.request_invalid",
        summary: "Tencent MemoryCore对账输入无效",
      };
    }
    const sessionId = stableImportSession(input.operationId);
    if (input.externalObjectId !== undefined && input.externalObjectId !== sessionId) {
      return {
        status: "failed",
        errorCode: "memory.import.external_identity_mismatch",
        summary: "Tencent MemoryCore外部Session身份不一致",
      };
    }
    try {
      const l0 = await this.postImportRead(
        "/v3/conversation/query",
        {
          team_id: config.teamId,
          agent_id: config.agentId,
          user_id: config.userId,
          session_id: sessionId,
          limit: 100,
          offset: 0,
          sort_order: "asc",
        },
        conversationQueryDataSchema,
        sessionId,
      );
      const matching = l0.data.messages.filter(
        (message) =>
          message.session_id === sessionId &&
          message.team_id === config.teamId &&
          message.user_id === config.userId &&
          message.agent_id === config.agentId &&
          message.role === "user" &&
          message.content === input.content,
      );
      if (matching.length === 0) {
        return l0.data.total === 0
          ? { status: "outcome_unknown", errorCode: "memory.import.l0_not_found" }
          : {
              status: "failed",
              errorCode: "memory.import.verification_mismatch",
              summary: "Tencent MemoryCore L0与冻结导入请求不一致",
            };
      }
      const accepted: MemoryImportAccepted = {
        externalObjectId: sessionId,
        ...(matching[0]?.version !== undefined
          ? { externalObjectVersion: matching[0].version }
          : { externalObjectVersion: "v1" }),
        externalStatus: "l0_accepted",
        responseSha256: hashCanonical("tencent-memorycore-l0-reconciliation.v1", {
          requestSha256: input.requestSha256,
          requestId: l0.request_id,
          messageIds: matching.map((message) => message.id).sort(),
        }),
      };

      const l1 = await this.postImportRead(
        "/v3/atomic/query",
        {
          team_id: config.teamId,
          agent_id: config.agentId,
          user_id: config.userId,
          limit: 100,
          offset: 0,
        },
        atomicQueryDataSchema,
        sessionId,
      );
      const materialized = l1.data.items
        .filter((item) => item.session_id === sessionId)
        .map((item) => ({ id: item.id, version: item.version, updatedAt: item.updated_at }));
      if (materialized.length === 0) return { status: "accepted", accepted };
      return {
        status: "materialized",
        accepted: { ...accepted, externalStatus: "l1_materialized" },
        verificationKind: "l0_and_session_l1",
        verificationSha256: hashCanonical("tencent-memorycore-import-verification.v1", {
          requestSha256: input.requestSha256,
          sessionId,
          l0MessageIds: matching.map((message) => message.id).sort(),
          l1Objects: materialized.sort((a, b) => a.id.localeCompare(b.id)),
        }),
      };
    } catch (error) {
      return {
        status: "outcome_unknown",
        errorCode:
          error instanceof MemoryImportBackendError
            ? error.code
            : "memory.import.reconcile_unavailable",
      };
    }
  }

  private requireConfiguration(_operation: "query"): ResolvedConfiguration {
    if (this.configuration === undefined) {
      throw new MemoryBackendError({
        code: "memory.backend.not_configured",
        message: "Tencent MemoryCore尚未配置",
        retryable: false,
      });
    }
    return this.configuration;
  }

  private requireImportConfiguration(): ResolvedConfiguration {
    if (this.configuration === undefined) {
      throw new MemoryImportBackendError({
        code: "memory.import.backend_not_configured",
        message: "Tencent MemoryCore尚未配置",
        phase: "before_external_call",
      });
    }
    return this.configuration;
  }

  private assertImportInput(input: MemoryImportInput): void {
    if (
      input.layer !== "L0" ||
      input.tags.length > 0 ||
      computeMemoryImportRequestSha256({
        kind: "tencent_conversation_capture",
        content: input.content,
        layer: "L0",
        turnId: input.turnId,
      }) !== input.requestSha256
    ) {
      throw new MemoryImportBackendError({
        code: "memory.import.request_hash_mismatch",
        message: "Tencent MemoryCore导入请求与冻结Intent不一致",
        phase: "before_external_call",
      });
    }
  }

  private headers(config: ResolvedConfiguration, sessionId: string): Record<string, string> {
    return {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "x-tdai-service-id": config.serviceId,
      "x-tdai-team-id": config.teamId,
      "x-tdai-user-id": config.userId,
      "x-tdai-agent-id": config.agentId,
      "x-tdai-session-id": sessionId,
    };
  }

  private async postQuery<T extends z.ZodType>(
    path: string,
    body: unknown,
    dataSchema: T,
    sessionId: string,
  ) {
    const config = this.requireConfiguration("query");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(config, sessionId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      throw new MemoryBackendError({
        code: isTimeoutError(error) ? "memory.backend.timeout" : "memory.backend.unavailable",
        message: "Tencent MemoryCore查询不可用",
        retryable: true,
      });
    });
    if (!response.ok) throw queryStatusError(response.status);
    try {
      return successEnvelope(dataSchema).parse(await readJsonBounded(response));
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.contract_invalid",
        message: "Tencent MemoryCore响应不符合固定合同",
        retryable: false,
      });
    }
  }

  private async postImportRead<T extends z.ZodType>(
    path: string,
    body: unknown,
    dataSchema: T,
    sessionId: string,
  ) {
    const config = this.requireImportConfiguration();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(config, sessionId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MemoryImportBackendError({
        code: "memory.import.reconcile_unavailable",
        message: "Tencent MemoryCore对账不可用",
        phase: "write_outcome_unknown",
      });
    }
    if (!response.ok) {
      let code = `memory.import.verify_http_${String(response.status)}`;
      try {
        const external = errorEnvelopeSchema.parse(await readJsonBounded(response, 256_000));
        if (external.code === 401) code = "memory.import.verify_unauthorized";
        if (external.code === 403) code = "memory.import.verify_forbidden";
      } catch {
        // HTTP状态已经是稳定证据；错误正文不跨信任边界。
      }
      throw new MemoryImportBackendError({
        code,
        message: "Tencent MemoryCore对账请求失败",
        phase: "write_outcome_unknown",
      });
    }
    try {
      return successEnvelope(dataSchema).parse(await readJsonBounded(response));
    } catch {
      throw new MemoryImportBackendError({
        code: "memory.import.verify_contract_invalid",
        message: "Tencent MemoryCore对账响应合同无效",
        phase: "write_outcome_unknown",
      });
    }
  }
}
