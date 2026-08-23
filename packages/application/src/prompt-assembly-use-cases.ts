import {
  DIRECT_PROMPT_COMPILER_V2_VERSION,
  DIRECT_PROMPT_COMPILER_V3_VERSION,
  DIRECT_PROMPT_INPUT_TOKEN_LIMIT,
  DIRECT_PROMPT_METER_VERSION,
  DIRECT_PROMPT_PROFILE_V2_VERSION,
  DIRECT_PROMPT_TOOL_TOKEN_RESERVE,
  PROMPT_ASSEMBLY_V2_SCHEMA_VERSION,
  PROMPT_ASSEMBLY_V3_SCHEMA_VERSION,
  WORKFLOW_PROMPT_COMPILER_VERSION,
  WORKFLOW_PROMPT_PROFILE_VERSION,
  promptTurnSelectionInputV2Schema,
  agentTemporaryConfigurationSchema,
  promptConfigurationPreviewDtoSchema,
  promptAssemblyIdSchema,
  agentVersionIdSchema,
  promptFragmentIdSchema,
  promptFragmentRevisionIdSchema,
  promptAssemblyPreviewDtoSchema,
  promptAssemblySchema,
  type PrincipalId,
  type AgentKey,
  type AgentProfileDto,
  type AgentVersion,
  type AgentVersionId,
  type PromptAssembly,
  type PromptAssemblyV2,
  type PromptAssemblyV3,
  type PiSystemPromptResolution,
  type PromptBearingNodeType,
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
  type WorkflowNodeResolution,
  type WorkflowRunSpec,
} from "@chat/contracts";
import {
  computePromptAssemblyRegionSha256,
  computePromptAssemblyV2Sha256,
  computePromptAssemblyV3Sha256,
  computePromptNodeAssemblySha256,
  computeWorkflowNodePromptOverrideIdentitySha256,
  computeWorkflowNodePromptOverrideSha256,
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
import { resolveCurrentAgentRuntimeBinding } from "./agent-version-runtime-validation.js";
import { hasAmbiguousAgentConfiguration } from "./workflow-node-catalog.js";

/**
 * V2先使用保守统一Meter；它用于确定性预算而不是冒充Provider精确Tokenizer。
 * Tool Schema在Pi中生成，因此Application为固定read-only Profile预留独立预算。
 */
interface CompileContext {
  readonly principalId: PrincipalId;
  readonly selection: PromptTurnSelectionInput;
  readonly definitionNodeId?: string;
}

interface ResolvedSource {
  readonly fragment: PromptAssemblyFragment;
}

export function resolveAgentPiSystemPrompt(input: {
  readonly profile: AgentProfileDto;
  readonly agentVersion?: AgentVersion | undefined;
  readonly systemPromptMode?: "inherit_runtime" | "replace" | undefined;
  readonly promptOverrideMarkdown?: string | undefined;
}): {
  readonly override?: string | undefined;
  readonly useOverride: boolean;
  readonly inheritsPiDefault: boolean;
  readonly piSystemPrompt?: PiSystemPromptResolution | undefined;
} {
  const override = input.promptOverrideMarkdown;
  const useOverride = override !== undefined && override.trim() !== "";
  if (input.agentVersion !== undefined && useOverride) {
    throw revisionConflict("Agent Version与Prompt Override不能组合为同一次执行身份");
  }
  const piBacked = input.profile.runtimeBaseline?.kind === "pi_coding_agent";
  const inheritsPiDefault =
    piBacked &&
    !useOverride &&
    (input.systemPromptMode === "inherit_runtime" ||
      (input.agentVersion === undefined
        ? input.profile.systemPrompt.source === "runtime_default"
        : input.agentVersion.systemPrompt.mode === "inherit_runtime"));
  const replacementBody = useOverride
    ? override!
    : input.agentVersion?.systemPrompt.mode === "replace"
      ? input.agentVersion.systemPrompt.bodyMarkdown
      : input.profile.systemPrompt.bodyMarkdown;
  const piSystemPrompt: PiSystemPromptResolution | undefined = piBacked
    ? inheritsPiDefault
      ? { kind: "pi_coding_agent", mode: "inherit" }
      : {
          kind: "pi_coding_agent",
          mode: "replace",
          bodyMarkdown: replacementBody,
          sha256: hashCanonical("pi-system-prompt-override.v1", {
            bodyMarkdown: replacementBody,
          }),
        }
    : undefined;
  return {
    ...(override === undefined ? {} : { override }),
    useOverride,
    inheritsPiDefault,
    ...(piSystemPrompt === undefined ? {} : { piSystemPrompt }),
  };
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
  const allowed = new Set<string>(catalog.sharedSelectionProfile.defaultRevisionIds);
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
  const requested = context.selection.regions;
  for (const key of new Set(requested.map((item) => item.regionKey))) {
    const region = catalog.regions.find((item) => item.regionKey === key);
    if (region === undefined) throw notFound(`Prompt Region不存在:${key}`);
    if (
      !region.userManageable ||
      region.availability !== "active" ||
      region.category !== "context"
    ) {
      throw forbidden(`该区域不属于会话上下文Prompt:${key}`);
    }
  }

  const regions: PromptAssemblyRegion[] = [];
  for (const region of catalog.regions
    .filter(
      (item) =>
        item.userManageable && item.availability === "active" && item.category === "context",
    )
    .sort((left, right) => left.stableOrder - right.stableOrder)) {
    if (region.plannedPlacement !== "system" && region.plannedPlacement !== "messages") continue;
    const shared = context.selection.regions.find((item) => item.regionKey === region.regionKey);
    const input = shared ?? {
      regionKey: region.regionKey,
      mode: "default" as const,
      selected: [],
    };
    const resolveExplicit = (refs: typeof input.selected) =>
      refs.map((ref) => {
        const resolved = sources.get(ref.promptFragmentRevisionId)?.fragment;
        if (resolved === undefined) throw notFound("Prompt Revision不存在、已归档或无权访问");
        if (resolved.sha256 !== ref.sha256) throw revisionConflict("Prompt Revision Hash已变化");
        if (resolved.regionKey !== region.regionKey) {
          throw revisionConflict("Prompt Revision与选择的Region不一致");
        }
        assertSourceVisible(resolved, context.selection);
        return resolved;
      });
    const explicit = resolveExplicit(input.selected);
    const defaults = regionDefaults(catalog, region.regionKey);
    const sharedFragments =
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
    const fragments = sharedFragments;
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

async function compileAgentRegion(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  binding: {
    readonly agentKey: AgentKey;
    readonly definitionNodeId: string;
    readonly nodeType: PromptBearingNodeType;
    readonly workflowDefinitionRevisionId: WorkflowDefinitionRevisionId;
    readonly agentVersionId?: AgentVersionId | undefined;
    readonly agentVersionSha256?: string | undefined;
    readonly workspaceRootId?: string | undefined;
    readonly systemPromptMode?: "inherit_runtime" | "replace" | undefined;
    readonly promptOverrideMarkdown?: string | undefined;
  },
): Promise<{
  readonly agentKey: AgentKey;
  readonly profile: AgentProfileDto;
  readonly agentVersion?: AgentVersion | undefined;
  readonly runtimeProfileSha256?: string | undefined;
  readonly workspaceGrantSha256?: string | undefined;
  readonly region: PromptAssemblyRegion;
  readonly piSystemPrompt?: PiSystemPromptResolution | undefined;
}> {
  const currentRuntime = await resolveCurrentAgentRuntimeBinding(deps, {
    principalId,
    agentKey: binding.agentKey,
    ...(binding.agentVersionId === undefined
      ? {}
      : {
          agentVersionId: binding.agentVersionId,
          agentVersionSha256: binding.agentVersionSha256,
        }),
    ...(binding.workspaceRootId === undefined ? {} : { workspaceRootId: binding.workspaceRootId }),
  });
  const { profile, agentVersion } = currentRuntime;
  const expectedProfileVersion = AGENT_PROFILE_VERSION_BY_KEY[binding.agentKey];
  if (profile.profileVersion !== expectedProfileVersion) {
    throw new Error(
      `Agent Profile版本与编译器不一致:${binding.agentKey}:${profile.profileVersion}`,
    );
  }
  if (!profile.supportedNodeTypes.includes(binding.nodeType)) {
    throw revisionConflict(`Agent ${binding.agentKey}不支持节点类型${binding.nodeType}`);
  }
  const { override, useOverride, inheritsPiDefault, piSystemPrompt } = resolveAgentPiSystemPrompt({
    profile,
    ...(agentVersion === undefined ? {} : { agentVersion }),
    ...(binding.systemPromptMode === undefined
      ? {}
      : { systemPromptMode: binding.systemPromptMode }),
    ...(binding.promptOverrideMarkdown === undefined
      ? {}
      : { promptOverrideMarkdown: binding.promptOverrideMarkdown }),
  });
  const overrideIdentity = computeWorkflowNodePromptOverrideIdentitySha256({
    workflowDefinitionRevisionId: binding.workflowDefinitionRevisionId,
    definitionNodeId: binding.definitionNodeId,
  });
  const resolvedOverride = useOverride ? override! : undefined;
  const overrideSha256 = useOverride
    ? computeWorkflowNodePromptOverrideSha256({
        workflowDefinitionRevisionId: binding.workflowDefinitionRevisionId,
        definitionNodeId: binding.definitionNodeId,
        nodeType: binding.nodeType,
        bodyMarkdown: resolvedOverride!,
      })
    : undefined;
  const versionPromptIdentity =
    agentVersion?.systemPrompt.mode === "replace"
      ? hashCanonical("id.agent-version-system-prompt.v1", {
          agentVersionId: agentVersion.agentVersionId,
          agentVersionSha256: agentVersion.sha256,
        })
      : undefined;
  const fragment: PromptAssemblyFragment | undefined = inheritsPiDefault
    ? undefined
    : useOverride
      ? {
          promptFragmentId: promptFragmentIdSchema.parse(`pfg_${overrideIdentity.slice(0, 32)}`),
          promptFragmentRevisionId: promptFragmentRevisionIdSchema.parse(
            `pfr_${overrideSha256?.slice(0, 32) ?? ""}`,
          ),
          revision: 1,
          sha256: overrideSha256 ?? "",
          ownerKind: "workflow_node_override",
          scope: { kind: "global" },
          title: `${profile.title} · 节点覆盖`,
          regionKey: "agent_identity",
          content: { kind: "markdown", bodyMarkdown: resolvedOverride! },
          selectionKind: "explicit",
        }
      : agentVersion?.systemPrompt.mode === "replace"
        ? {
            promptFragmentId: promptFragmentIdSchema.parse(
              `pfg_${versionPromptIdentity!.slice(0, 32)}`,
            ),
            promptFragmentRevisionId: promptFragmentRevisionIdSchema.parse(
              `pfr_${agentVersion.systemPrompt.sha256.slice(0, 32)}`,
            ),
            revision: agentVersion.version,
            sha256: agentVersion.systemPrompt.sha256,
            ownerKind: "principal",
            scope: agentVersion.scope,
            title: `${agentVersion.title} · System Prompt`,
            regionKey: "agent_identity",
            content: {
              kind: "markdown",
              bodyMarkdown: agentVersion.systemPrompt.bodyMarkdown,
            },
            selectionKind: "explicit",
          }
        : profile.systemPrompt.source === "runtime_default"
          ? undefined
          : {
              promptFragmentId: profile.systemPrompt.promptFragmentId,
              promptFragmentRevisionId: profile.systemPrompt.promptFragmentRevisionId,
              revision: profile.systemPrompt.revision,
              sha256: profile.systemPrompt.sha256,
              ownerKind: profile.systemPrompt.source === "builtin" ? "system" : "principal",
              scope: { kind: "global" },
              title:
                profile.systemPrompt.source === "builtin"
                  ? profile.title
                  : `${profile.title} · System Prompt`,
              regionKey: "agent_identity",
              content: { kind: "markdown", bodyMarkdown: profile.systemPrompt.bodyMarkdown },
              sourceRelativePath: profile.systemPrompt.sourceRelativePath,
              selectionKind:
                profile.systemPrompt.source === "builtin" ? "profile_default" : "explicit",
            };
  const fragments = fragment === undefined ? [] : [fragment];
  const shape = {
    regionKey: "agent_identity",
    title: "Agent System Prompt",
    placement: "system" as const,
    mode: inheritsPiDefault
      ? ("default" as const)
      : agentVersion === undefined && !useOverride && profile.systemPrompt.source === "builtin"
        ? ("default" as const)
        : ("replace" as const),
    fragments,
    renderedText: renderPromptAssemblyRegion({
      regionKey: "agent_identity",
      title: "Agent System Prompt",
      fragments,
    }),
  };
  return {
    agentKey: binding.agentKey,
    profile,
    ...(agentVersion === undefined ? {} : { agentVersion }),
    ...(currentRuntime.runtimeProfileSha256 === undefined
      ? {}
      : { runtimeProfileSha256: currentRuntime.runtimeProfileSha256 }),
    ...(currentRuntime.workspaceGrantSha256 === undefined
      ? {}
      : { workspaceGrantSha256: currentRuntime.workspaceGrantSha256 }),
    region: { ...shape, sha256: computePromptAssemblyRegionSha256(shape) },
    ...(piSystemPrompt === undefined ? {} : { piSystemPrompt }),
  };
}

export const AGENT_BINDINGS_BY_NODE_TYPE: Readonly<
  Record<PromptBearingNodeType, { readonly agentKey: AgentKey; readonly profileVersion: string }>
> = {
  "agent.plan": { agentKey: "planner", profileVersion: "planner-prompt.v3" },
  "agent.direct": { agentKey: "direct", profileVersion: "direct-agent-prompt.v1" },
  "execute.plan": {
    agentKey: "coding_executor",
    profileVersion: "executor-coding-agent-prompt.v1",
  },
  "note.extract": { agentKey: "note_extractor", profileVersion: "note-capture.v1" },
};

const AGENT_PROFILE_VERSION_BY_KEY: Readonly<Record<AgentKey, string>> = {
  planner: "planner-prompt.v3",
  direct: "direct-agent-prompt.v1",
  project_bootstrap: "project-bootstrap-agent.v1",
  coding_executor: "executor-coding-agent-prompt.v1",
  note_extractor: "note-capture.v1",
};

export function agentBindingForNode(
  nodeType: PromptBearingNodeType,
  config: Readonly<Record<string, unknown>>,
): {
  readonly agentKey: AgentKey;
  readonly profileVersion: string;
  readonly agentVersionId?: AgentVersionId | undefined;
  readonly agentVersionSha256?: string | undefined;
  readonly systemPromptMode?: "inherit_runtime" | "replace" | undefined;
  readonly promptOverrideMarkdown?: string | undefined;
} {
  if (nodeType === "agent.direct" && hasAmbiguousAgentConfiguration(config)) {
    throw revisionConflict("Direct Agent存在多个互斥配置来源");
  }
  const temporaryConfiguration =
    typeof config["agentTemporaryConfiguration"] === "object" &&
    config["agentTemporaryConfiguration"] !== null
      ? (config["agentTemporaryConfiguration"] as Readonly<Record<string, unknown>>)
      : undefined;
  const temporarySystemPrompt =
    typeof temporaryConfiguration?.["systemPrompt"] === "object" &&
    temporaryConfiguration["systemPrompt"] !== null
      ? (temporaryConfiguration["systemPrompt"] as Readonly<Record<string, unknown>>)
      : undefined;
  const promptOverrideMarkdown =
    temporarySystemPrompt?.["mode"] === "replace" &&
    typeof temporarySystemPrompt["bodyMarkdown"] === "string"
      ? temporarySystemPrompt["bodyMarkdown"]
      : typeof config["agentPromptOverride"] === "string" &&
          config["agentPromptOverride"].trim() !== ""
        ? config["agentPromptOverride"]
        : undefined;
  const versionRef =
    typeof config["agentVersionId"] === "string" && typeof config["agentVersionSha256"] === "string"
      ? {
          agentVersionId: agentVersionIdSchema.parse(config["agentVersionId"]),
          agentVersionSha256: config["agentVersionSha256"],
        }
      : {};
  const configuredAgentKey = config["agentKey"] as AgentKey | undefined;
  if (configuredAgentKey !== undefined) {
    return {
      agentKey: configuredAgentKey,
      profileVersion: AGENT_PROFILE_VERSION_BY_KEY[configuredAgentKey],
      ...versionRef,
      ...(temporarySystemPrompt?.["mode"] === "inherit_runtime" ||
      temporarySystemPrompt?.["mode"] === "replace"
        ? { systemPromptMode: temporarySystemPrompt["mode"] }
        : {}),
      ...(promptOverrideMarkdown === undefined ? {} : { promptOverrideMarkdown }),
    };
  }
  if (nodeType === "agent.direct" && config["capabilityMode"] === "project_bootstrap") {
    return {
      agentKey: "project_bootstrap",
      profileVersion: "project-bootstrap-agent.v1",
      ...versionRef,
      ...(temporarySystemPrompt?.["mode"] === "inherit_runtime" ||
      temporarySystemPrompt?.["mode"] === "replace"
        ? { systemPromptMode: temporarySystemPrompt["mode"] }
        : {}),
      ...(promptOverrideMarkdown === undefined ? {} : { promptOverrideMarkdown }),
    };
  }
  return {
    ...AGENT_BINDINGS_BY_NODE_TYPE[nodeType],
    ...versionRef,
    ...(temporarySystemPrompt?.["mode"] === "inherit_runtime" ||
    temporarySystemPrompt?.["mode"] === "replace"
      ? { systemPromptMode: temporarySystemPrompt["mode"] }
      : {}),
    ...(promptOverrideMarkdown === undefined ? {} : { promptOverrideMarkdown }),
  };
}

/**
 * Workflow目录只公开“节点引用哪个Agent”。Agent自己的System Prompt由Agent目录管理，
 * 会话上下文由Prompt Composer管理；Tool只展示Runtime策略而不接受Prompt授权。
 */
export function agentNodeBindingDescriptor(
  nodeType: PromptBearingNodeType,
  config: Readonly<Record<string, unknown>>,
) {
  const toolPolicy =
    nodeType === "agent.plan"
      ? { summary: "只允许提交结构化计划候选", defaultTools: ["submit_plan_candidate"] }
      : nodeType === "note.extract"
        ? { summary: "只允许提交结构化笔记候选", defaultTools: ["submit_note_candidate"] }
        : nodeType === "agent.direct"
          ? {
              summary:
                typeof config["agentVersionId"] === "string"
                  ? "由绑定的不可变Agent Version决定"
                  : config["capabilityMode"] === "project_bootstrap"
                    ? "只读文件工具，并可准备受控项目初始化候选"
                    : config["capabilityMode"] === "read_only"
                      ? "显式只读Agent版本"
                      : config["capabilityMode"] === "custom"
                        ? "由本次会话的Agent配置决定"
                        : "继承Pi CLI默认编码能力；调用审批另行治理",
              defaultTools:
                typeof config["agentVersionId"] === "string"
                  ? []
                  : config["capabilityMode"] === "project_bootstrap"
                    ? ["read", "grep", "find", "ls", "project_bootstrap_prepare"]
                    : config["capabilityMode"] === "read_only"
                      ? ["read", "grep", "find", "ls"]
                      : config["capabilityMode"] === "custom" &&
                          Array.isArray(config["enabledToolNames"])
                        ? config["enabledToolNames"].filter(
                            (name): name is string => typeof name === "string",
                          )
                        : ["read", "bash", "edit", "write"],
            }
          : {
              summary: "由批准的Execution Contract能力引用在运行时冻结",
              defaultTools: [],
            };
  const binding = agentBindingForNode(nodeType, config);
  return {
    agentKey: binding.agentKey,
    profileVersion: binding.profileVersion,
    bindingKind:
      binding.agentVersionId === undefined
        ? ("agent_catalog" as const)
        : ("agent_version" as const),
    ...(binding.agentVersionId === undefined
      ? {}
      : {
          agentVersionId: binding.agentVersionId,
          agentVersionSha256: binding.agentVersionSha256,
        }),
    promptPolicy: "agent_profile_plus_session_context" as const,
    promptSource:
      binding.promptOverrideMarkdown === undefined
        ? binding.agentVersionId === undefined
          ? ("agent_default" as const)
          : ("agent_version" as const)
        : ("workflow_override" as const),
    ...(binding.promptOverrideMarkdown === undefined
      ? {}
      : { promptOverrideMarkdown: binding.promptOverrideMarkdown }),
    toolPolicy: {
      kind:
        nodeType === "agent.direct"
          ? ("agent_configuration" as const)
          : ("runtime_locked" as const),
      ...toolPolicy,
    },
  };
}

const PROMPT_BEARING_NODE_TYPES = new Set<PromptBearingNodeType>(
  Object.keys(AGENT_BINDINGS_BY_NODE_TYPE) as PromptBearingNodeType[],
);

export function isPromptBearingNodeType(nodeType: string): nodeType is PromptBearingNodeType {
  return PROMPT_BEARING_NODE_TYPES.has(nodeType as PromptBearingNodeType);
}

export function promptBearingNodes(
  nodes: readonly WorkflowNodeResolution[],
): readonly (WorkflowNodeResolution & { readonly nodeType: PromptBearingNodeType })[] {
  return nodes.filter(
    (node): node is WorkflowNodeResolution & { nodeType: PromptBearingNodeType } =>
      node.activation === "enabled" && isPromptBearingNodeType(node.nodeType),
  );
}

function normalizeWorkflowSelection(input: {
  readonly selection: PromptTurnSelectionInput;
  readonly workflowDefinitionRevisionId: WorkflowDefinitionRevisionId;
  readonly nodes: readonly Pick<WorkflowNodeResolution, "definitionNodeId" | "nodeType">[];
}) {
  if (input.selection.schemaVersion === "prompt-turn-selection-input.v2") {
    if (input.selection.workflowDefinitionRevisionId !== input.workflowDefinitionRevisionId) {
      throw revisionConflict("Prompt节点选择绑定了其他Workflow Revision，请刷新后重试");
    }
    return promptTurnSelectionInputV2Schema.parse({ ...input.selection, nodeSelections: [] });
  }
  return promptTurnSelectionInputV2Schema.parse({
    schemaVersion: "prompt-turn-selection-input.v2",
    ...(input.selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: input.selection.workspaceRootId }),
    workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
    regions: input.selection.regions,
    nodeSelections: [],
  });
}

export async function compileWorkflowPromptAssembly(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly text: string;
    readonly selection: PromptTurnSelectionInput;
    readonly productSessionId: ProductSessionId;
    readonly productRunId: ProductRunId;
    readonly sourceMessageId: MessageId;
    readonly workflowDefinitionRevisionId: WorkflowDefinitionRevisionId;
    readonly nodeResolutions: readonly WorkflowNodeResolution[];
    readonly createdAt: string;
  },
): Promise<PromptAssemblyV3> {
  const nodes = promptBearingNodes(input.nodeResolutions);
  if (nodes.length === 0) {
    throw revisionConflict("当前Workflow没有可组装Prompt的模型节点");
  }
  const selection = normalizeWorkflowSelection({
    selection: input.selection,
    workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
    nodes,
  });
  const shared = await compileRegions(deps, { principalId: input.principalId, selection });
  const nodeAssemblies = await Promise.all(
    nodes.map(async (node) => {
      const nodeType = node.nodeType as PromptBearingNodeType;
      const binding = agentBindingForNode(nodeType, node.config);
      const agent = await compileAgentRegion(deps, input.principalId, {
        ...binding,
        definitionNodeId: node.definitionNodeId,
        nodeType,
        workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
        ...(selection.workspaceRootId === undefined
          ? {}
          : { workspaceRootId: selection.workspaceRootId }),
      });
      const regions = [agent.region, ...shared.regions];
      const systemPromptAppend = [
        agent.piSystemPrompt === undefined ? agent.region.renderedText : "",
        shared.systemPromptAppend,
      ]
        .filter((value) => value !== "")
        .join("\n\n");
      const body = {
        definitionNodeId: node.definitionNodeId,
        nodeType,
        profileVersion: binding.profileVersion,
        regions,
        systemPromptAppend,
        ...(agent.piSystemPrompt === undefined ? {} : { piSystemPrompt: agent.piSystemPrompt }),
      } as const;
      return { ...body, sha256: computePromptNodeAssemblySha256(body) };
    }),
  );
  const promptAssemblyId = promptAssemblyIdSchema.parse(
    `pma_${hashCanonical("id.prompt-assembly.v1", { productRunId: input.productRunId }).slice(0, 32)}`,
  );
  const body = {
    schemaVersion: PROMPT_ASSEMBLY_V3_SCHEMA_VERSION,
    promptAssemblyId,
    productSessionId: input.productSessionId,
    productRunId: input.productRunId,
    sourceMessageId: input.sourceMessageId,
    workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
    profileVersion: WORKFLOW_PROMPT_PROFILE_VERSION,
    compilerVersion: WORKFLOW_PROMPT_COMPILER_VERSION,
    ...(selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: selection.workspaceRootId }),
    selection,
    sharedRegions: shared.regions,
    nodes: nodeAssemblies,
  } as const;
  return promptAssemblySchema.parse({
    ...body,
    sha256: computePromptAssemblyV3Sha256(body),
    createdAt: input.createdAt,
  }) as PromptAssemblyV3;
}

function userPromptFor(messageContext: string, text: string): string {
  return messageContext === "" ? text : [messageContext, text].join("\n\n");
}

function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

/** Run编译与Operation授权共用，保证Version/临时配置到Pi能力包络只有一套算法。 */
export function resolveDirectAgentExecutionEnvelope(input: {
  readonly profile: AgentProfileDto;
  readonly agentVersion?: AgentVersion | undefined;
  readonly directNodeConfig: Readonly<Record<string, unknown>>;
  readonly workspaceRootId?: string | undefined;
  readonly piSystemPrompt?: PiSystemPromptResolution | undefined;
}): {
  readonly tools: PromptAssemblyV2["tools"];
  readonly requestOptions: PromptAssemblyV2["requestOptions"];
  readonly piSystemPrompt?: PiSystemPromptResolution | undefined;
} {
  if (hasAmbiguousAgentConfiguration(input.directNodeConfig)) {
    throw revisionConflict("Direct Agent的多个配置来源不能同时进入能力解析");
  }
  const rawTemporaryConfiguration = input.directNodeConfig["agentTemporaryConfiguration"];
  const parsedTemporaryConfiguration =
    rawTemporaryConfiguration === undefined
      ? undefined
      : agentTemporaryConfigurationSchema.safeParse(rawTemporaryConfiguration);
  if (parsedTemporaryConfiguration !== undefined && !parsedTemporaryConfiguration.success) {
    throw revisionConflict("临时Agent配置已经损坏，请重新配置当前会话");
  }
  const temporaryConfiguration = parsedTemporaryConfiguration?.data;
  const temporaryRuntimeVariant =
    temporaryConfiguration === undefined
      ? undefined
      : input.profile.runtimeBaseline?.variants.find(
          (variant) => variant.variantKey === temporaryConfiguration.runtime.baseVariantKey,
        );
  if (temporaryConfiguration !== undefined && temporaryRuntimeVariant === undefined) {
    throw revisionConflict("临时Agent配置引用的Pi运行基线不存在或已经变化");
  }
  if (temporaryConfiguration?.basedOnVersionId !== undefined) {
    const basedOn = input.profile.versions.find(
      (version) => version.agentVersionId === temporaryConfiguration.basedOnVersionId,
    );
    if (
      basedOn === undefined ||
      basedOn.sha256 !== temporaryConfiguration.basedOnVersionSha256 ||
      (basedOn.scope.kind === "workspace" && basedOn.scope.rootId !== input.workspaceRootId)
    ) {
      throw revisionConflict("临时Agent配置的来源Version不存在、越过Workspace或Hash已变化");
    }
  }
  if (temporaryConfiguration !== undefined && temporaryRuntimeVariant !== undefined) {
    const selectedNames = new Set(temporaryConfiguration.enabledToolNames);
    const orderedSelectedNames = temporaryRuntimeVariant.tools
      .map((tool) => tool.name)
      .filter((toolName) => selectedNames.has(toolName));
    if (
      orderedSelectedNames.length !== temporaryConfiguration.enabledToolNames.length ||
      JSON.stringify(orderedSelectedNames) !==
        JSON.stringify(temporaryConfiguration.enabledToolNames)
    ) {
      throw revisionConflict("临时Agent配置包含当前Pi目录不存在的Tool，或Tool顺序已经变化");
    }
  }
  const resolvedConfiguration = temporaryConfiguration ?? input.agentVersion;
  const capabilityMode =
    input.directNodeConfig["capabilityMode"] === "project_bootstrap"
      ? ("project_bootstrap" as const)
      : resolvedConfiguration !== undefined
        ? ("custom" as const)
        : input.directNodeConfig["capabilityMode"] === "read_only"
          ? ("read_only" as const)
          : input.directNodeConfig["capabilityMode"] === "custom"
            ? ("custom" as const)
            : ("pi_cli_default" as const);
  const configuredToolNames =
    resolvedConfiguration?.enabledToolNames ??
    (Array.isArray(input.directNodeConfig["enabledToolNames"])
      ? input.directNodeConfig["enabledToolNames"]
      : undefined);
  if (capabilityMode === "custom" && configuredToolNames === undefined) {
    throw revisionConflict("自定义Agent能力缺少明确Tool清单");
  }
  const inheritedResources = {
    contextFiles: "inherit_runtime_default" as const,
    skills: "inherit_runtime_default" as const,
    promptTemplates: "inherit_runtime_default" as const,
    extensions: "inherit_runtime_default" as const,
  };
  const isolatedResources = {
    contextFiles: "disabled" as const,
    skills: "disabled" as const,
    promptTemplates: "disabled" as const,
    extensions: "disabled" as const,
  };
  const tools: PromptAssemblyV2["tools"] = {
    capabilityMode,
    selectionMode: capabilityMode === "pi_cli_default" ? "inherit_runtime_default" : "explicit",
    names:
      capabilityMode === "project_bootstrap"
        ? ["read", "grep", "find", "ls", "project_bootstrap_prepare"]
        : capabilityMode === "read_only"
          ? ["read", "grep", "find", "ls"]
          : capabilityMode === "pi_cli_default"
            ? []
            : configuredToolNames!,
    resources:
      resolvedConfiguration?.resources ??
      (input.directNodeConfig["resourcePolicy"] === undefined
        ? capabilityMode === "pi_cli_default"
          ? inheritedResources
          : isolatedResources
        : (input.directNodeConfig["resourcePolicy"] as PromptAssemblyV2["tools"]["resources"])),
    estimatedTokens: DIRECT_PROMPT_TOOL_TOKEN_RESERVE,
  };
  const usesPiRuntimeDefaults =
    resolvedConfiguration?.runtime.baseVariantKey === "pi_cli_default" ||
    (resolvedConfiguration === undefined && capabilityMode === "pi_cli_default");
  const requestOptions: PromptAssemblyV2["requestOptions"] = {
    providerId: "dashscope-coding",
    modelId: "qwen3.7-plus",
    thinkingLevel: usesPiRuntimeDefaults ? "medium" : "off",
    retryEnabled: usesPiRuntimeDefaults,
    compactionEnabled: usesPiRuntimeDefaults,
  };
  return {
    tools,
    requestOptions,
    ...(input.piSystemPrompt === undefined ? {} : { piSystemPrompt: input.piSystemPrompt }),
  };
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
    profileVersion:
      input.selection.schemaVersion === "prompt-turn-selection-input.v2"
        ? WORKFLOW_PROMPT_PROFILE_VERSION
        : DIRECT_PROMPT_PROFILE_V2_VERSION,
    compilerVersion:
      input.selection.schemaVersion === "prompt-turn-selection-input.v2"
        ? WORKFLOW_PROMPT_COMPILER_VERSION
        : DIRECT_PROMPT_COMPILER_V2_VERSION,
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
    readonly nodeResolutions?: readonly WorkflowNodeResolution[];
    readonly createdAt: string;
  },
): Promise<PromptAssemblyV2> {
  const nodes =
    input.nodeResolutions === undefined
      ? [
          {
            definitionNodeId: "direct.agent",
            nodeType: "agent.direct" as const,
            schemaVersion: 1,
            config: { capabilityMode: "pi_cli_default" },
            activation: "enabled" as const,
          },
        ]
      : promptBearingNodes(input.nodeResolutions);
  const directNode = nodes.find((node) => node.nodeType === "agent.direct");
  if (directNode === undefined) throw revisionConflict("Direct Workflow缺少Agent Prompt节点");
  const selection = normalizeWorkflowSelection({
    selection: input.selection,
    workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
    nodes,
  });
  const configuration = await compileRegions(deps, {
    principalId: input.principalId,
    selection,
  });
  const binding = agentBindingForNode("agent.direct", directNode.config);
  const agent = await compileAgentRegion(deps, input.principalId, {
    ...binding,
    definitionNodeId: directNode.definitionNodeId,
    nodeType: "agent.direct",
    workflowDefinitionRevisionId: input.workflowDefinitionRevisionId,
    ...(selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: selection.workspaceRootId }),
  });
  if (agent.runtimeProfileSha256 === undefined) {
    throw revisionConflict("Direct Agent缺少可复核的Runtime Profile");
  }
  const regions = [agent.region, ...configuration.regions];
  const systemPromptAppend = [
    agent.piSystemPrompt === undefined ? agent.region.renderedText : "",
    configuration.systemPromptAppend,
  ]
    .filter((value) => value !== "")
    .join("\n\n");
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const instructionsEstimatedTokens =
    systemPromptAppend === "" ? 0 : estimatePromptTokens(systemPromptAppend);
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
  const { tools, requestOptions } = resolveDirectAgentExecutionEnvelope({
    profile: agent.profile,
    ...(agent.agentVersion === undefined ? {} : { agentVersion: agent.agentVersion }),
    directNodeConfig: directNode.config,
    ...(selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: selection.workspaceRootId }),
    ...(agent.piSystemPrompt === undefined ? {} : { piSystemPrompt: agent.piSystemPrompt }),
  });
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
    compilerVersion: DIRECT_PROMPT_COMPILER_V3_VERSION,
    ...(selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: selection.workspaceRootId }),
    runtimeProfileSha256: agent.runtimeProfileSha256,
    ...(agent.workspaceGrantSha256 === undefined
      ? {}
      : { workspaceGrantSha256: agent.workspaceGrantSha256 }),
    regions,
    systemPromptAppend,
    ...(agent.piSystemPrompt === undefined ? {} : { piSystemPrompt: agent.piSystemPrompt }),
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
  compiledRunSpec?: WorkflowRunSpec,
): void {
  const runSpec =
    compiledRunSpec ??
    Object.values(snapshot.entities.workflowRunSpecs).find(
      (candidate) => candidate.productRunId === assembly.productRunId,
    );
  const boundAgentVersions = (runSpec?.nodeResolutions ?? []).flatMap((node) => {
    const agentVersionId = node.config["agentVersionId"];
    const agentVersionSha256 = node.config["agentVersionSha256"];
    if (typeof agentVersionId !== "string" || typeof agentVersionSha256 !== "string") return [];
    const version = snapshot.entities.agentVersions[agentVersionId];
    return version !== undefined &&
      version.sha256 === agentVersionSha256 &&
      version.ownerPrincipalId === principalId
      ? [version]
      : [];
  });
  const regions =
    assembly.schemaVersion === "prompt-assembly.v3"
      ? [...assembly.sharedRegions, ...assembly.nodes.flatMap((node) => node.regions)]
      : assembly.regions;
  for (const fragment of regions.flatMap((region) => region.fragments)) {
    if (
      fragment.ownerKind === "system" ||
      fragment.ownerKind === "workflow_node_override" ||
      fragment.ownerKind === "runtime"
    )
      continue;
    const revision = snapshot.entities.promptFragmentRevisions[fragment.promptFragmentRevisionId];
    const aggregate = snapshot.entities.promptFragments[fragment.promptFragmentId];
    const immutableVersionSource = boundAgentVersions.some(
      (version) =>
        fragment.content.kind === "markdown" &&
        version.systemPrompt.mode === "replace" &&
        version.systemPrompt.sha256 === fragment.sha256 &&
        version.systemPrompt.bodyMarkdown === fragment.content.bodyMarkdown &&
        JSON.stringify(version.scope) === JSON.stringify(fragment.scope),
    );
    if (immutableVersionSource) continue;
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

/**
 * Runtime只按Product Run和已发布节点类型取得冻结层；不得从DSH会话或当前文件重编译。
 * 返回undefined只用于兼容升级前已经存在的Planning/Note Run。
 */
export function workflowNodePromptFor(
  snapshot: ProductSnapshot,
  productRunId: ProductRunId,
  nodeType: PromptBearingNodeType,
) {
  const assemblies = Object.values(snapshot.entities.promptAssemblies).filter(
    (assembly): assembly is PromptAssemblyV3 =>
      assembly.productRunId === productRunId && assembly.schemaVersion === "prompt-assembly.v3",
  );
  if (assemblies.length > 1)
    throw revisionConflict("Product Run绑定了多个Workflow Prompt Assembly");
  const assembly = assemblies[0];
  if (assembly === undefined) return undefined;
  const nodes = assembly.nodes.filter((node) => node.nodeType === nodeType);
  if (nodes.length !== 1) throw revisionConflict(`Workflow Prompt节点数量无效:${nodeType}`);
  const node = nodes[0]!;
  return {
    promptAssemblyId: assembly.promptAssemblyId,
    promptAssemblySha256: assembly.sha256,
    definitionNodeId: node.definitionNodeId,
    nodeAssemblySha256: node.sha256,
    profileVersion: node.profileVersion,
    systemPromptAppend: node.systemPromptAppend,
    ...(node.piSystemPrompt === undefined ? {} : { piSystemPrompt: node.piSystemPrompt }),
  };
}
