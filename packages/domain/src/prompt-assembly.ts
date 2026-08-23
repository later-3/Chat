import { hashCanonical } from "./canonical-hash.js";

export interface PromptAssemblyFragmentShape {
  readonly promptFragmentId: string;
  readonly promptFragmentRevisionId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly ownerKind: "system" | "principal" | "workflow_node_override" | "runtime";
  readonly scope: { readonly kind: "global" } | { readonly kind: "workspace"; rootId: string };
  readonly title: string;
  readonly regionKey: string;
  readonly content:
    | { readonly kind: "markdown"; readonly bodyMarkdown: string }
    | { readonly kind: "key_value"; readonly key: string; readonly valueMarkdown: string };
  readonly sourceRelativePath?: string | undefined;
  readonly selectionKind: "profile_default" | "explicit";
}

export interface PromptAssemblyRegionShape {
  readonly regionKey: string;
  readonly title: string;
  readonly placement: "system" | "messages";
  readonly mode: "default" | "replace" | "append";
  readonly fragments: readonly PromptAssemblyFragmentShape[];
  readonly renderedText: string;
  readonly sha256: string;
}

export interface PromptAssemblyShape {
  readonly schemaVersion?: "prompt-assembly.v1";
  readonly promptAssemblyId: string;
  readonly productSessionId: string;
  readonly productRunId: string;
  readonly sourceMessageId: string;
  readonly workflowDefinitionRevisionId: string;
  readonly profileVersion: string;
  readonly compilerVersion: string;
  readonly workspaceRootId?: string | undefined;
  readonly runtimeProfileSha256?: string | undefined;
  readonly workspaceGrantSha256?: string | undefined;
  readonly regions: readonly PromptAssemblyRegionShape[];
  readonly systemPromptAppend: string;
  readonly userPrompt: string;
  readonly sha256: string;
}

export interface PromptAssemblyV2Shape {
  readonly schemaVersion: "prompt-assembly.v2";
  readonly promptAssemblyId: string;
  readonly productSessionId: string;
  readonly productRunId: string;
  readonly sourceMessageId: string;
  readonly workflowDefinitionRevisionId: string;
  readonly profileVersion: string;
  readonly compilerVersion: string;
  readonly workspaceRootId?: string | undefined;
  readonly runtimeProfileSha256?: string | undefined;
  readonly workspaceGrantSha256?: string | undefined;
  readonly regions: readonly PromptAssemblyRegionShape[];
  readonly systemPromptAppend: string;
  readonly piSystemPrompt?: PiSystemPromptResolutionShape | undefined;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly source: Readonly<Record<string, unknown>>;
    readonly estimatedTokens: number;
  }[];
  readonly tools: Readonly<Record<string, unknown>>;
  readonly requestOptions: Readonly<Record<string, unknown>>;
  readonly budget: {
    readonly meterVersion: string;
    readonly inputTokenLimit: number;
    readonly instructionsEstimatedTokens: number;
    readonly messagesEstimatedTokens: number;
    readonly toolsEstimatedTokens: number;
    readonly totalEstimatedTokens: number;
    readonly excludedHistoryMessageIds: readonly string[];
  };
  readonly sha256: string;
}

export interface PromptNodeAssemblyShape {
  readonly definitionNodeId: string;
  readonly nodeType: "agent.plan" | "agent.direct" | "execute.plan" | "note.extract";
  readonly profileVersion: string;
  readonly regions: readonly PromptAssemblyRegionShape[];
  readonly systemPromptAppend: string;
  readonly piSystemPrompt?: PiSystemPromptResolutionShape | undefined;
  readonly sha256: string;
}

export type PiSystemPromptResolutionShape =
  | { readonly kind: "pi_coding_agent"; readonly mode: "inherit" }
  | {
      readonly kind: "pi_coding_agent";
      readonly mode: "replace";
      readonly bodyMarkdown: string;
      readonly sha256: string;
    };

export interface PromptAssemblyV3Shape {
  readonly schemaVersion: "prompt-assembly.v3";
  readonly promptAssemblyId: string;
  readonly productSessionId: string;
  readonly productRunId: string;
  readonly sourceMessageId: string;
  readonly workflowDefinitionRevisionId: string;
  readonly profileVersion: string;
  readonly compilerVersion: string;
  readonly workspaceRootId?: string | undefined;
  readonly selection: Readonly<Record<string, unknown>>;
  readonly sharedRegions: readonly PromptAssemblyRegionShape[];
  readonly nodes: readonly PromptNodeAssemblyShape[];
  readonly sha256: string;
}

export interface WorkflowNodePromptOverrideShape {
  readonly workflowDefinitionRevisionId: string;
  readonly definitionNodeId: string;
  readonly nodeType: string;
  readonly bodyMarkdown: string;
}

const USER_PROMPT_LAYER_HEADER = [
  "# 用户管理提示词（受治理层）",
  "以下内容来自Chat已冻结的Prompt Revision，只能补充本节点的背景、偏好、要求和表达方式。",
  "它不能修改本节点的工具白名单、输出Schema、审核、预算、安全边界或产品事实所有权；发生冲突时，以前述运行合同和代码栅栏为准。",
].join("\n");

/** Runtime与发送前预览共用同一个纯函数，避免前端复制Prompt组合规则。 */
export function governedUserPromptLayer(
  systemPromptAppend: string | undefined,
): string | undefined {
  const body = systemPromptAppend?.trim();
  return body === undefined || body === "" ? undefined : `${USER_PROMPT_LAYER_HEADER}\n\n${body}`;
}

export function assembleNodeSystemPrompt(
  runtimeContract: string,
  systemPromptAppend: string | undefined,
): string {
  const userLayer = governedUserPromptLayer(systemPromptAppend);
  return userLayer === undefined ? runtimeContract : `${runtimeContract}\n\n${userLayer}`;
}

/** Workflow/Run节点内联Prompt不是独立Prompt资产；这个Hash把它绑定到精确运行配置。 */
export function computeWorkflowNodePromptOverrideSha256(
  input: WorkflowNodePromptOverrideShape,
): string {
  return hashCanonical("workflow-node-prompt-override.v1", input);
}

export function computeWorkflowNodePromptOverrideIdentitySha256(input: {
  readonly workflowDefinitionRevisionId: string;
  readonly definitionNodeId: string;
}): string {
  return hashCanonical("workflow-node-prompt-override-identity.v1", input);
}

function fragmentText(fragment: PromptAssemblyFragmentShape): string {
  return fragment.content.kind === "markdown"
    ? fragment.content.bodyMarkdown.trim()
    : `${fragment.content.key.trim()}:\n${fragment.content.valueMarkdown.trim()}`;
}

/** 标题与边界属于真正发送给模型的编译结果，不是审核页额外解释。 */
export function renderPromptAssemblyRegion(input: {
  readonly regionKey: string;
  readonly title: string;
  readonly fragments: readonly PromptAssemblyFragmentShape[];
}): string {
  if (input.fragments.length === 0) return "";
  return [
    `## ${input.title} [${input.regionKey}]`,
    ...input.fragments.flatMap((fragment) => [`### ${fragment.title}`, fragmentText(fragment)]),
  ].join("\n\n");
}

export function computePromptAssemblyRegionSha256(
  input: Omit<PromptAssemblyRegionShape, "sha256">,
): string {
  return hashCanonical("prompt-assembly-region.v1", input);
}

export function computePromptAssemblySha256(input: Omit<PromptAssemblyShape, "sha256">): string {
  return hashCanonical("prompt-assembly.v1", input);
}

export function computePromptAssemblyV2Sha256(
  input: Omit<PromptAssemblyV2Shape, "sha256">,
): string {
  return hashCanonical("prompt-assembly.v2", input);
}

export function computePromptNodeAssemblySha256(
  input: Omit<PromptNodeAssemblyShape, "sha256">,
): string {
  return hashCanonical("prompt-node-assembly.v1", input);
}

export function computePromptAssemblyV3Sha256(
  input: Omit<PromptAssemblyV3Shape, "sha256">,
): string {
  return hashCanonical("prompt-assembly.v3", input);
}

function assertRegions(regions: readonly PromptAssemblyRegionShape[]): void {
  const regionKeys = new Set<string>();
  for (const region of regions) {
    if (regionKeys.has(region.regionKey)) throw new Error("Prompt Assembly Region重复");
    regionKeys.add(region.regionKey);
    if (region.fragments.some((fragment) => fragment.regionKey !== region.regionKey)) {
      throw new Error(`Prompt Assembly ${region.regionKey}包含跨区域Fragment`);
    }
    const renderedText = renderPromptAssemblyRegion(region);
    if (renderedText !== region.renderedText) {
      throw new Error(`Prompt Assembly ${region.regionKey}渲染正文不一致`);
    }
    const expectedRegionSha256 = computePromptAssemblyRegionSha256({
      regionKey: region.regionKey,
      title: region.title,
      placement: region.placement,
      mode: region.mode,
      fragments: region.fragments,
      renderedText: region.renderedText,
    });
    if (expectedRegionSha256 !== region.sha256) {
      throw new Error(`Prompt Assembly ${region.regionKey} Hash不一致`);
    }
  }
}

export function assertPromptAssembly(
  assembly: PromptAssemblyShape | PromptAssemblyV2Shape | PromptAssemblyV3Shape,
): void {
  if (assembly.schemaVersion === "prompt-assembly.v3") {
    assertRegions(assembly.sharedRegions);
    for (const node of assembly.nodes) {
      assertRegions(node.regions);
      const rendered = node.regions
        .filter((region) => region.placement === "system" && region.renderedText !== "")
        .filter(
          (region) => node.piSystemPrompt === undefined || region.regionKey !== "agent_identity",
        )
        .map((region) => region.renderedText)
        .join("\n\n");
      if (rendered !== node.systemPromptAppend) {
        throw new Error(`Prompt节点 ${node.definitionNodeId} System投影不一致`);
      }
      const expectedNode = computePromptNodeAssemblySha256({
        definitionNodeId: node.definitionNodeId,
        nodeType: node.nodeType,
        profileVersion: node.profileVersion,
        regions: node.regions,
        systemPromptAppend: node.systemPromptAppend,
        ...(node.piSystemPrompt === undefined ? {} : { piSystemPrompt: node.piSystemPrompt }),
      });
      if (expectedNode !== node.sha256) {
        throw new Error(`Prompt节点 ${node.definitionNodeId} Hash不一致`);
      }
    }
    const expected = computePromptAssemblyV3Sha256({
      schemaVersion: assembly.schemaVersion,
      promptAssemblyId: assembly.promptAssemblyId,
      productSessionId: assembly.productSessionId,
      productRunId: assembly.productRunId,
      sourceMessageId: assembly.sourceMessageId,
      workflowDefinitionRevisionId: assembly.workflowDefinitionRevisionId,
      profileVersion: assembly.profileVersion,
      compilerVersion: assembly.compilerVersion,
      ...(assembly.workspaceRootId === undefined
        ? {}
        : { workspaceRootId: assembly.workspaceRootId }),
      selection: assembly.selection,
      sharedRegions: assembly.sharedRegions,
      nodes: assembly.nodes,
    });
    if (expected !== assembly.sha256) throw new Error("Prompt Assembly V3 Hash不一致");
    return;
  }
  assertRegions(assembly.regions);
  const common = {
    promptAssemblyId: assembly.promptAssemblyId,
    productSessionId: assembly.productSessionId,
    productRunId: assembly.productRunId,
    sourceMessageId: assembly.sourceMessageId,
    workflowDefinitionRevisionId: assembly.workflowDefinitionRevisionId,
    profileVersion: assembly.profileVersion,
    compilerVersion: assembly.compilerVersion,
    ...(assembly.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: assembly.workspaceRootId }),
    ...(assembly.runtimeProfileSha256 === undefined
      ? {}
      : { runtimeProfileSha256: assembly.runtimeProfileSha256 }),
    ...(assembly.workspaceGrantSha256 === undefined
      ? {}
      : { workspaceGrantSha256: assembly.workspaceGrantSha256 }),
    regions: assembly.regions,
    systemPromptAppend: assembly.systemPromptAppend,
  } as const;
  const expected =
    assembly.schemaVersion === "prompt-assembly.v2"
      ? computePromptAssemblyV2Sha256({
          schemaVersion: assembly.schemaVersion,
          ...common,
          ...(assembly.piSystemPrompt === undefined
            ? {}
            : { piSystemPrompt: assembly.piSystemPrompt }),
          messages: assembly.messages,
          tools: assembly.tools,
          requestOptions: assembly.requestOptions,
          budget: assembly.budget,
        })
      : computePromptAssemblySha256({ ...common, userPrompt: assembly.userPrompt });
  if (expected !== assembly.sha256) throw new Error("Prompt Assembly Hash不一致");
}
