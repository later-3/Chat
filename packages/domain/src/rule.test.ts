import { describe, expect, it } from "vitest";
import {
  assertRuleLifecycleTransition,
  assertRuleRevisionAppend,
  assertRuleRevisionIntegrity,
  assertRuleRevisionUnchanged,
  computeRuleRevisionSha256,
  getAllowedRuleLifecycleTransitions,
  type RuleRevisionSnapshotShape,
  type RuleScopeShape,
} from "./rule-revision.js";
import {
  ruleScopeMatches,
  selectRules,
  type RuleSelectionCandidateShape,
  type RuleSelectionRequestShape,
} from "./rule-selection.js";

const now = "2026-08-10T00:00:00.000Z";
const shaA = "a".repeat(64);
const globalScope: RuleScopeShape = {
  schemaVersion: "rule-scope.v1",
  ruleScopeId: "rsc_global",
  kind: "global",
};
const planningScope: RuleScopeShape = {
  schemaVersion: "rule-scope.v1",
  ruleScopeId: "rsc_planning",
  kind: "contextual",
  scenario: "planning",
  workflowNodeKey: "policy.rules",
};

function makeRevision(
  input: {
    revision?: number;
    ruleRevisionId?: string;
    supersedesRevisionId?: string;
    supersedesRevisionSha256?: string;
    body?: string;
    tagIds?: readonly string[];
    conflictsWithRuleIds?: readonly string[];
  } = {},
): RuleRevisionSnapshotShape {
  const revision = input.revision ?? 1;
  const draft = {
    ruleId: "rul_quality",
    revision,
    ...(input.supersedesRevisionId === undefined
      ? {}
      : { supersedesRevisionId: input.supersedesRevisionId }),
    ...(revision === 1
      ? {}
      : { supersedesRevisionSha256: input.supersedesRevisionSha256 ?? makeRevision().sha256 }),
    body: input.body ?? "交付前必须运行与风险匹配的测试。",
    rationale: "产品完成必须来自可验证事实。",
    appliesWhen: ["修改产品行为"],
    doesNotApplyWhen: ["纯只读解释"],
    positiveExamples: ["运行状态机正反例"],
    negativeExamples: ["只说测试应该会通过"],
    scopes: [planningScope],
    tagIds: input.tagIds ?? ["rtg_quality"],
    conflictsWithRuleIds: input.conflictsWithRuleIds ?? [],
    risk: "high" as const,
    origin: { kind: "user_authored" as const, principalId: "usr_owner" },
    sourceCases: [{ kind: "product_run" as const, productRunId: "run_case1" }],
  };
  return {
    ...draft,
    ruleRevisionId: input.ruleRevisionId ?? `rrv_quality${revision}`,
    sha256: computeRuleRevisionSha256(draft),
    createdAt: now,
  };
}

function makeCandidate(
  ruleId: string,
  overrides: Partial<RuleSelectionCandidateShape> = {},
): RuleSelectionCandidateShape {
  return {
    ruleId,
    ruleRevisionId: `rrv_${ruleId.slice(4)}1`,
    ruleRevisionSha256: shaA,
    lifecycle: "active",
    enforcement: "user_selectable",
    priority: 100,
    tagIds: [],
    scopes: [globalScope],
    conflictsWithRuleIds: [],
    contentCharacters: 10,
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<RuleSelectionRequestShape> = {},
): RuleSelectionRequestShape {
  return {
    explicitRules: [],
    excludedRuleIds: [],
    selectedTagIds: [],
    context: { scenario: "planning" },
    budget: { maxRules: 20, maxContentCharacters: 10_000 },
    ...overrides,
  };
}

describe("Rule Revision与生命周期", () => {
  it("Hash对集合读取顺序稳定，但正文变化必然改变Hash", () => {
    const first = makeRevision({
      tagIds: ["rtg_quality", "rtg_delivery"],
      conflictsWithRuleIds: ["rul_fast", "rul_unchecked"],
    });
    const reordered = makeRevision({
      tagIds: ["rtg_delivery", "rtg_quality"],
      conflictsWithRuleIds: ["rul_unchecked", "rul_fast"],
    });
    expect(first.sha256).toBe(reordered.sha256);
    expect(makeRevision({ body: "允许跳过测试。" }).sha256).not.toBe(first.sha256);
    expect(() => assertRuleRevisionIntegrity(first)).not.toThrow();
  });

  it("修改只能顺序追加新Revision，旧Revision即使重算Hash也不可改写", () => {
    const first = makeRevision();
    const second = makeRevision({
      revision: 2,
      ruleRevisionId: "rrv_quality2",
      supersedesRevisionId: first.ruleRevisionId,
      body: "交付前必须运行测试，并记录测试命令。",
    });
    expect(() => assertRuleRevisionAppend({ current: first, next: second })).not.toThrow();
    const skipped = makeRevision({
      revision: 3,
      ruleRevisionId: "rrv_quality3",
      supersedesRevisionId: first.ruleRevisionId,
    });
    expect(() => assertRuleRevisionAppend({ current: first, next: skipped })).toThrow("严格递增");

    const rewrittenDraft = { ...first, body: "历史正文被覆盖" };
    const rewritten = {
      ...rewrittenDraft,
      sha256: computeRuleRevisionSha256(rewrittenDraft),
    };
    expect(() => assertRuleRevisionIntegrity(rewritten)).not.toThrow();
    expect(() => assertRuleRevisionUnchanged({ original: first, persisted: rewritten })).toThrow(
      "不可修改",
    );
  });

  it("candidate必须先试用再启用，禁用恢复也先回trial，Assistant不能决定生效", () => {
    expect(getAllowedRuleLifecycleTransitions("candidate")).toEqual(["trial", "rejected"]);
    expect(() =>
      assertRuleLifecycleTransition({
        from: "candidate",
        to: "trial",
        enforcement: "user_selectable",
        actor: { kind: "principal", principalId: "usr_owner" },
        reason: "先试用",
      }),
    ).not.toThrow();
    expect(() =>
      assertRuleLifecycleTransition({
        from: "candidate",
        to: "active",
        enforcement: "user_selectable",
        actor: { kind: "principal", principalId: "usr_owner" },
        reason: "直接启用",
      }),
    ).toThrow("不允许");
    expect(() =>
      assertRuleLifecycleTransition({
        from: "trial",
        to: "active",
        enforcement: "user_selectable",
        actor: { kind: "assistant" },
        reason: "模型认为有效",
      }),
    ).toThrow("Assistant");
    expect(() =>
      assertRuleLifecycleTransition({
        from: "disabled",
        to: "trial",
        enforcement: "user_selectable",
        actor: { kind: "principal", principalId: "usr_owner" },
        reason: "重新验证",
      }),
    ).not.toThrow();
  });
});

describe("Rule Scope与确定性选择", () => {
  it("contextual Scope各字段取AND，不同场景不匹配", () => {
    expect(
      ruleScopeMatches(planningScope, {
        scenario: "planning",
        workflowNodeKey: "policy.rules",
      }),
    ).toBe(true);
    expect(ruleScopeMatches(planningScope, { scenario: "planning" })).toBe(false);
    expect(
      ruleScopeMatches(planningScope, {
        scenario: "note_capture",
        workflowNodeKey: "policy.rules",
      }),
    ).toBe(false);
    expect(ruleScopeMatches(globalScope, { scenario: "note_capture" })).toBe(true);
  });

  it("先处理禁用/排除和陈旧Revision，再选择必需与Scope active规则", () => {
    const disabled = makeCandidate("rul_disabled", { lifecycle: "disabled" });
    const stale = makeCandidate("rul_stale", { ruleRevisionId: "rrv_stale2" });
    const required = makeCandidate("rul_safety", {
      enforcement: "system_required",
      priority: 1_000,
    });
    const matching = makeCandidate("rul_project", { scopes: [planningScope] });
    const mismatch = makeCandidate("rul_note", {
      scopes: [
        {
          schemaVersion: "rule-scope.v1",
          ruleScopeId: "rsc_note",
          kind: "contextual",
          scenario: "note_capture",
        },
      ],
    });
    const result = selectRules({
      candidates: [mismatch, matching, stale, disabled, required],
      request: makeRequest({
        explicitRules: [
          {
            ruleId: disabled.ruleId,
            ruleRevisionId: disabled.ruleRevisionId,
            ruleRevisionSha256: disabled.ruleRevisionSha256,
          },
          {
            ruleId: stale.ruleId,
            ruleRevisionId: "rrv_stale1",
            ruleRevisionSha256: stale.ruleRevisionSha256,
          },
        ],
        excludedRuleIds: [required.ruleId],
        context: {
          scenario: "planning",
          workflowNodeKey: "policy.rules",
        },
      }),
    });
    expect(result.status).toBe("requires_user_resolution");
    expect(result.selected.map((rule) => rule.ruleId)).toEqual(["rul_safety", "rul_project"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "explicit_revision_stale",
      "explicit_rule_unavailable",
      "required_exclusion_ignored",
    ]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "rul_disabled", code: "lifecycle_unavailable" }),
        expect.objectContaining({ ruleId: "rul_stale", code: "revision_stale" }),
        expect.objectContaining({ ruleId: "rul_note", code: "scope_mismatch" }),
      ]),
    );
  });

  it("两条显式Rule冲突时要求用户处理，不让任一条进入Context", () => {
    const first = makeCandidate("rul_a", { conflictsWithRuleIds: ["rul_b"] });
    const second = makeCandidate("rul_b");
    const result = selectRules({
      candidates: [first, second],
      request: makeRequest({
        explicitRules: [first, second].map((rule) => ({
          ruleId: rule.ruleId,
          ruleRevisionId: rule.ruleRevisionId,
          ruleRevisionSha256: rule.ruleRevisionSha256,
        })),
      }),
    });
    expect(result.status).toBe("requires_user_resolution");
    expect(result.selected).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        leftRuleId: "rul_a",
        rightRuleId: "rul_b",
        kind: "explicit",
        resolution: "requires_user",
      },
    ]);
    expect(result.diagnostics[0]?.code).toBe("explicit_conflict_requires_resolution");
  });

  it("自动冲突按priority再按Rule ID稳定排除，候选读取顺序不影响结果或Hash", () => {
    const first = makeCandidate("rul_a", {
      priority: 200,
      conflictsWithRuleIds: ["rul_b"],
    });
    const second = makeCandidate("rul_b", { priority: 200 });
    const forward = selectRules({ candidates: [first, second], request: makeRequest() });
    const reverse = selectRules({ candidates: [second, first], request: makeRequest() });
    expect(forward.selected.map((rule) => rule.ruleId)).toEqual(["rul_a"]);
    expect(forward.excluded).toContainEqual(
      expect.objectContaining({
        ruleId: "rul_b",
        code: "automatic_conflict",
        conflictingRuleId: "rul_a",
      }),
    );
    expect(reverse).toEqual(forward);
  });

  it("两条系统必需Rule冲突时阻断，不能靠稳定排序静默选择", () => {
    const first = makeCandidate("rul_requiredA", {
      enforcement: "system_required",
      conflictsWithRuleIds: ["rul_requiredB"],
    });
    const second = makeCandidate("rul_requiredB", { enforcement: "system_required" });
    const result = selectRules({ candidates: [second, first], request: makeRequest() });
    expect(result.status).toBe("blocked");
    expect(result.selected).toEqual([]);
    expect(result.conflicts[0]).toMatchObject({ kind: "required", resolution: "blocked" });
    expect(result.diagnostics[0]?.code).toBe("required_rule_conflict");
  });

  it("预算先保留必需和显式Rule，自动Rule稳定裁剪；必需超限则阻断", () => {
    const required = makeCandidate("rul_required", {
      enforcement: "system_required",
      priority: 1_000,
      contentCharacters: 5,
    });
    const explicit = makeCandidate("rul_explicit", { priority: 10, contentCharacters: 5 });
    const automatic = makeCandidate("rul_auto", { priority: 900, contentCharacters: 5 });
    const explicitRef = {
      ruleId: explicit.ruleId,
      ruleRevisionId: explicit.ruleRevisionId,
      ruleRevisionSha256: explicit.ruleRevisionSha256,
    };
    const result = selectRules({
      candidates: [automatic, explicit, required],
      request: makeRequest({
        explicitRules: [explicitRef],
        budget: { maxRules: 2, maxContentCharacters: 10 },
      }),
    });
    expect(result.status).toBe("ready");
    expect(new Set(result.selected.map((rule) => rule.ruleId))).toEqual(
      new Set(["rul_required", "rul_explicit"]),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "automatic_budget_exceeded",
    );

    const blocked = selectRules({
      candidates: [required],
      request: makeRequest({ budget: { maxRules: 0, maxContentCharacters: 0 } }),
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.selected).toEqual([]);
    expect(blocked.diagnostics[0]?.code).toBe("required_budget_exceeded");

    const explicitOverBudget = selectRules({
      candidates: [required, explicit],
      request: makeRequest({
        explicitRules: [explicitRef],
        budget: { maxRules: 2, maxContentCharacters: 5 },
      }),
    });
    expect(explicitOverBudget.status).toBe("requires_user_resolution");
    expect(explicitOverBudget.selected.map((rule) => rule.ruleId)).toEqual(["rul_required"]);
    expect(explicitOverBudget.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "explicit_budget_exceeded",
    );
  });

  it("RuleSelection结果不含正文，Tag选择可以显式采用不匹配Scope的active规则", () => {
    const tagged = makeCandidate("rul_tagged", {
      tagIds: ["rtg_selected"],
      scopes: [
        {
          schemaVersion: "rule-scope.v1",
          ruleScopeId: "rsc_note",
          kind: "contextual",
          scenario: "note_capture",
        },
      ],
    });
    const result = selectRules({
      candidates: [tagged],
      request: makeRequest({ selectedTagIds: ["rtg_selected"] }),
    });
    expect(result.status).toBe("ready");
    expect(result.selected[0]).toMatchObject({
      ruleId: "rul_tagged",
      source: "selected_tag",
    });
    expect(JSON.stringify(result)).not.toContain("body");
    expect(JSON.stringify(result)).not.toContain("正文");
  });
});
