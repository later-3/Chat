import type {
  PromptFragmentContent,
  PromptFragmentId,
  PromptFragmentRevisionId,
  PromptFragmentScope,
  PromptRegionDefinitionDto,
} from "@chat/contracts";

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
  readonly regions: readonly PromptRegionDefinitionDto[];
  readonly builtinFragments: readonly BuiltinPromptFragmentRevision[];
}

/** Git Prompt Catalog的只读Port；Product Store不复制Builtin正文。 */
export interface PromptCatalogPort {
  load(): Promise<PromptCatalogSnapshot>;
}
