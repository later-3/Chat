import {
  PROMPT_STUDIO_API_SCHEMA_VERSION,
  promptFragmentCommandResultDtoSchema,
  promptFragmentDetailDtoSchema,
  promptFragmentPageDtoSchema,
  promptFragmentRevisionDetailDtoSchema,
  promptFragmentRevisionSchema,
  promptFragmentSchema,
  promptRegionsDtoSchema,
  type ChangePromptFragmentArchiveStatusPayload,
  type CommandId,
  type CopyPromptFragmentPayload,
  type CreatePromptFragmentPayload,
  type ListPromptFragmentsQuery,
  type PrincipalId,
  type PromptFragment,
  type PromptFragmentContent,
  type PromptFragmentDraftPayload,
  type PromptFragmentId,
  type PromptFragmentRevision,
  type PromptFragmentRevisionId,
  type RevisePromptFragmentPayload,
} from "@chat/contracts";
import {
  assertPromptFragmentContent,
  computePromptFragmentRevisionSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps, PromptFragmentIdFactory } from "./deps.js";
import type {
  BuiltinPromptFragmentRevision,
  PromptCatalogSnapshot,
} from "./prompt-catalog-port.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";

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

function requireIds(deps: ApplicationDeps): PromptFragmentIdFactory {
  if (deps.promptFragmentIds === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Prompt Fragment ID工厂未配置",
    });
  }
  return deps.promptFragmentIds;
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
  if (region.contentKind !== draft.content.kind) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: `Prompt Region ${region.regionKey} 要求${region.contentKind}内容`,
    });
  }
  assertPromptFragmentContent(draft.content);
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

function builtinSummary(fragment: BuiltinPromptFragmentRevision) {
  return {
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragmentId: fragment.promptFragmentId,
    ownerKind: "system" as const,
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

function userSummary(fragment: PromptFragment, revision: PromptFragmentRevision) {
  return {
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragmentId: fragment.promptFragmentId,
    ownerKind: "principal" as const,
    status: fragment.status,
    regionKey: revision.regionKey,
    title: revision.title,
    ...(revision.description !== undefined ? { description: revision.description } : {}),
    contentKind: contentKind(revision.content),
    currentRevisionId: revision.promptFragmentRevisionId,
    currentRevisionNumber: revision.revision,
    currentRevisionSha256: revision.sha256,
    revision: fragment.revision,
    updatedAt: fragment.updatedAt,
    allowedActions:
      fragment.status === "active" ? (["revise", "archive"] as const) : (["restore"] as const),
  };
}

function revisionDetail(
  revision: PromptFragmentRevision | BuiltinPromptFragmentRevision,
  ownerKind: "system" | "principal",
) {
  return promptFragmentRevisionDetailDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    promptFragmentId: revision.promptFragmentId,
    promptFragmentRevisionId: revision.promptFragmentRevisionId,
    ownerKind,
    revision: revision.revision,
    regionKey: revision.regionKey,
    title: revision.title,
    ...(revision.description !== undefined ? { description: revision.description } : {}),
    content: revision.content,
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
    ...(ownerKind === "system" && "sourceRelativePath" in revision
      ? { sourceRelativePath: revision.sourceRelativePath }
      : {}),
  });
}

function builtinDetail(fragment: BuiltinPromptFragmentRevision) {
  return promptFragmentDetailDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    fragment: builtinSummary(fragment),
    currentRevision: revisionDetail(fragment, "system"),
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

function userDetail(
  entities: {
    readonly promptFragmentRevisions: Record<string, PromptFragmentRevision>;
  },
  fragment: PromptFragment,
) {
  const revision = currentRevision(entities, fragment);
  const revisions = Object.values(entities.promptFragmentRevisions)
    .filter((item) => item.promptFragmentId === fragment.promptFragmentId)
    .sort((left, right) => right.revision - left.revision);
  return promptFragmentDetailDtoSchema.parse({
    schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
    fragment: userSummary(fragment, revision),
    currentRevision: revisionDetail(revision, "principal"),
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

export async function listPromptFragments(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly query: ListPromptFragmentsQuery },
) {
  const [catalog, { snapshot }] = await Promise.all([
    requireCatalog(deps).load(),
    deps.store.read({ kind: "committedSnapshot" }),
  ]);
  const builtin = catalog.builtinFragments.map(builtinSummary);
  const user = Object.values(snapshot.entities.promptFragments)
    .filter((fragment) => fragment.ownerPrincipalId === input.principalId)
    .map((fragment) => userSummary(fragment, currentRevision(snapshot.entities, fragment)));
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
  if (builtin !== undefined) return revisionDetail(builtin, "system");
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const revision = snapshot.entities.promptFragmentRevisions[input.promptFragmentRevisionId];
  if (revision === undefined) throw notFound("Prompt Fragment Revision不存在");
  ownedFragment(snapshot.entities, revision.promptFragmentId, input.principalId);
  return revisionDetail(revision, "principal");
}

function buildRevision(input: {
  readonly ids: PromptFragmentIdFactory;
  readonly promptFragmentId: PromptFragmentId;
  readonly revision: number;
  readonly draft: PromptFragmentDraftPayload;
  readonly principalId: PrincipalId;
  readonly createdAt: string;
  readonly supersedes?: PromptFragmentRevision | undefined;
  readonly derivedFrom?: PromptFragmentRevision["derivedFrom"] | undefined;
}): PromptFragmentRevision {
  const normalizedContent =
    input.draft.content.kind === "markdown"
      ? { kind: "markdown" as const, bodyMarkdown: input.draft.content.bodyMarkdown.trim() }
      : {
          kind: "key_value" as const,
          key: input.draft.content.key.trim(),
          valueMarkdown: input.draft.content.valueMarkdown.trim(),
        };
  const body = {
    promptFragmentId: input.promptFragmentId,
    revision: input.revision,
    regionKey: input.draft.regionKey,
    title: input.draft.title.trim(),
    ...(input.draft.description !== undefined
      ? { description: input.draft.description.trim() }
      : {}),
    content: normalizedContent,
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
    schemaVersion: "prompt-fragment-revision.v1",
    promptFragmentRevisionId: input.ids.revision(),
    ...body,
    sha256: computePromptFragmentRevisionSha256(body),
    createdAt: input.createdAt,
  });
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

export async function createPromptFragment(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreatePromptFragmentPayload;
  },
) {
  const ids = requireIds(deps);
  const catalog = await requireCatalog(deps).load();
  assertDraftAllowed(catalog, input.payload);
  const now = deps.now();
  const promptFragmentId = ids.fragment();
  const revision = buildRevision({
    ids,
    promptFragmentId,
    revision: 1,
    draft: input.payload,
    principalId: input.principalId,
    createdAt: now,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreatePromptFragment",
    requestSha256: hashCanonical("command.create-prompt-fragment.v1", input.payload),
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
  ownedFragment(snapshot.entities, source.promptFragmentId, principalId);
  if (source.sha256 !== payload.sourceSha256) throw revisionConflict("复制来源Prompt版本已变化");
  return {
    source,
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
  const ids = requireIds(deps);
  const catalog = await requireCatalog(deps).load();
  const { source, derivedFrom } = await resolveCopySource(
    deps,
    catalog,
    input.principalId,
    input.payload,
  );
  const draft = {
    regionKey: source.regionKey,
    title: input.payload.title ?? `${source.title}（副本）`,
    ...(source.description !== undefined ? { description: source.description } : {}),
    content: source.content,
  };
  assertDraftAllowed(catalog, draft);
  const now = deps.now();
  const promptFragmentId = ids.fragment();
  const revision = buildRevision({
    ids,
    promptFragmentId,
    revision: 1,
    draft,
    principalId: input.principalId,
    createdAt: now,
    derivedFrom,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CopyPromptFragment",
    requestSha256: hashCanonical("command.copy-prompt-fragment.v1", input.payload),
    mutate: (product) => {
      product.entities.promptFragmentRevisions[revision.promptFragmentRevisionId] = revision;
      product.entities.promptFragments[promptFragmentId] = promptFragmentSchema.parse({
        schemaVersion: "prompt-fragment.v1",
        promptFragmentId,
        ownerPrincipalId: input.principalId,
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
  const ids = requireIds(deps);
  const catalog = await requireCatalog(deps).load();
  assertDraftAllowed(catalog, input.payload.revision);
  const preflight = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const aggregate = ownedFragment(preflight.entities, input.promptFragmentId, input.principalId);
  const previous = currentRevision(preflight.entities, aggregate);
  const now = deps.now();
  const next = buildRevision({
    ids,
    promptFragmentId: input.promptFragmentId,
    revision: previous.revision + 1,
    draft: input.payload.revision,
    principalId: input.principalId,
    createdAt: now,
    supersedes: previous,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RevisePromptFragment",
    requestSha256: hashCanonical("command.revise-prompt-fragment.v1", {
      promptFragmentId: input.promptFragmentId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
    }),
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
