import type {
  WorkflowMemoryProviderRegistryPort,
  WorkflowMemoryQueryInput,
  WorkflowMemoryQueryOutput,
  WorkflowMemoryQueryProviderPort,
  WorkflowMemoryWriteAccepted,
  WorkflowMemoryWriteInput,
  WorkflowMemoryWriteReconcileInput,
  WorkflowMemoryWriteReconcileOutput,
  WorkflowMemoryWriteProviderPort,
} from "@chat/application";
import { memoryProviderDescriptorSchema, type MemoryProviderDescriptor } from "@chat/contracts";

export const TEST_WORKFLOW_MEMORY_PROVIDER_DESCRIPTOR: MemoryProviderDescriptor =
  memoryProviderDescriptorSchema.parse({
    schemaVersion: "memory-provider-descriptor.v1",
    providerId: "mbk_tencentmemorycore",
    displayName: "Tencent MemoryCore 确定性测试Provider",
    providerKind: "tencent_memorycore_test",
    transport: "http",
    adapterContractVersion: "workflow-memory-test.v1",
    configured: true,
    authMode: "none",
    credentialRevision: "none",
    configurationFingerprint: "f".repeat(64),
    capabilities: {
      query: { maxResults: 20, maxContextCharacters: 32_000 },
      write: {
        maxContentCharacters: 50_000,
        materialization: "accepted_only",
        idempotency: "chat_reconcile",
      },
      reconcile: true,
      management: { list: false, get: false, update: false, delete: false, history: false },
    },
  });

/** API与Workflow测试进程共用同一公开描述，避免夹具绕过冻结Provider合同。 */
export function createDeterministicWorkflowMemoryRegistry(
  queryMemory: (input: WorkflowMemoryQueryInput) => Promise<WorkflowMemoryQueryOutput>,
  write?: {
    readonly writeMemory?: (
      input: WorkflowMemoryWriteInput,
    ) => Promise<WorkflowMemoryWriteAccepted>;
    readonly reconcileMemoryWrite?: (
      input: WorkflowMemoryWriteReconcileInput,
    ) => Promise<WorkflowMemoryWriteReconcileOutput>;
  },
): WorkflowMemoryProviderRegistryPort {
  const queryProvider: WorkflowMemoryQueryProviderPort = {
    describeProvider: () => TEST_WORKFLOW_MEMORY_PROVIDER_DESCRIPTOR,
    health: async () => ({ status: "ready" }),
    queryMemory,
  };
  const writeProvider: WorkflowMemoryWriteProviderPort = {
    describeProvider: () => TEST_WORKFLOW_MEMORY_PROVIDER_DESCRIPTOR,
    writeMemory:
      write?.writeMemory ??
      (async (input) => ({
        externalObjectId: `memory-write:${input.operationId}`,
        externalObjectVersion: "v1",
        externalStatus: "accepted",
        responseSha256: "a".repeat(64),
      })),
    reconcileMemoryWrite:
      write?.reconcileMemoryWrite ??
      (async (input) => ({
        status: "materialized",
        accepted: {
          externalObjectId: input.externalObjectId ?? `memory-write:${input.operationId}`,
          externalObjectVersion: "v1",
          externalStatus: "materialized",
          responseSha256: "a".repeat(64),
        },
        verificationKind: "provider_query",
        verificationSha256: "b".repeat(64),
      })),
  };
  return {
    list: () => [TEST_WORKFLOW_MEMORY_PROVIDER_DESCRIPTOR],
    getQuery: (providerId) =>
      providerId === TEST_WORKFLOW_MEMORY_PROVIDER_DESCRIPTOR.providerId
        ? queryProvider
        : undefined,
    getWrite: (providerId) =>
      providerId === TEST_WORKFLOW_MEMORY_PROVIDER_DESCRIPTOR.providerId
        ? writeProvider
        : undefined,
  };
}
