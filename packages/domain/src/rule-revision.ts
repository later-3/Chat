import { canonicalJsonStringify, hashCanonical } from "./canonical-hash.js";

export type RuleLifecycleStatusShape =
  "candidate" | "trial" | "active" | "weakened" | "disabled" | "rejected";

export type RuleEnforcementShape = "user_selectable" | "system_required";
export type RuleRiskShape = "low" | "medium" | "high";

export type RuleScenarioShape =
  | "general_chat"
  | "planning"
  | "project_intake"
  | "project_advancement"
  | "note_capture"
  | "memory_capture";

export type RuleScopeShape =
  | {
      readonly schemaVersion: "rule-scope.v1";
      readonly ruleScopeId: string;
      readonly kind: "global";
    }
  | {
      readonly schemaVersion: "rule-scope.v1";
      readonly ruleScopeId: string;
      readonly kind: "contextual";
      readonly scenario: RuleScenarioShape;
      readonly projectMethodProfileId?: string;
      readonly projectStageKey?: string;
      readonly workflowNodeKey?: string;
      readonly projectId?: string;
    };

export type RuleRevisionOriginShape =
  | { readonly kind: "user_authored"; readonly principalId: string }
  | { readonly kind: "assistant_candidate"; readonly sourceMessageId: string }
  | { readonly kind: "user_imported"; readonly principalId: string };

export type RuleSourceCaseRefShape =
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "product_run"; readonly productRunId: string }
  | { readonly kind: "project_decision"; readonly projectDecisionId: string };

export interface RuleRevisionSnapshotShape {
  readonly ruleRevisionId: string;
  readonly ruleId: string;
  readonly revision: number;
  readonly supersedesRevisionId?: string;
  readonly body: string;
  readonly rationale: string;
  readonly appliesWhen: readonly string[];
  readonly doesNotApplyWhen: readonly string[];
  readonly positiveExamples: readonly string[];
  readonly negativeExamples: readonly string[];
  readonly scopes: readonly RuleScopeShape[];
  readonly tagIds: readonly string[];
  readonly conflictsWithRuleIds: readonly string[];
  readonly risk: RuleRiskShape;
  readonly origin: RuleRevisionOriginShape;
  readonly sourceCases: readonly RuleSourceCaseRefShape[];
  readonly sha256: string;
  readonly createdAt: string;
}

export type RuleDecisionActorShape =
  | { readonly kind: "principal"; readonly principalId: string }
  | {
      readonly kind: "system_governance";
      readonly policyVersion: string;
      readonly policySha256: string;
    }
  | { readonly kind: "assistant" };

const RULE_LIFECYCLE_TRANSITIONS: Readonly<
  Record<RuleLifecycleStatusShape, readonly RuleLifecycleStatusShape[]>
> = {
  candidate: ["trial", "rejected"],
  trial: ["active", "disabled", "rejected"],
  active: ["weakened", "disabled"],
  weakened: ["active", "disabled"],
  disabled: ["trial", "rejected"],
  rejected: [],
};

/**
 * Rule必须经过candidate→trial→active，不允许模型候选直接生效。disabled恢复也先回trial，
 * 让重新验证成为显式步骤；rejected保留历史但不再复活。
 */
export function assertRuleLifecycleTransition(input: {
  readonly from: RuleLifecycleStatusShape;
  readonly to: RuleLifecycleStatusShape;
  readonly enforcement: RuleEnforcementShape;
  readonly actor: RuleDecisionActorShape;
  readonly reason: string;
}): void {
  if (!RULE_LIFECYCLE_TRANSITIONS[input.from].includes(input.to)) {
    throw new RuleDomainError(
      "rule_lifecycle_transition_invalid",
      `Rule不允许从${input.from}转换到${input.to}`,
    );
  }
  if (input.reason.trim().length === 0) {
    throw new RuleDomainError("rule_lifecycle_reason_required", "Rule生命周期决定必须说明理由");
  }
  if (input.actor.kind === "assistant") {
    throw new RuleDomainError(
      "rule_lifecycle_actor_forbidden",
      "Assistant只能提出candidate，不能决定Rule生命周期",
    );
  }
  if (input.enforcement === "system_required" && input.actor.kind !== "system_governance") {
    throw new RuleDomainError(
      "rule_system_required_governance_required",
      "系统必需Rule只能由显式治理策略决定生命周期",
    );
  }
}

export function getAllowedRuleLifecycleTransitions(
  lifecycle: RuleLifecycleStatusShape,
): readonly RuleLifecycleStatusShape[] {
  return RULE_LIFECYCLE_TRANSITIONS[lifecycle];
}

/**
 * Revision Hash覆盖所有行为与来源字段；Scope、Tag、冲突和来源引用按集合规范化，
 * 避免相同语义因读取顺序不同得到不同Hash。
 */
export function computeRuleRevisionSha256(
  input: Omit<RuleRevisionSnapshotShape, "ruleRevisionId" | "sha256" | "createdAt">,
): string {
  return hashCanonical("rule-revision.v1", {
    ruleId: input.ruleId,
    revision: input.revision,
    supersedesRevisionId: input.supersedesRevisionId ?? null,
    body: input.body,
    rationale: input.rationale,
    appliesWhen: input.appliesWhen,
    doesNotApplyWhen: input.doesNotApplyWhen,
    positiveExamples: input.positiveExamples,
    negativeExamples: input.negativeExamples,
    scopes: [...input.scopes].sort((left, right) =>
      left.ruleScopeId.localeCompare(right.ruleScopeId),
    ),
    tagIds: sortedUnique(input.tagIds),
    conflictsWithRuleIds: sortedUnique(input.conflictsWithRuleIds),
    risk: input.risk,
    origin: input.origin,
    sourceCases: [...input.sourceCases].sort((left, right) =>
      canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right)),
    ),
  });
}

export function assertRuleRevisionIntegrity(revision: RuleRevisionSnapshotShape): void {
  if (revision.revision === 1 && revision.supersedesRevisionId !== undefined) {
    throw new RuleDomainError(
      "rule_revision_initial_supersedes_invalid",
      "首个Rule Revision不能引用被替代Revision",
    );
  }
  if (revision.revision > 1 && revision.supersedesRevisionId === undefined) {
    throw new RuleDomainError(
      "rule_revision_supersedes_required",
      "后续Rule Revision必须引用上一Revision",
    );
  }
  if (new Set(revision.scopes.map((scope) => scope.ruleScopeId)).size !== revision.scopes.length) {
    throw new RuleDomainError("rule_revision_scope_duplicate", "Rule Revision不能包含重复Scope");
  }
  if (revision.conflictsWithRuleIds.includes(revision.ruleId)) {
    throw new RuleDomainError("rule_revision_self_conflict", "Rule不能声明与自身冲突");
  }
  assertUnique(revision.tagIds, "rule_revision_tag_duplicate", "Rule Revision不能包含重复Tag");
  assertUnique(
    revision.conflictsWithRuleIds,
    "rule_revision_conflict_duplicate",
    "Rule Revision不能重复声明冲突Rule",
  );
  const computed = computeRuleRevisionSha256(revision);
  if (computed !== revision.sha256) {
    throw new RuleDomainError("rule_revision_hash_mismatch", "Rule Revision Hash不匹配");
  }
}

/** 修改Rule只能顺序追加Revision；不能覆盖、跳号或换到另一个Rule。 */
export function assertRuleRevisionAppend(input: {
  readonly current: RuleRevisionSnapshotShape;
  readonly next: RuleRevisionSnapshotShape;
}): void {
  assertRuleRevisionIntegrity(input.current);
  assertRuleRevisionIntegrity(input.next);
  if (input.next.ruleId !== input.current.ruleId) {
    throw new RuleDomainError("rule_revision_rule_mismatch", "新旧Revision必须属于同一Rule");
  }
  if (input.next.ruleRevisionId === input.current.ruleRevisionId) {
    throw new RuleDomainError(
      "rule_revision_identity_reused",
      "追加Revision必须分配新的Rule Revision ID",
    );
  }
  if (input.next.revision !== input.current.revision + 1) {
    throw new RuleDomainError("rule_revision_sequence_invalid", "Rule Revision必须严格递增一版");
  }
  if (input.next.supersedesRevisionId !== input.current.ruleRevisionId) {
    throw new RuleDomainError(
      "rule_revision_supersedes_mismatch",
      "新Revision必须精确引用当前Revision",
    );
  }
}

/** 已持久Revision逐字段不可变；即使攻击者重新计算Hash也不能改写历史版本。 */
export function assertRuleRevisionUnchanged(input: {
  readonly original: RuleRevisionSnapshotShape;
  readonly persisted: RuleRevisionSnapshotShape;
}): void {
  if (canonicalJsonStringify(input.original) !== canonicalJsonStringify(input.persisted)) {
    throw new RuleDomainError(
      "rule_revision_immutable_violation",
      "已持久Rule Revision不可修改，必须追加新Revision",
    );
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) {
    throw new RuleDomainError(code, message);
  }
}

export class RuleDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuleDomainError";
    this.code = code;
  }
}
