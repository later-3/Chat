import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  hashCanonical,
  sha256Hex,
  CanonicalJsonError,
} from "./canonical-hash.js";
import {
  assertDecisionBinding,
  assertSingleOpenApproval,
  assertSinglePlanUnderReview,
} from "./invariants.js";
import {
  DomainInvariantError,
  canTransitionPlanStatus,
  isTerminalPlanStatus,
  nextPlanRevision,
} from "./plan-state.js";
import {
  canTransitionRunLifecycle,
  isTerminalRunLifecycle,
  transitionRunLifecycle,
  type RunLifecycle,
} from "./run-lifecycle.js";

describe("canonical json", () => {
  it("对象键排序、数组保持顺序，键顺序不同Hash相同", () => {
    const a = { b: 1, a: [3, { y: 2, x: 1 }] };
    const b = { a: [3, { x: 1, y: 2 }], b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonStringify(a)).toBe('{"a":[3,{"x":1,"y":2}],"b":1}');
  });

  it("拒绝undefined、函数、Symbol、非有限数字、Date和循环引用", () => {
    expect(() => canonicalJsonStringify({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify({ f: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify({ s: Symbol("x") })).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify({ n: Number.POSITIVE_INFINITY })).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalJsonStringify({ d: new Date(0) })).toThrow(CanonicalJsonError);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => canonicalJsonStringify(circular)).toThrow(CanonicalJsonError);
  });

  it("Hash携带Schema版本域，跨域不冲突", () => {
    const value = { objective: "x" };
    const h1 = hashCanonical("plan-revision.v1", value);
    const h2 = hashCanonical("plan-revision.v2", value);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
    expect(h1).toBe(hashCanonical("plan-revision.v1", { objective: "x" }));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(() => hashCanonical("PlanV1", value)).toThrow(CanonicalJsonError);
  });
});

describe("plan revision state machine", () => {
  it("under_review可批准/取代/拒绝/过期，其余全部终态", () => {
    for (const to of ["approved", "superseded", "rejected", "expired"] as const) {
      expect(canTransitionPlanStatus("under_review", to)).toBe(true);
    }
    expect(canTransitionPlanStatus("under_review", "under_review")).toBe(false);
    for (const terminal of ["approved", "superseded", "rejected", "expired"] as const) {
      expect(isTerminalPlanStatus(terminal)).toBe(true);
      expect(canTransitionPlanStatus(terminal, "under_review")).toBe(false);
    }
  });

  it("规划修订上限：新版本号单调递增", () => {
    expect(nextPlanRevision([], 5)).toBe(1);
    expect(nextPlanRevision([1, 2], 5)).toBe(3);
    expect(nextPlanRevision([1, 2, 3, 4], 5)).toBe(5);
  });

  it("达到上限后失败关闭（第6次不再调用模型）", () => {
    expect(() => nextPlanRevision([1, 2, 3, 4, 5], 5)).toThrow(DomainInvariantError);
    expect(() => nextPlanRevision([1, 2, 3, 4, 5], 5)).toThrow(/已达上限/);
  });
});

describe("run lifecycle", () => {
  const at = (status: RunLifecycle["status"], phase: RunLifecycle["phase"]): RunLifecycle => ({
    status,
    phase,
  });

  it("覆盖任务书§9.1的完整合法路径", () => {
    const queued = at("pending", "queued");
    const planning = transitionRunLifecycle(queued, at("running", "planning"));
    const review = transitionRunLifecycle(planning, at("waiting_human", "plan_review"));
    // request_revision回到规划
    const replanning = transitionRunLifecycle(review, at("running", "planning"));
    const review2 = transitionRunLifecycle(replanning, at("waiting_human", "plan_review"));
    // approve进入执行与验证
    const executing = transitionRunLifecycle(review2, at("running", "executing"));
    const validating = transitionRunLifecycle(executing, at("running", "validating"));
    const done = transitionRunLifecycle(validating, at("succeeded", "completed"));
    expect(isTerminalRunLifecycle(done)).toBe(true);
  });

  it("reject进入cancelled/rejected；终态不可再转换", () => {
    const review = at("waiting_human", "plan_review");
    const rejected = transitionRunLifecycle(review, at("cancelled", "rejected"));
    expect(rejected.status).toBe("cancelled");
    expect(() => transitionRunLifecycle(rejected, at("running", "executing"))).toThrow(
      DomainInvariantError,
    );
  });

  it("非法转换失败关闭", () => {
    expect(canTransitionRunLifecycle(at("pending", "queued"), at("succeeded", "completed"))).toBe(
      false,
    );
    expect(
      canTransitionRunLifecycle(at("running", "executing"), at("waiting_human", "plan_review")),
    ).toBe(false);
    expect(() =>
      transitionRunLifecycle(at("pending", "queued"), at("running", "validating")),
    ).toThrow(DomainInvariantError);
  });
});

describe("decision binding invariants", () => {
  const approval = {
    approvalRequestId: "apr_1",
    productRunId: "run_1",
    planId: "pln_1",
    planRevision: 2,
    planSha256: "a".repeat(64),
    status: "open" as const,
  };

  it("旧revision、错误Hash、已决定、过期全部失败关闭", () => {
    const ok = { planId: "pln_1", planRevision: 2, planSha256: "a".repeat(64) };
    expect(() => assertDecisionBinding(approval, ok)).not.toThrow();

    expect(() => assertDecisionBinding(approval, { ...ok, planRevision: 1 })).toThrow(/revision/);
    expect(() => assertDecisionBinding(approval, { ...ok, planSha256: "b".repeat(64) })).toThrow(
      /Hash/,
    );
    expect(() => assertDecisionBinding({ ...approval, status: "decided" }, ok)).toThrow(/已有决定/);
    expect(() => assertDecisionBinding({ ...approval, status: "expired" }, ok)).toThrow(/已过期/);
  });

  it("一个Run最多一个under_review Plan和一个open Approval", () => {
    const plan = {
      productRunId: "run_1",
      planId: "pln_1",
      planRevision: 1,
      status: "under_review",
    };
    expect(() => assertSinglePlanUnderReview([plan])).not.toThrow();
    expect(() =>
      assertSinglePlanUnderReview([plan, { ...plan, planId: "pln_2", planRevision: 2 }]),
    ).toThrow(DomainInvariantError);

    expect(() => assertSingleOpenApproval([approval])).not.toThrow();
    expect(() =>
      assertSingleOpenApproval([approval, { ...approval, approvalRequestId: "apr_2" }]),
    ).toThrow(DomainInvariantError);
  });
});
