import { z } from "zod";
import { agentKeySchema } from "./agent-key.js";
import {
  agentEnabledToolNamesSchema,
  agentResourcesSchema,
  agentRuntimeSchema,
  agentVersionCapabilitySelectionRefSchema,
  legacyAgentVersionV1Schema,
  agentVersionSchema,
} from "./agent-configuration.js";
import { sha256Schema } from "./hash.js";
import {
  agentVersionIdSchema,
  promptFragmentIdSchema,
  promptFragmentRevisionIdSchema,
} from "./ids.js";
import { promptFragmentScopeSchema } from "./prompt-fragment.js";
import { capabilityDescriptorSchema, resolvedCapabilityRefSchema } from "./capability.js";

export const LEGACY_AGENT_PROFILE_API_SCHEMA_VERSION = "chat-agent-profile-api.v2";
export const AGENT_PROFILE_API_SCHEMA_VERSION = "chat-agent-profile-api.v3";

export { agentKeySchema, type AgentKey } from "./agent-key.js";

export const agentToolDefinitionDtoSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    policy: z.enum(["runtime_default", "runtime_locked"]),
  })
  .strict();

export const agentRuntimeToolDtoSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(4_000),
    parametersJson: z.string().min(1).max(65_536),
    sourceRelativePath: z.string().min(1).max(500),
    capability: capabilityDescriptorSchema,
    /** 无法满足scopePolicy时目录仍可展示来源，但不能伪造一个可执行Scope。 */
    resolvedRef: resolvedCapabilityRefSchema.optional(),
  })
  .strict();

/** v2已发布响应的逐字段合同；不得用v3安全字段反向扩张同一literal。 */
export const agentRuntimeToolV2DtoSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(4_000),
    parametersJson: z.string().min(1).max(65_536),
    sourceRelativePath: z.string().min(1).max(500),
  })
  .strict();

export const agentRuntimeDiagnosticDtoSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(80),
    message: z.string().min(1).max(1_000),
    sourcePath: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const agentRuntimeVariantDtoSchema = z
  .object({
    variantKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/u),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
    capabilityCatalogSha256: sha256Schema,
    readiness: z.enum(["available", "unavailable", "paused"]),
    diagnostics: z.array(agentRuntimeDiagnosticDtoSchema).max(128),
    enabledToolNames: z.array(z.string().min(1).max(80)).max(32),
    piSystemPrompt: z
      .object({
        bodyMarkdown: z.string().min(1).max(131_072),
        sha256: sha256Schema,
        dynamicPlaceholders: z.array(z.string().min(1).max(80)).max(16),
        sourceRelativePaths: z.array(z.string().min(1).max(500)).min(1).max(32),
      })
      .strict(),
    tools: z.array(agentRuntimeToolDtoSchema).max(32),
    resourceInventory: z
      .object({
        extensions: z.array(z.string().min(1).max(1_000)).max(128),
        skills: z.array(z.string().min(1).max(1_000)).max(256),
        promptTemplates: z.array(z.string().min(1).max(1_000)).max(256),
        contextFiles: z.array(z.string().min(1).max(1_000)).max(128),
        /** 四类资源路径与正文Hash的聚合；任一正文漂移都会改变Runtime Manifest。 */
        contentSha256: sha256Schema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const agentRuntimeVariantV2DtoSchema = z
  .object({
    variantKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/u),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
    capabilityCatalogSha256: sha256Schema,
    enabledToolNames: z.array(z.string().min(1).max(80)).max(32),
    piSystemPrompt: z
      .object({
        bodyMarkdown: z.string().min(1).max(131_072),
        sha256: sha256Schema,
        dynamicPlaceholders: z.array(z.string().min(1).max(80)).max(16),
        sourceRelativePaths: z.array(z.string().min(1).max(500)).min(1).max(32),
      })
      .strict(),
    tools: z.array(agentRuntimeToolV2DtoSchema).max(32),
    resourceInventory: z
      .object({
        extensions: z.array(z.string().min(1).max(1_000)).max(128),
        skills: z.array(z.string().min(1).max(1_000)).max(256),
        promptTemplates: z.array(z.string().min(1).max(1_000)).max(256),
        contextFiles: z.array(z.string().min(1).max(1_000)).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Pi运行时基线只负责投影实际SDK行为；用户可写Agent Prompt仍由Product Store拥有。 */
export const agentRuntimeBaselineDtoSchema = z
  .object({
    kind: z.literal("pi_coding_agent"),
    title: z.literal("Pi Coding Agent"),
    packageName: z.literal("@earendil-works/pi-coding-agent"),
    packageVersion: z.string().min(1).max(80),
    managedSource: z.literal("later-3/pi@codex/later-custom"),
    managedSourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
    compositionStrategy: z.enum([
      "pi_runtime_then_agent_version_then_workflow_session_run_then_chat_context",
      "pi_default_or_custom_then_chat_runtime_then_context",
    ]),
    chatRuntimeAppend: z
      .object({
        bodyMarkdown: z.string().min(1).max(65_536),
        sha256: sha256Schema,
        sourceRelativePath: z.string().min(1).max(500),
        appliesToVariantKeys: z.array(z.string().min(1).max(80)).max(16).default([]),
      })
      .strict(),
    variants: z.array(agentRuntimeVariantDtoSchema).min(1).max(16),
    finalReviewNote: z.string().min(1).max(1_000),
  })
  .strict();

export const agentRuntimeBaselineV2DtoSchema = z
  .object({
    kind: z.literal("pi_coding_agent"),
    title: z.literal("Pi Coding Agent"),
    packageName: z.literal("@earendil-works/pi-coding-agent"),
    packageVersion: z.string().min(1).max(80),
    managedSource: z.literal("later-3/pi@codex/later-custom"),
    managedSourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
    compositionStrategy: z.enum([
      "pi_runtime_then_agent_version_then_workflow_session_run_then_chat_context",
      "pi_default_or_custom_then_chat_runtime_then_context",
    ]),
    chatRuntimeAppend: z
      .object({
        bodyMarkdown: z.string().min(1).max(65_536),
        sha256: sha256Schema,
        sourceRelativePath: z.string().min(1).max(500),
        appliesToVariantKeys: z.array(z.string().min(1).max(80)).max(16).default([]),
      })
      .strict(),
    variants: z.array(agentRuntimeVariantV2DtoSchema).min(1).max(16),
    finalReviewNote: z.string().min(1).max(1_000),
  })
  .strict();

const persistedAgentSystemPromptDtoSchema = z
  .object({
    source: z.enum(["builtin", "principal_override"]),
    mode: z.literal("replace"),
    promptFragmentId: promptFragmentIdSchema,
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    revision: z.number().int().positive(),
    aggregateRevision: z.number().int().nonnegative(),
    sha256: sha256Schema,
    bodyMarkdown: z.string().min(1).max(131_072),
    sourceRelativePath: z.string().min(1).max(500),
  })
  .strict();

const runtimeDefaultAgentSystemPromptDtoSchema = z
  .object({
    source: z.literal("runtime_default"),
    mode: z.literal("inherit"),
    aggregateRevision: z.number().int().nonnegative(),
    sha256: sha256Schema,
    bodyMarkdown: z.string().min(1).max(131_072),
    runtimeVariantKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/u),
    sourceRelativePaths: z.array(z.string().min(1).max(500)).min(1).max(32),
  })
  .strict();

export const agentSystemPromptDtoSchema = z.union([
  persistedAgentSystemPromptDtoSchema,
  runtimeDefaultAgentSystemPromptDtoSchema,
]);

export const agentProfileDtoSchema = z
  .object({
    schemaVersion: z.literal(AGENT_PROFILE_API_SCHEMA_VERSION),
    agentKey: agentKeySchema,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
    profileVersion: z.string().min(1).max(80),
    supportedNodeTypes: z.array(z.string().min(1).max(80)).min(1).max(16),
    systemPrompt: agentSystemPromptDtoSchema,
    runtimeBaseline: agentRuntimeBaselineDtoSchema.optional(),
    tools: z.array(agentToolDefinitionDtoSchema).max(32),
    /** Principal创建的不可变完整Agent版本；内置默认继续由真实Runtime投影。 */
    versions: z.array(agentVersionSchema).max(256),
    allowedActions: z.array(z.enum(["revise_prompt", "restore_default", "create_version"])).max(3),
  })
  .strict();

export const agentProfileV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_AGENT_PROFILE_API_SCHEMA_VERSION),
    agentKey: agentKeySchema,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
    profileVersion: z.string().min(1).max(80),
    supportedNodeTypes: z.array(z.string().min(1).max(80)).min(1).max(16),
    systemPrompt: agentSystemPromptDtoSchema,
    runtimeBaseline: agentRuntimeBaselineV2DtoSchema.optional(),
    tools: z.array(agentToolDefinitionDtoSchema).max(32),
    versions: z.array(legacyAgentVersionV1Schema).max(256),
    allowedActions: z.array(z.enum(["revise_prompt", "restore_default", "create_version"])).max(3),
  })
  .strict();

export const agentProfilesDtoSchema = z
  .object({
    schemaVersion: z.literal(AGENT_PROFILE_API_SCHEMA_VERSION),
    items: z.array(agentProfileDtoSchema).max(32),
  })
  .strict();

export const agentProfilesV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_AGENT_PROFILE_API_SCHEMA_VERSION),
    items: z.array(agentProfileV2DtoSchema).max(32),
  })
  .strict();

export const reviseAgentPromptPayloadSchema = z
  .object({
    expectedAggregateRevision: z.number().int().nonnegative(),
    currentRevisionId: promptFragmentRevisionIdSchema.optional(),
    currentRevisionSha256: sha256Schema.optional(),
    bodyMarkdown: z.string().trim().min(1).max(65_536),
  })
  .strict();

export const restoreAgentPromptPayloadSchema = z
  .object({
    expectedAggregateRevision: z.number().int().positive(),
    currentRevisionId: promptFragmentRevisionIdSchema,
    currentRevisionSha256: sha256Schema,
  })
  .strict();

/** 保存永远创建新的不可变Agent Version，不在原版本上就地修改。 */
export const createAgentVersionPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    scope: promptFragmentScopeSchema,
    runtime: agentRuntimeSchema,
    systemPrompt: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("inherit_runtime") }).strict(),
      z
        .object({ mode: z.literal("replace"), bodyMarkdown: z.string().min(1).max(131_072) })
        .strict(),
    ]),
    enabledToolNames: agentEnabledToolNamesSchema,
    enabledCapabilityRefs: z.array(agentVersionCapabilitySelectionRefSchema).max(32).optional(),
    resources: agentResourcesSchema,
    basedOnVersionId: agentVersionIdSchema.optional(),
    basedOnVersionSha256: sha256Schema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.basedOnVersionId === undefined) !== (value.basedOnVersionSha256 === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["basedOnVersionId"],
        message: "派生版本必须同时绑定Version ID与Hash",
      });
    }
  });

export type AgentRuntimeBaselineDto = z.infer<typeof agentRuntimeBaselineDtoSchema>;
export type AgentProfileDto = z.infer<typeof agentProfileDtoSchema>;
export type AgentProfilesDto = z.infer<typeof agentProfilesDtoSchema>;
export type ReviseAgentPromptPayload = z.infer<typeof reviseAgentPromptPayloadSchema>;
export type RestoreAgentPromptPayload = z.infer<typeof restoreAgentPromptPayloadSchema>;
export type CreateAgentVersionPayload = z.infer<typeof createAgentVersionPayloadSchema>;
