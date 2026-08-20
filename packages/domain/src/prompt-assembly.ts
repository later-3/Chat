import { hashCanonical } from "./canonical-hash.js";

export interface PromptAssemblyFragmentShape {
  readonly promptFragmentId: string;
  readonly promptFragmentRevisionId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly ownerKind: "system" | "principal";
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
  readonly regions: readonly PromptAssemblyRegionShape[];
  readonly systemPromptAppend: string;
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

export function assertPromptAssembly(assembly: PromptAssemblyShape | PromptAssemblyV2Shape): void {
  const regionKeys = new Set<string>();
  for (const region of assembly.regions) {
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
    regions: assembly.regions,
    systemPromptAppend: assembly.systemPromptAppend,
  } as const;
  const expected =
    assembly.schemaVersion === "prompt-assembly.v2"
      ? computePromptAssemblyV2Sha256({
          schemaVersion: assembly.schemaVersion,
          ...common,
          messages: assembly.messages,
          tools: assembly.tools,
          requestOptions: assembly.requestOptions,
          budget: assembly.budget,
        })
      : computePromptAssemblySha256({ ...common, userPrompt: assembly.userPrompt });
  if (expected !== assembly.sha256) throw new Error("Prompt Assembly Hash不一致");
}
