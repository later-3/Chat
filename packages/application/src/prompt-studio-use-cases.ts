import {
  AGENT_PROFILE_API_SCHEMA_VERSION,
  AGENT_VERSION_SCHEMA_VERSION,
  PROMPT_STUDIO_API_SCHEMA_VERSION,
  agentVersionIdSchema,
  agentVersionHashInputSchema,
  agentVersionSchema,
  agentProfileDtoSchema,
  agentProfilesDtoSchema,
  promptFragmentCommandResultDtoSchema,
  promptFragmentDetailDtoSchema,
  promptFragmentIdSchema,
  promptFragmentPageDtoSchema,
  promptFragmentRevisionDetailDtoSchema,
  promptFragmentRevisionIdSchema,
  promptFragmentRevisionSchema,
  promptFragmentSchema,
  promptRegionsDtoSchema,
  promptWorkspacesDtoSchema,
  type AgentKey,
  type AgentProfileDto,
  type CreateAgentVersionPayload,
  type ChangePromptFragmentArchiveStatusPayload,
  type CommandId,
  type CopyPromptFragmentPayload,
  type CreatePromptFragmentPayload,
  type ListPromptFragmentsQuery,
  type PrincipalId,
  type ProductSnapshot,
  type PromptFragment,
  type PromptFragmentContent,
  type PromptFragmentDraftPayload,
  type PromptFragmentId,
  type PromptFragmentRevision,
  type PromptFragmentRevisionId,
  type RevisePromptFragmentPayload,
  type RestoreAgentPromptPayload,
  type ReviseAgentPromptPayload,
} from "@chat/contracts";
import {
  assertPromptFragmentContent,
  computePromptFragmentRevisionV2Sha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import type {
  BuiltinPromptFragmentRevision,
  PromptCatalogSnapshot,
} from "./prompt-catalog-port.js";
import {
  ApplicationError,
  CommandIdReusedError,
  forbidden,
  notFound,
  revisionConflict,
} from "./errors.js";

function requireCatalog(deps: ApplicationDeps) {
  if (deps.promptCatalog === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Prompt Catalog未配置",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
  return deps.promptCatalog;
}

function assertDraftAllowed(
  catalog: PromptCatalogSnapshot,
  draft: PromptFragmentDraftPayload,
): void {
  const region = catalog.regions.find((item) => item.regionKey === draft.regionKey);
  if (region === undefined) throw notFound("Prompt Region不存在");
  if (!region.userManageable || region.contentKind === "runtime") {
    throw forbidden("该Prompt Region是运行时只读区域");
  }
  if (region.category === "identity") {
    throw forbidden("Agent System Prompt只能在Agent设置中管理");
  }
  if (region.contentKind !== draft.content.kind) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: `Prompt Region ${region.regionKey} 要求${region.contentKind}内容`,
    });
  }
  assertPromptFragmentContent(draft.content);
}

function assertScopeAllowed(deps: ApplicationDeps, scope: PromptFragment["scope"]): void {
  if (scope.kind === "global") return;
  const root = deps.projectRoots?.list().find((item) => item.rootId === scope.rootId);
  if (root === undefined) throw forbidden("Workspace未配置或不允许用于Prompt");
}

function ownedFragment(
  entities: { readonly promptFragments: Record<string, PromptFragment> },
  promptFragmentId: PromptFragmentId,
  principalId: PrincipalId,
): PromptFragment {
  const fragment = entities.promptFragments[promptFragmentId];
  if (fragment === undefined) throw notFound("Prompt Fragment不存在");
  if (fragment.ownerPrincipalId !== principalId) throw forbidden("无权访问该Prompt Fragment");
  return fragment;
}

function currentRevision(
  entities: { readonly promptFragmentRevisions: Record<string, PromptFragmentRevision> },
  fragment: PromptFragment,
): PromptFragmentRevision {
  const revision = entities.promptFragmentRevisions[fragment.currentRevisionId];
  if (revision === undefined) throw notFound("Prompt Fragment Revision不存在");
  return revision;
}

function contentKind(content: PromptFragmentContent): "markdown" | "key_value" {
  return content.kind;
}

function revisionContentKind(revision: PromptFragmentRevision): "markdown" | "key_value" {
  return revision.schemaVersion === "prompt-fragment-revision.v2"
    ? revision.contentRef.contentKind
    : contentKind(revision.content);
}

function builtinSummary(fragment: BuiltinPromptFragmentRevision) {
  return {
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragmentId: fragment.promptFragmentId,
    ownerKind: "system" as const,
    scope: fragment.scope,
    status: "builtin" as const,
    regionKey: fragment.regionKey,
    title: fragment.title,
    ...(fragment.description !== undefined ? { description: fragment.description } : {}),
    contentKind: contentKind(fragment.content),
    currentRevisionId: fragment.promptFragmentRevisionId,
    currentRevisionNumber: fragment.revision,
    currentRevisionSha256: fragment.sha256,
    revision: fragment.revision,
    updatedAt: fragment.createdAt,
    sourceRelativePath: fragment.sourceRelativePath,
    allowedActions: ["copy" as const],
  };
}

function userSummary(
  fragment: PromptFragment,
  revision: PromptFragmentRevision,
  sourceRelativePath?: string,
) {
  return {
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragmentId: fragment.promptFragmentId,
    ownerKind: "principal" as const,
    scope: fragment.scope,
    status: fragment.status,
    regionKey: revision.regionKey,
    title: revision.title,
    ...(revision.description !== undefined ? { description: revision.description } : {}),
    contentKind: revisionContentKind(revision),
    currentRevisionId: revision.promptFragmentRevisionId,
    currentRevisionNumber: revision.revision,
    currentRevisionSha256: revision.sha256,
    revision: fragment.revision,
    updatedAt: fragment.updatedAt,
    ...(sourceRelativePath === undefined ? {} : { sourceRelativePath }),
    allowedActions:
      fragment.status === "active" ? (["revise", "archive"] as const) : (["restore"] as const),
  };
}

function revisionDetail(
  revision: PromptFragmentRevision | BuiltinPromptFragmentRevision,
  ownerKind: "system" | "principal",
  scope: PromptFragment["scope"],
  content: PromptFragmentContent,
  sourceRelativePath?: string,
) {
  return promptFragmentRevisionDetailDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragmentId: revision.promptFragmentId,
    promptFragmentRevisionId: revision.promptFragmentRevisionId,
    ownerKind,
    scope,
    revision: revision.revision,
    regionKey: revision.regionKey,
    title: revision.title,
    ...(revision.description !== undefined ? { description: revision.description } : {}),
    content,
    ...("supersedesRevisionId" in revision && revision.supersedesRevisionId !== undefined
      ? { supersedesRevisionId: revision.supersedesRevisionId }
      : {}),
    ...("supersedesRevisionSha256" in revision && revision.supersedesRevisionSha256 !== undefined
      ? { supersedesRevisionSha256: revision.supersedesRevisionSha256 }
      : {}),
    ...("derivedFrom" in revision && revision.derivedFrom !== undefined
      ? { derivedFrom: revision.derivedFrom }
      : {}),
    sha256: revision.sha256,
    createdAt: revision.createdAt,
    ...(sourceRelativePath !== undefined
      ? { sourceRelativePath }
      : ownerKind === "system" && "sourceRelativePath" in revision
        ? { sourceRelativePath: revision.sourceRelativePath }
        : {}),
  });
}

function builtinDetail(fragment: BuiltinPromptFragmentRevision) {
  return promptFragmentDetailDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    fragment: builtinSummary(fragment),
    currentRevision: revisionDetail(
      fragment,
      "system",
      fragment.scope,
      fragment.content,
      fragment.sourceRelativePath,
    ),
    revisions: [
      {
        schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
        promptFragmentRevisionId: fragment.promptFragmentRevisionId,
        revision: fragment.revision,
        title: fragment.title,
        sha256: fragment.sha256,
        createdAt: fragment.createdAt,
      },
    ],
  });
}

function promptFileContentSha256(content: PromptFragmentContent): string {
  return hashCanonical("prompt-file-content.v1", content);
}

function requirePromptFiles(deps: ApplicationDeps) {
  if (deps.promptFiles === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Prompt Markdown文件库未配置",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
  return deps.promptFiles;
}

async function readPromptFileProjection(
  deps: ApplicationDeps,
  fragment: PromptFragment,
  revision: PromptFragmentRevision,
) {
  if (revision.schemaVersion === "prompt-fragment-revision.v1") {
    if (deps.promptFiles === undefined) return undefined;
    // 旧v1快照的正文仍在Store；首次详情读取时幂等迁入可见Markdown文件。
    return deps.promptFiles.publishRevision({
      promptFragmentId: revision.promptFragmentId,
      promptFragmentRevisionId: revision.promptFragmentRevisionId,
      revision: revision.revision,
      regionKey: revision.regionKey,
      title: revision.title,
      ...(revision.description === undefined ? {} : { description: revision.description }),
      scope: fragment.scope,
      content: revision.content,
      contentSha256: promptFileContentSha256(revision.content),
      createdAt: revision.createdAt,
    });
  }
  const file = await requirePromptFiles(deps).readRevision({
    promptFragmentId: revision.promptFragmentId,
    promptFragmentRevisionId: revision.promptFragmentRevisionId,
    regionKey: revision.regionKey,
    scope: fragment.scope,
    expectedContentSha256: revision.contentRef.contentSha256,
  });
  if (
    file.sourceRelativePath !== revision.contentRef.sourceRelativePath ||
    file.sourceSha256 !== revision.contentRef.sourceSha256 ||
    file.content.kind !== revision.contentRef.contentKind ||
    (file.content.kind === "key_value" && file.content.key !== revision.contentRef.key)
  ) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Prompt Markdown文件与产品版本引用不一致",
      recoveryAction: "contact_support",
    });
  }
  return file;
}

async function userDetail(
  deps: ApplicationDeps,
  entities: {
    readonly promptFragmentRevisions: Record<string, PromptFragmentRevision>;
  },
  fragment: PromptFragment,
) {
  const revision = currentRevision(entities, fragment);
  const file = await readPromptFileProjection(deps, fragment, revision);
  const content =
    file?.content ??
    (revision.schemaVersion === "prompt-fragment-revision.v1" ? revision.content : undefined);
  if (content === undefined) throw new Error("Prompt Revision正文不可用");
  const revisions = Object.values(entities.promptFragmentRevisions)
    .filter((item) => item.promptFragmentId === fragment.promptFragmentId)
    .sort((left, right) => right.revision - left.revision);
  return promptFragmentDetailDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    fragment: userSummary(fragment, revision, file?.sourceRelativePath),
    currentRevision: revisionDetail(
      revision,
      "principal",
      fragment.scope,
      content,
      file?.sourceRelativePath,
    ),
    revisions: revisions.map((item) => ({
      schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
      promptFragmentRevisionId: item.promptFragmentRevisionId,
      revision: item.revision,
      title: item.title,
      sha256: item.sha256,
      createdAt: item.createdAt,
    })),
  });
}

export async function listPromptRegions(deps: ApplicationDeps) {
  const catalog = await requireCatalog(deps).load();
  return promptRegionsDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    catalogSha256: catalog.catalogSha256,
    items: catalog.regions,
  });
}

export async function listPromptWorkspaces(deps: ApplicationDeps) {
  return promptWorkspacesDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    items: (deps.projectRoots?.list() ?? []).map((root) => ({
      schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
      rootId: root.rootId,
      title: root.displayName,
    })),
  });
}

export async function listPromptFragments(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly query: ListPromptFragmentsQuery },
) {
  const [catalog, { snapshot }] = await Promise.all([
    requireCatalog(deps).load(),
    deps.store.read({ kind: "committedSnapshot" }),
  ]);
  const builtin = catalog.builtinFragments.map(builtinSummary);
  const user = await Promise.all(
    Object.values(snapshot.entities.promptFragments)
      .filter((fragment) => fragment.ownerPrincipalId === input.principalId)
      .map(async (fragment) => {
        const revision = currentRevision(snapshot.entities, fragment);
        return userSummary(
          fragment,
          revision,
          revision.schemaVersion === "prompt-fragment-revision.v2"
            ? revision.contentRef.sourceRelativePath
            : undefined,
        );
      }),
  );
  const rows = [...builtin, ...user]
    .filter(
      (item) => input.query.regionKey === undefined || item.regionKey === input.query.regionKey,
    )
    .filter(
      (item) => input.query.ownerKind === undefined || item.ownerKind === input.query.ownerKind,
    )
    .filter(
      (item) =>
        input.query.status === undefined ||
        (item.ownerKind === "principal" && item.status === input.query.status),
    )
    .filter(
      (item) => input.query.scopeKind === undefined || item.scope.kind === input.query.scopeKind,
    )
    .filter(
      (item) =>
        input.query.workspaceRootId === undefined ||
        (item.scope.kind === "workspace" && item.scope.rootId === input.query.workspaceRootId),
    )
    .sort((left, right) => {
      const order = left.regionKey.localeCompare(right.regionKey);
      return order !== 0
        ? order
        : left.title === right.title
          ? left.promptFragmentId.localeCompare(right.promptFragmentId)
          : left.title.localeCompare(right.title);
    });
  const cursorIndex =
    input.query.cursor === undefined
      ? undefined
      : rows.findIndex((item) => item.promptFragmentId === input.query.cursor);
  if (cursorIndex === -1) throw revisionConflict("Prompt Fragment列表cursor已过期");
  const start = cursorIndex === undefined ? 0 : cursorIndex + 1;
  const items = rows.slice(start, start + input.query.limit);
  const hasMore = rows.length > start + input.query.limit;
  return promptFragmentPageDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    items,
    ...(hasMore && items.length > 0 ? { nextCursor: items.at(-1)!.promptFragmentId } : {}),
  });
}

export async function getPromptFragment(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly promptFragmentId: PromptFragmentId },
) {
  const catalog = await requireCatalog(deps).load();
  const builtin = catalog.builtinFragments.find(
    (item) => item.promptFragmentId === input.promptFragmentId,
  );
  if (builtin !== undefined) return builtinDetail(builtin);
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return userDetail(
    deps,
    snapshot.entities,
    ownedFragment(snapshot.entities, input.promptFragmentId, input.principalId),
  );
}

export async function getPromptFragmentRevision(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly promptFragmentRevisionId: PromptFragmentRevisionId;
  },
) {
  const catalog = await requireCatalog(deps).load();
  const builtin = catalog.builtinFragments.find(
    (item) => item.promptFragmentRevisionId === input.promptFragmentRevisionId,
  );
  if (builtin !== undefined)
    return revisionDetail(
      builtin,
      "system",
      builtin.scope,
      builtin.content,
      builtin.sourceRelativePath,
    );
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const revision = snapshot.entities.promptFragmentRevisions[input.promptFragmentRevisionId];
  if (revision === undefined) throw notFound("Prompt Fragment Revision不存在");
  ownedFragment(snapshot.entities, revision.promptFragmentId, input.principalId);
  const aggregate = ownedFragment(snapshot.entities, revision.promptFragmentId, input.principalId);
  const file = await readPromptFileProjection(deps, aggregate, revision);
  const content =
    file?.content ??
    (revision.schemaVersion === "prompt-fragment-revision.v1" ? revision.content : undefined);
  if (content === undefined) throw new Error("Prompt Revision正文不可用");
  return revisionDetail(revision, "principal", aggregate.scope, content, file?.sourceRelativePath);
}

async function buildRevision(
  deps: ApplicationDeps,
  input: {
    readonly promptFragmentId: PromptFragmentId;
    readonly promptFragmentRevisionId: PromptFragmentRevisionId;
    readonly revision: number;
    readonly draft: PromptFragmentDraftPayload;
    readonly scope: PromptFragment["scope"];
    readonly principalId: PrincipalId;
    readonly createdAt: string;
    readonly supersedes?: PromptFragmentRevision | undefined;
    readonly derivedFrom?: PromptFragmentRevision["derivedFrom"] | undefined;
  },
): Promise<PromptFragmentRevision> {
  const normalizedContent =
    input.draft.content.kind === "markdown"
      ? { kind: "markdown" as const, bodyMarkdown: input.draft.content.bodyMarkdown.trim() }
      : {
          kind: "key_value" as const,
          key: input.draft.content.key.trim(),
          valueMarkdown: input.draft.content.valueMarkdown.trim(),
        };
  const file = await requirePromptFiles(deps).publishRevision({
    promptFragmentId: input.promptFragmentId,
    promptFragmentRevisionId: input.promptFragmentRevisionId,
    revision: input.revision,
    regionKey: input.draft.regionKey,
    title: input.draft.title.trim(),
    ...(input.draft.description === undefined
      ? {}
      : { description: input.draft.description.trim() }),
    scope: input.scope,
    content: normalizedContent,
    contentSha256: promptFileContentSha256(normalizedContent),
    createdAt: input.createdAt,
  });
  const contentRef = {
    kind: "managed_markdown" as const,
    contentKind: normalizedContent.kind,
    ...(normalizedContent.kind === "key_value" ? { key: normalizedContent.key } : {}),
    contentSha256: promptFileContentSha256(normalizedContent),
    sourceRelativePath: file.sourceRelativePath,
    sourceSha256: file.sourceSha256,
  };
  const body = {
    promptFragmentId: input.promptFragmentId,
    revision: input.revision,
    regionKey: input.draft.regionKey,
    title: input.draft.title.trim(),
    ...(input.draft.description !== undefined
      ? { description: input.draft.description.trim() }
      : {}),
    contentRef,
    ...(input.supersedes !== undefined
      ? {
          supersedesRevisionId: input.supersedes.promptFragmentRevisionId,
          supersedesRevisionSha256: input.supersedes.sha256,
        }
      : {}),
    ...(input.derivedFrom !== undefined ? { derivedFrom: input.derivedFrom } : {}),
    authoredByPrincipalId: input.principalId,
  };
  return promptFragmentRevisionSchema.parse({
    schemaVersion: "prompt-fragment-revision.v2",
    promptFragmentRevisionId: input.promptFragmentRevisionId,
    ...body,
    sha256: computePromptFragmentRevisionV2Sha256(body),
    createdAt: input.createdAt,
  });
}

function commandFragmentId(commandId: CommandId): PromptFragmentId {
  return promptFragmentIdSchema.parse(
    `pfg_${hashCanonical("id.prompt-fragment.command.v1", { commandId }).slice(0, 40)}`,
  );
}

function commandRevisionId(
  commandId: CommandId,
  promptFragmentId: PromptFragmentId,
): PromptFragmentRevisionId {
  return promptFragmentRevisionIdSchema.parse(
    `pfr_${hashCanonical("id.prompt-fragment-revision.command.v1", {
      commandId,
      promptFragmentId,
    }).slice(0, 40)}`,
  );
}

async function readCommandResult(
  deps: ApplicationDeps,
  result: { readonly resultRefs: Record<string, string>; readonly replayed: boolean },
  principalId: PrincipalId,
) {
  const promptFragmentId = result.resultRefs["promptFragmentId"] as PromptFragmentId | undefined;
  if (promptFragmentId === undefined) throw new Error("Prompt Fragment命令Receipt缺少结果引用");
  return promptFragmentCommandResultDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragment: await getPromptFragment(deps, { principalId, promptFragmentId }),
    replayed: result.replayed,
  });
}

async function readCommandReplay(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly commandType: string;
    readonly requestSha256: string;
    readonly principalId: PrincipalId;
  },
): Promise<Awaited<ReturnType<typeof readCommandResult>> | undefined> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const receipt = snapshot.commandReceipts[input.commandId];
  if (receipt === undefined) return undefined;
  if (receipt.commandType !== input.commandType || receipt.requestSha256 !== input.requestSha256) {
    throw new CommandIdReusedError(input.commandId);
  }
  return readCommandResult(
    deps,
    { resultRefs: receipt.resultRefs, replayed: true },
    input.principalId,
  );
}

export async function createPromptFragment(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreatePromptFragmentPayload;
  },
) {
  const requestSha256 = hashCanonical("command.create-prompt-fragment.v1", input.payload);
  const replay = await readCommandReplay(deps, {
    commandId: input.commandId,
    commandType: "CreatePromptFragment",
    requestSha256,
    principalId: input.principalId,
  });
  if (replay !== undefined) return replay;
  const catalog = await requireCatalog(deps).load();
  assertDraftAllowed(catalog, input.payload);
  assertScopeAllowed(deps, input.payload.scope);
  const now = deps.now();
  const promptFragmentId = commandFragmentId(input.commandId);
  const revision = await buildRevision(deps, {
    promptFragmentId,
    promptFragmentRevisionId: commandRevisionId(input.commandId, promptFragmentId),
    revision: 1,
    draft: input.payload,
    scope: input.payload.scope,
    principalId: input.principalId,
    createdAt: now,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreatePromptFragment",
    requestSha256,
    mutate: (draft) => {
      if (
        draft.entities.promptFragments[promptFragmentId] !== undefined ||
        catalog.builtinFragments.some((item) => item.promptFragmentId === promptFragmentId)
      ) {
        throw revisionConflict("Prompt Fragment ID冲突");
      }
      draft.entities.promptFragmentRevisions[revision.promptFragmentRevisionId] = revision;
      draft.entities.promptFragments[promptFragmentId] = promptFragmentSchema.parse({
        schemaVersion: "prompt-fragment.v1",
        promptFragmentId,
        ownerPrincipalId: input.principalId,
        scope: input.payload.scope,
        status: "active",
        currentRevisionId: revision.promptFragmentRevisionId,
        currentRevisionNumber: 1,
        currentRevisionSha256: revision.sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      return {
        resultRefs: {
          promptFragmentId,
          promptFragmentRevisionId: revision.promptFragmentRevisionId,
        },
      };
    },
  });
  return readCommandResult(deps, result, input.principalId);
}

async function resolveCopySource(
  deps: ApplicationDeps,
  catalog: PromptCatalogSnapshot,
  principalId: PrincipalId,
  payload: CopyPromptFragmentPayload,
) {
  const builtin = catalog.builtinFragments.find(
    (item) => item.promptFragmentRevisionId === payload.sourcePromptFragmentRevisionId,
  );
  if (builtin !== undefined) {
    if (builtin.sha256 !== payload.sourceSha256) throw revisionConflict("Builtin Prompt版本已变化");
    return {
      source: builtin,
      content: builtin.content,
      derivedFrom: {
        kind: "builtin" as const,
        promptFragmentId: builtin.promptFragmentId,
        promptFragmentRevisionId: builtin.promptFragmentRevisionId,
        revision: builtin.revision,
        sha256: builtin.sha256,
        sourceRelativePath: builtin.sourceRelativePath,
      },
    };
  }
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const source = snapshot.entities.promptFragmentRevisions[payload.sourcePromptFragmentRevisionId];
  if (source === undefined) throw notFound("复制来源Prompt Revision不存在");
  const aggregate = ownedFragment(snapshot.entities, source.promptFragmentId, principalId);
  if (source.sha256 !== payload.sourceSha256) throw revisionConflict("复制来源Prompt版本已变化");
  const file = await readPromptFileProjection(deps, aggregate, source);
  const content =
    file?.content ??
    (source.schemaVersion === "prompt-fragment-revision.v1" ? source.content : undefined);
  if (content === undefined) throw new Error("复制来源Prompt正文不可用");
  return {
    source,
    content,
    derivedFrom: {
      kind: "principal" as const,
      promptFragmentId: source.promptFragmentId,
      promptFragmentRevisionId: source.promptFragmentRevisionId,
      revision: source.revision,
      sha256: source.sha256,
    },
  };
}

export async function copyPromptFragment(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CopyPromptFragmentPayload;
  },
) {
  const requestSha256 = hashCanonical("command.copy-prompt-fragment.v1", input.payload);
  const replay = await readCommandReplay(deps, {
    commandId: input.commandId,
    commandType: "CopyPromptFragment",
    requestSha256,
    principalId: input.principalId,
  });
  if (replay !== undefined) return replay;
  const catalog = await requireCatalog(deps).load();
  const { source, content, derivedFrom } = await resolveCopySource(
    deps,
    catalog,
    input.principalId,
    input.payload,
  );
  assertScopeAllowed(deps, input.payload.destinationScope);
  const draft = {
    regionKey: source.regionKey,
    title: input.payload.title ?? `${source.title}（副本）`,
    ...(source.description !== undefined ? { description: source.description } : {}),
    content,
  };
  assertDraftAllowed(catalog, draft);
  const now = deps.now();
  const promptFragmentId = commandFragmentId(input.commandId);
  const revision = await buildRevision(deps, {
    promptFragmentId,
    promptFragmentRevisionId: commandRevisionId(input.commandId, promptFragmentId),
    revision: 1,
    draft,
    scope: input.payload.destinationScope,
    principalId: input.principalId,
    createdAt: now,
    derivedFrom,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CopyPromptFragment",
    requestSha256,
    mutate: (product) => {
      product.entities.promptFragmentRevisions[revision.promptFragmentRevisionId] = revision;
      product.entities.promptFragments[promptFragmentId] = promptFragmentSchema.parse({
        schemaVersion: "prompt-fragment.v1",
        promptFragmentId,
        ownerPrincipalId: input.principalId,
        scope: input.payload.destinationScope,
        status: "active",
        currentRevisionId: revision.promptFragmentRevisionId,
        currentRevisionNumber: 1,
        currentRevisionSha256: revision.sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      return {
        resultRefs: {
          promptFragmentId,
          promptFragmentRevisionId: revision.promptFragmentRevisionId,
        },
      };
    },
  });
  return readCommandResult(deps, result, input.principalId);
}

export async function revisePromptFragment(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly promptFragmentId: PromptFragmentId;
    readonly expectedRevision: number;
    readonly payload: RevisePromptFragmentPayload;
  },
) {
  const requestSha256 = hashCanonical("command.revise-prompt-fragment.v1", {
    promptFragmentId: input.promptFragmentId,
    expectedRevision: input.expectedRevision,
    payload: input.payload,
  });
  const replay = await readCommandReplay(deps, {
    commandId: input.commandId,
    commandType: "RevisePromptFragment",
    requestSha256,
    principalId: input.principalId,
  });
  if (replay !== undefined) return replay;
  const catalog = await requireCatalog(deps).load();
  assertDraftAllowed(catalog, input.payload.revision);
  const preflight = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const aggregate = ownedFragment(preflight.entities, input.promptFragmentId, input.principalId);
  const previous = currentRevision(preflight.entities, aggregate);
  const now = deps.now();
  const next = await buildRevision(deps, {
    promptFragmentId: input.promptFragmentId,
    promptFragmentRevisionId: commandRevisionId(input.commandId, input.promptFragmentId),
    revision: previous.revision + 1,
    draft: input.payload.revision,
    scope: aggregate.scope,
    principalId: input.principalId,
    createdAt: now,
    supersedes: previous,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RevisePromptFragment",
    requestSha256,
    mutate: (draft) => {
      const current = ownedFragment(draft.entities, input.promptFragmentId, input.principalId);
      if (current.status !== "active") throw revisionConflict("已归档Prompt不能修订");
      if (
        current.revision !== input.expectedRevision ||
        current.currentRevisionId !== input.payload.currentRevisionId ||
        current.currentRevisionSha256 !== input.payload.currentRevisionSha256
      ) {
        throw revisionConflict("Prompt Fragment已变化，请刷新后重试");
      }
      draft.entities.promptFragmentRevisions[next.promptFragmentRevisionId] = next;
      draft.entities.promptFragments[input.promptFragmentId] = promptFragmentSchema.parse({
        ...current,
        currentRevisionId: next.promptFragmentRevisionId,
        currentRevisionNumber: next.revision,
        currentRevisionSha256: next.sha256,
        revision: current.revision + 1,
        updatedAt: now,
      });
      return {
        resultRefs: {
          promptFragmentId: input.promptFragmentId,
          promptFragmentRevisionId: next.promptFragmentRevisionId,
        },
      };
    },
  });
  return readCommandResult(deps, result, input.principalId);
}

export async function changePromptFragmentArchiveStatus(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly promptFragmentId: PromptFragmentId;
    readonly expectedRevision: number;
    readonly payload: ChangePromptFragmentArchiveStatusPayload;
  },
) {
  const now = deps.now();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ChangePromptFragmentArchiveStatus",
    requestSha256: hashCanonical("command.change-prompt-fragment-archive-status.v1", {
      promptFragmentId: input.promptFragmentId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
    }),
    mutate: (draft) => {
      const fragment = ownedFragment(draft.entities, input.promptFragmentId, input.principalId);
      if (
        fragment.revision !== input.expectedRevision ||
        fragment.currentRevisionId !== input.payload.currentRevisionId ||
        fragment.currentRevisionSha256 !== input.payload.currentRevisionSha256
      ) {
        throw revisionConflict("Prompt Fragment已变化，请刷新后重试");
      }
      if (fragment.status === input.payload.targetStatus) {
        throw revisionConflict("Prompt Fragment已处于目标状态");
      }
      draft.entities.promptFragments[input.promptFragmentId] = promptFragmentSchema.parse({
        ...fragment,
        status: input.payload.targetStatus,
        revision: fragment.revision + 1,
        updatedAt: now,
      });
      return {
        resultRefs: {
          promptFragmentId: input.promptFragmentId,
          promptFragmentRevisionId: fragment.currentRevisionId,
        },
      };
    },
  });
  return readCommandResult(deps, result, input.principalId);
}

function agentOverrideFragmentId(principalId: PrincipalId, agentKey: AgentKey): PromptFragmentId {
  return promptFragmentIdSchema.parse(
    `pfg_${hashCanonical("id.agent-profile-override.v2", { principalId, agentKey }).slice(0, 32)}`,
  );
}

/** v1只按agentKey分配ID；读取保留兼容，任何新写入都迁到Principal隔离的v2身份。 */
function legacyAgentOverrideFragmentId(agentKey: AgentKey): PromptFragmentId {
  return promptFragmentIdSchema.parse(`pfg_agentprofile${agentKey.replaceAll("_", "")}`);
}

function currentAgentOverride(
  snapshot: ProductSnapshot,
  principalId: PrincipalId,
  agentKey: AgentKey,
): PromptFragment | undefined {
  const current = snapshot.entities.promptFragments[agentOverrideFragmentId(principalId, agentKey)];
  if (current !== undefined) return current;
  const legacy = snapshot.entities.promptFragments[legacyAgentOverrideFragmentId(agentKey)];
  return legacy?.ownerPrincipalId === principalId ? legacy : undefined;
}

async function agentProfileProjection(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  agentKey: AgentKey,
  workspaceRootId?: string,
): Promise<AgentProfileDto> {
  const catalog = await requireCatalog(deps).load();
  const definition = catalog.agents.find((agent) => agent.agentKey === agentKey);
  if (definition === undefined) throw notFound("Agent不存在");
  const runtimeBaseline = await deps.agentRuntimeProfiles?.read(agentKey, workspaceRootId);
  const defaultPrompt = definition.defaultPrompt;
  const builtinRevisionId = defaultPrompt.promptFragmentRevisionId;
  const builtin =
    builtinRevisionId !== undefined
      ? catalog.builtinFragments.find(
          (fragment) => fragment.promptFragmentRevisionId === builtinRevisionId,
        )
      : undefined;
  if (
    builtinRevisionId !== undefined &&
    (builtin === undefined || builtin.content.kind !== "markdown")
  ) {
    throw new Error(`Agent ${agentKey} 默认System Prompt不存在`);
  }
  const runtimeVariant =
    defaultPrompt.kind === "pi_coding_agent"
      ? runtimeBaseline?.variants.find(
          (variant) => variant.variantKey === defaultPrompt.defaultVariantKey,
        )
      : undefined;
  if (defaultPrompt.kind === "pi_coding_agent" && runtimeVariant === undefined) {
    throw new Error(`Agent ${agentKey} Pi运行时默认变体不存在`);
  }
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const versions = Object.values(snapshot.entities.agentVersions)
    .filter(
      (version) =>
        version.ownerPrincipalId === principalId &&
        version.agentKey === agentKey &&
        (version.scope.kind === "global" || version.scope.rootId === workspaceRootId),
    )
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.version - left.version,
    );
  const aggregate = currentAgentOverride(snapshot, principalId, agentKey);
  const customRevision =
    aggregate === undefined
      ? undefined
      : snapshot.entities.promptFragmentRevisions[aggregate.currentRevisionId];
  const customFile =
    aggregate === undefined || customRevision === undefined
      ? undefined
      : await readPromptFileProjection(deps, aggregate, customRevision);
  const customContent =
    customFile?.content ??
    (customRevision?.schemaVersion === "prompt-fragment-revision.v1"
      ? customRevision.content
      : undefined);
  const useCustom =
    aggregate?.status === "active" &&
    customRevision !== undefined &&
    customContent?.kind === "markdown";
  const builtinBodyMarkdown =
    builtin?.content.kind === "markdown" ? builtin.content.bodyMarkdown : undefined;
  // Pi-backed Agent的默认Tool描述必须来自构造System Prompt时使用的同一个真实
  // AgentSession投影，不能让Catalog里的一份手写摘要再次成为第二事实源。Catalog
  // 只补充Pi基线之外、由Chat显式注册的产品Tool（例如项目初始化候选Tool）。
  const runtimeTools = runtimeVariant?.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
  const runtimeToolNames = new Set(runtimeTools?.map((tool) => tool.name) ?? []);
  const projectedTools = [
    ...(runtimeTools ?? []),
    ...definition.tools.filter((tool) => !runtimeToolNames.has(tool.name)),
  ];
  return agentProfileDtoSchema.parse({
    schemaVersion: AGENT_PROFILE_API_SCHEMA_VERSION,
    agentKey,
    title: definition.title,
    description: definition.description,
    profileVersion: definition.profileVersion,
    supportedNodeTypes: definition.supportedNodeTypes,
    systemPrompt: useCustom
      ? {
          source: "principal_override",
          mode: "replace",
          promptFragmentId: customRevision.promptFragmentId,
          promptFragmentRevisionId: customRevision.promptFragmentRevisionId,
          revision: customRevision.revision,
          aggregateRevision: aggregate.revision,
          sha256: customRevision.sha256,
          bodyMarkdown: customContent.bodyMarkdown,
          sourceRelativePath:
            customFile?.sourceRelativePath ??
            (customRevision.schemaVersion === "prompt-fragment-revision.v2"
              ? customRevision.contentRef.sourceRelativePath
              : `legacy/${customRevision.promptFragmentRevisionId}.md`),
        }
      : builtin !== undefined
        ? {
            source: "builtin",
            mode: "replace",
            promptFragmentId: builtin!.promptFragmentId,
            promptFragmentRevisionId: builtin!.promptFragmentRevisionId,
            revision: builtin!.revision,
            aggregateRevision: aggregate?.revision ?? 0,
            sha256: builtin!.sha256,
            bodyMarkdown: builtinBodyMarkdown!,
            sourceRelativePath: builtin!.sourceRelativePath,
          }
        : {
            source: "runtime_default",
            mode: "inherit",
            aggregateRevision: aggregate?.revision ?? 0,
            sha256: runtimeVariant!.piSystemPrompt.sha256,
            bodyMarkdown: runtimeVariant!.piSystemPrompt.bodyMarkdown,
            runtimeVariantKey: runtimeVariant!.variantKey,
            sourceRelativePaths: runtimeVariant!.piSystemPrompt.sourceRelativePaths,
          },
    ...(runtimeBaseline === undefined ? {} : { runtimeBaseline }),
    tools: projectedTools.map((tool) => ({
      ...tool,
      policy:
        runtimeBaseline === undefined ? ("runtime_locked" as const) : ("runtime_default" as const),
    })),
    versions,
    allowedActions: [
      "revise_prompt",
      ...(useCustom ? (["restore_default"] as const) : []),
      ...(runtimeBaseline !== undefined && agentKey === "direct"
        ? (["create_version"] as const)
        : []),
    ],
  });
}

/**
 * 保存完整Agent配置时始终新增不可变Version；内置Agent Catalog和已有Version都不被覆盖。
 * Workflow/Session/Run只引用Version ID+Hash，实际执行前仍会重新校验Runtime基线。
 */
export async function createAgentVersion(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly agentKey: AgentKey;
    readonly payload: CreateAgentVersionPayload;
  },
) {
  assertScopeAllowed(deps, input.payload.scope);
  const workspaceRootId =
    input.payload.scope.kind === "workspace" ? input.payload.scope.rootId : undefined;
  const profile = await agentProfileProjection(
    deps,
    input.principalId,
    input.agentKey,
    workspaceRootId,
  );
  if (input.agentKey !== "direct") {
    throw forbidden("当前Agent节点尚未接入可执行的Agent Version消费链");
  }
  const runtimeBaseline = profile.runtimeBaseline;
  if (runtimeBaseline === undefined || runtimeBaseline.kind !== "pi_coding_agent") {
    throw forbidden("当前Agent Runtime尚不支持完整版本管理");
  }
  const runtimeVariant = runtimeBaseline.variants.find(
    (variant) => variant.variantKey === input.payload.runtime.baseVariantKey,
  );
  if (runtimeVariant === undefined) {
    throw revisionConflict("Agent Version引用的Pi运行基线不存在或已经变化");
  }
  const selectedToolNames = new Set(input.payload.enabledToolNames);
  const orderedSelectedTools = runtimeVariant.tools
    .map((tool) => tool.name)
    .filter((toolName) => selectedToolNames.has(toolName));
  if (
    orderedSelectedTools.length !== input.payload.enabledToolNames.length ||
    JSON.stringify(orderedSelectedTools) !== JSON.stringify(input.payload.enabledToolNames)
  ) {
    throw revisionConflict("Agent Version包含当前Pi目录不存在的Tool，或Tool顺序已经变化");
  }
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const base =
    input.payload.basedOnVersionId === undefined
      ? undefined
      : snapshot.entities.agentVersions[input.payload.basedOnVersionId];
  if (
    base !== undefined &&
    (base.ownerPrincipalId !== input.principalId ||
      base.agentKey !== input.agentKey ||
      base.sha256 !== input.payload.basedOnVersionSha256 ||
      JSON.stringify(base.scope) !== JSON.stringify(input.payload.scope))
  ) {
    throw revisionConflict("派生的Agent Version身份、所有者、Scope或Hash不匹配");
  }
  if (input.payload.basedOnVersionId !== undefined && base === undefined) {
    throw notFound("派生的Agent Version不存在");
  }
  const now = deps.now();
  const agentVersionId = agentVersionIdSchema.parse(
    `avn_${hashCanonical("id.agent-version.v1", {
      commandId: input.commandId,
      agentKey: input.agentKey,
    }).slice(0, 32)}`,
  );
  const versionNumber =
    Math.max(
      0,
      ...Object.values(snapshot.entities.agentVersions)
        .filter(
          (version) =>
            version.ownerPrincipalId === input.principalId && version.agentKey === input.agentKey,
        )
        .map((version) => version.version),
    ) + 1;
  const systemPrompt =
    input.payload.systemPrompt.mode === "inherit_runtime"
      ? ({ mode: "inherit_runtime" } as const)
      : ({
          mode: "replace" as const,
          bodyMarkdown: input.payload.systemPrompt.bodyMarkdown,
          sha256: hashCanonical("agent-system-prompt.v1", {
            bodyMarkdown: input.payload.systemPrompt.bodyMarkdown,
          }),
        } as const);
  const hashInput = agentVersionHashInputSchema.parse({
    schemaVersion: AGENT_VERSION_SCHEMA_VERSION,
    agentVersionId,
    agentKey: input.agentKey,
    ownerPrincipalId: input.principalId,
    scope: input.payload.scope,
    version: versionNumber,
    title: input.payload.title,
    description: input.payload.description,
    runtime: input.payload.runtime,
    baselineRef: {
      packageName: runtimeBaseline.packageName,
      packageVersion: runtimeBaseline.packageVersion,
      managedSource: runtimeBaseline.managedSource,
      managedSourceRevision: runtimeBaseline.managedSourceRevision,
      variantKey: runtimeVariant.variantKey,
      capabilityCatalogSha256: runtimeVariant.capabilityCatalogSha256,
    },
    systemPrompt,
    enabledToolNames: input.payload.enabledToolNames,
    resources: input.payload.resources,
    ...(base === undefined ? {} : { basedOnVersionId: base.agentVersionId }),
    createdAt: now,
  });
  const version = agentVersionSchema.parse({
    ...hashInput,
    sha256: hashCanonical("agent-version.v1", hashInput),
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateAgentVersion",
    requestSha256: hashCanonical("command.create-agent-version.v1", {
      agentKey: input.agentKey,
      payload: input.payload,
    }),
    mutate: (draft) => {
      const currentNextVersion =
        Math.max(
          0,
          ...Object.values(draft.entities.agentVersions)
            .filter(
              (candidate) =>
                candidate.ownerPrincipalId === input.principalId &&
                candidate.agentKey === input.agentKey,
            )
            .map((candidate) => candidate.version),
        ) + 1;
      if (currentNextVersion !== version.version) {
        throw revisionConflict("Agent版本序号已经变化，请刷新后重新保存");
      }
      draft.entities.agentVersions[version.agentVersionId] = version;
      return { resultRefs: { agentVersionId: version.agentVersionId } };
    },
  });
  return agentProfileProjection(deps, input.principalId, input.agentKey, workspaceRootId);
}

export async function listAgentProfiles(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly workspaceRootId?: string | undefined },
) {
  if (input.workspaceRootId !== undefined) {
    assertScopeAllowed(deps, { kind: "workspace", rootId: input.workspaceRootId });
  }
  const catalog = await requireCatalog(deps).load();
  return agentProfilesDtoSchema.parse({
    schemaVersion: AGENT_PROFILE_API_SCHEMA_VERSION,
    items: await Promise.all(
      catalog.agents.map((agent) =>
        agentProfileProjection(deps, input.principalId, agent.agentKey, input.workspaceRootId),
      ),
    ),
  });
}

export async function getAgentProfile(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly agentKey: AgentKey;
    readonly workspaceRootId?: string | undefined;
  },
) {
  if (input.workspaceRootId !== undefined) {
    assertScopeAllowed(deps, { kind: "workspace", rootId: input.workspaceRootId });
  }
  return agentProfileProjection(deps, input.principalId, input.agentKey, input.workspaceRootId);
}

export async function reviseAgentPrompt(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly agentKey: AgentKey;
    readonly payload: ReviseAgentPromptPayload;
  },
) {
  const requestSha256 = hashCanonical("command.revise-agent-prompt.v1", {
    agentKey: input.agentKey,
    payload: input.payload,
  });
  const commandType = "ReviseAgentPrompt";
  const before = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const priorReceipt = before.commandReceipts[input.commandId];
  if (priorReceipt !== undefined) {
    if (priorReceipt.commandType !== commandType || priorReceipt.requestSha256 !== requestSha256) {
      throw new CommandIdReusedError(input.commandId);
    }
    return agentProfileProjection(deps, input.principalId, input.agentKey);
  }
  const catalog = await requireCatalog(deps).load();
  const definition = catalog.agents.find((agent) => agent.agentKey === input.agentKey);
  if (definition === undefined) throw notFound("Agent不存在");
  const defaultPrompt = definition.defaultPrompt;
  const builtinRevisionId = defaultPrompt.promptFragmentRevisionId;
  const builtin =
    builtinRevisionId !== undefined
      ? catalog.builtinFragments.find(
          (fragment) => fragment.promptFragmentRevisionId === builtinRevisionId,
        )
      : undefined;
  if (builtinRevisionId !== undefined && builtin === undefined) {
    throw new Error("Agent默认System Prompt不存在");
  }
  const promptFragmentId = agentOverrideFragmentId(input.principalId, input.agentKey);
  const existing = before.entities.promptFragments[promptFragmentId];
  const legacy = before.entities.promptFragments[legacyAgentOverrideFragmentId(input.agentKey)];
  const effectiveExisting =
    existing ?? (legacy?.ownerPrincipalId === input.principalId ? legacy : undefined);
  if ((effectiveExisting?.revision ?? 0) !== input.payload.expectedAggregateRevision) {
    throw revisionConflict("Agent Prompt已经变化，请刷新后重试");
  }
  const previous =
    existing === undefined
      ? undefined
      : before.entities.promptFragmentRevisions[existing.currentRevisionId];
  const legacyRevision =
    existing === undefined && effectiveExisting !== undefined
      ? before.entities.promptFragmentRevisions[effectiveExisting.currentRevisionId]
      : undefined;
  const observedRevision = previous ?? legacyRevision;
  if (
    observedRevision !== undefined &&
    (input.payload.currentRevisionId !== undefined ||
      input.payload.currentRevisionSha256 !== undefined) &&
    (observedRevision.promptFragmentRevisionId !== input.payload.currentRevisionId ||
      observedRevision.sha256 !== input.payload.currentRevisionSha256)
  ) {
    throw revisionConflict("Agent Prompt Revision已经变化，请刷新后重试");
  }
  const now = deps.now();
  const next = await buildRevision(deps, {
    promptFragmentId,
    promptFragmentRevisionId: commandRevisionId(input.commandId, promptFragmentId),
    revision: (previous?.revision ?? 0) + 1,
    draft: {
      regionKey: "agent_identity",
      title: `${definition.title} · System Prompt`,
      description: `${definition.title}的用户可管理身份与长期职责；安全运行契约保持锁定。`,
      content: { kind: "markdown", bodyMarkdown: input.payload.bodyMarkdown },
    },
    scope: { kind: "global" },
    principalId: input.principalId,
    createdAt: now,
    ...(previous === undefined ? {} : { supersedes: previous }),
    ...(previous !== undefined
      ? {}
      : legacyRevision !== undefined
        ? {
            derivedFrom: {
              kind: "principal" as const,
              promptFragmentId: legacyRevision.promptFragmentId,
              promptFragmentRevisionId: legacyRevision.promptFragmentRevisionId,
              revision: legacyRevision.revision,
              sha256: legacyRevision.sha256,
            },
          }
        : builtin !== undefined
          ? {
              derivedFrom: {
                kind: "builtin" as const,
                promptFragmentId: builtin.promptFragmentId,
                promptFragmentRevisionId: builtin.promptFragmentRevisionId,
                revision: builtin.revision,
                sha256: builtin.sha256,
                sourceRelativePath: builtin.sourceRelativePath,
              },
            }
          : {}),
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType,
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.promptFragments[promptFragmentId];
      const currentLegacy =
        current === undefined
          ? draft.entities.promptFragments[legacyAgentOverrideFragmentId(input.agentKey)]
          : undefined;
      const effectiveCurrent =
        current ??
        (currentLegacy?.ownerPrincipalId === input.principalId ? currentLegacy : undefined);
      if ((effectiveCurrent?.revision ?? 0) !== input.payload.expectedAggregateRevision) {
        throw revisionConflict("Agent Prompt已经变化，请刷新后重试");
      }
      draft.entities.promptFragmentRevisions[next.promptFragmentRevisionId] = next;
      draft.entities.promptFragments[promptFragmentId] = promptFragmentSchema.parse({
        schemaVersion: "prompt-fragment.v1",
        promptFragmentId,
        ownerPrincipalId: input.principalId,
        scope: { kind: "global" },
        status: "active",
        currentRevisionId: next.promptFragmentRevisionId,
        currentRevisionNumber: next.revision,
        currentRevisionSha256: next.sha256,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      if (current === undefined && currentLegacy?.ownerPrincipalId === input.principalId) {
        draft.entities.promptFragments[currentLegacy.promptFragmentId] = promptFragmentSchema.parse(
          {
            ...currentLegacy,
            status: "archived",
            revision: currentLegacy.revision + 1,
            updatedAt: now,
          },
        );
      }
      return {
        resultRefs: {
          promptFragmentId,
          promptFragmentRevisionId: next.promptFragmentRevisionId,
        },
      };
    },
  });
  return agentProfileProjection(deps, input.principalId, input.agentKey);
}

export async function restoreAgentPrompt(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly agentKey: AgentKey;
    readonly payload: RestoreAgentPromptPayload;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const active = currentAgentOverride(snapshot, input.principalId, input.agentKey);
  if (active === undefined) throw notFound("Agent Prompt Override不存在");
  const promptFragmentId = active.promptFragmentId;
  await changePromptFragmentArchiveStatus(deps, {
    principalId: input.principalId,
    commandId: input.commandId,
    promptFragmentId,
    expectedRevision: input.payload.expectedAggregateRevision,
    payload: {
      currentRevisionId: input.payload.currentRevisionId,
      currentRevisionSha256: input.payload.currentRevisionSha256,
      targetStatus: "archived",
    },
  });
  return agentProfileProjection(deps, input.principalId, input.agentKey);
}
