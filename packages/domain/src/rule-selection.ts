import { hashCanonical } from "./canonical-hash.js";
import {
  RuleDomainError,
  type RuleEnforcementShape,
  type RuleLifecycleStatusShape,
  type RuleScenarioShape,
  type RuleScopeShape,
} from "./rule-revision.js";

export interface RuleSelectionCandidateShape {
  readonly ruleId: string;
  readonly ruleRevisionId: string;
  readonly ruleRevisionSha256: string;
  readonly lifecycle: RuleLifecycleStatusShape;
  readonly enforcement: RuleEnforcementShape;
  readonly priority: number;
  readonly tagIds: readonly string[];
  readonly scopes: readonly RuleScopeShape[];
  readonly conflictsWithRuleIds: readonly string[];
  readonly contentCharacters: number;
}

export interface RuleSelectionContextShape {
  readonly scenario: RuleScenarioShape;
  readonly projectMethodProfileId?: string;
  readonly projectStageKey?: string;
  readonly workflowNodeKey?: string;
  readonly projectId?: string;
}

export interface RequestedRuleRevisionShape {
  readonly ruleId: string;
  readonly ruleRevisionId: string;
  readonly ruleRevisionSha256: string;
}

export interface RuleSelectionBudgetShape {
  readonly maxRules: number;
  readonly maxContentCharacters: number;
}

export interface RuleSelectionRequestShape {
  readonly explicitRules: readonly RequestedRuleRevisionShape[];
  readonly excludedRuleIds: readonly string[];
  readonly selectedTagIds: readonly string[];
  readonly context: RuleSelectionContextShape;
  readonly budget: RuleSelectionBudgetShape;
}

export type RuleSelectionSourceShape =
  "explicit_rule" | "selected_tag" | "system_required" | "scope_active";

export interface SelectedRuleRevisionShape {
  readonly ruleId: string;
  readonly ruleRevisionId: string;
  readonly ruleRevisionSha256: string;
  readonly source: RuleSelectionSourceShape;
  readonly priority: number;
  readonly contentCharacters: number;
}

export type RuleSelectionExclusionCodeShape =
  | "explicitly_excluded"
  | "explicit_selection_excluded"
  | "rule_missing"
  | "revision_stale"
  | "lifecycle_unavailable"
  | "scope_mismatch"
  | "automatic_conflict"
  | "explicit_conflict"
  | "required_conflict"
  | "budget_exceeded";

export interface ExcludedRuleRevisionShape {
  readonly ruleId: string;
  readonly ruleRevisionId?: string;
  readonly code: RuleSelectionExclusionCodeShape;
  readonly conflictingRuleId?: string;
}

export type RuleSelectionDiagnosticCodeShape =
  | "explicit_rule_missing"
  | "explicit_revision_stale"
  | "explicit_rule_unavailable"
  | "explicit_selection_excluded"
  | "required_rule_unavailable"
  | "required_exclusion_ignored"
  | "explicit_conflict_requires_resolution"
  | "required_rule_conflict"
  | "automatic_conflict_excluded"
  | "required_budget_exceeded"
  | "explicit_budget_exceeded"
  | "automatic_budget_exceeded";

export interface RuleSelectionDiagnosticShape {
  readonly code: RuleSelectionDiagnosticCodeShape;
  readonly severity: "info" | "warning" | "error";
  readonly ruleIds: readonly string[];
}

export interface RuleSelectionConflictShape {
  readonly leftRuleId: string;
  readonly rightRuleId: string;
  readonly kind: "explicit" | "required" | "automatic";
  readonly resolution: "requires_user" | "blocked" | "left_selected" | "right_selected";
}

export interface RuleSelectionResultShape {
  readonly status: "ready" | "requires_user_resolution" | "blocked";
  readonly selected: readonly SelectedRuleRevisionShape[];
  readonly excluded: readonly ExcludedRuleRevisionShape[];
  readonly conflicts: readonly RuleSelectionConflictShape[];
  readonly diagnostics: readonly RuleSelectionDiagnosticShape[];
  readonly selectedContentCharacters: number;
  readonly sha256: string;
}

type MutableStatus = { blocked: boolean; requiresUser: boolean };

/**
 * 确定性Rule选择器。它只消费Revision摘要，不接触正文：正文由Application在status=ready后
 * 按精确Revision/Hash组装Context，避免选择阶段把完整规则复制到日志或公开摘要。
 */
export function selectRules(input: {
  readonly candidates: readonly RuleSelectionCandidateShape[];
  readonly request: RuleSelectionRequestShape;
}): RuleSelectionResultShape {
  assertSelectionInput(input);
  const candidates = sortCandidates(input.candidates);
  const byRuleId = new Map(candidates.map((candidate) => [candidate.ruleId, candidate]));
  const excludedRuleIds = new Set(input.request.excludedRuleIds);
  const selectedTagIds = new Set(input.request.selectedTagIds);
  const selected = new Map<string, SelectedRuleRevisionShape>();
  const withheldRuleIds = new Set<string>();
  const exclusions: ExcludedRuleRevisionShape[] = [];
  const diagnostics: RuleSelectionDiagnosticShape[] = [];
  const conflicts: RuleSelectionConflictShape[] = [];
  const status: MutableStatus = { blocked: false, requiresUser: false };

  for (const ruleId of [...excludedRuleIds].sort()) {
    const candidate = byRuleId.get(ruleId);
    addExclusion(exclusions, {
      ruleId,
      ...(candidate === undefined ? {} : { ruleRevisionId: candidate.ruleRevisionId }),
      code: "explicitly_excluded",
    });
  }

  selectExplicitRules({
    requested: [...input.request.explicitRules].sort((left, right) =>
      left.ruleId.localeCompare(right.ruleId),
    ),
    byRuleId,
    excludedRuleIds,
    selected,
    withheldRuleIds,
    exclusions,
    diagnostics,
    status,
  });

  for (const candidate of candidates) {
    if (
      candidate.enforcement === "user_selectable" &&
      candidate.lifecycle === "active" &&
      candidate.tagIds.some((tagId) => selectedTagIds.has(tagId)) &&
      !excludedRuleIds.has(candidate.ruleId) &&
      !withheldRuleIds.has(candidate.ruleId) &&
      !selected.has(candidate.ruleId)
    ) {
      selected.set(candidate.ruleId, toSelected(candidate, "selected_tag"));
    }
  }

  selectRequiredRules({
    candidates,
    excludedRuleIds,
    selected,
    exclusions,
    diagnostics,
    status,
  });

  selectScopedActiveRules({
    candidates,
    context: input.request.context,
    excludedRuleIds,
    withheldRuleIds,
    selected,
    exclusions,
  });

  resolveConflicts({
    candidatesByRuleId: byRuleId,
    selected,
    exclusions,
    diagnostics,
    conflicts,
    status,
  });

  const budgeted = applyBudget({
    selected: [...selected.values()],
    budget: input.request.budget,
    exclusions,
    diagnostics,
    status,
  });
  const finalSelected = sortSelectedForOutput(budgeted);
  const finalExcluded = sortExclusions(exclusions);
  const finalConflicts = sortConflicts(conflicts);
  const finalDiagnostics = sortDiagnostics(diagnostics);
  const selectedContentCharacters = finalSelected.reduce(
    (total, rule) => total + rule.contentCharacters,
    0,
  );
  const finalStatus = status.blocked
    ? "blocked"
    : status.requiresUser
      ? "requires_user_resolution"
      : "ready";
  const resultWithoutHash = {
    status: finalStatus,
    selected: finalSelected,
    excluded: finalExcluded,
    conflicts: finalConflicts,
    diagnostics: finalDiagnostics,
    selectedContentCharacters,
  } as const;
  return {
    ...resultWithoutHash,
    sha256: computeRuleSelectionSha256({ request: input.request, result: resultWithoutHash }),
  };
}

export function ruleScopeMatches(
  scope: RuleScopeShape,
  context: RuleSelectionContextShape,
): boolean {
  if (scope.kind === "global") return true;
  return (
    scope.scenario === context.scenario &&
    matchesOptional(scope.projectMethodProfileId, context.projectMethodProfileId) &&
    matchesOptional(scope.projectStageKey, context.projectStageKey) &&
    matchesOptional(scope.workflowNodeKey, context.workflowNodeKey) &&
    matchesOptional(scope.projectId, context.projectId)
  );
}

export function computeRuleSelectionSha256(input: {
  readonly request: RuleSelectionRequestShape;
  readonly result: Omit<RuleSelectionResultShape, "sha256">;
}): string {
  return hashCanonical("rule-selection.v1", {
    request: {
      explicitRules: [...input.request.explicitRules].sort(compareRequestedRule),
      excludedRuleIds: sortedUnique(input.request.excludedRuleIds),
      selectedTagIds: sortedUnique(input.request.selectedTagIds),
      context: normalizeContext(input.request.context),
      budget: input.request.budget,
    },
    result: {
      status: input.result.status,
      selected: input.result.selected,
      excluded: input.result.excluded.map((item) => ({
        ruleId: item.ruleId,
        ruleRevisionId: item.ruleRevisionId ?? null,
        code: item.code,
        conflictingRuleId: item.conflictingRuleId ?? null,
      })),
      conflicts: input.result.conflicts,
      diagnostics: input.result.diagnostics,
      selectedContentCharacters: input.result.selectedContentCharacters,
    },
  });
}

function selectExplicitRules(input: {
  requested: readonly RequestedRuleRevisionShape[];
  byRuleId: ReadonlyMap<string, RuleSelectionCandidateShape>;
  excludedRuleIds: ReadonlySet<string>;
  selected: Map<string, SelectedRuleRevisionShape>;
  withheldRuleIds: Set<string>;
  exclusions: ExcludedRuleRevisionShape[];
  diagnostics: RuleSelectionDiagnosticShape[];
  status: MutableStatus;
}): void {
  for (const requested of input.requested) {
    const candidate = input.byRuleId.get(requested.ruleId);
    if (candidate === undefined) {
      addExclusion(input.exclusions, { ruleId: requested.ruleId, code: "rule_missing" });
      input.diagnostics.push({
        code: "explicit_rule_missing",
        severity: "error",
        ruleIds: [requested.ruleId],
      });
      input.status.requiresUser = true;
      input.withheldRuleIds.add(requested.ruleId);
      continue;
    }
    if (
      candidate.ruleRevisionId !== requested.ruleRevisionId ||
      candidate.ruleRevisionSha256 !== requested.ruleRevisionSha256
    ) {
      addExclusion(input.exclusions, {
        ruleId: candidate.ruleId,
        ruleRevisionId: candidate.ruleRevisionId,
        code: "revision_stale",
      });
      input.diagnostics.push({
        code: "explicit_revision_stale",
        severity: "error",
        ruleIds: [candidate.ruleId],
      });
      input.status.requiresUser = true;
      input.withheldRuleIds.add(candidate.ruleId);
      continue;
    }
    if (input.excludedRuleIds.has(candidate.ruleId)) {
      addExclusion(input.exclusions, {
        ruleId: candidate.ruleId,
        ruleRevisionId: candidate.ruleRevisionId,
        code: "explicit_selection_excluded",
      });
      input.diagnostics.push({
        code: "explicit_selection_excluded",
        severity: "error",
        ruleIds: [candidate.ruleId],
      });
      input.status.requiresUser = true;
      input.withheldRuleIds.add(candidate.ruleId);
      continue;
    }
    if (!isExplicitlySelectable(candidate.lifecycle)) {
      addExclusion(input.exclusions, {
        ruleId: candidate.ruleId,
        ruleRevisionId: candidate.ruleRevisionId,
        code: "lifecycle_unavailable",
      });
      input.diagnostics.push({
        code: "explicit_rule_unavailable",
        severity: "error",
        ruleIds: [candidate.ruleId],
      });
      input.status.requiresUser = true;
      input.withheldRuleIds.add(candidate.ruleId);
      continue;
    }
    input.selected.set(candidate.ruleId, toSelected(candidate, "explicit_rule"));
  }
}

function selectRequiredRules(input: {
  candidates: readonly RuleSelectionCandidateShape[];
  excludedRuleIds: ReadonlySet<string>;
  selected: Map<string, SelectedRuleRevisionShape>;
  exclusions: ExcludedRuleRevisionShape[];
  diagnostics: RuleSelectionDiagnosticShape[];
  status: MutableStatus;
}): void {
  for (const candidate of input.candidates) {
    if (candidate.enforcement !== "system_required") continue;
    if (candidate.lifecycle !== "active") {
      addExclusion(input.exclusions, {
        ruleId: candidate.ruleId,
        ruleRevisionId: candidate.ruleRevisionId,
        code: "lifecycle_unavailable",
      });
      input.diagnostics.push({
        code: "required_rule_unavailable",
        severity: "error",
        ruleIds: [candidate.ruleId],
      });
      input.status.blocked = true;
      continue;
    }
    if (input.excludedRuleIds.has(candidate.ruleId)) {
      input.diagnostics.push({
        code: "required_exclusion_ignored",
        severity: "warning",
        ruleIds: [candidate.ruleId],
      });
    }
    input.selected.set(candidate.ruleId, toSelected(candidate, "system_required"));
  }
}

function selectScopedActiveRules(input: {
  candidates: readonly RuleSelectionCandidateShape[];
  context: RuleSelectionContextShape;
  excludedRuleIds: ReadonlySet<string>;
  withheldRuleIds: ReadonlySet<string>;
  selected: Map<string, SelectedRuleRevisionShape>;
  exclusions: ExcludedRuleRevisionShape[];
}): void {
  for (const candidate of input.candidates) {
    if (input.selected.has(candidate.ruleId)) continue;
    if (input.excludedRuleIds.has(candidate.ruleId)) continue;
    if (input.withheldRuleIds.has(candidate.ruleId)) continue;
    if (candidate.enforcement !== "user_selectable" || candidate.lifecycle !== "active") {
      addExclusion(input.exclusions, {
        ruleId: candidate.ruleId,
        ruleRevisionId: candidate.ruleRevisionId,
        code: "lifecycle_unavailable",
      });
      continue;
    }
    if (!candidate.scopes.some((scope) => ruleScopeMatches(scope, input.context))) {
      addExclusion(input.exclusions, {
        ruleId: candidate.ruleId,
        ruleRevisionId: candidate.ruleRevisionId,
        code: "scope_mismatch",
      });
      continue;
    }
    input.selected.set(candidate.ruleId, toSelected(candidate, "scope_active"));
  }
}

function resolveConflicts(input: {
  candidatesByRuleId: ReadonlyMap<string, RuleSelectionCandidateShape>;
  selected: Map<string, SelectedRuleRevisionShape>;
  exclusions: ExcludedRuleRevisionShape[];
  diagnostics: RuleSelectionDiagnosticShape[];
  conflicts: RuleSelectionConflictShape[];
  status: MutableStatus;
}): void {
  const ruleIds = [...input.selected.keys()].sort();
  for (let leftIndex = 0; leftIndex < ruleIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ruleIds.length; rightIndex += 1) {
      const leftId = ruleIds[leftIndex];
      const rightId = ruleIds[rightIndex];
      if (leftId === undefined || rightId === undefined) continue;
      const left = input.selected.get(leftId);
      const right = input.selected.get(rightId);
      if (left === undefined || right === undefined) continue;
      const leftCandidate = input.candidatesByRuleId.get(leftId);
      const rightCandidate = input.candidatesByRuleId.get(rightId);
      if (
        leftCandidate === undefined ||
        rightCandidate === undefined ||
        !rulesConflict(leftCandidate, rightCandidate)
      ) {
        continue;
      }
      resolveConflictPair({ ...input, left, right });
    }
  }
}

function resolveConflictPair(input: {
  left: SelectedRuleRevisionShape;
  right: SelectedRuleRevisionShape;
  selected: Map<string, SelectedRuleRevisionShape>;
  exclusions: ExcludedRuleRevisionShape[];
  diagnostics: RuleSelectionDiagnosticShape[];
  conflicts: RuleSelectionConflictShape[];
  status: MutableStatus;
}): void {
  const leftRequired = input.left.source === "system_required";
  const rightRequired = input.right.source === "system_required";
  const leftExplicit = isExplicitSource(input.left.source);
  const rightExplicit = isExplicitSource(input.right.source);
  if (leftRequired && rightRequired) {
    input.selected.delete(input.left.ruleId);
    input.selected.delete(input.right.ruleId);
    excludeConflict(input.exclusions, input.left, input.right, "required_conflict");
    excludeConflict(input.exclusions, input.right, input.left, "required_conflict");
    input.conflicts.push({
      leftRuleId: input.left.ruleId,
      rightRuleId: input.right.ruleId,
      kind: "required",
      resolution: "blocked",
    });
    input.diagnostics.push({
      code: "required_rule_conflict",
      severity: "error",
      ruleIds: [input.left.ruleId, input.right.ruleId],
    });
    input.status.blocked = true;
    return;
  }
  if (
    (leftExplicit && rightExplicit) ||
    (leftRequired && rightExplicit) ||
    (rightRequired && leftExplicit)
  ) {
    const keep = leftRequired ? input.left : rightRequired ? input.right : undefined;
    if (keep === undefined) {
      input.selected.delete(input.left.ruleId);
      input.selected.delete(input.right.ruleId);
      excludeConflict(input.exclusions, input.left, input.right, "explicit_conflict");
      excludeConflict(input.exclusions, input.right, input.left, "explicit_conflict");
    } else {
      const remove = keep.ruleId === input.left.ruleId ? input.right : input.left;
      input.selected.delete(remove.ruleId);
      excludeConflict(input.exclusions, remove, keep, "explicit_conflict");
    }
    input.conflicts.push({
      leftRuleId: input.left.ruleId,
      rightRuleId: input.right.ruleId,
      kind: "explicit",
      resolution: "requires_user",
    });
    input.diagnostics.push({
      code: "explicit_conflict_requires_resolution",
      severity: "error",
      ruleIds: [input.left.ruleId, input.right.ruleId],
    });
    input.status.requiresUser = true;
    return;
  }
  const winner = chooseConflictWinner(input.left, input.right);
  const loser = winner.ruleId === input.left.ruleId ? input.right : input.left;
  input.selected.delete(loser.ruleId);
  excludeConflict(input.exclusions, loser, winner, "automatic_conflict");
  input.conflicts.push({
    leftRuleId: input.left.ruleId,
    rightRuleId: input.right.ruleId,
    kind: "automatic",
    resolution: winner.ruleId === input.left.ruleId ? "left_selected" : "right_selected",
  });
  input.diagnostics.push({
    code: "automatic_conflict_excluded",
    severity: "info",
    ruleIds: [loser.ruleId, winner.ruleId],
  });
}

function applyBudget(input: {
  selected: readonly SelectedRuleRevisionShape[];
  budget: RuleSelectionBudgetShape;
  exclusions: ExcludedRuleRevisionShape[];
  diagnostics: RuleSelectionDiagnosticShape[];
  status: MutableStatus;
}): SelectedRuleRevisionShape[] {
  const accepted: SelectedRuleRevisionShape[] = [];
  let characters = 0;
  const groups = [
    input.selected.filter((rule) => rule.source === "system_required"),
    input.selected.filter((rule) => isExplicitSource(rule.source)),
    input.selected.filter((rule) => rule.source === "scope_active"),
  ];
  for (const [groupIndex, group] of groups.entries()) {
    for (const rule of sortSelectedByPriority(group)) {
      if (
        accepted.length < input.budget.maxRules &&
        characters + rule.contentCharacters <= input.budget.maxContentCharacters
      ) {
        accepted.push(rule);
        characters += rule.contentCharacters;
        continue;
      }
      addExclusion(input.exclusions, {
        ruleId: rule.ruleId,
        ruleRevisionId: rule.ruleRevisionId,
        code: "budget_exceeded",
      });
      const code =
        groupIndex === 0
          ? "required_budget_exceeded"
          : groupIndex === 1
            ? "explicit_budget_exceeded"
            : "automatic_budget_exceeded";
      input.diagnostics.push({
        code,
        severity: groupIndex === 2 ? "warning" : "error",
        ruleIds: [rule.ruleId],
      });
      if (groupIndex === 0) input.status.blocked = true;
      if (groupIndex === 1) input.status.requiresUser = true;
    }
  }
  return accepted;
}

function assertSelectionInput(input: {
  readonly candidates: readonly RuleSelectionCandidateShape[];
  readonly request: RuleSelectionRequestShape;
}): void {
  const candidateIds = input.candidates.map((candidate) => candidate.ruleId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new RuleDomainError(
      "rule_selection_candidate_duplicate",
      "Rule Selector每个Rule只能接收一个当前Revision",
    );
  }
  const explicitIds = input.request.explicitRules.map((rule) => rule.ruleId);
  if (new Set(explicitIds).size !== explicitIds.length) {
    throw new RuleDomainError("rule_selection_explicit_duplicate", "显式Rule选择不能重复同一Rule");
  }
  if (
    !Number.isInteger(input.request.budget.maxRules) ||
    input.request.budget.maxRules < 0 ||
    !Number.isInteger(input.request.budget.maxContentCharacters) ||
    input.request.budget.maxContentCharacters < 0
  ) {
    throw new RuleDomainError("rule_selection_budget_invalid", "Rule选择预算必须是非负整数");
  }
  for (const candidate of input.candidates) {
    if (
      !Number.isInteger(candidate.priority) ||
      candidate.priority < 0 ||
      !Number.isInteger(candidate.contentCharacters) ||
      candidate.contentCharacters <= 0
    ) {
      throw new RuleDomainError(
        "rule_selection_candidate_invalid",
        "Rule选择候选的priority和正文字符数必须有效",
      );
    }
  }
}

function toSelected(
  candidate: RuleSelectionCandidateShape,
  source: RuleSelectionSourceShape,
): SelectedRuleRevisionShape {
  return {
    ruleId: candidate.ruleId,
    ruleRevisionId: candidate.ruleRevisionId,
    ruleRevisionSha256: candidate.ruleRevisionSha256,
    source,
    priority: candidate.priority,
    contentCharacters: candidate.contentCharacters,
  };
}

function isExplicitlySelectable(lifecycle: RuleLifecycleStatusShape): boolean {
  return lifecycle === "trial" || lifecycle === "active" || lifecycle === "weakened";
}

function isExplicitSource(source: RuleSelectionSourceShape): boolean {
  return source === "explicit_rule" || source === "selected_tag";
}

function rulesConflict(
  left: RuleSelectionCandidateShape,
  right: RuleSelectionCandidateShape,
): boolean {
  return (
    left.conflictsWithRuleIds.includes(right.ruleId) ||
    right.conflictsWithRuleIds.includes(left.ruleId)
  );
}

function chooseConflictWinner(
  left: SelectedRuleRevisionShape,
  right: SelectedRuleRevisionShape,
): SelectedRuleRevisionShape {
  if (left.source === "system_required" && right.source !== "system_required") return left;
  if (right.source === "system_required" && left.source !== "system_required") return right;
  if (isExplicitSource(left.source) && !isExplicitSource(right.source)) return left;
  if (isExplicitSource(right.source) && !isExplicitSource(left.source)) return right;
  if (left.priority !== right.priority) return left.priority > right.priority ? left : right;
  return left.ruleId.localeCompare(right.ruleId) <= 0 ? left : right;
}

function excludeConflict(
  exclusions: ExcludedRuleRevisionShape[],
  rule: SelectedRuleRevisionShape,
  conflict: SelectedRuleRevisionShape,
  code: "automatic_conflict" | "explicit_conflict" | "required_conflict",
): void {
  addExclusion(exclusions, {
    ruleId: rule.ruleId,
    ruleRevisionId: rule.ruleRevisionId,
    code,
    conflictingRuleId: conflict.ruleId,
  });
}

function addExclusion(
  exclusions: ExcludedRuleRevisionShape[],
  exclusion: ExcludedRuleRevisionShape,
): void {
  const duplicate = exclusions.some(
    (current) =>
      current.ruleId === exclusion.ruleId &&
      current.code === exclusion.code &&
      current.conflictingRuleId === exclusion.conflictingRuleId,
  );
  if (!duplicate) exclusions.push(exclusion);
}

function sortCandidates(
  candidates: readonly RuleSelectionCandidateShape[],
): RuleSelectionCandidateShape[] {
  return [...candidates].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.ruleRevisionId.localeCompare(right.ruleRevisionId),
  );
}

function sortSelectedByPriority(
  rules: readonly SelectedRuleRevisionShape[],
): SelectedRuleRevisionShape[] {
  return [...rules].sort(
    (left, right) => right.priority - left.priority || left.ruleId.localeCompare(right.ruleId),
  );
}

function sortSelectedForOutput(
  rules: readonly SelectedRuleRevisionShape[],
): SelectedRuleRevisionShape[] {
  const rank: Readonly<Record<RuleSelectionSourceShape, number>> = {
    explicit_rule: 0,
    selected_tag: 1,
    system_required: 2,
    scope_active: 3,
  };
  return [...rules].sort(
    (left, right) =>
      rank[left.source] - rank[right.source] ||
      right.priority - left.priority ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

function sortExclusions(
  exclusions: readonly ExcludedRuleRevisionShape[],
): ExcludedRuleRevisionShape[] {
  return [...exclusions].sort(
    (left, right) =>
      left.ruleId.localeCompare(right.ruleId) ||
      left.code.localeCompare(right.code) ||
      (left.conflictingRuleId ?? "").localeCompare(right.conflictingRuleId ?? ""),
  );
}

function sortConflicts(
  conflicts: readonly RuleSelectionConflictShape[],
): RuleSelectionConflictShape[] {
  return [...conflicts].sort(
    (left, right) =>
      left.leftRuleId.localeCompare(right.leftRuleId) ||
      left.rightRuleId.localeCompare(right.rightRuleId),
  );
}

function sortDiagnostics(
  diagnostics: readonly RuleSelectionDiagnosticShape[],
): RuleSelectionDiagnosticShape[] {
  return [...diagnostics].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.ruleIds.join("\u0000").localeCompare(right.ruleIds.join("\u0000")),
  );
}

function matchesOptional(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function compareRequestedRule(
  left: RequestedRuleRevisionShape,
  right: RequestedRuleRevisionShape,
): number {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.ruleRevisionId.localeCompare(right.ruleRevisionId) ||
    left.ruleRevisionSha256.localeCompare(right.ruleRevisionSha256)
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeContext(context: RuleSelectionContextShape): Record<string, string | null> {
  return {
    scenario: context.scenario,
    projectMethodProfileId: context.projectMethodProfileId ?? null,
    projectStageKey: context.projectStageKey ?? null,
    workflowNodeKey: context.workflowNodeKey ?? null,
    projectId: context.projectId ?? null,
  };
}
