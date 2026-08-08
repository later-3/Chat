import type { MemoryBackendPort, MemoryBackendRegistryPort } from "@chat/application";
import type { MemoryBackendId } from "@chat/contracts";
import {
  MEMMY_DEFAULT_BASE_URL,
  MemmyMemoryAdapter,
  type MemmyAdapterOptions,
} from "./memmy-adapter.js";

export class MemoryBackendRegistry implements MemoryBackendRegistryPort {
  private readonly byId: ReadonlyMap<MemoryBackendId, MemoryBackendPort>;

  constructor(backends: readonly MemoryBackendPort[]) {
    const byId = new Map<MemoryBackendId, MemoryBackendPort>();
    for (const backend of backends) {
      const id = backend.describe().backendId;
      if (byId.has(id)) throw new Error(`重复Memory backendId:${id}`);
      byId.set(id, backend);
    }
    this.byId = byId;
  }

  list(): readonly MemoryBackendPort[] {
    return [...this.byId.values()];
  }

  get(backendId: MemoryBackendId): MemoryBackendPort | undefined {
    return this.byId.get(backendId);
  }
}

export function createMemoryBackendRegistry(
  env: NodeJS.ProcessEnv,
  overrides: { readonly memmy?: Partial<MemmyAdapterOptions> } = {},
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
  return new MemoryBackendRegistry([memmy]);
}
