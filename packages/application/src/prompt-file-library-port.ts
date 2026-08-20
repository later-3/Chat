import type {
  PromptFragmentContent,
  PromptFragmentId,
  PromptFragmentRevisionId,
  PromptFragmentScope,
} from "@chat/contracts";

export interface PromptFileRevisionInput {
  readonly promptFragmentId: PromptFragmentId;
  readonly promptFragmentRevisionId: PromptFragmentRevisionId;
  readonly revision: number;
  readonly regionKey: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly scope: PromptFragmentScope;
  readonly content: PromptFragmentContent;
  readonly contentSha256: string;
  readonly createdAt: string;
}

export interface PromptFileRevisionProjection {
  readonly sourceRelativePath: string;
  readonly sourceSha256: string;
  readonly content: PromptFragmentContent;
}

/**
 * 用户Prompt正文的可见Markdown文件边界。Application仍拥有Command/CAS与产品快照；
 * Adapter只在受权Global或Workspace Prompt目录中幂等发布、读取精确Revision文件。
 */
export interface PromptFileLibraryPort {
  publishRevision(input: PromptFileRevisionInput): Promise<PromptFileRevisionProjection>;
  readRevision(input: {
    readonly promptFragmentId: PromptFragmentId;
    readonly promptFragmentRevisionId: PromptFragmentRevisionId;
    readonly regionKey: string;
    readonly scope: PromptFragmentScope;
    readonly expectedContentSha256: string;
  }): Promise<PromptFileRevisionProjection>;
}
