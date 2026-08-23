import {
  MemoryBackendError,
  MemoryImportBackendError,
  WorkflowMemoryProviderError,
  WorkflowMemoryWriteProviderError,
  type MemoryBackendHealth,
  type MemoryBackendPort,
  type MemoryBackendProfile,
  type MemoryImportAccepted,
  type MemoryImportBackendProfile,
  type MemoryImportBackendPort,
  type MemoryImportInput,
  type MemoryImportReconcileInput,
  type MemoryImportReconcileOutput,
  type MemoryQueryInput,
  type MemoryQueryOutput,
  type WorkflowMemoryQueryInput,
  type WorkflowMemoryQueryOutput,
  type WorkflowMemoryQueryProviderPort,
  type WorkflowMemoryWriteAccepted,
  type WorkflowMemoryWriteInput,
  type WorkflowMemoryWriteProviderPort,
  type WorkflowMemoryWriteReconcileInput,
  type WorkflowMemoryWriteReconcileOutput,
} from "@chat/application";
import {
  memoryBackendIdSchema,
  memoryCredentialRevisionSchema,
  memoryProviderDescriptorSchema,
  principalIdSchema,
  type MemoryBackendId,
  type MemoryProviderDescriptor,
} from "@chat/contracts";
import {
  computeMemoryImportRequestSha256,
  estimateMemorySectionTokens,
  hashCanonical,
} from "@chat/domain";
import { z } from "zod";

export const MEMMY_BACKEND_ID: MemoryBackendId = memoryBackendIdSchema.parse("mbk_memmy");
export const MEMMY_DEFAULT_BASE_URL = "http://127.0.0.1:18960";

const memmyKindSchema = z.enum(["trace", "span", "policy", "world_model", "skill"]);
const memmyLayerSchema = z.enum(["L1", "L2", "L3", "Skill"]);
const memmyStatusSchema = z.enum(["activated", "resolving", "archived", "deleted"]);

const memmyModelStatusSchema = z
  .object({
    provider: z.string().max(200),
    model: z.string().max(500).optional(),
    configured: z.boolean(),
    remote: z.boolean(),
    lastOkAt: z.iso.datetime().optional(),
    lastError: z.string().max(10_000).optional(),
  })
  .strict();

const memmyHealthResponseSchema = z
  .object({
    ok: z.boolean(),
    version: z.string().min(1).max(100),
    uptimeMs: z.number().finite().nonnegative(),
    mode: z.enum(["local", "cloud", "dev"]),
    activeProfile: z.enum(["account", "byok"]),
    storage: z
      .object({
        backend: z.enum(["sqlite", "openmem-cloud-rest"]),
        backendId: z.enum(["sqlite-local", "openmem-cloud-rest"]).optional(),
        schemaVersion: z.string().min(1).max(100),
        ready: z.boolean(),
        lastMigrationId: z.string().max(500).optional(),
        fullText: z.enum(["fts5", "tsvector", "remote", "none"]).optional(),
        vector: z.enum(["sidecar", "native", "remote", "none"]).optional(),
        changeLog: z.boolean().optional(),
        idempotency: z.boolean().optional(),
        jobs: z.boolean().optional(),
        importExport: z.boolean().optional(),
      })
      .strict(),
    models: z
      .object({
        summary: memmyModelStatusSchema,
        evolution: memmyModelStatusSchema,
        embedding: memmyModelStatusSchema,
      })
      .strict(),
    capabilities: z
      .object({
        routes: z.array(z.string().min(1).max(500)).max(100),
        tools: z.array(z.string().min(1).max(200)).max(100),
        memoryLayers: z.array(memmyLayerSchema).max(4),
        supportsCli: z.boolean(),
      })
      .strict(),
    serverTime: z.iso.datetime(),
  })
  .strict();

const memmyHitSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: memmyKindSchema,
    memoryLayer: memmyLayerSchema,
    status: memmyStatusSchema,
    title: z.string().min(1).max(500).optional(),
    snippet: z.string().max(50_000),
    score: z.number().finite(),
    tags: z.array(z.string().min(1).max(64)).max(50),
    updatedAt: z.iso.datetime().optional(),
    source: z.enum(["search", "episode", "rule", "skill"]),
  })
  .strict();

const memmySectionSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    kind: memmyKindSchema,
    memoryLayer: memmyLayerSchema,
    memoryIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    content: z.string().min(1).max(50_000),
    tokenEstimate: z.number().int().nonnegative().optional(),
  })
  .strict();

const memmySearchResponseSchema = z
  .object({
    injectedContext: z.string().max(200_000),
    debug: z
      .object({
        searchEventId: z.string().min(1).max(200),
        hits: z.array(memmyHitSchema).max(100),
        sourceMemoryIds: z.array(z.string().min(1).max(200)).max(100),
        status: z.array(z.string().max(200)).max(100),
        sections: z.array(memmySectionSchema).max(20),
        tokenEstimate: z.number().int().nonnegative().optional(),
        serverTime: z.iso.datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, context) => {
    const announced = new Set(response.debug.sourceMemoryIds);
    const sectionIds = new Set(response.debug.sections.flatMap((section) => section.memoryIds));
    for (const id of sectionIds) {
      if (!announced.has(id)) {
        context.addIssue({
          code: "custom",
          message: "section memory id is absent from sourceMemoryIds",
          path: ["debug", "sections"],
        });
      }
    }
    for (const id of announced) {
      if (!sectionIds.has(id)) {
        context.addIssue({
          code: "custom",
          message: "sourceMemoryId has no adopted section",
          path: ["debug", "sourceMemoryIds"],
        });
      }
    }
    for (const [index, section] of response.debug.sections.entries()) {
      const hitById = new Map(response.debug.hits.map((hit) => [hit.id, hit]));
      const tagCount = new Set(section.memoryIds.flatMap((id) => hitById.get(id)?.tags ?? [])).size;
      if (tagCount > 50) {
        context.addIssue({
          code: "custom",
          message: "section-derived tags exceed Chat snapshot limit",
          path: ["debug", "sections", index],
        });
      }
    }
  });

const memmySearchRequestSchema = z
  .object({
    // 普通query固定requestId以便安全重放；只读write reconcile故意省略，避免
    // memmy永久缓存第一次尚未物化的搜索结果。
    requestId: z.string().min(1).max(200).optional(),
    adapterId: z.literal("chat"),
    namespace: z
      .object({
        source: z.string().trim().min(1).max(200),
        profileId: z.string().trim().min(1).max(200),
        sessionKey: z.string().min(1).max(200),
        userId: z.string().trim().min(1).max(200),
      })
      .strict(),
    query: z.string().trim().min(1).max(100_000),
    layers: z.array(memmyLayerSchema).min(1).max(4),
    tags: z.array(z.string().trim().min(1).max(64)).max(20),
    limit: z.number().int().min(1).max(20),
    contextBudget: z.number().int().min(128).max(8_192),
    includeInjectedContext: z.literal(true),
    verbose: z.literal(true),
  })
  .strict();

const memmyAddRequestSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    adapterId: z.literal("chat"),
    namespace: z
      .object({
        source: z.string().trim().min(1).max(200),
        profileId: z.string().trim().min(1).max(200),
        sessionKey: z.string().min(1).max(200),
        userId: z.string().trim().min(1).max(200),
      })
      .strict(),
    content: z.string().min(1).max(50_000),
    layer: z.literal("L2"),
    title: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(64)).max(20),
    // 顶层source会覆盖memmy namespace.source；sessionId会被当作memmy原生Session外键。
    // Chat没有创建这两类外部对象，因此只发送namespace与稳定turnId。
    turnId: z.string().min(1).max(200),
    deferProcessing: z.literal(false),
  })
  .strict();

const memmyAddResponseSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: memmyKindSchema,
    memoryLayer: z.literal("L2"),
    status: memmyStatusSchema,
    title: z.string().min(1).max(500),
    summary: z.string().max(50_000),
    tags: z.array(z.string().min(1).max(64)).max(50),
    createdAt: z.iso.datetime(),
    serverTime: z.iso.datetime(),
    duplicate: z.literal(true).optional(),
  })
  .strict();

const memmyProcessingRecordSchema = z
  .object({
    memoryId: z.string().min(1).max(200),
    state: z.enum([
      "summary_pending",
      "summarizing",
      "embedding_pending",
      "embedding",
      "ready",
      "ready_text_only",
      "failed",
    ]),
    stage: z.enum(["summary", "embedding"]).nullable().optional(),
    activeJobId: z.string().max(200).nullable().optional(),
    attemptCount: z.number().int().nonnegative(),
    manualRetryCount: z.number().int().nonnegative(),
    retryAction: z.enum(["retry", "open_settings", "none"]),
    errorCode: z.string().max(200).nullable().optional(),
    errorMessage: z.string().max(10_000).nullable().optional(),
    failedAt: z.iso.datetime().nullable().optional(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const memmyMemoryDetailFields = {
  id: z.string().min(1).max(200),
  kind: memmyKindSchema,
  memoryLayer: z.literal("L2"),
  status: memmyStatusSchema,
  title: z.string().min(1).max(500),
  summary: z.string().max(50_000),
  tags: z.array(z.string().min(1).max(64)).max(50),
  metrics: z
    .object({
      value: z.number().finite().optional(),
      alpha: z.number().finite().optional(),
      reflectionDone: z.boolean(),
    })
    .strict()
    .optional(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.number().int().nonnegative(),
  processing: memmyProcessingRecordSchema.optional(),
  body: z.string().min(1).max(100_000),
  sourceMemoryIds: z.array(z.string().min(1).max(200)).max(100),
  // 固定版本 memmy 会把 L2 的层级载荷同时放在顶层与 item 中；字段必须显式列出，
  // 不能用 passthrough，否则上游合同漂移会被静默吞掉。
  policy: z
    .object({
      utilityScore: z.number().finite().optional(),
      confidence: z.number().finite().optional(),
      evidenceMemoryIds: z.array(z.string().min(1).max(200)).max(100),
      repairHints: z.array(z.string().max(10_000)).max(100),
    })
    .strict()
    .optional(),
  // getMemory() 的 item 也携带 refs；顶层 refs 在响应 Schema 中仍为必填。
  refs: z.record(z.string(), z.unknown()).optional(),
};

const memmyMemoryDetailSchema = z.object(memmyMemoryDetailFields).strict();
const memmyGetResponseSchema = z
  .object({
    ...memmyMemoryDetailFields,
    item: memmyMemoryDetailSchema,
    refs: z.record(z.string(), z.unknown()),
    etag: z.string().min(1).max(500),
  })
  .strict();

const memmyPanelItemSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: memmyKindSchema,
    memoryLayer: memmyLayerSchema,
    status: memmyStatusSchema,
    title: z.string().min(1).max(500),
    summary: z.string().max(50_000),
    tags: z.array(z.string().min(1).max(64)).max(50),
    metrics: memmyMemoryDetailFields.metrics,
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
    processing: memmyProcessingRecordSchema.optional(),
  })
  .strict();

const memmyPanelItemsResponseSchema = z
  .object({
    items: z.array(memmyPanelItemSchema).max(100),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
    serverTime: z.iso.datetime(),
  })
  .strict();

export interface MemmyAdapterOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly namespaceSource?: string;
  readonly profileId?: string;
  /** 当前Chat部署绑定的唯一Principal；固定memmy尚不具备可信的库内多租户过滤。 */
  readonly expectedPrincipalId?: string;
  readonly configurationRevision?: string;
  /** Bearer凭据的非秘密keyId/revision；不得传入Token或Token Hash。 */
  readonly credentialRevision?: string;
  readonly fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy baseUrl不是合法URL",
      retryable: false,
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy baseUrl包含不允许的组成部分",
      retryable: false,
    });
  }
  const loopbackHost =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol === "http:" && !loopbackHost) {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "远端memmy必须使用HTTPS",
      retryable: false,
    });
  }
  return url.toString().replace(/\/+$/u, "");
}

function normalizeNonSecretConfigValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() ?? fallback;
  if (normalized.length === 0 || normalized.length > 200) {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy namespace配置无效",
      retryable: false,
    });
  }
  return normalized;
}

function normalizeToken(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveCredentialIdentity(
  token: string | undefined,
  value: string | undefined,
): { authMode: "none" | "bearer"; credentialRevision: string } {
  if (token === undefined) return { authMode: "none", credentialRevision: "none" };
  const parsed = memoryCredentialRevisionSchema.safeParse(value?.trim());
  if (!parsed.success) {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy Bearer凭据缺少有效的非秘密credential revision",
      retryable: false,
    });
  }
  if (parsed.data === "none") {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy Bearer凭据不能使用none作为credential revision",
      retryable: false,
    });
  }
  return { authMode: "bearer", credentialRevision: parsed.data };
}

function normalizeTimeoutMs(value: number | undefined): number {
  const parsed = z
    .number()
    .int()
    .positive()
    .max(300_000)
    .safeParse(value ?? 10_000);
  if (!parsed.success) {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy timeout配置无效",
      retryable: false,
    });
  }
  return parsed.data;
}

function normalizeExpectedPrincipalId(value: string | undefined): string {
  const parsed = principalIdSchema.safeParse(value?.trim() || "usr_debug");
  if (!parsed.success) {
    throw new MemoryBackendError({
      code: "memory.backend.config_invalid",
      message: "memmy单Principal绑定配置无效",
      retryable: false,
    });
  }
  return parsed.data;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

class MemmyResponseTooLargeError extends Error {
  constructor() {
    super("memmy响应超过Adapter字节上限");
    this.name = "MemmyResponseTooLargeError";
  }
}

/** 外部响应在JSON解析前按字节限流，避免先把无界正文完整读入内存。 */
async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > maxBytes) {
    throw new MemmyResponseTooLargeError();
  }
  if (response.body === null) return JSON.parse("");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MemmyResponseTooLargeError();
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

/**
 * 固定memmy会在落盘前移除协议上下文块、展开current_user_request并规范空白。
 * 显式导入不能静默改变用户确认的事实，因此变化必须在外部写入前失败关闭。
 */
function normalizeMemmyProtocolText(value: string): string {
  let text = value;
  for (const tag of ["memmy_memory_context", "memos_context", "memory_context"]) {
    const closed = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "giu");
    text = text.replace(closed, "");
    const unclosed = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`, "iu");
    text = text.replace(unclosed, "").trimEnd();
  }
  text = text.replace(
    /<current_user_request(?:\s[^>]*)?>([\s\S]*?)<\/current_user_request>/giu,
    "$1",
  );
  return text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function statusError(status: number): MemoryBackendError {
  if (status === 401) {
    return new MemoryBackendError({
      code: "memory.backend.unauthorized",
      message: "memmy鉴权失败",
      retryable: false,
    });
  }
  if (status === 403) {
    return new MemoryBackendError({
      code: "memory.backend.forbidden",
      message: "memmy拒绝访问",
      retryable: false,
    });
  }
  if (status === 429) {
    return new MemoryBackendError({
      code: "memory.backend.rate_limited",
      message: "memmy请求受限",
      retryable: true,
    });
  }
  return new MemoryBackendError({
    code: status >= 500 ? "memory.backend.unavailable" : "memory.backend.request_rejected",
    message: `memmy返回HTTP ${String(status)}`,
    retryable: status >= 500,
  });
}

function latestIso(values: readonly (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => value !== undefined)
    .sort((a, b) => b.localeCompare(a))[0];
}

function detailTurnId(detail: z.infer<typeof memmyGetResponseSchema>): string | undefined {
  const info = detail.metadata["info"];
  if (typeof info !== "object" || info === null || Array.isArray(info)) return undefined;
  const value = (info as Record<string, unknown>)["turn_id"];
  return typeof value === "string" ? value : undefined;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

/**
 * memmy-agent 1.0.4 会按 contextBudget 组装结果，但外部 tokenEstimate 不能
 * 成为 Chat 的唯一预算证据。Adapter 在信任边界重算，防止低报或合同漂移。
 */
function assertWithinBudget(
  response: z.infer<typeof memmySearchResponseSchema>,
  contextBudget: number,
): number {
  const recomputed = response.debug.sections.reduce(
    (total, section) => total + estimateMemorySectionTokens(section),
    0,
  );
  const estimated = Math.max(response.debug.tokenEstimate ?? 0, recomputed);
  if (estimated > contextBudget) {
    throw new MemoryBackendError({
      code: "memory.response.over_budget",
      message: "memmy返回内容超过Chat上下文预算",
      retryable: false,
    });
  }
  return estimated;
}

function legacyWorkflowWriteInput(
  input: WorkflowMemoryWriteInput | WorkflowMemoryWriteReconcileInput,
): MemoryImportInput {
  const sessionKey = "sessionKey" in input ? input.sessionKey : input.productSessionId;
  const turnKey = "turnKey" in input ? input.turnKey : input.sourceMessageId;
  const shape = {
    content: input.content,
    layer: "L2" as const,
    title: "conversation_turn",
    tags: [] as const,
    turnId: turnKey,
  };
  return {
    // 固定requestId就是Chat持久化的mwi_*；对账只能重用该身份，不能生成第二次写入。
    operationId: input.operationId as never,
    requestSha256: computeMemoryImportRequestSha256(shape),
    content: input.content,
    layer: "L2",
    title: shape.title,
    tags: shape.tags,
    source: "chat.explicit_import",
    // 旧Import Port仍带ProductSession品牌；网络协议只需要已冻结的稳定namespace key。
    sessionId: sessionKey as never,
    turnId: turnKey,
  };
}

function wrapWorkflowWriteAccepted(
  requestSha256: string,
  accepted: MemoryImportAccepted,
): WorkflowMemoryWriteAccepted {
  return {
    externalObjectId: accepted.externalObjectId,
    ...(accepted.externalObjectVersion !== undefined
      ? { externalObjectVersion: accepted.externalObjectVersion }
      : {}),
    ...(accepted.externalStatus !== undefined ? { externalStatus: accepted.externalStatus } : {}),
    responseSha256: hashCanonical("memory-write-memmy-accepted.v1", {
      requestSha256,
      providerResponseSha256: accepted.responseSha256,
    }),
  };
}

function workflowQueryErrorCode(code: string): string {
  if (code.startsWith("memory.backend.")) {
    return code.replace(/^memory\.backend/u, "memory.provider");
  }
  if (code.startsWith("memory.response.")) {
    return code.replace(/^memory\.response/u, "memory.provider.response");
  }
  return "memory.provider.unavailable";
}

export class MemmyMemoryAdapter
  implements
    MemoryBackendPort,
    MemoryImportBackendPort,
    WorkflowMemoryQueryProviderPort,
    WorkflowMemoryWriteProviderPort
{
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly namespaceSource: string;
  private readonly profileId: string;
  private readonly expectedPrincipalId: string;
  private readonly authMode: "none" | "bearer";
  private readonly credentialRevision: string;
  private readonly configurationFingerprint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MemmyAdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = normalizeToken(options.token);
    const credentialIdentity = resolveCredentialIdentity(this.token, options.credentialRevision);
    this.authMode = credentialIdentity.authMode;
    this.credentialRevision = credentialIdentity.credentialRevision;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.namespaceSource = normalizeNonSecretConfigValue(options.namespaceSource, "chat");
    this.profileId = normalizeNonSecretConfigValue(options.profileId, "chat-debug");
    this.expectedPrincipalId = normalizeExpectedPrincipalId(options.expectedPrincipalId);
    const configurationRevision = normalizeNonSecretConfigValue(
      options.configurationRevision,
      "memmy-local-v1",
    );
    this.configurationFingerprint = hashCanonical("memmy-adapter-configuration.v2", {
      baseUrl: this.baseUrl,
      namespaceSource: this.namespaceSource,
      profileId: this.profileId,
      expectedPrincipalId: this.expectedPrincipalId,
      configurationRevision,
      authMode: this.authMode,
      credentialRevision: this.credentialRevision,
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe(): MemoryBackendProfile {
    const base = {
      backendId: MEMMY_BACKEND_ID,
      displayName: "memmy 本地记忆",
      kind: "memmy",
      adapterContractVersion: "memmy-http-query.v1",
      configurationFingerprint: this.configurationFingerprint,
      configured: true,
      capabilities: {
        query: true,
        tags: true,
        layers: ["L1", "L2", "L3", "Skill"],
        maxLimit: 20,
        maxContextBudget: 8_192,
      },
    } as const;
    return this.authMode === "none"
      ? { ...base, authMode: "none", credentialRevision: "none" }
      : {
          ...base,
          authMode: "bearer",
          credentialRevision: this.credentialRevision,
        };
  }

  describeImport(): MemoryImportBackendProfile {
    const base = {
      backendId: MEMMY_BACKEND_ID,
      displayName: "memmy 本地记忆",
      kind: "memmy",
      adapterContractVersion: "memmy-http-import.v1",
      configurationFingerprint: this.configurationFingerprint,
      configured: true,
      capabilities: {
        mode: "explicit_fact",
        layers: ["L2"] as ["L2"],
        title: true,
        tags: true,
        maxContentChars: 50_000,
      },
    } as const;
    return {
      descriptor:
        this.authMode === "none"
          ? { ...base, authMode: "none" as const, credentialRevision: "none" as const }
          : {
              ...base,
              authMode: "bearer" as const,
              credentialRevision: this.credentialRevision,
            },
    };
  }

  /**
   * Workflow只冻结Chat通用能力；memmy的层级与namespace都留在Adapter内部。
   * 管理能力尚未接入对应Port，因此固定服务虽有GET路由也不向产品层虚报。
   */
  describeProvider(): MemoryProviderDescriptor {
    return memoryProviderDescriptorSchema.parse({
      schemaVersion: "memory-provider-descriptor.v1",
      providerId: MEMMY_BACKEND_ID,
      displayName: "memmy 本地记忆",
      providerKind: "memmy",
      transport: "http",
      adapterContractVersion: "memmy-http.v2",
      configured: true,
      configurationFingerprint: this.configurationFingerprint,
      capabilities: {
        query: { maxResults: 20, maxContextCharacters: 50_000 },
        write: {
          maxContentCharacters: 50_000,
          // 当前Chat固定写L2；上游同步落盘且文本召回不依赖embedding job。
          materialization: "synchronous",
          idempotency: "provider_key",
        },
        reconcile: true,
        management: { list: false, get: false, update: false, delete: false, history: false },
      },
      authMode: this.authMode,
      credentialRevision: this.credentialRevision,
    });
  }

  /**
   * memmy的真实namespace主键不包含sessionKey，因此每次请求都必须显式携带
   * Chat Principal。旧Port没有principal字段，只能退化为session级userId以避免
   * 跨产品Session串读；新Workflow Port始终传入真正的principalId。
   */
  private namespace(userId: string, sessionKey: string) {
    this.assertExpectedPrincipal(userId);
    return {
      source: this.namespaceSource,
      profileId: this.profileId,
      sessionKey,
      userId,
    } as const;
  }

  private assertExpectedPrincipal(userId: string): void {
    if (userId !== this.expectedPrincipalId) {
      throw new MemoryBackendError({
        code: "memory.backend.principal_not_configured",
        message: "memmy未为该Principal配置专属物理数据库",
        retryable: false,
      });
    }
  }

  private requestHeaders(input: {
    readonly userId: string;
    readonly sessionKey: string;
    readonly json?: boolean;
  }): Record<string, string> {
    return {
      ...(input.json === true ? { "content-type": "application/json" } : {}),
      ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
      // GET没有body namespace；POST也同时传header，确保固定HTTP鉴权层与业务body同源。
      "x-memmy-user-id": input.userId,
      "x-memmy-profile-id": this.profileId,
      "x-memmy-session-key": input.sessionKey,
    };
  }

  private scopedReadUrl(path: string): string {
    const url = new URL(path, `${this.baseUrl}/`);
    url.searchParams.set("source", this.namespaceSource);
    return url.toString();
  }

  async health(): Promise<MemoryBackendHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/health`, {
        method: "GET",
        headers: this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok)
        return { status: "unavailable", errorCode: statusError(response.status).code };
      const health = memmyHealthResponseSchema.parse(await readJsonBounded(response, 256_000));
      if (!health.ok || !health.storage.ready) return { status: "unavailable" };
      if (!health.capabilities.tools.includes("memory.search")) {
        return { status: "unavailable", errorCode: "memory.backend.capability_missing" };
      }
      return { status: "ready" };
    } catch (error) {
      return {
        status: "unavailable",
        errorCode:
          error instanceof MemoryBackendError
            ? error.code
            : isTimeoutError(error)
              ? "memory.backend.timeout"
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? "memory.backend.contract_invalid"
                : "memory.backend.unavailable",
      };
    }
  }

  async query(input: MemoryQueryInput): Promise<MemoryQueryOutput> {
    let request: z.infer<typeof memmySearchRequestSchema>;
    try {
      request = memmySearchRequestSchema.parse({
        requestId: input.operationId,
        adapterId: "chat",
        namespace: {
          ...this.namespace(this.expectedPrincipalId, input.productSessionId),
        },
        query: input.query,
        layers: input.layers,
        tags: input.tags,
        limit: input.limit,
        contextBudget: input.contextBudget,
        includeInjectedContext: true,
        verbose: true,
      });
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.request_invalid",
        message: "memmy查询请求不符合固定合同",
        retryable: false,
      });
    }

    return this.executeSearch(request, input.contextBudget);
  }

  async queryMemory(input: WorkflowMemoryQueryInput): Promise<WorkflowMemoryQueryOutput> {
    const capability = this.describeProvider().capabilities.query;
    if (
      capability === null ||
      input.maxResults > capability.maxResults ||
      input.maxContextCharacters > capability.maxContextCharacters
    ) {
      throw new WorkflowMemoryProviderError({
        code: "memory.provider.capability_unsupported",
        message: "memmy查询超出已声明能力",
        retryable: false,
      });
    }
    try {
      const request = memmySearchRequestSchema.parse({
        requestId: input.operationId,
        adapterId: "chat",
        namespace: this.namespace(input.principalId, input.productSessionId),
        query: input.query,
        // Workflow合同不泄漏memmy层级；当前固定Provider在全部可查询层中召回。
        layers: ["L1", "L2", "L3", "Skill"],
        tags: [],
        limit: input.maxResults,
        contextBudget: 8_192,
        includeInjectedContext: true,
        verbose: true,
      });
      const output = await this.executeSearch(request, 8_192);
      return {
        externalQueryId: output.externalQueryId,
        hitCount: output.hitCount,
        sections: output.sections.map((section) => ({
          externalObjectIds: section.externalObjectIds,
          title: section.title,
          category:
            section.kind === "policy"
              ? "procedure"
              : section.kind === "world_model"
                ? "preference"
                : section.kind === "skill"
                  ? "skill"
                  : "episode",
          content: section.content,
          labels: section.tags,
          ...(section.score !== undefined ? { score: section.score } : {}),
          ...(section.sourceUpdatedAt !== undefined
            ? { sourceUpdatedAt: section.sourceUpdatedAt }
            : {}),
        })),
      };
    } catch (error) {
      if (error instanceof MemoryBackendError) {
        throw new WorkflowMemoryProviderError({
          code: workflowQueryErrorCode(error.code),
          message: error.message,
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }

  private async executeSearch(
    request: z.infer<typeof memmySearchRequestSchema>,
    contextBudget: number,
  ): Promise<MemoryQueryOutput> {
    const parsed = await this.fetchSearch(request);
    const tokenEstimate = assertWithinBudget(parsed, contextBudget);
    const hitById = new Map(parsed.debug.hits.map((hit) => [hit.id, hit]));
    return {
      externalQueryId: parsed.debug.searchEventId,
      hitCount: new Set(parsed.debug.sourceMemoryIds).size,
      tokenEstimate,
      sections: parsed.debug.sections.map((section) => {
        const externalObjectIds = [...new Set(section.memoryIds)];
        const hits = externalObjectIds.flatMap((id) => {
          const hit = hitById.get(id);
          return hit === undefined ? [] : [hit];
        });
        const tags = [...new Set(hits.flatMap((hit) => hit.tags))].sort();
        const scores = hits.map((hit) => hit.score);
        const score = scores.length === 0 ? undefined : Math.max(...scores);
        const sourceUpdatedAt = latestIso(hits.map((hit) => hit.updatedAt));
        return {
          externalObjectIds,
          title: section.title,
          kind: section.kind,
          memoryLayer: section.memoryLayer,
          content: section.content,
          tags,
          ...(score !== undefined ? { score } : {}),
          tokenEstimate: estimateMemorySectionTokens(section),
          ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
        };
      }),
    };
  }

  private async fetchSearch(
    request: z.infer<typeof memmySearchRequestSchema>,
  ): Promise<z.infer<typeof memmySearchResponseSchema>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/memory/search`, {
        method: "POST",
        headers: this.requestHeaders({
          userId: request.namespace.userId,
          sessionKey: request.namespace.sessionKey,
          json: true,
        }),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MemoryBackendError({
        code: isTimeoutError(error) ? "memory.backend.timeout" : "memory.backend.unavailable",
        message: "memmy网络调用失败",
        retryable: true,
      });
    }
    if (!response.ok) throw statusError(response.status);

    try {
      return memmySearchResponseSchema.parse(await readJsonBounded(response, 1_500_000));
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.contract_invalid",
        message: "memmy响应不符合固定合同",
        retryable: false,
      });
    }
  }

  async import(input: MemoryImportInput): Promise<MemoryImportAccepted> {
    // 旧Port没有principal字段；它只能恢复当前单用户部署的冻结Run。
    return this.importForUser(input, this.expectedPrincipalId);
  }

  private async importForUser(
    input: MemoryImportInput,
    userId: string,
  ): Promise<MemoryImportAccepted> {
    if (input.layer !== "L2") {
      throw new MemoryImportBackendError({
        code: "memory.import.layer_unsupported",
        message: "memmy只接受L2显式事实导入",
        phase: "before_external_call",
      });
    }
    if (
      normalizeMemmyProtocolText(input.content) !== input.content ||
      normalizeMemmyProtocolText(input.title) !== input.title
    ) {
      throw new MemoryImportBackendError({
        code: "memory.import.content_requires_normalization",
        message: "Memory导入内容会被memmy改写，请调整后重新导入",
        phase: "before_external_call",
      });
    }
    if (
      computeMemoryImportRequestSha256({
        content: input.content,
        layer: input.layer,
        title: input.title,
        tags: input.tags,
        turnId: input.turnId,
      }) !== input.requestSha256
    ) {
      throw new MemoryImportBackendError({
        code: "memory.import.request_hash_mismatch",
        message: "Memory导入请求Hash不一致",
        phase: "before_external_call",
      });
    }

    let request: z.infer<typeof memmyAddRequestSchema>;
    try {
      request = memmyAddRequestSchema.parse({
        requestId: input.operationId,
        adapterId: "chat",
        namespace: this.namespace(userId, input.sessionId),
        content: input.content,
        layer: input.layer,
        title: input.title,
        tags: input.tags,
        turnId: input.turnId,
        deferProcessing: false,
      });
    } catch {
      throw new MemoryImportBackendError({
        code: "memory.import.request_invalid",
        message: "memmy导入请求不符合固定合同",
        phase: "before_external_call",
      });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/memory/add`, {
        method: "POST",
        headers: this.requestHeaders({ userId, sessionKey: input.sessionId, json: true }),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MemoryImportBackendError({
        code: isTimeoutError(error) ? "memory.import.timeout" : "memory.import.connection_lost",
        message: "memmy导入结果未知",
        phase: "write_outcome_unknown",
      });
    }

    if (!response.ok) {
      const rejected = [400, 401, 403, 404, 409, 422, 429].includes(response.status);
      throw new MemoryImportBackendError({
        code:
          response.status === 409
            ? "memory.import.idempotency_conflict"
            : `memory.import.http_${String(response.status)}`,
        message: "memmy拒绝导入请求",
        phase: rejected ? "rejected_before_write" : "write_outcome_unknown",
      });
    }

    let parsed: z.infer<typeof memmyAddResponseSchema>;
    try {
      parsed = memmyAddResponseSchema.parse(await readJsonBounded(response, 256_000));
    } catch {
      throw new MemoryImportBackendError({
        code: "memory.import.response_invalid",
        message: "memmy可能已写入但响应合同无效",
        phase: "write_outcome_unknown",
      });
    }
    return {
      externalObjectId: parsed.id,
      externalStatus: parsed.status,
      responseSha256: hashCanonical("memmy-memory-add-response.v1", parsed),
    };
  }

  async writeMemory(input: WorkflowMemoryWriteInput): Promise<WorkflowMemoryWriteAccepted> {
    try {
      this.assertExpectedPrincipal(input.principalId);
    } catch {
      throw new WorkflowMemoryWriteProviderError({
        code: "memory.write.principal_not_configured",
        message: "memmy未为该Principal配置专属物理数据库",
        phase: "before_external_call",
      });
    }
    try {
      const accepted = await this.importForUser(legacyWorkflowWriteInput(input), input.principalId);
      return wrapWorkflowWriteAccepted(input.requestSha256, accepted);
    } catch (error) {
      if (error instanceof MemoryImportBackendError) {
        throw new WorkflowMemoryWriteProviderError({
          code: error.code.replace(/^memory\.import/u, "memory.write"),
          message: error.message,
          phase: error.phase,
        });
      }
      throw error;
    }
  }

  async reconcile(input: MemoryImportReconcileInput): Promise<MemoryImportReconcileOutput> {
    // 旧Port缺少principal，只能使用当前部署绑定；整个对账实现只允许只读调用。
    return this.reconcileForUser(input, this.expectedPrincipalId);
  }

  private async readMemoryDetail(
    externalObjectId: string,
    userId: string,
    sessionKey: string,
  ): Promise<z.infer<typeof memmyGetResponseSchema>> {
    const response = await this.fetchImpl(
      this.scopedReadUrl(`/api/v1/memory/${encodeURIComponent(externalObjectId)}`),
      {
        method: "GET",
        headers: this.requestHeaders({ userId, sessionKey }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) throw statusError(response.status);
    try {
      return memmyGetResponseSchema.parse(await readJsonBounded(response, 1_000_000));
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.contract_invalid",
        message: "memmy详情响应不符合固定合同",
        retryable: false,
      });
    }
  }

  /**
   * 固定memmy没有公开的requestId精确读取路由；panel/items的q会读取内部
   * memory_key（其中包含稳定operationId），这里只把它当候选定位，再以详情严格证明。
   * 该GET仅允许用于绑定单Principal且使用Chat专属物理数据库的Adapter实例。
   */
  private async locateWriteCandidates(
    input: MemoryImportReconcileInput,
    userId: string,
  ): Promise<readonly string[]> {
    this.assertExpectedPrincipal(userId);
    const url = new URL(this.scopedReadUrl("/api/v1/panel/items"));
    url.searchParams.set("q", input.operationId);
    url.searchParams.set("layer", "L2");
    url.searchParams.set("page", "1");
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.requestHeaders({ userId, sessionKey: input.sessionId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw statusError(response.status);
    let parsed: z.infer<typeof memmyPanelItemsResponseSchema>;
    try {
      parsed = memmyPanelItemsResponseSchema.parse(await readJsonBounded(response, 1_000_000));
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.contract_invalid",
        message: "memmy候选定位响应不符合固定合同",
        retryable: false,
      });
    }
    if (parsed.hasNext || parsed.total > parsed.items.length) {
      throw new MemoryBackendError({
        code: "memory.backend.reconcile_ambiguous",
        message: "memmy写入候选超过单页安全上限",
        retryable: false,
      });
    }
    return [...new Set(parsed.items.map((item) => item.id))];
  }

  private detailMatchesWrite(
    detail: z.infer<typeof memmyGetResponseSchema>,
    input: MemoryImportReconcileInput,
  ): boolean {
    return (
      detail.body === input.content &&
      detail.title === input.title &&
      detail.memoryLayer === "L2" &&
      detailTurnId(detail) === input.turnId &&
      sameStringSet(detail.tags, ["manual", ...input.tags])
    );
  }

  private acceptedFromVerifiedDetail(
    detail: z.infer<typeof memmyGetResponseSchema>,
    input: MemoryImportReconcileInput,
  ): MemoryImportAccepted {
    return {
      externalObjectId: detail.id,
      externalObjectVersion: String(detail.version),
      externalStatus: detail.status,
      responseSha256: hashCanonical("memmy-memory-reconciled-object.v2", {
        externalObjectId: detail.id,
        version: detail.version,
        etag: detail.etag,
        requestSha256: input.requestSha256,
      }),
    };
  }

  private async reconcileForUser(
    input: MemoryImportReconcileInput,
    userId: string,
  ): Promise<MemoryImportReconcileOutput> {
    try {
      this.assertExpectedPrincipal(userId);
    } catch {
      return {
        status: "failed",
        errorCode: "memory.import.principal_not_configured",
        summary: "memmy未为该Principal配置专属物理数据库",
      };
    }
    let detail: z.infer<typeof memmyGetResponseSchema> | undefined;

    if (input.externalObjectId === undefined) {
      try {
        const candidateIds = await this.locateWriteCandidates(input, userId);
        let matchingCandidates = 0;
        for (const candidateId of candidateIds) {
          const candidate = await this.readMemoryDetail(candidateId, userId, input.sessionId);
          // 相似搜索可能返回无关对象；只有稳定turnId相同才具有写入身份意义。
          if (detailTurnId(candidate) !== input.turnId) continue;
          matchingCandidates += 1;
          if (!this.detailMatchesWrite(candidate, input)) {
            return {
              status: "failed",
              errorCode: "memory.import.verification_mismatch",
              summary: "memmy对象与冻结导入请求不一致",
            };
          }
          detail = candidate;
        }
        if (matchingCandidates > 1) {
          return {
            status: "failed",
            errorCode: "memory.import.verification_ambiguous",
            summary: "memmy存在多个匹配冻结写入的对象",
          };
        }
      } catch {
        return { status: "outcome_unknown", errorCode: "memory.import.verify_unavailable" };
      }
      if (detail === undefined) {
        return { status: "outcome_unknown", errorCode: "memory.import.object_not_found" };
      }
    } else {
      try {
        detail = await this.readMemoryDetail(input.externalObjectId, userId, input.sessionId);
      } catch {
        return { status: "outcome_unknown", errorCode: "memory.import.verify_unavailable" };
      }
      if (detail.id !== input.externalObjectId || !this.detailMatchesWrite(detail, input)) {
        return {
          status: "failed",
          errorCode: "memory.import.verification_mismatch",
          summary: "memmy对象与冻结导入请求不一致",
        };
      }
    }

    const accepted = this.acceptedFromVerifiedDetail(detail, input);
    // Chat固定写入L2；上游对该层同步落盘，GET严格匹配且activated即已具备文本召回。
    if (detail.status !== "activated") return { status: "accepted", accepted };
    return {
      status: "materialized",
      accepted,
      verificationKind: "read_by_id",
      verificationSha256: hashCanonical("memmy-memory-import-verification.v2", {
        externalObjectId: detail.id,
        version: detail.version,
        etag: detail.etag,
        requestSha256: input.requestSha256,
      }),
    };
  }

  async reconcileMemoryWrite(
    input: WorkflowMemoryWriteReconcileInput,
  ): Promise<WorkflowMemoryWriteReconcileOutput> {
    const result = await this.reconcileForUser(
      {
        ...legacyWorkflowWriteInput(input),
        ...(input.externalObjectId !== undefined
          ? { externalObjectId: input.externalObjectId }
          : {}),
      },
      input.principalId,
    );
    if (result.status === "outcome_unknown") {
      return {
        status: "outcome_unknown",
        errorCode: result.errorCode.replace(/^memory\.import/u, "memory.write"),
      };
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        errorCode: result.errorCode.replace(/^memory\.import/u, "memory.write"),
        summary: result.summary,
      };
    }
    const accepted = wrapWorkflowWriteAccepted(input.requestSha256, result.accepted);
    return result.status === "accepted"
      ? { status: "accepted", accepted }
      : {
          status: "materialized",
          accepted,
          verificationKind: result.verificationKind,
          verificationSha256: hashCanonical("memory-write-memmy-verification.v1", {
            requestSha256: input.requestSha256,
            providerVerificationSha256: result.verificationSha256,
          }),
        };
  }
}
