import type {
  AgentProfileAgentKey,
  PromptFragmentContent,
  PromptFragmentId,
  PromptFragmentRevisionId,
  PromptFragmentScope,
  PromptRegionDefinitionDto,
} from "@chat/contracts";

export interface PromptAgentDefinition {
  readonly agentKey: AgentProfileAgentKey;
  readonly title: string;
  readonly description: string;
  readonly profileVersion: string;
  readonly supportedNodeTypes: readonly string[];
  readonly defaultPrompt:
    | {
        readonly kind: "catalog_fragment";
        readonly promptFragmentRevisionId: PromptFragmentRevisionId;
      }
    | {
        readonly kind: "pi_coding_agent";
        /** 设置页使用的基准能力；真实Run仍按冻结Capability选择对应变体。 */
        readonly defaultVariantKey: string;
        /** 某些Pi能力以Chat内置身份完整替换Pi基础System；Direct缺省时直接继承Pi。 */
        readonly promptFragmentRevisionId?: PromptFragmentRevisionId | undefined;
      };
  readonly tools: readonly { readonly name: string; readonly description: string }[];
}

export interface BuiltinPromptFragmentRevision {
  readonly promptFragmentId: PromptFragmentId;
  readonly promptFragmentRevisionId: PromptFragmentRevisionId;
  readonly revision: number;
  readonly regionKey: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly content: PromptFragmentContent;
  readonly scope: PromptFragmentScope;
  readonly sha256: string;
  readonly sourceRelativePath: string;
  readonly sourceWorkspaceRootId?: string | undefined;
  readonly createdAt: string;
}

export interface PromptCatalogSnapshot {
  readonly catalogSha256: string;
  /** 用户未显式改写Region时采用的共享层默认组合；身份与Revision均由Git Catalog版本化。 */
  readonly sharedSelectionProfile: {
    readonly profileId: string;
    readonly defaultRevisionIds: readonly PromptFragmentRevisionId[];
  };
  readonly regions: readonly PromptRegionDefinitionDto[];
  readonly builtinFragments: readonly BuiltinPromptFragmentRevision[];
  readonly agents: readonly PromptAgentDefinition[];
}

/** Git Prompt Catalog的只读Port；Product Store不复制Builtin正文。 */
export interface PromptCatalogPort {
  /** 当前运行图可发现的Catalog；默认运行图不得泄漏冻结的专项能力。 */
  load(): Promise<PromptCatalogSnapshot>;
  /**
   * 历史Run只凭已经冻结的Revision ID与Hash精确恢复Builtin正文。
   * 该入口不是Catalog枚举或详情查询，Hash不一致时必须返回undefined。
   */
  resolveBuiltinRevision(input: {
    readonly promptFragmentRevisionId: PromptFragmentRevisionId;
    readonly sha256: string;
  }): Promise<BuiltinPromptFragmentRevision | undefined>;
}
