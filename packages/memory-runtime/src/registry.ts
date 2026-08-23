import type {
  MemoryBackendPort,
  MemoryBackendRegistryPort,
  MemoryImportBackendPort,
  MemoryImportBackendRegistryPort,
  WorkflowMemoryQueryProviderPort,
  WorkflowMemoryWriteProviderPort,
  WorkflowMemoryProviderRegistryPort,
} from "@chat/application";
import type { MemoryBackendId, MemoryProviderDescriptor } from "@chat/contracts";
import { computeMemoryProviderDescriptorSha256 } from "@chat/domain";
import { z } from "zod";
import {
  MEMMY_DEFAULT_BASE_URL,
  MemmyMemoryAdapter,
  type MemmyAdapterOptions,
} from "./memmy-adapter.js";
import {
  TENCENT_MEMORYCORE_DEFAULT_BASE_URL,
  TencentMemoryCoreAdapter,
  type TencentMemoryCoreAdapterOptions,
} from "./tencent-memorycore-adapter.js";

type RegisteredMemoryBackend = MemoryBackendPort & MemoryImportBackendPort;
type RegisteredMemoryProvider = RegisteredMemoryBackend &
  WorkflowMemoryQueryProviderPort &
  WorkflowMemoryWriteProviderPort;

export class MemoryBackendRegistry
  implements MemoryBackendRegistryPort, MemoryImportBackendRegistryPort
{
  private readonly byId: ReadonlyMap<MemoryBackendId, RegisteredMemoryBackend>;

  constructor(backends: readonly RegisteredMemoryBackend[]) {
    const byId = new Map<MemoryBackendId, RegisteredMemoryBackend>();
    for (const backend of backends) {
      const id = backend.describe().backendId;
      if (byId.has(id)) throw new Error(`重复Memory backendId:${id}`);
      byId.set(id, backend);
    }
    this.byId = byId;
  }

  list(): readonly RegisteredMemoryBackend[] {
    return [...this.byId.values()];
  }

  get(backendId: MemoryBackendId): RegisteredMemoryBackend | undefined {
    return this.byId.get(backendId);
  }
}

/** Workflow仍需要一个Registry Port；关闭时用真正的空Registry，不实例化Adapter。 */
export function createEmptyMemoryBackendRegistry(): MemoryBackendRegistry {
  return new MemoryBackendRegistry([]);
}

type WorkflowMemoryProvider = WorkflowMemoryQueryProviderPort | WorkflowMemoryWriteProviderPort;

/**
 * 新Registry按能力注册，不要求每个Provider同时实现query/write。相同providerId若由
 * 两个对象提供能力，它们的安全描述必须逐字节同源，否则API与Workflow会冻结不同合同。
 */
export class WorkflowMemoryProviderRegistry implements WorkflowMemoryProviderRegistryPort {
  readonly #descriptors: ReadonlyMap<string, MemoryProviderDescriptor>;
  readonly #queries: ReadonlyMap<string, WorkflowMemoryQueryProviderPort>;
  readonly #writes: ReadonlyMap<string, WorkflowMemoryWriteProviderPort>;

  constructor(input: {
    readonly queries?: readonly WorkflowMemoryQueryProviderPort[];
    readonly writes?: readonly WorkflowMemoryWriteProviderPort[];
  }) {
    const descriptors = new Map<string, MemoryProviderDescriptor>();
    const queries = new Map<string, WorkflowMemoryQueryProviderPort>();
    const writes = new Map<string, WorkflowMemoryWriteProviderPort>();
    const register = (provider: WorkflowMemoryProvider) => {
      const descriptor = provider.describeProvider();
      const existing = descriptors.get(descriptor.providerId);
      if (
        existing !== undefined &&
        computeMemoryProviderDescriptorSha256(existing) !==
          computeMemoryProviderDescriptorSha256(descriptor)
      ) {
        throw new Error(`Workflow Memory Provider描述冲突:${descriptor.providerId}`);
      }
      descriptors.set(descriptor.providerId, descriptor);
      return descriptor.providerId;
    };
    for (const provider of input.queries ?? []) {
      const providerId = register(provider);
      if (queries.has(providerId)) throw new Error(`重复query Provider:${providerId}`);
      queries.set(providerId, provider);
    }
    for (const provider of input.writes ?? []) {
      const providerId = register(provider);
      if (writes.has(providerId)) throw new Error(`重复write Provider:${providerId}`);
      writes.set(providerId, provider);
    }
    this.#descriptors = descriptors;
    this.#queries = queries;
    this.#writes = writes;
  }

  list(): readonly MemoryProviderDescriptor[] {
    return [...this.#descriptors.values()].sort((left, right) =>
      left.providerId.localeCompare(right.providerId),
    );
  }

  getQuery(providerId: string): WorkflowMemoryQueryProviderPort | undefined {
    return this.#queries.get(providerId);
  }

  getWrite(providerId: string): WorkflowMemoryWriteProviderPort | undefined {
    return this.#writes.get(providerId);
  }
}

export function createEmptyWorkflowMemoryProviderRegistry(): WorkflowMemoryProviderRegistry {
  return new WorkflowMemoryProviderRegistry({});
}

export const memoryRuntimeModeSchema = z.enum(["off", "memorycore", "memmy", "compare"]);
export type MemoryRuntimeMode = z.infer<typeof memoryRuntimeModeSchema>;

/** 缺省安全关闭；显式空值和未知值不能静默回退，避免两个组合根装配出不同Provider集。 */
export function parseMemoryMode(env: NodeJS.ProcessEnv): MemoryRuntimeMode {
  if (env.CHAT_MEMORY_MODE === undefined) return "off";
  const parsed = memoryRuntimeModeSchema.safeParse(env.CHAT_MEMORY_MODE.trim());
  if (!parsed.success) {
    throw new Error("CHAT_MEMORY_MODE必须是off、memorycore、memmy或compare");
  }
  return parsed.data;
}

export interface MemoryRegistrySet {
  /** 遗留query Port与import Port共享同一个Registry和同一批Adapter实例。 */
  readonly memoryBackends: MemoryBackendRegistry;
  readonly memoryImportBackends: MemoryBackendRegistry;
  /** 新Workflow query/write Port仍指向上面同一批Adapter实例。 */
  readonly workflowMemoryProviders: WorkflowMemoryProviderRegistry;
}

interface MemoryAdapterOverrides {
  readonly memmy?: Partial<MemmyAdapterOptions>;
  readonly tencentMemoryCore?: Partial<TencentMemoryCoreAdapterOptions>;
}

function createMemmyAdapter(
  env: NodeJS.ProcessEnv,
  options: Partial<MemmyAdapterOptions> | undefined,
): MemmyMemoryAdapter {
  return new MemmyMemoryAdapter({
    baseUrl: options?.baseUrl ?? env.CHAT_MEMMY_BASE_URL ?? MEMMY_DEFAULT_BASE_URL,
    ...(options?.token !== undefined
      ? { token: options.token }
      : env.CHAT_MEMMY_TOKEN !== undefined
        ? { token: env.CHAT_MEMMY_TOKEN }
        : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.namespaceSource !== undefined ? { namespaceSource: options.namespaceSource } : {}),
    ...(options?.profileId !== undefined ? { profileId: options.profileId } : {}),
    ...(options?.expectedPrincipalId !== undefined
      ? { expectedPrincipalId: options.expectedPrincipalId }
      : env.CHAT_MEMMY_PRINCIPAL_ID !== undefined
        ? { expectedPrincipalId: env.CHAT_MEMMY_PRINCIPAL_ID }
        : {}),
    ...(options?.configurationRevision !== undefined
      ? { configurationRevision: options.configurationRevision }
      : env.CHAT_MEMMY_CONFIG_REVISION !== undefined
        ? { configurationRevision: env.CHAT_MEMMY_CONFIG_REVISION }
        : {}),
    ...(options?.credentialRevision !== undefined
      ? { credentialRevision: options.credentialRevision }
      : env.CHAT_MEMMY_CREDENTIAL_REVISION !== undefined
        ? { credentialRevision: env.CHAT_MEMMY_CREDENTIAL_REVISION }
        : {}),
    ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}

function createTencentMemoryCoreAdapter(
  env: NodeJS.ProcessEnv,
  options: Partial<TencentMemoryCoreAdapterOptions> | undefined,
): TencentMemoryCoreAdapter {
  return new TencentMemoryCoreAdapter({
    baseUrl:
      options?.baseUrl ??
      env.CHAT_TENCENT_MEMORYCORE_BASE_URL ??
      TENCENT_MEMORYCORE_DEFAULT_BASE_URL,
    ...(options?.token !== undefined
      ? { token: options.token }
      : env.CHAT_TENCENT_MEMORYCORE_TOKEN !== undefined
        ? { token: env.CHAT_TENCENT_MEMORYCORE_TOKEN }
        : {}),
    ...(options?.serviceId !== undefined
      ? { serviceId: options.serviceId }
      : env.CHAT_TENCENT_MEMORYCORE_SERVICE_ID !== undefined
        ? { serviceId: env.CHAT_TENCENT_MEMORYCORE_SERVICE_ID }
        : {}),
    ...(options?.teamId !== undefined
      ? { teamId: options.teamId }
      : env.CHAT_TENCENT_MEMORYCORE_TEAM_ID !== undefined
        ? { teamId: env.CHAT_TENCENT_MEMORYCORE_TEAM_ID }
        : {}),
    ...(options?.userId !== undefined
      ? { userId: options.userId }
      : env.CHAT_TENCENT_MEMORYCORE_USER_ID !== undefined
        ? { userId: env.CHAT_TENCENT_MEMORYCORE_USER_ID }
        : {}),
    ...(options?.agentId !== undefined
      ? { agentId: options.agentId }
      : env.CHAT_TENCENT_MEMORYCORE_AGENT_ID !== undefined
        ? { agentId: env.CHAT_TENCENT_MEMORYCORE_AGENT_ID }
        : {}),
    ...(options?.configurationRevision !== undefined
      ? { configurationRevision: options.configurationRevision }
      : env.CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION !== undefined
        ? { configurationRevision: env.CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION }
        : {}),
    ...(options?.credentialRevision !== undefined
      ? { credentialRevision: options.credentialRevision }
      : env.CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION !== undefined
        ? { credentialRevision: env.CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION }
        : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}

function createSelectedMemoryAdapters(
  env: NodeJS.ProcessEnv,
  mode: Exclude<MemoryRuntimeMode, "off">,
  overrides: MemoryAdapterOverrides,
): readonly RegisteredMemoryProvider[] {
  const adapters: RegisteredMemoryProvider[] = [];
  if (mode === "memmy" || mode === "compare") {
    adapters.push(createMemmyAdapter(env, overrides.memmy));
  }
  if (mode === "memorycore" || mode === "compare") {
    adapters.push(createTencentMemoryCoreAdapter(env, overrides.tencentMemoryCore));
  }
  return adapters;
}

/**
 * 一个进程只建立一套Memory Adapter实例，再把它们投影到遗留query/import和新
 * Workflow query/write Port。调用方必须先解析mode并显式传入，避免组合根二次解析。
 * `off`在读取任何Provider配置前返回，因此坏的遗留endpoint/凭据不会牵绊基础启动。
 */
export function createMemoryRegistrySet(
  env: NodeJS.ProcessEnv,
  options: MemoryAdapterOverrides & { readonly mode: MemoryRuntimeMode },
): MemoryRegistrySet {
  if (options.mode === "off") {
    const memoryBackends = createEmptyMemoryBackendRegistry();
    return {
      memoryBackends,
      memoryImportBackends: memoryBackends,
      workflowMemoryProviders: createEmptyWorkflowMemoryProviderRegistry(),
    };
  }

  const adapters = createSelectedMemoryAdapters(env, options.mode, options);
  const memoryBackends = new MemoryBackendRegistry(adapters);
  return {
    memoryBackends,
    memoryImportBackends: memoryBackends,
    workflowMemoryProviders: new WorkflowMemoryProviderRegistry({
      queries: adapters,
      writes: adapters,
    }),
  };
}

export function createMemoryBackendRegistry(
  env: NodeJS.ProcessEnv,
  overrides: MemoryAdapterOverrides & { readonly mode?: MemoryRuntimeMode } = {},
): MemoryBackendRegistry {
  const mode =
    overrides.mode === undefined
      ? parseMemoryMode(env)
      : memoryRuntimeModeSchema.parse(overrides.mode);
  return createMemoryRegistrySet(env, { ...overrides, mode }).memoryBackends;
}

export function createWorkflowMemoryProviderRegistry(
  env: NodeJS.ProcessEnv,
  overrides: {
    readonly mode?: MemoryRuntimeMode;
    readonly memmy?: Partial<MemmyAdapterOptions>;
    readonly tencentMemoryCore?: Partial<TencentMemoryCoreAdapterOptions>;
  } = {},
): WorkflowMemoryProviderRegistry {
  const mode =
    overrides.mode === undefined
      ? parseMemoryMode(env)
      : memoryRuntimeModeSchema.parse(overrides.mode);
  return createMemoryRegistrySet(env, { ...overrides, mode }).workflowMemoryProviders;
}
