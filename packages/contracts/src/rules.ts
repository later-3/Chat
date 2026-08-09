import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  commandIdSchema,
  contextPackageIdSchema,
  messageIdSchema,
  principalIdSchema,
  productRunIdSchema,
  projectDecisionIdSchema,
  projectIdSchema,
  ruleDecisionIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  ruleScopeIdSchema,
  ruleSelectionIdSchema,
  ruleTagIdSchema,
} from "./ids.js";
import { projectMethodProfileIdSchema } from "./project.js";

const isoDateTimeSchema = z.iso.datetime();
const shortTextSchema = z.string().trim().min(1).max(500);
const ruleTitleSchema = z.string().trim().min(1).max(160);

export const ruleLifecycleSchema = z.enum([
  "candidate",
  "trial",
  "active",
  "weakened",
  "disabled",
  "rejected",
]);

export const ruleRiskSchema = z.enum(["low", "medium", "high"]);
export const ruleEnforcementSchema = z.enum(["user_selectable", "system_required"]);

export const ruleScenarioSchema = z.enum([
  "general_chat",
  "planning",
  "project_intake",
  "project_advancement",
  "note_capture",
  "memory_capture",
]);

export const ruleProjectStageKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u);
export const ruleWorkflowNodeKeySchema = z.string().regex(/^[a-z][a-z0-9.-]{0,119}$/u);

/**
 * Scope是Revision内的不可变值对象。global与contextual显式分支避免用空数组暗示
 * “任意场景”；contextual内各约束取AND，不同Scope之间取OR。
 */
export const ruleScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal("rule-scope.v1"),
      ruleScopeId: ruleScopeIdSchema,
      kind: z.literal("global"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("rule-scope.v1"),
      ruleScopeId: ruleScopeIdSchema,
      kind: z.literal("contextual"),
      scenario: ruleScenarioSchema,
      projectMethodProfileId: projectMethodProfileIdSchema.optional(),
      projectStageKey: ruleProjectStageKeySchema.optional(),
      workflowNodeKey: ruleWorkflowNodeKeySchema.optional(),
      projectId: projectIdSchema.optional(),
    })
    .strict(),
]);

export const ruleSourceCaseRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      messageId: messageIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("product_run"),
      productRunId: productRunIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_decision"),
      projectDecisionId: projectDecisionIdSchema,
    })
    .strict(),
]);

export const ruleRevisionOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user_authored"),
      principalId: principalIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assistant_candidate"),
      sourceMessageId: messageIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("user_imported"),
      principalId: principalIdSchema,
    })
    .strict(),
]);

/**
 * RuleRevision一经保存不可更新；修改正文、Scope、标签、冲突或风险都必须追加Revision。
 * Hash覆盖全部行为字段，历史Context只引用精确Revision与Hash。
 */
export const ruleRevisionSchema = z
  .object({
    schemaVersion: z.literal("rule-revision.v1"),
    ruleRevisionId: ruleRevisionIdSchema,
    ruleId: ruleIdSchema,
    revision: z.number().int().positive(),
    supersedesRevisionId: ruleRevisionIdSchema.optional(),
    body: z.string().trim().min(1).max(8_000),
    rationale: z.string().trim().min(1).max(4_000),
    appliesWhen: z.array(shortTextSchema).max(20),
    doesNotApplyWhen: z.array(shortTextSchema).max(20),
    positiveExamples: z.array(z.string().trim().min(1).max(1_000)).max(20),
    negativeExamples: z.array(z.string().trim().min(1).max(1_000)).max(20),
    scopes: z.array(ruleScopeSchema).min(1).max(20),
    tagIds: z.array(ruleTagIdSchema).max(30),
    conflictsWithRuleIds: z.array(ruleIdSchema).max(30),
    risk: ruleRiskSchema,
    origin: ruleRevisionOriginSchema,
    sourceCases: z.array(ruleSourceCaseRefSchema).max(30),
    sha256: sha256Schema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

/** Rule只拥有聚合身份、CAS revision和当前精确Revision；正文只存在于RuleRevision。 */
export const ruleSchema = z
  .object({
    schemaVersion: z.literal("rule.v1"),
    ruleId: ruleIdSchema,
    ownerPrincipalId: principalIdSchema,
    title: ruleTitleSchema,
    lifecycle: ruleLifecycleSchema,
    enforcement: ruleEnforcementSchema,
    priority: z.number().int().min(0).max(1_000),
    currentRevisionId: ruleRevisionIdSchema,
    currentRevisionNumber: z.number().int().positive(),
    currentRevisionSha256: sha256Schema,
    latestDecisionId: ruleDecisionIdSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const ruleTagSchema = z
  .object({
    schemaVersion: z.literal("rule-tag.v1"),
    ruleTagId: ruleTagIdSchema,
    ownerPrincipalId: principalIdSchema,
    name: z.string().trim().min(1).max(80),
    normalizedKey: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$/u),
    description: z.string().trim().min(1).max(500).optional(),
    status: z.enum(["active", "archived"]),
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const ruleDecisionActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("principal"),
      principalId: principalIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("system_governance"),
      policyVersion: z.string().regex(/^[a-z][a-z0-9.-]{0,119}\.v\d+$/u),
      policySha256: sha256Schema,
    })
    .strict(),
]);

/** 生命周期变化是独立Decision；它绑定当时Revision/Hash，不能被后续修改倒灌。 */
export const ruleDecisionSchema = z
  .object({
    schemaVersion: z.literal("rule-decision.v1"),
    ruleDecisionId: ruleDecisionIdSchema,
    ruleId: ruleIdSchema,
    boundRevisionId: ruleRevisionIdSchema,
    boundRevisionSha256: sha256Schema,
    expectedRuleRevision: z.number().int().positive(),
    fromLifecycle: ruleLifecycleSchema,
    toLifecycle: ruleLifecycleSchema,
    actor: ruleDecisionActorSchema,
    reason: z.string().trim().min(1).max(2_000),
    commandId: commandIdSchema,
    decidedAt: isoDateTimeSchema,
  })
  .strict();

export const ruleSelectionContextSchema = z
  .object({
    scenario: ruleScenarioSchema,
    projectMethodProfileId: projectMethodProfileIdSchema.optional(),
    projectStageKey: ruleProjectStageKeySchema.optional(),
    workflowNodeKey: ruleWorkflowNodeKeySchema.optional(),
    projectId: projectIdSchema.optional(),
  })
  .strict();

export const ruleSelectionRequestedRefSchema = z
  .object({
    ruleId: ruleIdSchema,
    ruleRevisionId: ruleRevisionIdSchema,
    ruleRevisionSha256: sha256Schema,
  })
  .strict();

export const ruleSelectionSourceSchema = z.enum([
  "explicit_rule",
  "selected_tag",
  "system_required",
  "scope_active",
]);

export const ruleSelectionExclusionCodeSchema = z.enum([
  "explicitly_excluded",
  "explicit_selection_excluded",
  "rule_missing",
  "revision_stale",
  "lifecycle_unavailable",
  "scope_mismatch",
  "automatic_conflict",
  "explicit_conflict",
  "required_conflict",
  "budget_exceeded",
]);

export const ruleSelectionDiagnosticCodeSchema = z.enum([
  "explicit_rule_missing",
  "explicit_revision_stale",
  "explicit_rule_unavailable",
  "explicit_selection_excluded",
  "required_rule_unavailable",
  "required_exclusion_ignored",
  "explicit_conflict_requires_resolution",
  "required_rule_conflict",
  "automatic_conflict_excluded",
  "required_budget_exceeded",
  "explicit_budget_exceeded",
  "automatic_budget_exceeded",
]);

export const ruleSelectionRequestSnapshotSchema = z
  .object({
    explicitRules: z.array(ruleSelectionRequestedRefSchema).max(50),
    excludedRuleIds: z.array(ruleIdSchema).max(50),
    selectedTagIds: z.array(ruleTagIdSchema).max(30),
  })
  .strict();

export const ruleSelectionBudgetSchema = z
  .object({
    maxRules: z.number().int().nonnegative().max(100),
    maxContentCharacters: z.number().int().nonnegative().max(200_000),
  })
  .strict();

export const selectedRuleRevisionRefSchema = z
  .object({
    ruleId: ruleIdSchema,
    ruleRevisionId: ruleRevisionIdSchema,
    ruleRevisionSha256: sha256Schema,
    source: ruleSelectionSourceSchema,
    priority: z.number().int().min(0).max(1_000),
    contentCharacters: z.number().int().positive().max(8_000),
  })
  .strict();

export const excludedRuleRevisionRefSchema = z
  .object({
    ruleId: ruleIdSchema,
    ruleRevisionId: ruleRevisionIdSchema.optional(),
    code: ruleSelectionExclusionCodeSchema,
    conflictingRuleId: ruleIdSchema.optional(),
  })
  .strict();

export const ruleSelectionConflictSchema = z
  .object({
    leftRuleId: ruleIdSchema,
    rightRuleId: ruleIdSchema,
    kind: z.enum(["explicit", "required", "automatic"]),
    resolution: z.enum(["requires_user", "blocked", "left_selected", "right_selected"]),
  })
  .strict();

export const ruleSelectionDiagnosticSchema = z
  .object({
    code: ruleSelectionDiagnosticCodeSchema,
    severity: z.enum(["info", "warning", "error"]),
    ruleIds: z.array(ruleIdSchema).min(1).max(2),
  })
  .strict();

/**
 * RuleSelection只保存精确Revision引用、选择原因和稳定诊断；规则正文仍只在Revision中。
 */
export const ruleSelectionSchema = z
  .object({
    schemaVersion: z.literal("rule-selection.v1"),
    ruleSelectionId: ruleSelectionIdSchema,
    productRunId: productRunIdSchema,
    contextPackageId: contextPackageIdSchema.optional(),
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
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type RuleLifecycle = z.infer<typeof ruleLifecycleSchema>;
export type RuleRisk = z.infer<typeof ruleRiskSchema>;
export type RuleEnforcement = z.infer<typeof ruleEnforcementSchema>;
export type RuleScenario = z.infer<typeof ruleScenarioSchema>;
export type RuleScope = z.infer<typeof ruleScopeSchema>;
export type RuleRevision = z.infer<typeof ruleRevisionSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type RuleTag = z.infer<typeof ruleTagSchema>;
export type RuleDecision = z.infer<typeof ruleDecisionSchema>;
export type RuleSelectionContext = z.infer<typeof ruleSelectionContextSchema>;
export type RuleSelectionRequestedRef = z.infer<typeof ruleSelectionRequestedRefSchema>;
export type RuleSelectionBudget = z.infer<typeof ruleSelectionBudgetSchema>;
export type SelectedRuleRevisionRef = z.infer<typeof selectedRuleRevisionRefSchema>;
export type ExcludedRuleRevisionRef = z.infer<typeof excludedRuleRevisionRefSchema>;
export type RuleSelectionConflict = z.infer<typeof ruleSelectionConflictSchema>;
export type RuleSelectionDiagnostic = z.infer<typeof ruleSelectionDiagnosticSchema>;
export type RuleSelection = z.infer<typeof ruleSelectionSchema>;
