import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  ruleDecisionIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  ruleSelectionIdSchema,
  ruleTagIdSchema,
} from "./ids.js";
import {
  excludedRuleRevisionRefSchema,
  ruleDecisionActorSchema,
  ruleEnforcementSchema,
  ruleLifecycleSchema,
  ruleRevisionOriginSchema,
  ruleRiskSchema,
  ruleScopeSchema,
  ruleSelectionBudgetSchema,
  ruleSelectionConflictSchema,
  ruleSelectionContextSchema,
  ruleSelectionDiagnosticSchema,
  ruleSelectionRequestSnapshotSchema,
  ruleSourceCaseRefSchema,
  ruleScenarioSchema,
  ruleWorkflowNodeKeySchema,
  selectedRuleRevisionRefSchema,
} from "./rules.js";

export const RULES_API_SCHEMA_VERSION = "chat-rules-api.v1";

/** Scope创建输入不接受产品ID；ruleScopeId由服务端随Revision分配。 */
export const ruleScopeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({
      kind: z.literal("contextual"),
      scenario: ruleScenarioSchema,
      workflowNodeKey: ruleWorkflowNodeKeySchema.optional(),
    })
    .strict(),
]);

/** Scope DTO本身不含正文或Runtime身份，可安全嵌入Rule摘要。 */
export const ruleScopeDtoSchema = ruleScopeSchema;

/** 发送前只提交精确Rule Revision、排除和Tag选择；浏览器不能提交规则正文快照。 */
export const ruleSelectionInputSchema = z
  .object({
    explicitRules: ruleSelectionRequestSnapshotSchema.shape.explicitRules,
    excludedRuleIds: ruleSelectionRequestSnapshotSchema.shape.excludedRuleIds,
    selectedTagIds: ruleSelectionRequestSnapshotSchema.shape.selectedTagIds,
    budget: ruleSelectionBudgetSchema,
  })
  .strict();

export const ruleRevisionDraftPayloadSchema = z
  .object({
    body: z.string().trim().min(1).max(8_000),
    rationale: z.string().trim().min(1).max(4_000),
    appliesWhen: z.array(z.string().trim().min(1).max(500)).max(20),
    doesNotApplyWhen: z.array(z.string().trim().min(1).max(500)).max(20),
    positiveExamples: z.array(z.string().trim().min(1).max(1_000)).max(20),
    negativeExamples: z.array(z.string().trim().min(1).max(1_000)).max(20),
    scopes: z.array(ruleScopeInputSchema).min(1).max(20),
    tagIds: z.array(ruleTagIdSchema).max(30),
    conflictsWithRuleIds: z.array(ruleIdSchema).max(30),
    risk: ruleRiskSchema,
    sourceCases: z.array(ruleSourceCaseRefSchema).max(30),
  })
  .strict();

export const createRulePayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    priority: z.number().int().min(0).max(1_000),
    revision: ruleRevisionDraftPayloadSchema,
  })
  .strict();

export const reviseRulePayloadSchema = z
  .object({
    currentRevisionId: ruleRevisionIdSchema,
    currentRevisionSha256: sha256Schema,
    title: z.string().trim().min(1).max(160).optional(),
    revision: ruleRevisionDraftPayloadSchema,
  })
  .strict();

export const transitionRulePayloadSchema = z
  .object({
    boundRevisionId: ruleRevisionIdSchema,
    boundRevisionSha256: sha256Schema,
    toLifecycle: ruleLifecycleSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const createRuleTagPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const updateRuleTagPayloadSchema = createRuleTagPayloadSchema;
export const archiveRuleTagPayloadSchema = z.object({}).strict();

export const listRulesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    lifecycle: ruleLifecycleSchema.optional(),
    tagId: ruleTagIdSchema.optional(),
    scenario: ruleScenarioSchema.optional(),
  })
  .strict();

export const ruleTagDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleTagId: ruleTagIdSchema,
    name: z.string().min(1).max(80),
    normalizedKey: z.string().min(1).max(80),
    description: z.string().min(1).max(500).optional(),
    status: z.enum(["active", "archived"]),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const ruleRevisionSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleRevisionId: ruleRevisionIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    risk: ruleRiskSchema,
    scopes: z.array(ruleScopeSchema).min(1).max(20),
    tagIds: z.array(ruleTagIdSchema).max(30),
    conflictsWithRuleIds: z.array(ruleIdSchema).max(30),
    createdAt: z.iso.datetime(),
  })
  .strict();

const ruleAllowedActionSchema = z.enum([
  "start_trial",
  "activate",
  "weaken",
  "disable",
  "reject",
  "revise",
]);

/** 列表摘要故意没有body/rationale/examples，避免选择器和列表复制完整规则正文。 */
export const ruleSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleId: ruleIdSchema,
    title: z.string().min(1).max(160),
    lifecycle: ruleLifecycleSchema,
    enforcement: ruleEnforcementSchema,
    priority: z.number().int().min(0).max(1_000),
    currentRevision: ruleRevisionSummaryDtoSchema,
    allowedActions: z.array(ruleAllowedActionSchema).max(6),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

/** Detail仅在用户主动打开单条规则时返回正文；列表与RuleSelection仍只含摘要和引用。 */
export const ruleRevisionDetailDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleRevisionId: ruleRevisionIdSchema,
    ruleId: ruleIdSchema,
    revision: z.number().int().positive(),
    supersedesRevisionId: ruleRevisionIdSchema.optional(),
    supersedesRevisionSha256: sha256Schema.optional(),
    body: z.string().min(1).max(8_000),
    rationale: z.string().min(1).max(4_000),
    appliesWhen: z.array(z.string().min(1).max(500)).max(20),
    doesNotApplyWhen: z.array(z.string().min(1).max(500)).max(20),
    positiveExamples: z.array(z.string().min(1).max(1_000)).max(20),
    negativeExamples: z.array(z.string().min(1).max(1_000)).max(20),
    scopes: z.array(ruleScopeSchema).min(1).max(20),
    tagIds: z.array(ruleTagIdSchema).max(30),
    conflictsWithRuleIds: z.array(ruleIdSchema).max(30),
    risk: ruleRiskSchema,
    origin: ruleRevisionOriginSchema,
    sourceCases: z.array(ruleSourceCaseRefSchema).max(30),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ruleDetailDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleId: ruleIdSchema,
    title: z.string().min(1).max(160),
    lifecycle: ruleLifecycleSchema,
    enforcement: ruleEnforcementSchema,
    priority: z.number().int().min(0).max(1_000),
    currentRevision: ruleRevisionDetailDtoSchema,
    allowedActions: z.array(ruleAllowedActionSchema).max(6),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const ruleDecisionDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleDecisionId: ruleDecisionIdSchema,
    ruleId: ruleIdSchema,
    boundRevisionId: ruleRevisionIdSchema,
    boundRevisionSha256: sha256Schema,
    fromLifecycle: ruleLifecycleSchema,
    toLifecycle: ruleLifecycleSchema,
    actor: ruleDecisionActorSchema,
    reason: z.string().min(1).max(2_000),
    decidedAt: z.iso.datetime(),
  })
  .strict();

/** Selection DTO不含Rule正文；详情按精确revision另行授权查询。 */
export const ruleSelectionDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    ruleSelectionId: ruleSelectionIdSchema,
    context: ruleSelectionContextSchema,
    request: ruleSelectionRequestSnapshotSchema,
    budget: ruleSelectionBudgetSchema,
    status: z.enum(["ready", "requires_user_resolution", "blocked"]),
    selected: z.array(selectedRuleRevisionRefSchema).max(100),
    excluded: z.array(excludedRuleRevisionRefSchema).max(200),
    conflicts: z.array(ruleSelectionConflictSchema).max(100),
    diagnostics: z.array(ruleSelectionDiagnosticSchema).max(200),
    selectedContentCharacters: z.number().int().nonnegative().max(200_000),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const rulePageDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    items: z.array(ruleSummaryDtoSchema).max(100),
    nextCursor: z.string().min(1).max(500).optional(),
  })
  .strict();

export const ruleTagsDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    items: z.array(ruleTagDtoSchema).max(500),
  })
  .strict();

export const ruleDetailResponseDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    rule: ruleDetailDtoSchema,
    decisions: z.array(ruleDecisionDtoSchema).max(100),
  })
  .strict();

export const ruleCommandResultDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    rule: ruleDetailDtoSchema,
    replayed: z.boolean(),
  })
  .strict();

export const ruleTagCommandResultDtoSchema = z
  .object({
    schemaVersion: z.literal(RULES_API_SCHEMA_VERSION),
    tag: ruleTagDtoSchema,
    replayed: z.boolean(),
  })
  .strict();

export type RuleSelectionInput = z.infer<typeof ruleSelectionInputSchema>;
export type RuleScopeInput = z.infer<typeof ruleScopeInputSchema>;
export type RuleScopeDto = z.infer<typeof ruleScopeDtoSchema>;
export type RuleRevisionDraftPayload = z.infer<typeof ruleRevisionDraftPayloadSchema>;
export type CreateRulePayload = z.infer<typeof createRulePayloadSchema>;
export type ReviseRulePayload = z.infer<typeof reviseRulePayloadSchema>;
export type TransitionRulePayload = z.infer<typeof transitionRulePayloadSchema>;
export type CreateRuleTagPayload = z.infer<typeof createRuleTagPayloadSchema>;
export type UpdateRuleTagPayload = z.infer<typeof updateRuleTagPayloadSchema>;
export type ListRulesQuery = z.infer<typeof listRulesQuerySchema>;
export type RuleTagDto = z.infer<typeof ruleTagDtoSchema>;
export type RuleRevisionSummaryDto = z.infer<typeof ruleRevisionSummaryDtoSchema>;
export type RuleSummaryDto = z.infer<typeof ruleSummaryDtoSchema>;
export type RuleRevisionDetailDto = z.infer<typeof ruleRevisionDetailDtoSchema>;
export type RuleDetailDto = z.infer<typeof ruleDetailDtoSchema>;
export type RuleDecisionDto = z.infer<typeof ruleDecisionDtoSchema>;
export type RuleSelectionDto = z.infer<typeof ruleSelectionDtoSchema>;
export type RulePageDto = z.infer<typeof rulePageDtoSchema>;
export type RuleTagsDto = z.infer<typeof ruleTagsDtoSchema>;
export type RuleDetailResponseDto = z.infer<typeof ruleDetailResponseDtoSchema>;
export type RuleCommandResultDto = z.infer<typeof ruleCommandResultDtoSchema>;
export type RuleTagCommandResultDto = z.infer<typeof ruleTagCommandResultDtoSchema>;
