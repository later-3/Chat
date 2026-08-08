import {
  MemoryBackendError,
  MemoryImportBackendError,
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
} from "@chat/application";
import {
  memoryBackendIdSchema,
  memoryCredentialRevisionSchema,
  type MemoryBackendId,
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
    requestId: z.string().min(1).max(200),
    adapterId: z.literal("chat"),
    namespace: z
      .object({
        source: z.string().trim().min(1).max(200),
        profileId: z.string().trim().min(1).max(200),
        sessionKey: z.string().min(1).max(200),
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

export interface MemmyAdapterOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly namespaceSource?: string;
  readonly profileId?: string;
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

export class MemmyMemoryAdapter implements MemoryBackendPort, MemoryImportBackendPort {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly namespaceSource: string;
  private readonly profileId: string;
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
    const configurationRevision = normalizeNonSecretConfigValue(
      options.configurationRevision,
      "memmy-local-v1",
    );
    this.configurationFingerprint = hashCanonical("memmy-adapter-configuration.v2", {
      baseUrl: this.baseUrl,
      namespaceSource: this.namespaceSource,
      profileId: this.profileId,
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
          source: this.namespaceSource,
          profileId: this.profileId,
          sessionKey: input.productSessionId,
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

  private async executeSearch(
    request: z.infer<typeof memmySearchRequestSchema>,
    contextBudget: number,
  ): Promise<MemoryQueryOutput> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/memory/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        },
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

    let parsed: z.infer<typeof memmySearchResponseSchema>;
    try {
      parsed = memmySearchResponseSchema.parse(await readJsonBounded(response, 1_500_000));
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.contract_invalid",
        message: "memmy响应不符合固定合同",
        retryable: false,
      });
    }
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

  async import(input: MemoryImportInput): Promise<MemoryImportAccepted> {
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
        namespace: {
          source: this.namespaceSource,
          profileId: this.profileId,
          sessionKey: input.sessionId,
        },
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
        headers: {
          "content-type": "application/json",
          ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        },
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

  async reconcile(input: MemoryImportReconcileInput): Promise<MemoryImportReconcileOutput> {
    let accepted: MemoryImportAccepted;
    if (input.externalObjectId === undefined) {
      try {
        // 固定memmy以adapterId + requestId +正文指纹返回原结果；这是一次有界对账，
        // 不是更换身份后的第二次写入。
        accepted = await this.import(input);
      } catch (error) {
        if (error instanceof MemoryImportBackendError) {
          return error.phase === "rejected_before_write"
            ? { status: "failed", errorCode: error.code, summary: "memmy拒绝幂等对账" }
            : { status: "outcome_unknown", errorCode: error.code };
        }
        return { status: "outcome_unknown", errorCode: "memory.import.reconcile_failed" };
      }
    } else {
      accepted = {
        externalObjectId: input.externalObjectId,
        responseSha256: hashCanonical("memmy-memory-known-object.v1", {
          externalObjectId: input.externalObjectId,
          requestSha256: input.requestSha256,
        }),
      };
    }

    let detail: z.infer<typeof memmyGetResponseSchema>;
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/memory/${encodeURIComponent(accepted.externalObjectId)}`,
        {
          method: "GET",
          headers: this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) {
        return {
          status: "outcome_unknown",
          errorCode: `memory.import.verify_http_${String(response.status)}`,
        };
      }
      detail = memmyGetResponseSchema.parse(await readJsonBounded(response, 1_000_000));
    } catch {
      return { status: "outcome_unknown", errorCode: "memory.import.verify_unavailable" };
    }

    if (
      detail.id !== accepted.externalObjectId ||
      detail.body !== input.content ||
      detail.title !== input.title ||
      detail.memoryLayer !== "L2" ||
      JSON.stringify([...detail.tags].sort()) !==
        JSON.stringify([...new Set(["manual", ...input.tags])].sort())
    ) {
      return {
        status: "failed",
        errorCode: "memory.import.verification_mismatch",
        summary: "memmy对象与冻结导入请求不一致",
      };
    }

    let search: MemoryQueryOutput;
    try {
      const request = memmySearchRequestSchema.parse({
        requestId: `${input.operationId}-verify`,
        adapterId: "chat",
        namespace: {
          source: this.namespaceSource,
          profileId: this.profileId,
          sessionKey: input.sessionId,
        },
        query: input.content,
        tags: input.tags,
        layers: ["L2"],
        limit: 20,
        contextBudget: 8_192,
        includeInjectedContext: true,
        verbose: true,
      });
      search = await this.executeSearch(request, 8_192);
    } catch {
      return {
        status: "accepted",
        accepted: {
          ...accepted,
          externalObjectVersion: String(detail.version),
          externalStatus: detail.status,
        },
      };
    }
    if (!search.sections.some((section) => section.externalObjectIds.includes(detail.id))) {
      return {
        status: "accepted",
        accepted: {
          ...accepted,
          externalObjectVersion: String(detail.version),
          externalStatus: detail.status,
        },
      };
    }
    const verified = {
      ...accepted,
      externalObjectVersion: String(detail.version),
      externalStatus: detail.status,
    };
    return {
      status: "materialized",
      accepted: verified,
      verificationKind: "read_by_id_and_search",
      verificationSha256: hashCanonical("memmy-memory-import-verification.v1", {
        externalObjectId: detail.id,
        version: detail.version,
        etag: detail.etag,
        requestSha256: input.requestSha256,
        externalQueryId: search.externalQueryId,
      }),
    };
  }
}
