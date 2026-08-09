import { describe, expect, it } from "vitest";
import {
  ruleDecisionIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  ruleScopeIdSchema,
  ruleSelectionIdSchema,
  ruleTagIdSchema,
} from "./ids.js";
import {
  RULES_API_SCHEMA_VERSION,
  ruleDetailDtoSchema,
  ruleScopeInputSchema,
  ruleSelectionDtoSchema,
  ruleSummaryDtoSchema,
} from "./rules-api.js";
import {
  ruleDecisionSchema,
  ruleRevisionSchema,
  ruleSchema,
  ruleScopeSchema,
  ruleSelectionSchema,
  ruleTagSchema,
} from "./rules.js";

const now = "2026-08-10T00:00:00.000Z";
const shaA = "a".repeat(64);
const scope = {
  schemaVersion: "rule-scope.v1" as const,
  ruleScopeId: "rsc_planning",
  kind: "contextual" as const,
  scenario: "planning" as const,
  projectMethodProfileId: "software-delivery.v1" as const,
  workflowNodeKey: "policy.rules",
};
const revision = {
  schemaVersion: "rule-revision.v1" as const,
  ruleRevisionId: "rrv_quality1",
  ruleId: "rul_quality",
  revision: 1,
  body: "交付前必须运行与改动风险匹配的测试。",
  rationale: "防止模型自述替代可验证结果。",
  appliesWhen: ["执行软件交付工作"],
  doesNotApplyWhen: ["只读解释且不修改事实"],
  positiveExamples: ["修改Domain状态机后运行正反例测试"],
  negativeExamples: ["只说应该可以，不运行测试"],
  scopes: [scope],
  tagIds: ["rtg_quality"],
  conflictsWithRuleIds: [],
  risk: "high" as const,
  origin: { kind: "user_authored" as const, principalId: "usr_owner" },
  sourceCases: [{ kind: "product_run" as const, productRunId: "run_case1" }],
  sha256: shaA,
  createdAt: now,
};

describe("Rule持久合同", () => {
  it("为六类Rule事实提供独立、带前缀的产品身份", () => {
    expect(ruleIdSchema.parse("rul_quality")).toBe("rul_quality");
    expect(ruleRevisionIdSchema.parse("rrv_quality1")).toBe("rrv_quality1");
    expect(ruleTagIdSchema.parse("rtg_quality")).toBe("rtg_quality");
    expect(ruleScopeIdSchema.parse("rsc_planning")).toBe("rsc_planning");
    expect(ruleDecisionIdSchema.parse("rde_trial1")).toBe("rde_trial1");
    expect(ruleSelectionIdSchema.parse("rsl_run1")).toBe("rsl_run1");
    expect(ruleIdSchema.safeParse("rrv_quality1").success).toBe(false);
  });

  it("严格校验Rule、Revision、Tag、Scope和Decision且拒绝扩展口袋", () => {
    expect(ruleScopeSchema.safeParse(scope).success).toBe(true);
    expect(ruleRevisionSchema.safeParse(revision).success).toBe(true);
    expect(
      ruleSchema.safeParse({
        schemaVersion: "rule.v1",
        ruleId: "rul_quality",
        ownerPrincipalId: "usr_owner",
        title: "交付必须有测试证据",
        lifecycle: "candidate",
        enforcement: "user_selectable",
        priority: 500,
        currentRevisionId: "rrv_quality1",
        currentRevisionNumber: 1,
        currentRevisionSha256: shaA,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
    expect(
      ruleTagSchema.safeParse({
        schemaVersion: "rule-tag.v1",
        ruleTagId: "rtg_quality",
        ownerPrincipalId: "usr_owner",
        name: "质量",
        normalizedKey: "质量",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
    expect(
      ruleDecisionSchema.safeParse({
        schemaVersion: "rule-decision.v1",
        ruleDecisionId: "rde_trial1",
        ruleId: "rul_quality",
        boundRevisionId: "rrv_quality1",
        boundRevisionSha256: shaA,
        expectedRuleRevision: 1,
        fromLifecycle: "candidate",
        toLifecycle: "trial",
        actor: { kind: "principal", principalId: "usr_owner" },
        reason: "先在本轮试用",
        commandId: "cmd_ruletrial1",
        decidedAt: now,
      }).success,
    ).toBe(true);
    expect(
      ruleRevisionSchema.safeParse({ ...revision, metadata: { arbitrary: true } }).success,
    ).toBe(false);
    expect(ruleScopeSchema.safeParse({ ...scope, provider: "private" }).success).toBe(false);
  });

  it("RuleSelection只持久化精确引用、原因和诊断，不复制正文", () => {
    const selection = {
      schemaVersion: "rule-selection.v1" as const,
      ruleSelectionId: "rsl_run1",
      productRunId: "run_rule1",
      contextPackageId: "ctxp_rule1",
      context: {
        scenario: "planning" as const,
        projectMethodProfileId: "software-delivery.v1" as const,
        workflowNodeKey: "policy.rules",
      },
      request: {
        explicitRules: [
          {
            ruleId: "rul_quality",
            ruleRevisionId: "rrv_quality1",
            ruleRevisionSha256: shaA,
          },
        ],
        excludedRuleIds: [],
        selectedTagIds: ["rtg_quality"],
      },
      budget: { maxRules: 10, maxContentCharacters: 8_000 },
      candidates: [
        {
          ruleId: "rul_quality",
          ruleRevisionId: "rrv_quality1",
          ruleRevisionSha256: shaA,
          lifecycle: "active" as const,
          enforcement: "user_selectable" as const,
          priority: 500,
          tagIds: ["rtg_quality"],
          scopes: [scope],
          conflictsWithRuleIds: [],
          contentCharacters: 21,
        },
      ],
      status: "ready" as const,
      selected: [
        {
          ruleId: "rul_quality",
          ruleRevisionId: "rrv_quality1",
          ruleRevisionSha256: shaA,
          source: "explicit_rule" as const,
          priority: 500,
          contentCharacters: 21,
        },
      ],
      excluded: [],
      conflicts: [],
      diagnostics: [],
      selectedContentCharacters: 21,
      sha256: shaA,
      createdAt: now,
    };
    expect(ruleSelectionSchema.safeParse(selection).success).toBe(true);
    expect(JSON.stringify(ruleSelectionSchema.parse(selection))).not.toContain(revision.body);
    expect(ruleSelectionSchema.safeParse({ ...selection, body: revision.body }).success).toBe(
      false,
    );
  });
});

describe("Rule公开合同", () => {
  const revisionSummary = {
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleRevisionId: "rrv_quality1",
    revision: 1,
    sha256: shaA,
    risk: "high" as const,
    scopes: [scope],
    tagIds: ["rtg_quality"],
    conflictsWithRuleIds: [],
    createdAt: now,
  };
  const summary = {
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleId: "rul_quality",
    title: "交付必须有测试证据",
    lifecycle: "active" as const,
    enforcement: "user_selectable" as const,
    priority: 500,
    currentRevision: revisionSummary,
    allowedActions: ["weaken", "disable", "revise"] as const,
    revision: 3,
    createdAt: now,
    updatedAt: now,
  };

  it("列表摘要严格排除正文，单条Detail才允许返回正文", () => {
    expect(ruleSummaryDtoSchema.safeParse(summary).success).toBe(true);
    expect(ruleSummaryDtoSchema.safeParse({ ...summary, body: revision.body }).success).toBe(false);
    expect(
      ruleDetailDtoSchema.safeParse({
        ...summary,
        currentRevision: {
          ...revision,
          schemaVersion: RULES_API_SCHEMA_VERSION,
        },
      }).success,
    ).toBe(true);
  });

  it("Scope创建输入不接受浏览器构造的产品ID", () => {
    expect(
      ruleScopeInputSchema.safeParse({
        kind: "contextual",
        scenario: "planning",
        workflowNodeKey: "policy.rules",
      }).success,
    ).toBe(true);
    expect(
      ruleScopeInputSchema.safeParse({
        kind: "contextual",
        scenario: "planning",
        ruleScopeId: "rsc_browserMade",
      }).success,
    ).toBe(false);
  });

  it("公开Selection同样拒绝正文和未知内部字段", () => {
    const dto = {
      schemaVersion: RULES_API_SCHEMA_VERSION,
      ruleSelectionId: "rsl_run1",
      context: { scenario: "planning" as const },
      request: { explicitRules: [], excludedRuleIds: [], selectedTagIds: [] },
      budget: { maxRules: 10, maxContentCharacters: 2_000 },
      status: "ready" as const,
      selected: [],
      excluded: [],
      conflicts: [],
      diagnostics: [],
      selectedContentCharacters: 0,
      sha256: shaA,
      createdAt: now,
    };
    expect(ruleSelectionDtoSchema.safeParse(dto).success).toBe(true);
    expect(ruleSelectionDtoSchema.safeParse({ ...dto, body: revision.body }).success).toBe(false);
    expect(ruleSelectionDtoSchema.safeParse({ ...dto, workflowRunId: "private" }).success).toBe(
      false,
    );
  });
});
