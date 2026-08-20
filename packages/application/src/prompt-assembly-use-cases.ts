import {
  DIRECT_PROMPT_COMPILER_VERSION,
  DIRECT_PROMPT_PROFILE_VERSION,
  PROMPT_ASSEMBLY_SCHEMA_VERSION,
  promptConfigurationPreviewDtoSchema,
  promptAssemblyIdSchema,
  promptAssemblyPreviewDtoSchema,
  promptAssemblySchema,
  type PrincipalId,
  type PromptAssembly,
  type PromptAssemblyFragment,
  type PromptAssemblyRegion,
  type PromptFragment,
  type PromptFragmentRevision,
  type PromptTurnSelectionInput,
  type ProductRunId,
  type ProductSnapshot,
  type ProductSessionId,
  type MessageId,
  type WorkflowDefinitionRevisionId,
} from "@chat/contracts";
import {
  computePromptAssemblyRegionSha256,
  computePromptAssemblySha256,
  hashCanonical,
  renderPromptAssemblyRegion,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";
import type {
  BuiltinPromptFragmentRevision,
  PromptCatalogSnapshot,
} from "./prompt-catalog-port.js";

/** Direct Profile的默认组件；精确Revision/Hash仍由Catalog在每次编译时解析。 */
export const DIRECT_PROMPT_PROFILE_DEFAULT_REVISION_IDS = [
  "pfr_builtinagentidentityv2",
  "pfr_builtintransparentdeliveryv1",
  "pfr_builtinevidencefirstv1",
  "pfr_builtinincrementaldeliveryv1",
] as const;

interface CompileContext {
  readonly principalId: PrincipalId;
  readonly selection: PromptTurnSelectionInput;
}

interface ResolvedSource {
  readonly fragment: PromptAssemblyFragment;
}

function requireCatalog(deps: ApplicationDeps) {
  if (deps.promptCatalog === undefined) throw new Error("Prompt Catalog未配置");
  return deps.promptCatalog;
}

function assertWorkspace(deps: ApplicationDeps, selection: PromptTurnSelectionInput): void {
  if (selection.workspaceRootId === undefined) return;
  if (!deps.projectRoots?.list().some((root) => root.rootId === selection.workspaceRootId)) {
    throw forbidden("Prompt选择绑定了未配置或未授权的Workspace");
  }
}

function builtinFragment(source: BuiltinPromptFragmentRevision): PromptAssemblyFragment {
  return {
    promptFragmentId: source.promptFragmentId,
    promptFragmentRevisionId: source.promptFragmentRevisionId,
    revision: source.revision,
    sha256: source.sha256,
    ownerKind: "system",
    scope: { kind: "global" },
    title: source.title,
    regionKey: source.regionKey,
    content: source.content,
    sourceRelativePath: source.sourceRelativePath,
    selectionKind: "explicit",
  };
}

function principalFragment(
  source: PromptFragmentRevision,
  aggregate: PromptFragment,
): PromptAssemblyFragment {
  return {
    promptFragmentId: source.promptFragmentId,
    promptFragmentRevisionId: source.promptFragmentRevisionId,
    revision: source.revision,
    sha256: source.sha256,
    ownerKind: "principal",
    scope: aggregate.scope,
    title: source.title,
    regionKey: source.regionKey,
    content: source.content,
    selectionKind: "explicit",
  };
}

async function sourcesFor(
  deps: ApplicationDeps,
  catalog: PromptCatalogSnapshot,
  context: CompileContext,
): Promise<Map<string, ResolvedSource>> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const sources = new Map<string, ResolvedSource>();
  for (const source of catalog.builtinFragments) {
    sources.set(source.promptFragmentRevisionId, { fragment: builtinFragment(source) });
  }
  for (const revision of Object.values(snapshot.entities.promptFragmentRevisions)) {
    const aggregate = snapshot.entities.promptFragments[revision.promptFragmentId];
    if (
      aggregate === undefined ||
      aggregate.ownerPrincipalId !== context.principalId ||
      aggregate.status !== "active"
    ) {
      continue;
    }
    sources.set(revision.promptFragmentRevisionId, {
      fragment: principalFragment(revision, aggregate),
    });
  }
  return sources;
}

function assertSourceVisible(
  source: PromptAssemblyFragment,
  selection: PromptTurnSelectionInput,
): void {
  if (source.scope.kind === "global") return;
  if (selection.workspaceRootId !== source.scope.rootId) {
    throw forbidden("不能把其他Workspace的Prompt组件用于当前会话");
  }
}

function regionDefaults(
  catalog: PromptCatalogSnapshot,
  regionKey: string,
): PromptAssemblyFragment[] {
  const allowed = new Set<string>(DIRECT_PROMPT_PROFILE_DEFAULT_REVISION_IDS);
  return catalog.builtinFragments
    .filter(
      (fragment) =>
        fragment.regionKey === regionKey && allowed.has(fragment.promptFragmentRevisionId),
    )
    .map((fragment) => ({ ...builtinFragment(fragment), selectionKind: "profile_default" }));
}

async function compileRegions(deps: ApplicationDeps, context: CompileContext) {
  assertWorkspace(deps, context.selection);
  const catalog = await requireCatalog(deps).load();
  const sources = await sourcesFor(deps, catalog, context);
  const requested = new Map(context.selection.regions.map((item) => [item.regionKey, item]));
  for (const key of requested.keys()) {
    const region = catalog.regions.find((item) => item.regionKey === key);
    if (region === undefined) throw notFound(`Prompt Region不存在:${key}`);
    if (!region.userManageable || region.availability !== "active") {
      throw forbidden(`Prompt Region不可由用户组装:${key}`);
    }
  }

  const regions: PromptAssemblyRegion[] = [];
  for (const region of catalog.regions
    .filter((item) => item.userManageable && item.availability === "active")
    .sort((left, right) => left.stableOrder - right.stableOrder)) {
    if (region.plannedPlacement !== "system" && region.plannedPlacement !== "messages") continue;
    const input = requested.get(region.regionKey) ?? {
      regionKey: region.regionKey,
      mode: "default" as const,
      selected: [],
    };
    const explicit = input.selected.map((ref) => {
      const resolved = sources.get(ref.promptFragmentRevisionId)?.fragment;
      if (resolved === undefined) throw notFound("Prompt Revision不存在、已归档或无权访问");
      if (resolved.sha256 !== ref.sha256) throw revisionConflict("Prompt Revision Hash已变化");
      if (resolved.regionKey !== region.regionKey) {
        throw revisionConflict("Prompt Revision与选择的Region不一致");
      }
      assertSourceVisible(resolved, context.selection);
      return resolved;
    });
    const defaults = regionDefaults(catalog, region.regionKey);
    const fragments =
      input.mode === "default"
        ? defaults
        : input.mode === "replace"
          ? explicit
          : [...defaults, ...explicit].filter(
              (fragment, index, all) =>
                all.findIndex(
                  (candidate) =>
                    candidate.promptFragmentRevisionId === fragment.promptFragmentRevisionId,
                ) === index,
            );
    const renderedText = renderPromptAssemblyRegion({
      regionKey: region.regionKey,
      title: region.title,
      fragments,
    });
    const shape = {
      regionKey: region.regionKey,
      title: region.title,
      placement: region.plannedPlacement,
      mode: input.mode,
      fragments,
      renderedText,
    } as const;
    regions.push({ ...shape, sha256: computePromptAssemblyRegionSha256(shape) });
  }

  const systemPromptAppend = regions
    .filter((region) => region.placement === "system" && region.renderedText !== "")
    .map((region) => region.renderedText)
    .join("\n\n");
  const messageContext = regions
    .filter((region) => region.placement === "messages" && region.renderedText !== "")
    .map((region) => region.renderedText)
    .join("\n\n");
  return { regions, systemPromptAppend, messageContext };
}

function userPromptFor(messageContext: string, text: string): string {
  return [
    ...(messageContext === "" ? [] : ["# Chat 提示词上下文", messageContext]),
    "# 当前输入 [current_input]",
    text,
  ].join("\n\n");
}

export async function previewDirectPromptConfiguration(
  deps: ApplicationDeps,
  input: CompileContext,
) {
  const configuration = await compileRegions(deps, input);
  return promptConfigurationPreviewDtoSchema.parse({
    schemaVersion: "chat-prompt-studio-api.v1",
    profileVersion: DIRECT_PROMPT_PROFILE_VERSION,
    compilerVersion: DIRECT_PROMPT_COMPILER_VERSION,
    ...configuration,
    sha256: hashCanonical("prompt-configuration-preview.v1", {
      selection: input.selection,
      ...configuration,
    }),
  });
}

export async function previewDirectPromptAssembly(
  deps: ApplicationDeps,
  input: CompileContext & { readonly text: string },
) {
  const configuration = await compileRegions(deps, input);
  const draft = {
    regions: configuration.regions,
    systemPromptAppend: configuration.systemPromptAppend,
    userPrompt: userPromptFor(configuration.messageContext, input.text),
  };
  return promptAssemblyPreviewDtoSchema.parse({
    schemaVersion: "chat-prompt-studio-api.v1",
    profileVersion: DIRECT_PROMPT_PROFILE_VERSION,
    compilerVersion: DIRECT_PROMPT_COMPILER_VERSION,
    ...draft,
    sha256: hashCanonical("prompt-assembly-preview.v1", {
      selection: input.selection,
      text: input.text,
      ...draft,
    }),
  });
}

export async function compileDirectPromptAssembly(
  deps: ApplicationDeps,
  input: CompileContext & {
    readonly text: string;
    readonly productSessionId: ProductSessionId;
    readonly productRunId: ProductRunId;
    readonly sourceMessageId: MessageId;
    readonly workflowDefinitionRevisionId: WorkflowDefinitionRevisionId;
    readonly createdAt: string;
  },
): Promise<PromptAssembly> {
  const configuration = await compileRegions(deps, input);
  const draft = {
    regions: configuration.regions,
    systemPromptAppend: configuration.systemPromptAppend,
    userPrompt: userPromptFor(configuration.messageContext, input.text),
  };
  const promptAssemblyId = promptAssemblyIdSchema.parse(
    `pma_${hashCanonical("id.prompt-assembly.v1", { productRunId: input.productRunId }).slice(0, 32)}`,
  );
  const body = {
    promptAssemblyId,
    productSessionId: input.productSessionId,
    productRunId: input.productRunId,
    sourceMessageId: input.sourceMessageId,
    workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
    profileVersion: DIRECT_PROMPT_PROFILE_VERSION,
    compilerVersion: DIRECT_PROMPT_COMPILER_VERSION,
    ...(input.selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: input.selection.workspaceRootId }),
    ...draft,
  } as const;
  return promptAssemblySchema.parse({
    schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
    ...body,
    sha256: computePromptAssemblySha256(body),
    createdAt: input.createdAt,
  });
}

/** SubmitUserMessage事务内再次校验用户Revision仍存在、可用且与预编译快照一致。 */
export function assertPromptAssemblySourcesCurrent(
  snapshot: ProductSnapshot,
  assembly: PromptAssembly,
  principalId: PrincipalId,
): void {
  for (const fragment of assembly.regions.flatMap((region) => region.fragments)) {
    if (fragment.ownerKind === "system") continue;
    const revision = snapshot.entities.promptFragmentRevisions[fragment.promptFragmentRevisionId];
    const aggregate = snapshot.entities.promptFragments[fragment.promptFragmentId];
    if (
      revision === undefined ||
      aggregate === undefined ||
      aggregate.ownerPrincipalId !== principalId ||
      aggregate.status !== "active" ||
      revision.promptFragmentId !== aggregate.promptFragmentId ||
      revision.sha256 !== fragment.sha256 ||
      JSON.stringify(aggregate.scope) !== JSON.stringify(fragment.scope)
    ) {
      throw revisionConflict("Prompt Assembly来源已变化，请重新预览后发送");
    }
  }
}
