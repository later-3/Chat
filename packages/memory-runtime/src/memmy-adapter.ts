import {
  MemoryBackendError,
  type MemoryBackendHealth,
  type MemoryBackendPort,
  type MemoryBackendProfile,
  type MemoryQueryInput,
  type MemoryQueryOutput,
} from "@chat/application";
import {
  memoryBackendIdSchema,
  memoryCredentialRevisionSchema,
  type MemoryBackendId,
} from "@chat/contracts";
import { estimateMemorySectionTokens, hashCanonical } from "@chat/domain";
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

export class MemmyMemoryAdapter implements MemoryBackendPort {
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

  async health(): Promise<MemoryBackendHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/health`, {
        method: "GET",
        headers: this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok)
        return { status: "unavailable", errorCode: statusError(response.status).code };
      const health = memmyHealthResponseSchema.parse(await response.json());
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
      parsed = memmySearchResponseSchema.parse(await response.json());
    } catch {
      throw new MemoryBackendError({
        code: "memory.backend.contract_invalid",
        message: "memmy响应不符合固定合同",
        retryable: false,
      });
    }
    const tokenEstimate = assertWithinBudget(parsed, input.contextBudget);

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
}
