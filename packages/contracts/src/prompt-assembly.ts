import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  messageIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  promptAssemblyIdSchema,
  promptFragmentIdSchema,
  promptFragmentRevisionIdSchema,
  workflowDefinitionRevisionIdSchema,
} from "./ids.js";
import {
  promptFragmentScopeSchema,
  promptRegionKeySchema,
  promptWorkspaceRootIdSchema,
} from "./prompt-fragment.js";

export const PROMPT_ASSEMBLY_SCHEMA_VERSION = "prompt-assembly.v1";
export const PROMPT_ASSEMBLY_V2_SCHEMA_VERSION = "prompt-assembly.v2";
export const DIRECT_PROMPT_PROFILE_VERSION = "direct-agent-prompt-profile.v1";
export const DIRECT_PROMPT_COMPILER_VERSION = "direct-agent-prompt-compiler.v1";
export const DIRECT_PROMPT_PROFILE_V2_VERSION = "direct-agent-prompt-profile.v2";
export const DIRECT_PROMPT_COMPILER_V2_VERSION = "direct-agent-prompt-compiler.v2";
export const DIRECT_PROMPT_INPUT_TOKEN_LIMIT = 64_000;
export const DIRECT_PROMPT_TOOL_TOKEN_RESERVE = 8_000;
export const DIRECT_PROMPT_METER_VERSION = "utf8-bytes-div-3.v1";
export const LEGACY_DIRECT_PROMPT_PROFILE_VERSION = "direct-agent-prompt-profile.legacy-v0";
export const LEGACY_DIRECT_PROMPT_COMPILER_VERSION = "direct-agent-prompt-compiler.legacy-v0";

export const promptCompositionModeSchema = z.enum(["default", "replace", "append"]);

export const promptRevisionSelectionSchema = z
  .object({
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    sha256: sha256Schema,
  })
  .strict();

/**
 * Assembly冻结来源的精确正文，不能复用Prompt Studio写入合同中的`.trim()`转换。
 * 否则Git Markdown尾部换行会在冻结后被静默删除，来源Hash与实际快照不再一一对应。
 */
const promptAssemblyFragmentContentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("markdown"),
      bodyMarkdown: z.string().min(1).max(65_536),
    })
    .strict(),
  z
    .object({
      kind: z.literal("key_value"),
      key: z.string().min(1).max(120),
      valueMarkdown: z.string().min(1).max(65_536),
    })
    .strict(),
]);

export const promptRegionCompositionInputSchema = z
  .object({
    regionKey: promptRegionKeySchema,
    mode: promptCompositionModeSchema,
    selected: z.array(promptRevisionSelectionSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "default" && value.selected.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["selected"],
        message: "default模式不能携带显式Prompt Revision",
      });
    }
    if (value.mode !== "default" && value.selected.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["selected"],
        message: "replace/append模式至少选择一个Prompt Revision",
      });
    }
    const ids = new Set(value.selected.map((item) => item.promptFragmentRevisionId));
    if (ids.size !== value.selected.length) {
      ctx.addIssue({
        code: "custom",
        path: ["selected"],
        message: "同一区域不能重复选择同一Prompt Revision",
      });
    }
  });

/** Browser只提交选择意图；服务端重新解析Revision、Scope、正文和默认Profile。 */
export const promptTurnSelectionInputSchema = z
  .object({
    schemaVersion: z.literal("prompt-turn-selection-input.v1"),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    regions: z.array(promptRegionCompositionInputSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set(value.regions.map((item) => item.regionKey));
    if (keys.size !== value.regions.length) {
      ctx.addIssue({ code: "custom", path: ["regions"], message: "Prompt Region选择重复" });
    }
  });

export const promptAssemblyFragmentSchema = z
  .object({
    promptFragmentId: promptFragmentIdSchema,
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    ownerKind: z.enum(["system", "principal"]),
    scope: promptFragmentScopeSchema,
    title: z.string().min(1).max(160),
    regionKey: promptRegionKeySchema,
    content: promptAssemblyFragmentContentSchema,
    sourceRelativePath: z.string().min(1).max(500).optional(),
    selectionKind: z.enum(["profile_default", "explicit"]),
  })
  .strict();

export const promptAssemblyRegionSchema = z
  .object({
    regionKey: promptRegionKeySchema,
    title: z.string().min(1).max(160),
    placement: z.enum(["system", "messages"]),
    mode: promptCompositionModeSchema,
    fragments: z.array(promptAssemblyFragmentSchema).max(64),
    renderedText: z.string().max(512_000),
    sha256: sha256Schema,
  })
  .strict();

export const promptEnvelopeMessageSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("product_message"),
      messageId: messageIdSchema,
      sessionSequence: z.number().int().positive(),
      sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("current_input"),
      messageId: messageIdSchema,
      sessionSequence: z.number().int().positive(),
      sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow_node_input"),
      producerNodeId: z.string().min(1).max(160),
      sha256: sha256Schema,
    })
    .strict(),
]);

/**
 * Chat交给Pi的模型可见Message。`role`只表达Provider协议角色，真实生产者由
 * source单独绑定；这样前序Workflow节点输出可以是user role而不会冒充真人输入。
 */
export const promptEnvelopeMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(100_000),
    source: promptEnvelopeMessageSourceSchema,
    estimatedTokens: z.number().int().positive().max(1_000_000),
  })
  .strict();

export const promptEnvelopeToolsSchema = z
  .object({
    capabilityMode: z.literal("read_only"),
    names: z.array(z.enum(["read", "grep", "find", "ls"])).length(4),
    estimatedTokens: z.literal(DIRECT_PROMPT_TOOL_TOKEN_RESERVE),
  })
  .strict();

export const promptEnvelopeRequestOptionsSchema = z
  .object({
    providerId: z.literal("dashscope-coding"),
    modelId: z.literal("qwen3.7-plus"),
    thinkingLevel: z.literal("off"),
    retryEnabled: z.literal(false),
    compactionEnabled: z.literal(false),
  })
  .strict();

export const promptAssemblyBudgetSchema = z
  .object({
    meterVersion: z.literal(DIRECT_PROMPT_METER_VERSION),
    inputTokenLimit: z.literal(DIRECT_PROMPT_INPUT_TOKEN_LIMIT),
    instructionsEstimatedTokens: z.number().int().nonnegative().max(1_000_000),
    messagesEstimatedTokens: z.number().int().nonnegative().max(1_000_000),
    toolsEstimatedTokens: z.number().int().nonnegative().max(1_000_000),
    totalEstimatedTokens: z.number().int().nonnegative().max(1_000_000),
    excludedHistoryMessageIds: z.array(messageIdSchema).max(1_000),
  })
  .strict();

/**
 * Product Store中的一次发送快照。它冻结最终采用的精确Revision与编译文本，后续
 * Fragment再修订、归档或Git Catalog升级都不能改变已启动Run的输入。
 */
export const promptAssemblyV1Schema = z
  .object({
    schemaVersion: z.literal(PROMPT_ASSEMBLY_SCHEMA_VERSION),
    promptAssemblyId: promptAssemblyIdSchema,
    productSessionId: productSessionIdSchema,
    productRunId: productRunIdSchema,
    sourceMessageId: messageIdSchema,
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    profileVersion: z.enum([DIRECT_PROMPT_PROFILE_VERSION, LEGACY_DIRECT_PROMPT_PROFILE_VERSION]),
    compilerVersion: z.enum([
      DIRECT_PROMPT_COMPILER_VERSION,
      LEGACY_DIRECT_PROMPT_COMPILER_VERSION,
    ]),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    regions: z.array(promptAssemblyRegionSchema).max(32),
    systemPromptAppend: z.string().max(512_000),
    userPrompt: z.string().min(1).max(1_000_000),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

/**
 * V2把真正交给Pi的四条输入通道冻结为产品事实。Region仍是开放的作者语义分类；
 * History保持原始role，Tools与Options不再散落在Runtime常量里。来源、预算和排除
 * 证据属于Assembly Manifest，不会被额外拼进模型正文。
 */
export const promptAssemblyV2Schema = z
  .object({
    schemaVersion: z.literal(PROMPT_ASSEMBLY_V2_SCHEMA_VERSION),
    promptAssemblyId: promptAssemblyIdSchema,
    productSessionId: productSessionIdSchema,
    productRunId: productRunIdSchema,
    sourceMessageId: messageIdSchema,
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    profileVersion: z.literal(DIRECT_PROMPT_PROFILE_V2_VERSION),
    compilerVersion: z.literal(DIRECT_PROMPT_COMPILER_V2_VERSION),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    regions: z.array(promptAssemblyRegionSchema).max(32),
    systemPromptAppend: z.string().max(512_000),
    messages: z.array(promptEnvelopeMessageSchema).min(1).max(1_000),
    tools: promptEnvelopeToolsSchema,
    requestOptions: promptEnvelopeRequestOptionsSchema,
    budget: promptAssemblyBudgetSchema,
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const current = value.messages.at(-1);
    if (
      current?.role !== "user" ||
      current.source.kind !== "current_input" ||
      current.source.messageId !== value.sourceMessageId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Prompt Assembly V2最后一条Message必须是当前真实User输入",
      });
    }
    if (
      value.budget.totalEstimatedTokens !==
      value.budget.instructionsEstimatedTokens +
        value.budget.messagesEstimatedTokens +
        value.budget.toolsEstimatedTokens
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["budget", "totalEstimatedTokens"],
        message: "Prompt Assembly V2预算分项与总量不一致",
      });
    }
    if (value.budget.totalEstimatedTokens > value.budget.inputTokenLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["budget", "totalEstimatedTokens"],
        message: "Prompt Assembly V2超过输入Token预算",
      });
    }
  });

export const promptAssemblySchema = z.union([promptAssemblyV1Schema, promptAssemblyV2Schema]);

export type PromptCompositionMode = z.infer<typeof promptCompositionModeSchema>;
export type PromptRevisionSelection = z.infer<typeof promptRevisionSelectionSchema>;
export type PromptRegionCompositionInput = z.infer<typeof promptRegionCompositionInputSchema>;
export type PromptTurnSelectionInput = z.infer<typeof promptTurnSelectionInputSchema>;
export type PromptAssemblyFragment = z.infer<typeof promptAssemblyFragmentSchema>;
export type PromptAssemblyRegion = z.infer<typeof promptAssemblyRegionSchema>;
export type PromptEnvelopeMessage = z.infer<typeof promptEnvelopeMessageSchema>;
export type PromptAssemblyBudget = z.infer<typeof promptAssemblyBudgetSchema>;
export type PromptAssembly = z.infer<typeof promptAssemblySchema>;
export type PromptAssemblyV1 = z.infer<typeof promptAssemblyV1Schema>;
export type PromptAssemblyV2 = z.infer<typeof promptAssemblyV2Schema>;
