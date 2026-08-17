import type {
  MemoryBackendPort,
  MemoryBackendRegistryPort,
  MemoryImportBackendPort,
  MemoryImportBackendRegistryPort,
} from "@chat/application";
import type { MemoryBackendId } from "@chat/contracts";
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
