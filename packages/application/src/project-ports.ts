import type {
  ProjectIntakeUnderstanding,
  ProjectAdvancementUnderstanding,
  ProjectObservationData,
  ProjectResourceAdapterKind,
} from "@chat/contracts";

export interface ProjectResourceRootDescriptor {
  readonly rootId: string;
  readonly displayName: string;
  readonly enabledAdapters: readonly ProjectResourceAdapterKind[];
  /** 只在服务端比较rootId映射；不得投影canonical path或把Hash当公开资源身份。 */
  readonly grantSha256?: string | undefined;
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

/**
 * PS2项目推进理解Port只读取已裁剪的当前Stage摘要；它不拥有Candidate或项目事实。
 * Provider/模型证据仅用于Trace和验收，不进入公开Command。
 */
export interface ProjectAdvancementUnderstandingPort {
  describe(): {
    readonly profileVersion: string;
    readonly providerName: string;
    readonly modelId: string;
    readonly promptTemplateVersion: string;
    readonly endpointHost: string;
  };
  understand(input: {
    readonly text: string;
    readonly projectName: string;
    readonly currentStage: {
      readonly name: string;
      readonly goal: string;
      readonly successCriteria: readonly string[];
    };
  }): Promise<{
    readonly understanding: ProjectAdvancementUnderstanding;
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
