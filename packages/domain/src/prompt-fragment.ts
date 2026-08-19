import { hashCanonical } from "./canonical-hash.js";

export type PromptFragmentContentShape =
  | { readonly kind: "markdown"; readonly bodyMarkdown: string }
  | { readonly kind: "key_value"; readonly key: string; readonly valueMarkdown: string };

export type PromptFragmentDerivedFromShape =
  | {
      readonly kind: "builtin";
      readonly promptFragmentId: string;
      readonly promptFragmentRevisionId: string;
      readonly revision: number;
      readonly sha256: string;
      readonly sourceRelativePath: string;
    }
  | {
      readonly kind: "principal";
      readonly promptFragmentId: string;
      readonly promptFragmentRevisionId: string;
      readonly revision: number;
      readonly sha256: string;
    };

export interface PromptFragmentRevisionShape {
  readonly promptFragmentRevisionId: string;
  readonly promptFragmentId: string;
  readonly revision: number;
  readonly regionKey: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly content: PromptFragmentContentShape;
  readonly supersedesRevisionId?: string | undefined;
  readonly supersedesRevisionSha256?: string | undefined;
  readonly derivedFrom?: PromptFragmentDerivedFromShape | undefined;
  readonly authoredByPrincipalId: string;
  readonly sha256: string;
}

const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u;

export class PromptFragmentDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PromptFragmentDomainError";
    this.code = code;
  }
}

export function assertPromptRegionKey(regionKey: string): void {
  if (!/^[a-z][a-z0-9_]{0,79}$/u.test(regionKey)) {
    throw new PromptFragmentDomainError("prompt.region_key_invalid", "Prompt Region key非法");
  }
}

export function assertPromptFragmentText(label: string, value: string, max: number): void {
  if (value.trim().length === 0 || value.length > max || FORBIDDEN_TEXT.test(value)) {
    throw new PromptFragmentDomainError(
      "prompt.fragment_text_invalid",
      `${label}为空、过长或包含非法控制字符`,
    );
  }
}

export function assertPromptFragmentContent(content: PromptFragmentContentShape): void {
  if (content.kind === "markdown") {
    assertPromptFragmentText("Prompt正文", content.bodyMarkdown, 65_536);
    return;
  }
  assertPromptFragmentText("Prompt key", content.key, 120);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u.test(content.key)) {
    throw new PromptFragmentDomainError("prompt.fragment_key_invalid", "Prompt key格式非法");
  }
  assertPromptFragmentText("Prompt value", content.valueMarkdown, 65_536);
}

export interface PromptFragmentRevisionHashInput {
  readonly promptFragmentId: string;
  readonly revision: number;
  readonly regionKey: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly content: PromptFragmentContentShape;
  readonly supersedesRevisionId?: string | undefined;
  readonly supersedesRevisionSha256?: string | undefined;
  readonly derivedFrom?: PromptFragmentDerivedFromShape | undefined;
  readonly authoredByPrincipalId: string;
}

export function computePromptFragmentRevisionSha256(
  input: PromptFragmentRevisionHashInput,
): string {
  return hashCanonical("prompt-fragment-revision.v1", input);
}

export function assertPromptFragmentRevision(revision: PromptFragmentRevisionShape): void {
  assertPromptRegionKey(revision.regionKey);
  assertPromptFragmentText("Prompt标题", revision.title, 160);
  if (revision.description !== undefined) {
    assertPromptFragmentText("Prompt描述", revision.description, 1_000);
  }
  assertPromptFragmentContent(revision.content);
  if (revision.revision === 1) {
    if (
      revision.supersedesRevisionId !== undefined ||
      revision.supersedesRevisionSha256 !== undefined
    ) {
      throw new PromptFragmentDomainError(
        "prompt.first_revision_has_parent",
        "Prompt首版不能声明supersedes",
      );
    }
  } else if (
    revision.supersedesRevisionId === undefined ||
    revision.supersedesRevisionSha256 === undefined
  ) {
    throw new PromptFragmentDomainError(
      "prompt.revision_parent_missing",
      "Prompt后续版本必须绑定上一版ID和Hash",
    );
  }
  const expected = computePromptFragmentRevisionSha256({
    promptFragmentId: revision.promptFragmentId,
    revision: revision.revision,
    regionKey: revision.regionKey,
    title: revision.title,
    ...(revision.description !== undefined ? { description: revision.description } : {}),
    content: revision.content,
    ...(revision.supersedesRevisionId !== undefined
      ? { supersedesRevisionId: revision.supersedesRevisionId }
      : {}),
    ...(revision.supersedesRevisionSha256 !== undefined
      ? { supersedesRevisionSha256: revision.supersedesRevisionSha256 }
      : {}),
    ...(revision.derivedFrom !== undefined ? { derivedFrom: revision.derivedFrom } : {}),
    authoredByPrincipalId: revision.authoredByPrincipalId,
  });
  if (revision.sha256 !== expected) {
    throw new PromptFragmentDomainError(
      "prompt.revision_hash_mismatch",
      "Prompt Revision Hash不一致",
    );
  }
}
