import type {
  ProjectIntakeUnderstanding,
  ProjectObservationData,
  ProjectResourceAdapterKind,
} from "@chat/contracts";

export interface ProjectResourceRootDescriptor {
  readonly rootId: string;
  readonly displayName: string;
  readonly enabledAdapters: readonly ProjectResourceAdapterKind[];
}

export interface ProjectResourceRootRegistryPort {
  list(): readonly ProjectResourceRootDescriptor[];
  observe(rootId: string): Promise<{
    readonly descriptor: ProjectResourceRootDescriptor;
    readonly data: ProjectObservationData;
  }>;
}

/**
 * 自然语言理解Port不暴露Provider/模型；Application与Workflow只依赖稳定输出合同。
 * 当前pi实现和未来其他模型实现必须通过同一strict合同。
 */
export interface ProjectIntakeUnderstandingPort {
  describe(): {
    readonly profileVersion: string;
    readonly providerName: string;
    readonly modelId: string;
    readonly promptTemplateVersion: string;
    readonly endpointHost: string;
  };
  understand(input: { readonly text: string; readonly resourceDisplayName: string }): Promise<{
    readonly understanding: ProjectIntakeUnderstanding;
    readonly evidence: {
      readonly durationMs: number;
      readonly providerRequestId?: string;
      readonly tokenUsage?: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
      };
    };
  }>;
}
