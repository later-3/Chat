import {
  memoryProviderComparisonOutcomeSchema,
  memoryProviderPairwiseComparisonSchema,
  previewMemoryProviderComparisonResponseSchema,
  workflowMemoryQueryIdSchema,
  type MemoryProviderComparisonOutcome,
  type PreviewMemoryProviderComparisonPayload,
  type PrincipalId,
} from "@chat/contracts";
import {
  buildMemoryProviderPairwiseComparisons,
  computeMemoryProviderComparisonSha256,
  computeMemoryProviderDescriptorSha256,
  computeMemorySessionSnapshotSha256,
  hashCanonical,
  sha256Hex,
  WorkflowMemoryInvariantError,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError } from "./errors.js";
import {
  loadMemorySessionSourceSnapshot,
  memorySessionSourceKey,
} from "./memory-session-import-use-cases.js";
import { normalizeWorkflowMemoryQueryResult } from "./workflow-memory-query-use-cases.js";
import { WorkflowMemoryProviderError } from "./workflow-memory-ports.js";

function providerEvidence(
  descriptor: ReturnType<NonNullable<ApplicationDeps["workflowMemoryProviders"]>["list"]>[number],
) {
  const queryCapability = descriptor.capabilities.query;
  if (queryCapability === null) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 409,
      message: "比较所选Memory Provider不支持查询",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  return {
    providerId: descriptor.providerId,
    displayName: descriptor.displayName,
    providerKind: descriptor.providerKind,
    transport: descriptor.transport,
    adapterContractVersion: descriptor.adapterContractVersion,
    providerDescriptorSha256: computeMemoryProviderDescriptorSha256(descriptor) as never,
    queryCapability,
    writeMaterialization: descriptor.capabilities.write?.materialization ?? null,
  };
}

function failedOutcome(
  evidence: ReturnType<typeof providerEvidence>,
  error: unknown,
): MemoryProviderComparisonOutcome {
  if (error instanceof WorkflowMemoryProviderError) {
    return memoryProviderComparisonOutcomeSchema.parse({
      ...evidence,
      status: "failed",
      errorCode: error.code,
      retryable: error.retryable,
    });
  }
  if (error instanceof WorkflowMemoryInvariantError) {
    return memoryProviderComparisonOutcomeSchema.parse({
      ...evidence,
      status: "failed",
      errorCode: error.code,
      retryable: false,
    });
  }
  return memoryProviderComparisonOutcomeSchema.parse({
    ...evidence,
    status: "failed",
    errorCode: "memory.provider.unavailable",
    retryable: false,
  });
}

/**
 * 同一来源、查询与预算并行调用多个Provider。该Preview是只读观察，不写Product Store，
 * 也不把Provider score变成跨实现排名；后续采用仍需独立产品决定。
 */
export async function previewMemoryProviderComparison(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly payload: PreviewMemoryProviderComparisonPayload;
  },
) {
  const registry = deps.workflowMemoryProviders;
  if (registry === undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 409,
      message: "Memory Provider未启用",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const providerIds = [...input.payload.providerIds].sort();
  if (
    providerIds.length < 2 ||
    providerIds.length > 4 ||
    new Set(providerIds).size !== providerIds.length
  ) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Memory比较需要2至4个不重复Provider",
    });
  }
  const providers = providerIds.map((providerId) => {
    const provider = registry.getQuery(providerId);
    const descriptor = provider?.describeProvider();
    const capability = descriptor?.capabilities.query;
    if (
      provider === undefined ||
      descriptor === undefined ||
      descriptor.providerId !== providerId ||
      !descriptor.configured ||
      capability === null ||
      capability === undefined ||
      input.payload.maxResults > capability.maxResults ||
      input.payload.maxContextCharacters > capability.maxContextCharacters
    ) {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 409,
        message: "比较所选Memory Provider未配置或预算超出能力",
        recoveryAction: "rehydrate_and_retry",
      });
    }
    return { provider, descriptor, evidence: providerEvidence(descriptor) };
  });
  const source = await loadMemorySessionSourceSnapshot(
    deps,
    input.principalId,
    input.payload.source,
  );
  const sourceSnapshotSha256 = computeMemorySessionSnapshotSha256(source);
  const querySha256 = sha256Hex(input.payload.query);
  const generatedAt = deps.now();
  const outcomes = await Promise.all(
    providers.map(async ({ provider, descriptor, evidence }) => {
      const operationId = workflowMemoryQueryIdSchema.parse(
        `wmq_${hashCanonical("id.memory-provider-comparison-query.v1", {
          source: input.payload.source,
          sourceSnapshotSha256,
          querySha256,
          providerId: descriptor.providerId,
          providerDescriptorSha256: evidence.providerDescriptorSha256,
          generatedAt,
        }).slice(0, 32)}`,
      );
      try {
        const output = await provider.queryMemory({
          operationId,
          sessionKey: memorySessionSourceKey(input.payload.source),
          principalId: input.principalId,
          query: input.payload.query,
          maxResults: input.payload.maxResults,
          maxContextCharacters: input.payload.maxContextCharacters,
        });
        const normalized = normalizeWorkflowMemoryQueryResult(
          {
            maxResults: input.payload.maxResults,
            maxContextCharacters: input.payload.maxContextCharacters,
          },
          output,
        );
        return memoryProviderComparisonOutcomeSchema.parse({
          ...evidence,
          status: "completed",
          hitCount: normalized.hitCount,
          selectedCount: normalized.sections.length,
          selectedCharacters: normalized.sections.reduce(
            (total, section) => total + section.title.length + section.content.length,
            0,
          ),
          resultSetSha256: normalized.resultSetSha256,
          items: normalized.sections.map((section) => ({
            title: section.title,
            category: section.category,
            content: section.content,
            contentSha256: sha256Hex(section.content),
            labels: section.labels,
            ...(section.score === undefined ? {} : { providerScore: section.score }),
            ...(section.sourceUpdatedAt === undefined
              ? {}
              : { sourceUpdatedAt: section.sourceUpdatedAt }),
          })),
        });
      } catch (error) {
        return failedOutcome(evidence, error);
      }
    }),
  );
  const pairwise = buildMemoryProviderPairwiseComparisons(outcomes).map((comparison) =>
    memoryProviderPairwiseComparisonSchema.parse(comparison),
  );
  const comparisonBase = {
    source: input.payload.source,
    sourceSnapshotSha256,
    querySha256,
    maxResults: input.payload.maxResults,
    maxContextCharacters: input.payload.maxContextCharacters,
    providers: outcomes,
    pairwise,
  };
  return previewMemoryProviderComparisonResponseSchema.parse({
    comparison: {
      schemaVersion: "memory-provider-comparison-preview.v1",
      sourceTitle: source.title,
      sourceUpdatedAt: source.updatedAt,
      ...comparisonBase,
      comparisonSha256: computeMemoryProviderComparisonSha256(comparisonBase),
      generatedAt,
    },
  });
}
