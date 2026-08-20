import {
  DIRECT_PROMPT_COMPILER_V2_VERSION,
  DIRECT_PROMPT_INPUT_TOKEN_LIMIT,
  DIRECT_PROMPT_METER_VERSION,
  DIRECT_PROMPT_PROFILE_V2_VERSION,
  DIRECT_PROMPT_TOOL_TOKEN_RESERVE,
  PROMPT_ASSEMBLY_V2_SCHEMA_VERSION,
  promptConfigurationPreviewDtoSchema,
  promptAssemblyIdSchema,
  promptAssemblyPreviewDtoSchema,
  promptAssemblySchema,
  type PrincipalId,
  type PromptAssembly,
  type PromptAssemblyV2,
  type PromptAssemblyFragment,
  type PromptAssemblyRegion,
  type PromptFragment,
  type PromptFragmentContent,
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
  computePromptAssemblyV2Sha256,
  computeMessageSha256,
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

/**
 * V2先使用保守统一Meter；它用于确定性预算而不是冒充Provider精确Tokenizer。
 * Tool Schema在Pi中生成，因此Application为固定read-only Profile预留独立预算。
 */
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
    scope: source.scope,
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
  content: PromptFragmentContent,
  sourceRelativePath?: string,
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
    content,
    ...(sourceRelativePath === undefined ? {} : { sourceRelativePath }),
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
    let content: PromptFragmentContent;
    let sourceRelativePath: string | undefined;
    if (revision.schemaVersion === "prompt-fragment-revision.v1") {
      content = revision.content;
      const file =
        deps.promptFiles === undefined
          ? undefined
          : await deps.promptFiles.publishRevision({
              promptFragmentId: revision.promptFragmentId,
              promptFragmentRevisionId: revision.promptFragmentRevisionId,
              revision: revision.revision,
              regionKey: revision.regionKey,
              title: revision.title,
              ...(revision.description === undefined ? {} : { description: revision.description }),
              scope: aggregate.scope,
              content: revision.content,
              contentSha256: hashCanonical("prompt-file-content.v1", revision.content),
              createdAt: revision.createdAt,
            });
      sourceRelativePath = file?.sourceRelativePath;
    } else {
      if (deps.promptFiles === undefined) throw new Error("Prompt Markdown文件库未配置");
      const file = await deps.promptFiles.readRevision({
        promptFragmentId: revision.promptFragmentId,
        promptFragmentRevisionId: revision.promptFragmentRevisionId,
        regionKey: revision.regionKey,
        scope: aggregate.scope,
        expectedContentSha256: revision.contentRef.contentSha256,
      });
      if (
        file.sourceRelativePath !== revision.contentRef.sourceRelativePath ||
        file.sourceSha256 !== revision.contentRef.sourceSha256 ||
        file.content.kind !== revision.contentRef.contentKind ||
        (file.content.kind === "key_value" && file.content.key !== revision.contentRef.key)
      ) {
        throw revisionConflict("Prompt Markdown文件与所选Revision证据不一致");
      }
      content = file.content;
      sourceRelativePath = file.sourceRelativePath;
    }
    sources.set(revision.promptFragmentRevisionId, {
      fragment: principalFragment(revision, aggregate, content, sourceRelativePath),
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
      // Prompt Library中的用户可管理组件统一成为命名System Section；真实交互只进入Messages。
      placement: "system" as const,
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
  const messageContext = "";
  return { regions, systemPromptAppend, messageContext };
}

function userPromptFor(messageContext: string, text: string): string {
  return messageContext === "" ? text : [messageContext, text].join("\n\n");
}

function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

function committedHistory(
  snapshot: ProductSnapshot,
  sessionId: ProductSessionId,
): Array<{
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly source: {
    readonly kind: "product_message";
    readonly messageId: MessageId;
    readonly sessionSequence: number;
    readonly sha256: string;
  };
  readonly estimatedTokens: number;
}> {
  const pairs = Object.values(snapshot.entities.runs)
    .filter(
      (run) =>
        run.sessionId === sessionId &&
        run.status === "succeeded" &&
        run.finalMessageId !== undefined,
    )
    .flatMap((run) => {
      const user = snapshot.entities.messages[run.sourceMessageId];
      const assistant =
        run.finalMessageId === undefined
          ? undefined
          : snapshot.entities.messages[run.finalMessageId];
      if (
        user?.role !== "user" ||
        assistant?.role !== "assistant" ||
        assistant.sourceRunId !== run.productRunId
      ) {
        return [];
      }
      return [{ user, assistant }];
    })
    .sort((left, right) => left.user.sessionSequence - right.user.sessionSequence);

  return pairs.flatMap(({ user, assistant }) =>
    [user, assistant].map((message) => ({
      role: message.role,
      text: message.content.text,
      source: {
        kind: "product_message" as const,
        messageId: message.messageId,
        sessionSequence: message.sessionSequence,
        sha256: computeMessageSha256(message),
      },
      estimatedTokens: estimatePromptTokens(message.content.text),
    })),
  );
}

function selectRecentHistory(input: {
  readonly candidates: ReturnType<typeof committedHistory>;
  readonly availableTokens: number;
}): {
  readonly selected: ReturnType<typeof committedHistory>;
  readonly excludedMessageIds: MessageId[];
} {
  const selectedPairs: Array<ReturnType<typeof committedHistory>> = [];
  let used = 0;
  for (let index = input.candidates.length - 2; index >= 0; index -= 2) {
    const pair = input.candidates.slice(index, index + 2);
    const tokens = pair.reduce((sum, message) => sum + message.estimatedTokens, 0);
    if (used + tokens > input.availableTokens) continue;
    selectedPairs.unshift(pair);
    used += tokens;
  }
  const selected = selectedPairs.flat();
  const included = new Set(selected.map((message) => message.source.messageId));
  return {
    selected,
    excludedMessageIds: input.candidates
      .filter((message) => !included.has(message.source.messageId))
      .map((message) => message.source.messageId),
  };
}

export async function previewDirectPromptConfiguration(
  deps: ApplicationDeps,
  input: CompileContext,
) {
  const configuration = await compileRegions(deps, input);
  return promptConfigurationPreviewDtoSchema.parse({
    schemaVersion: "chat-prompt-studio-api.v1",
    profileVersion: DIRECT_PROMPT_PROFILE_V2_VERSION,
    compilerVersion: DIRECT_PROMPT_COMPILER_V2_VERSION,
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
    profileVersion: DIRECT_PROMPT_PROFILE_V2_VERSION,
    compilerVersion: DIRECT_PROMPT_COMPILER_V2_VERSION,
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
    readonly sourceMessageSequence: number;
    readonly sourceMessageSha256: string;
    readonly workflowDefinitionRevisionId: WorkflowDefinitionRevisionId;
    readonly createdAt: string;
  },
): Promise<PromptAssemblyV2> {
  const configuration = await compileRegions(deps, input);
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const instructionsEstimatedTokens =
    configuration.systemPromptAppend === ""
      ? 0
      : estimatePromptTokens(configuration.systemPromptAppend);
  const currentEstimatedTokens = estimatePromptTokens(input.text);
  const mandatoryTokens =
    instructionsEstimatedTokens + currentEstimatedTokens + DIRECT_PROMPT_TOOL_TOKEN_RESERVE;
  if (mandatoryTokens > DIRECT_PROMPT_INPUT_TOKEN_LIMIT) {
    throw revisionConflict("Direct Prompt必需内容超过输入Token预算");
  }
  const history = selectRecentHistory({
    candidates: committedHistory(snapshot, input.productSessionId),
    availableTokens: DIRECT_PROMPT_INPUT_TOKEN_LIMIT - mandatoryTokens,
  });
  const messages = [
    ...history.selected,
    {
      role: "user" as const,
      text: input.text,
      source: {
        kind: "current_input" as const,
        messageId: input.sourceMessageId,
        sessionSequence: input.sourceMessageSequence,
        sha256: input.sourceMessageSha256,
      },
      estimatedTokens: currentEstimatedTokens,
    },
  ];
  const messagesEstimatedTokens = messages.reduce(
    (sum, message) => sum + message.estimatedTokens,
    0,
  );
  const tools = {
    capabilityMode: "read_only" as const,
    names: ["read", "grep", "find", "ls"] as const,
    estimatedTokens: DIRECT_PROMPT_TOOL_TOKEN_RESERVE,
  };
  const requestOptions = {
    providerId: "dashscope-coding" as const,
    modelId: "qwen3.7-plus" as const,
    thinkingLevel: "off" as const,
    retryEnabled: false as const,
    compactionEnabled: false as const,
  };
  const budget = {
    meterVersion: DIRECT_PROMPT_METER_VERSION,
    inputTokenLimit: DIRECT_PROMPT_INPUT_TOKEN_LIMIT,
    instructionsEstimatedTokens,
    messagesEstimatedTokens,
    toolsEstimatedTokens: tools.estimatedTokens,
    totalEstimatedTokens:
      instructionsEstimatedTokens + messagesEstimatedTokens + tools.estimatedTokens,
    excludedHistoryMessageIds: history.excludedMessageIds,
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
    profileVersion: DIRECT_PROMPT_PROFILE_V2_VERSION,
    compilerVersion: DIRECT_PROMPT_COMPILER_V2_VERSION,
    ...(input.selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: input.selection.workspaceRootId }),
    regions: configuration.regions,
    systemPromptAppend: configuration.systemPromptAppend,
    messages,
    tools,
    requestOptions,
    budget,
  } as const;
  return promptAssemblySchema.parse({
    schemaVersion: PROMPT_ASSEMBLY_V2_SCHEMA_VERSION,
    ...body,
    sha256: computePromptAssemblyV2Sha256({
      schemaVersion: PROMPT_ASSEMBLY_V2_SCHEMA_VERSION,
      ...body,
    }),
    createdAt: input.createdAt,
  }) as PromptAssemblyV2;
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
