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

export function createMemoryBackendRegistry(
  env: NodeJS.ProcessEnv,
  overrides: {
    readonly memmy?: Partial<MemmyAdapterOptions>;
    readonly tencentMemoryCore?: Partial<TencentMemoryCoreAdapterOptions>;
  } = {},
): MemoryBackendRegistry {
  const memmy = new MemmyMemoryAdapter({
    baseUrl: overrides.memmy?.baseUrl ?? env.CHAT_MEMMY_BASE_URL ?? MEMMY_DEFAULT_BASE_URL,
    ...(overrides.memmy?.token !== undefined
      ? { token: overrides.memmy.token }
      : env.CHAT_MEMMY_TOKEN !== undefined
        ? { token: env.CHAT_MEMMY_TOKEN }
        : {}),
    ...(overrides.memmy?.timeoutMs !== undefined ? { timeoutMs: overrides.memmy.timeoutMs } : {}),
    ...(overrides.memmy?.namespaceSource !== undefined
      ? { namespaceSource: overrides.memmy.namespaceSource }
      : {}),
    ...(overrides.memmy?.profileId !== undefined ? { profileId: overrides.memmy.profileId } : {}),
    ...(overrides.memmy?.configurationRevision !== undefined
      ? { configurationRevision: overrides.memmy.configurationRevision }
      : env.CHAT_MEMMY_CONFIG_REVISION !== undefined
        ? { configurationRevision: env.CHAT_MEMMY_CONFIG_REVISION }
        : {}),
    ...(overrides.memmy?.credentialRevision !== undefined
      ? { credentialRevision: overrides.memmy.credentialRevision }
      : env.CHAT_MEMMY_CREDENTIAL_REVISION !== undefined
        ? { credentialRevision: env.CHAT_MEMMY_CREDENTIAL_REVISION }
        : {}),
    ...(overrides.memmy?.fetchImpl !== undefined ? { fetchImpl: overrides.memmy.fetchImpl } : {}),
  });
  const tencent = new TencentMemoryCoreAdapter({
    baseUrl:
      overrides.tencentMemoryCore?.baseUrl ??
      env.CHAT_TENCENT_MEMORYCORE_BASE_URL ??
      TENCENT_MEMORYCORE_DEFAULT_BASE_URL,
    ...(overrides.tencentMemoryCore?.token !== undefined
      ? { token: overrides.tencentMemoryCore.token }
      : env.CHAT_TENCENT_MEMORYCORE_TOKEN !== undefined
        ? { token: env.CHAT_TENCENT_MEMORYCORE_TOKEN }
        : {}),
    ...(overrides.tencentMemoryCore?.serviceId !== undefined
      ? { serviceId: overrides.tencentMemoryCore.serviceId }
      : env.CHAT_TENCENT_MEMORYCORE_SERVICE_ID !== undefined
        ? { serviceId: env.CHAT_TENCENT_MEMORYCORE_SERVICE_ID }
        : {}),
    ...(overrides.tencentMemoryCore?.teamId !== undefined
      ? { teamId: overrides.tencentMemoryCore.teamId }
      : env.CHAT_TENCENT_MEMORYCORE_TEAM_ID !== undefined
        ? { teamId: env.CHAT_TENCENT_MEMORYCORE_TEAM_ID }
        : {}),
    ...(overrides.tencentMemoryCore?.userId !== undefined
      ? { userId: overrides.tencentMemoryCore.userId }
      : env.CHAT_TENCENT_MEMORYCORE_USER_ID !== undefined
        ? { userId: env.CHAT_TENCENT_MEMORYCORE_USER_ID }
        : {}),
    ...(overrides.tencentMemoryCore?.agentId !== undefined
      ? { agentId: overrides.tencentMemoryCore.agentId }
      : env.CHAT_TENCENT_MEMORYCORE_AGENT_ID !== undefined
        ? { agentId: env.CHAT_TENCENT_MEMORYCORE_AGENT_ID }
        : {}),
    ...(overrides.tencentMemoryCore?.configurationRevision !== undefined
      ? { configurationRevision: overrides.tencentMemoryCore.configurationRevision }
      : env.CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION !== undefined
        ? { configurationRevision: env.CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION }
        : {}),
    ...(overrides.tencentMemoryCore?.credentialRevision !== undefined
      ? { credentialRevision: overrides.tencentMemoryCore.credentialRevision }
      : env.CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION !== undefined
        ? { credentialRevision: env.CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION }
        : {}),
    ...(overrides.tencentMemoryCore?.timeoutMs !== undefined
      ? { timeoutMs: overrides.tencentMemoryCore.timeoutMs }
      : {}),
    ...(overrides.tencentMemoryCore?.fetchImpl !== undefined
      ? { fetchImpl: overrides.tencentMemoryCore.fetchImpl }
      : {}),
  });
  return new MemoryBackendRegistry([memmy, tencent]);
}

/** 新架构首期只装配Tencent；旧memmy Adapter不再进入活动Registry。 */
export function createWorkflowMemoryProviderRegistry(
  env: NodeJS.ProcessEnv,
  overrides: { readonly tencentMemoryCore?: Partial<TencentMemoryCoreAdapterOptions> } = {},
): WorkflowMemoryProviderRegistry {
  const options = overrides.tencentMemoryCore;
  const tencent = new TencentMemoryCoreAdapter({
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
  return new WorkflowMemoryProviderRegistry({ queries: [tencent], writes: [tencent] });
}
