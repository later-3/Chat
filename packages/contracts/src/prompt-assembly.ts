import { z } from "zod";
import { directAgentToolNameSchema } from "./agent-runtime-capabilities.js";
export {
  directAgentToolNameSchema,
  piBuiltinToolNameSchema,
} from "./agent-runtime-capabilities.js";
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
import { workflowDefinitionNodeIdSchema } from "./workflow-definition.js";
import {
  promptFragmentScopeSchema,
  promptRegionKeySchema,
  promptWorkspaceRootIdSchema,
} from "./prompt-fragment.js";

export const PROMPT_ASSEMBLY_SCHEMA_VERSION = "prompt-assembly.v1";
export const PROMPT_ASSEMBLY_V2_SCHEMA_VERSION = "prompt-assembly.v2";
export const PROMPT_ASSEMBLY_V3_SCHEMA_VERSION = "prompt-assembly.v3";
export const WORKFLOW_PROMPT_PROFILE_VERSION = "workflow-agent-prompt-profile.v1";
export const WORKFLOW_PROMPT_COMPILER_VERSION = "workflow-agent-prompt-compiler.v1";
export const DIRECT_PROMPT_PROFILE_VERSION = "direct-agent-prompt-profile.v1";
export const DIRECT_PROMPT_COMPILER_VERSION = "direct-agent-prompt-compiler.v1";
export const DIRECT_PROMPT_PROFILE_V2_VERSION = "direct-agent-prompt-profile.v2";
export const DIRECT_PROMPT_COMPILER_V2_VERSION = "direct-agent-prompt-compiler.v2";
export const DIRECT_PROMPT_COMPILER_V3_VERSION = "direct-agent-prompt-compiler.v3";
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
export const promptTurnSelectionInputV1Schema = z
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

export const promptNodeSelectionInputSchema = z
  .object({
    definitionNodeId: workflowDefinitionNodeIdSchema,
    regions: z.array(promptRegionCompositionInputSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set(value.regions.map((item) => item.regionKey));
    if (keys.size !== value.regions.length) {
      ctx.addIssue({ code: "custom", path: ["regions"], message: "节点Prompt Region选择重复" });
    }
  });

/**
 * V2历史上允许节点级Prompt选择。当前Compiler只接受会话上下文Region并把
 * `nodeSelections`归一为空数组；保留字段仅用于读取既有草稿，不能再修改Agent身份。
 */
export const promptTurnSelectionInputV2Schema = z
  .object({
    schemaVersion: z.literal("prompt-turn-selection-input.v2"),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    regions: z.array(promptRegionCompositionInputSchema).max(32),
    nodeSelections: z.array(promptNodeSelectionInputSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const regionKeys = new Set(value.regions.map((item) => item.regionKey));
    if (regionKeys.size !== value.regions.length) {
      ctx.addIssue({ code: "custom", path: ["regions"], message: "Prompt Region选择重复" });
    }
    const nodeIds = new Set(value.nodeSelections.map((item) => item.definitionNodeId));
    if (nodeIds.size !== value.nodeSelections.length) {
      ctx.addIssue({ code: "custom", path: ["nodeSelections"], message: "Prompt节点选择重复" });
    }
  });

export const promptTurnSelectionInputSchema = z.union([
  promptTurnSelectionInputV1Schema,
  promptTurnSelectionInputV2Schema,
]);

export const promptAssemblyFragmentSchema = z
  .object({
    promptFragmentId: promptFragmentIdSchema,
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    ownerKind: z.enum(["system", "principal", "workflow_node_override", "runtime"]),
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

/**
 * Direct Agent只在这里冻结“本次Agent实际向模型暴露哪些Tool”。Tool是否需要审批
 * 属于执行策略，不能再通过删掉Pi默认能力来表达。`pi_cli_default`必须与受管Pi SDK
 * 的默认激活集合一致；`custom`用于Agent Version、Workflow或会话的显式选择。
 */
export const directAgentCapabilityModeSchema = z.enum([
  "pi_cli_default",
  "custom",
  "read_only",
  "project_bootstrap",
]);

export const agentRuntimeResourcePolicySchema = z
  .object({
    contextFiles: z.enum(["inherit_runtime_default", "disabled"]),
    skills: z.enum(["inherit_runtime_default", "disabled"]),
    promptTemplates: z.enum(["inherit_runtime_default", "disabled"]),
    extensions: z.enum(["inherit_runtime_default", "disabled"]),
  })
  .strict();

export const promptEnvelopeToolsSchema = z
  .object({
    capabilityMode: directAgentCapabilityModeSchema,
    /** Pi默认值直到真实AgentSession完成Extension绑定后才能解析；受限配置必须显式冻结。 */
    selectionMode: z.enum(["inherit_runtime_default", "explicit"]).optional(),
    names: z.array(directAgentToolNameSchema).max(32),
    /** v2历史Assembly没有该字段；新编译结果必须显式冻结，Runtime兼容旧值。 */
    resources: agentRuntimeResourcePolicySchema.optional(),
    estimatedTokens: z.literal(DIRECT_PROMPT_TOOL_TOKEN_RESERVE),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.names).size !== value.names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["names"],
        message: "Tool清单不能包含重复项",
      });
    }
    const selectionMode = value.selectionMode ?? "explicit";
    if (
      value.capabilityMode === "pi_cli_default" &&
      (selectionMode !== "inherit_runtime_default" || value.names.length !== 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectionMode"],
        message: "Pi默认能力必须由真实Runtime解析，不能手写冻结Tool名字",
      });
    }
    if (value.capabilityMode !== "pi_cli_default" && selectionMode !== "explicit") {
      ctx.addIssue({
        code: "custom",
        path: ["selectionMode"],
        message: "自定义或受限Agent必须显式冻结Tool清单",
      });
    }
    const expected =
      value.capabilityMode === "read_only"
        ? ["read", "grep", "find", "ls"]
        : value.capabilityMode === "project_bootstrap"
          ? ["read", "grep", "find", "ls", "project_bootstrap_prepare"]
          : undefined;
    if (expected !== undefined && JSON.stringify(value.names) !== JSON.stringify(expected)) {
      ctx.addIssue({
        code: "custom",
        path: ["names"],
        message: "预设Capability Mode的Tool清单必须与其冻结定义完全一致",
      });
    }
    if (
      value.capabilityMode !== "project_bootstrap" &&
      value.names.includes("project_bootstrap_prepare")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["names"],
        message: "项目初始化Tool只能由project_bootstrap模式启用",
      });
    }
  });

export const promptEnvelopeRequestOptionsSchema = z
  .object({
    providerId: z.literal("dashscope-coding"),
    modelId: z.literal("qwen3.7-plus"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    retryEnabled: z.boolean(),
    compactionEnabled: z.boolean(),
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

/** Pi拥有默认System Prompt；Chat只冻结继承或完整覆盖的用户决定。 */
export const piSystemPromptResolutionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      kind: z.literal("pi_coding_agent"),
      mode: z.literal("inherit"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pi_coding_agent"),
      mode: z.literal("replace"),
      bodyMarkdown: z.string().min(1).max(131_072),
      sha256: sha256Schema,
    })
    .strict(),
]);

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
 * V2冻结Chat交给Pi的System追加层、Messages、Capability Tool清单与Options。
 * Pi基础System和部署期锁定的动态Runtime Contract不伪装成用户Prompt；最终Provider
 * Payload由PromptReviewRequest另行冻结。来源、预算和排除证据属于Assembly Manifest。
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
    compilerVersion: z.enum([DIRECT_PROMPT_COMPILER_V2_VERSION, DIRECT_PROMPT_COMPILER_V3_VERSION]),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    /** 新Run在Provider前复核这两个Hash；旧v2 Compiler记录继续按历史语义读取。 */
    runtimeProfileSha256: sha256Schema.optional(),
    workspaceGrantSha256: sha256Schema.optional(),
    regions: z.array(promptAssemblyRegionSchema).max(32),
    systemPromptAppend: z.string().max(512_000),
    piSystemPrompt: piSystemPromptResolutionSchema.optional(),
    messages: z.array(promptEnvelopeMessageSchema).min(1).max(1_000),
    tools: promptEnvelopeToolsSchema,
    requestOptions: promptEnvelopeRequestOptionsSchema,
    budget: promptAssemblyBudgetSchema,
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.compilerVersion === DIRECT_PROMPT_COMPILER_V3_VERSION &&
      value.runtimeProfileSha256 === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeProfileSha256"],
        message: "Prompt Assembly V2新编译器必须冻结Runtime Profile Hash",
      });
    }
    if (
      value.compilerVersion === DIRECT_PROMPT_COMPILER_V3_VERSION &&
      (value.workspaceRootId === undefined) !== (value.workspaceGrantSha256 === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaceGrantSha256"],
        message: "Workspace Root与Grant Hash必须成对冻结",
      });
    }
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

export const promptBearingNodeTypeSchema = z.enum([
  "agent.plan",
  "agent.direct",
  "execute.plan",
  "note.extract",
]);

/**
 * 一个Workflow模型节点冻结后的完整Prompt输入：独立Agent Profile的System Prompt
 * 加同一份会话上下文。Tool/安全合同仍由Runtime强制，不能由Prompt扩权。
 */
export const promptNodeAssemblySchema = z
  .object({
    definitionNodeId: workflowDefinitionNodeIdSchema,
    nodeType: promptBearingNodeTypeSchema,
    profileVersion: z.string().min(1).max(100),
    regions: z.array(promptAssemblyRegionSchema).max(32),
    systemPromptAppend: z.string().max(512_000),
    piSystemPrompt: piSystemPromptResolutionSchema.optional(),
    sha256: sha256Schema,
  })
  .strict();

/**
 * 非Direct Workflow在Run创建时冻结的Prompt计划。它不是一次Provider Payload：
 * Planner、Executor和Note会在各自执行时把当前输入/上下文/工具加入Runtime Envelope。
 */
export const promptAssemblyV3Schema = z
  .object({
    schemaVersion: z.literal(PROMPT_ASSEMBLY_V3_SCHEMA_VERSION),
    promptAssemblyId: promptAssemblyIdSchema,
    productSessionId: productSessionIdSchema,
    productRunId: productRunIdSchema,
    sourceMessageId: messageIdSchema,
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    profileVersion: z.literal(WORKFLOW_PROMPT_PROFILE_VERSION),
    compilerVersion: z.literal(WORKFLOW_PROMPT_COMPILER_VERSION),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    selection: promptTurnSelectionInputV2Schema,
    sharedRegions: z.array(promptAssemblyRegionSchema).max(32),
    nodes: z.array(promptNodeAssemblySchema).min(1).max(32),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.selection.workflowDefinitionRevisionId !== value.workflowDefinitionRevisionId) {
      ctx.addIssue({
        code: "custom",
        path: ["selection", "workflowDefinitionRevisionId"],
        message: "Prompt选择与Workflow Revision不一致",
      });
    }
    if (value.selection.workspaceRootId !== value.workspaceRootId) {
      ctx.addIssue({
        code: "custom",
        path: ["selection", "workspaceRootId"],
        message: "Prompt选择与Assembly Workspace不一致",
      });
    }
    const nodeIds = new Set(value.nodes.map((node) => node.definitionNodeId));
    if (nodeIds.size !== value.nodes.length) {
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "Prompt节点Assembly重复" });
    }
  });

export const promptAssemblySchema = z.union([
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
]);

export type PromptCompositionMode = z.infer<typeof promptCompositionModeSchema>;
export type PromptRevisionSelection = z.infer<typeof promptRevisionSelectionSchema>;
export type PromptRegionCompositionInput = z.infer<typeof promptRegionCompositionInputSchema>;
export type PromptNodeSelectionInput = z.infer<typeof promptNodeSelectionInputSchema>;
export type PromptTurnSelectionInput = z.infer<typeof promptTurnSelectionInputSchema>;
export type PromptAssemblyFragment = z.infer<typeof promptAssemblyFragmentSchema>;
export type PromptAssemblyRegion = z.infer<typeof promptAssemblyRegionSchema>;
export type PromptEnvelopeMessage = z.infer<typeof promptEnvelopeMessageSchema>;
export type PromptAssemblyBudget = z.infer<typeof promptAssemblyBudgetSchema>;
export type PromptAssembly = z.infer<typeof promptAssemblySchema>;
export type PromptAssemblyV1 = z.infer<typeof promptAssemblyV1Schema>;
export type PromptAssemblyV2 = z.infer<typeof promptAssemblyV2Schema>;
export type PromptBearingNodeType = z.infer<typeof promptBearingNodeTypeSchema>;
export type PromptNodeAssembly = z.infer<typeof promptNodeAssemblySchema>;
export type PiSystemPromptResolution = z.infer<typeof piSystemPromptResolutionSchema>;
export type PromptAssemblyV3 = z.infer<typeof promptAssemblyV3Schema>;
