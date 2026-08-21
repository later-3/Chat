import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { promptFragmentIdSchema, promptFragmentRevisionIdSchema } from "./ids.js";

export const AGENT_PROFILE_API_SCHEMA_VERSION = "chat-agent-profile-api.v1";

export const agentKeySchema = z.enum([
  "planner",
  "direct",
  "project_bootstrap",
  "coding_executor",
  "note_extractor",
]);

export const agentToolDefinitionDtoSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    policy: z.literal("runtime_locked"),
  })
  .strict();

export const agentRuntimeToolDtoSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(4_000),
    parametersJson: z.string().min(1).max(65_536),
    sourceRelativePath: z.string().min(1).max(500),
  })
  .strict();

export const agentRuntimeVariantDtoSchema = z
  .object({
    variantKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/u),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
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
    compositionStrategy: z.literal("pi_default_or_custom_then_chat_runtime_then_context"),
    chatRuntimeAppend: z
      .object({
        bodyMarkdown: z.string().min(1).max(65_536),
        sha256: sha256Schema,
        sourceRelativePath: z.string().min(1).max(500),
      })
      .strict(),
    variants: z.array(agentRuntimeVariantDtoSchema).min(1).max(16),
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
    allowedActions: z.array(z.enum(["revise_prompt", "restore_default"])).max(2),
  })
  .strict();

export const agentProfilesDtoSchema = z
  .object({
    schemaVersion: z.literal(AGENT_PROFILE_API_SCHEMA_VERSION),
    items: z.array(agentProfileDtoSchema).max(32),
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

export type AgentKey = z.infer<typeof agentKeySchema>;
export type AgentRuntimeBaselineDto = z.infer<typeof agentRuntimeBaselineDtoSchema>;
export type AgentProfileDto = z.infer<typeof agentProfileDtoSchema>;
export type AgentProfilesDto = z.infer<typeof agentProfilesDtoSchema>;
export type ReviseAgentPromptPayload = z.infer<typeof reviseAgentPromptPayloadSchema>;
export type RestoreAgentPromptPayload = z.infer<typeof restoreAgentPromptPayloadSchema>;
