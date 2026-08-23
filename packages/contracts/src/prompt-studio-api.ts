import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { promptFragmentIdSchema, promptFragmentRevisionIdSchema } from "./ids.js";
import { workflowDefinitionNodeIdSchema } from "./workflow-definition.js";
import {
  promptFragmentContentSchema,
  promptFragmentScopeSchema,
  promptRegionKeySchema,
  promptWorkspaceRootIdSchema,
} from "./prompt-fragment.js";
import {
  DIRECT_PROMPT_COMPILER_V2_VERSION,
  DIRECT_PROMPT_COMPILER_V3_VERSION,
  DIRECT_PROMPT_COMPILER_VERSION,
  DIRECT_PROMPT_PROFILE_V2_VERSION,
  DIRECT_PROMPT_PROFILE_VERSION,
  WORKFLOW_PROMPT_COMPILER_VERSION,
  WORKFLOW_PROMPT_PROFILE_VERSION,
  promptAssemblyRegionSchema,
  promptTurnSelectionInputSchema,
} from "./prompt-assembly.js";

export const PROMPT_STUDIO_API_SCHEMA_VERSION = "chat-prompt-studio-api.v1";

export const promptRegionDefinitionDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    regionKey: promptRegionKeySchema,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(2_000),
    category: z.enum(["identity", "context", "runtime"]),
    plannedPlacement: z.enum(["system", "messages", "tools", "request_options"]),
    contentKind: z.enum(["markdown", "key_value", "runtime"]),
    cardinality: z.enum(["single", "multiple", "automatic"]),
    userManageable: z.boolean(),
    availability: z.enum(["active", "planned"]),
    stableOrder: z.number().int().nonnegative(),
    catalogRevision: z.number().int().positive(),
    sha256: sha256Schema,
    sourceRelativePath: z.string().min(1).max(500),
  })
  .strict();

export const promptRegionsDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    catalogSha256: sha256Schema,
    items: z.array(promptRegionDefinitionDtoSchema).max(100),
  })
  .strict();

export const promptFragmentOwnerKindSchema = z.enum(["system", "principal"]);

export const promptWorkspaceDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    rootId: promptWorkspaceRootIdSchema,
    title: z.string().min(1).max(160),
  })
  .strict();

export const promptWorkspacesDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    items: z.array(promptWorkspaceDtoSchema).max(100),
  })
  .strict();

export const promptFragmentRevisionSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const promptFragmentSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    promptFragmentId: promptFragmentIdSchema,
    ownerKind: promptFragmentOwnerKindSchema,
    scope: promptFragmentScopeSchema,
    status: z.enum(["active", "archived", "builtin"]),
    regionKey: promptRegionKeySchema,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000).optional(),
    contentKind: z.enum(["markdown", "key_value"]),
    currentRevisionId: promptFragmentRevisionIdSchema,
    currentRevisionNumber: z.number().int().positive(),
    currentRevisionSha256: sha256Schema,
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
    sourceRelativePath: z.string().min(1).max(500).optional(),
    allowedActions: z.array(z.enum(["copy", "revise", "archive", "restore"])).max(4),
  })
  .strict();

export const promptFragmentRevisionDetailDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    promptFragmentId: promptFragmentIdSchema,
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    ownerKind: promptFragmentOwnerKindSchema,
    scope: promptFragmentScopeSchema,
    revision: z.number().int().positive(),
    regionKey: promptRegionKeySchema,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000).optional(),
    content: promptFragmentContentSchema,
    supersedesRevisionId: promptFragmentRevisionIdSchema.optional(),
    supersedesRevisionSha256: sha256Schema.optional(),
    derivedFrom: z
      .object({
        kind: z.enum(["builtin", "principal"]),
        promptFragmentId: promptFragmentIdSchema,
        promptFragmentRevisionId: promptFragmentRevisionIdSchema,
        revision: z.number().int().positive(),
        sha256: sha256Schema,
        sourceRelativePath: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
    sourceRelativePath: z.string().min(1).max(500).optional(),
  })
  .strict();

export const promptFragmentDetailDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    fragment: promptFragmentSummaryDtoSchema,
    currentRevision: promptFragmentRevisionDetailDtoSchema,
    revisions: z.array(promptFragmentRevisionSummaryDtoSchema).max(500),
  })
  .strict();

export const promptFragmentPageDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    items: z.array(promptFragmentSummaryDtoSchema).max(100),
    nextCursor: z.string().min(1).max(500).optional(),
  })
  .strict();

export const listPromptFragmentsQuerySchema = z
  .object({
    regionKey: promptRegionKeySchema.optional(),
    ownerKind: promptFragmentOwnerKindSchema.optional(),
    status: z.enum(["active", "archived"]).optional(),
    scopeKind: z.enum(["global", "workspace"]).optional(),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const promptFragmentDraftPayloadSchema = z
  .object({
    regionKey: promptRegionKeySchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000).optional(),
    content: promptFragmentContentSchema,
  })
  .strict();

export const createPromptFragmentPayloadSchema = promptFragmentDraftPayloadSchema.extend({
  scope: promptFragmentScopeSchema,
});

export const copyPromptFragmentPayloadSchema = z
  .object({
    sourcePromptFragmentRevisionId: promptFragmentRevisionIdSchema,
    sourceSha256: sha256Schema,
    title: z.string().trim().min(1).max(160).optional(),
    destinationScope: promptFragmentScopeSchema,
  })
  .strict();

export const revisePromptFragmentPayloadSchema = z
  .object({
    currentRevisionId: promptFragmentRevisionIdSchema,
    currentRevisionSha256: sha256Schema,
    revision: promptFragmentDraftPayloadSchema,
  })
  .strict();

export const changePromptFragmentArchiveStatusPayloadSchema = z
  .object({
    currentRevisionId: promptFragmentRevisionIdSchema,
    currentRevisionSha256: sha256Schema,
    targetStatus: z.enum(["active", "archived"]),
  })
  .strict();

export const promptFragmentCommandResultDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    promptFragment: promptFragmentDetailDtoSchema,
    replayed: z.boolean(),
  })
  .strict();

/** 发送前语义预览；它不是Provider Payload，最终原始请求仍由Prompt Review展示。 */
export const previewPromptAssemblyPayloadSchema = z
  .object({
    text: z.string().min(1).max(4_000),
    selection: promptTurnSelectionInputSchema,
  })
  .strict();

/** 只预览Region配置，不要求或伪造本轮用户输入。 */
export const previewPromptConfigurationPayloadSchema = z
  .object({
    selection: promptTurnSelectionInputSchema,
    definitionNodeId: workflowDefinitionNodeIdSchema.optional(),
  })
  .strict();

export const promptConfigurationPreviewDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    profileVersion: z.enum([
      DIRECT_PROMPT_PROFILE_VERSION,
      DIRECT_PROMPT_PROFILE_V2_VERSION,
      WORKFLOW_PROMPT_PROFILE_VERSION,
    ]),
    compilerVersion: z.enum([
      DIRECT_PROMPT_COMPILER_VERSION,
      DIRECT_PROMPT_COMPILER_V2_VERSION,
      DIRECT_PROMPT_COMPILER_V3_VERSION,
      WORKFLOW_PROMPT_COMPILER_VERSION,
    ]),
    regions: z.array(promptAssemblyRegionSchema).max(32),
    systemPromptAppend: z.string().max(512_000),
    messageContext: z.string().max(512_000),
    sha256: sha256Schema,
  })
  .strict();

export const promptAssemblyPreviewDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_STUDIO_API_SCHEMA_VERSION),
    profileVersion: z.enum([DIRECT_PROMPT_PROFILE_VERSION, DIRECT_PROMPT_PROFILE_V2_VERSION]),
    compilerVersion: z.enum([
      DIRECT_PROMPT_COMPILER_VERSION,
      DIRECT_PROMPT_COMPILER_V2_VERSION,
      DIRECT_PROMPT_COMPILER_V3_VERSION,
    ]),
    regions: z.array(promptAssemblyRegionSchema).max(32),
    systemPromptAppend: z.string().max(512_000),
    userPrompt: z.string().min(1).max(1_000_000),
    sha256: sha256Schema,
  })
  .strict();

export type PromptRegionDefinitionDto = z.infer<typeof promptRegionDefinitionDtoSchema>;
export type PromptRegionsDto = z.infer<typeof promptRegionsDtoSchema>;
export type PromptWorkspaceDto = z.infer<typeof promptWorkspaceDtoSchema>;
export type PromptWorkspacesDto = z.infer<typeof promptWorkspacesDtoSchema>;
export type PromptFragmentRevisionSummaryDto = z.infer<
  typeof promptFragmentRevisionSummaryDtoSchema
>;
export type PromptFragmentSummaryDto = z.infer<typeof promptFragmentSummaryDtoSchema>;
export type PromptFragmentRevisionDetailDto = z.infer<typeof promptFragmentRevisionDetailDtoSchema>;
export type PromptFragmentDetailDto = z.infer<typeof promptFragmentDetailDtoSchema>;
export type PromptFragmentPageDto = z.infer<typeof promptFragmentPageDtoSchema>;
export type ListPromptFragmentsQuery = z.infer<typeof listPromptFragmentsQuerySchema>;
export type PromptFragmentDraftPayload = z.infer<typeof promptFragmentDraftPayloadSchema>;
export type CreatePromptFragmentPayload = z.infer<typeof createPromptFragmentPayloadSchema>;
export type CopyPromptFragmentPayload = z.infer<typeof copyPromptFragmentPayloadSchema>;
export type RevisePromptFragmentPayload = z.infer<typeof revisePromptFragmentPayloadSchema>;
export type ChangePromptFragmentArchiveStatusPayload = z.infer<
  typeof changePromptFragmentArchiveStatusPayloadSchema
>;
export type PromptFragmentCommandResultDto = z.infer<typeof promptFragmentCommandResultDtoSchema>;
export type PreviewPromptAssemblyPayload = z.infer<typeof previewPromptAssemblyPayloadSchema>;
export type PromptAssemblyPreviewDto = z.infer<typeof promptAssemblyPreviewDtoSchema>;
export type PreviewPromptConfigurationPayload = z.infer<
  typeof previewPromptConfigurationPayloadSchema
>;
export type PromptConfigurationPreviewDto = z.infer<typeof promptConfigurationPreviewDtoSchema>;
