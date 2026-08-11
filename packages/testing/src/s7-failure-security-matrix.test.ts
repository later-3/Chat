import { describe, expect, it } from "vitest";
import { type PrincipalId, type ProductSnapshot } from "@chat/contracts";
import {
  createProductSession,
  submitUserMessage,
  transitionConfigurablePlanningNode,
} from "@chat/application";
import { SYSTEM_NOTE_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { createApiApp } from "@chat/api";
import { auditProductIntegrity } from "./product-integrity-auditor.js";
import { createS7ApplicationFixture } from "./fixtures/s7-versioned-fixtures.js";

const OWNER = "usr_s7matrix" as PrincipalId;
const OTHER = "usr_s7matrixother" as PrincipalId;

const SECURITY_MATRIX = [
  {
    axis: "concurrency.same_session_cross_workload",
    evidence: "s7-failure-security-matrix.test.ts",
    status: "covered",
  },
  {
    axis: "concurrency.same_definition_multiple_runs",
    evidence: "s7-failure-security-matrix.test.ts",
    status: "covered",
  },
  {
    axis: "concurrency.same_status_different_evidence",
    evidence: "s7-failure-security-matrix.test.ts",
    status: "covered",
  },
  { axis: "idor.session_run", evidence: "s7-failure-security-matrix.test.ts", status: "covered" },
  {
    axis: "idor.node_definition_resource",
    evidence: "configurable-planning-quality-gate.test.ts",
    status: "covered",
  },
  { axis: "idor.note_source_ref", evidence: "note-backend-use-cases.test.ts", status: "covered" },
  {
    axis: "input.unknown_and_prototype_keys",
    evidence: "s7-failure-security-matrix.test.ts",
    status: "covered",
  },
  {
    axis: "sensitive.outbox_receipt_auditor",
    evidence: "s7-failure-security-matrix.test.ts",
    status: "covered",
  },
  {
    axis: "sensitive.runtime_public_dto",
    evidence: "architecture-boundaries.test.ts",
    status: "covered",
  },
] as const;

async function submitWithCasRetry(
  deps: Parameters<typeof submitUserMessage>[0],
  input: Parameters<typeof submitUserMessage>[1],
) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await submitUserMessage(deps, input);
    } catch (error) {
      if (
        attempt === 5 ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "revision_conflict"
      ) {
        throw error;
      }
    }
  }
  throw new Error("S7 CAS retry不可达");
}

async function concurrentSnapshot(): Promise<ProductSnapshot> {
  const fixture = await createS7ApplicationFixture("s7matrix");
  const { session } = await createProductSession(fixture.deps, {
    principalId: OWNER,
    commandId: fixture.command(),
    payload: {},
  });
  const seeded = await fixture.deps.store.read({ kind: "committedSnapshot" });
  const noteRevision =
    seeded.snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
  if (noteRevision === undefined) throw new Error("S7矩阵缺少Note Definition");

  const noteSelection = {
    kind: "published_revision" as const,
    workflowDefinitionRevisionId: noteRevision.workflowDefinitionRevisionId,
    definitionSha256: noteRevision.definitionSha256,
    businessInput: {
      kind: "note_capture" as const,
      source: { kind: "full_message" as const },
      defaultKind: "general" as const,
      suggestedTagLabels: [],
    },
  };
  await Promise.all([
    submitWithCasRetry(fixture.deps, {
      principalId: OWNER,
      sessionId: session.sessionId,
      commandId: fixture.command(),
      payload: { text: "并发Planning A：Authorization Bearer s7_message_canary" },
    }),
    submitWithCasRetry(fixture.deps, {
      principalId: OWNER,
      sessionId: session.sessionId,
      commandId: fixture.command(),
      payload: { text: "并发Planning B：同一Definition不同Run" },
    }),
    submitWithCasRetry(fixture.deps, {
      principalId: OWNER,
      sessionId: session.sessionId,
      commandId: fixture.command(),
      payload: {
        text: "并发Note：<script>仅作为不可信Markdown文本</script>",
        workflowSelection: noteSelection,
      },
    }),
  ]);
  return (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
}

describe("S7并发、IDOR、敏感数据与unknown字段代表矩阵", () => {
  it("矩阵每个要求轴都有既有或本文件的可重复证据", () => {
    expect(new Set(SECURITY_MATRIX.map((entry) => entry.axis))).toEqual(
      new Set([
        "concurrency.same_session_cross_workload",
        "concurrency.same_definition_multiple_runs",
        "concurrency.same_status_different_evidence",
        "idor.session_run",
        "idor.node_definition_resource",
        "idor.note_source_ref",
        "input.unknown_and_prototype_keys",
        "sensitive.outbox_receipt_auditor",
        "sensitive.runtime_public_dto",
      ]),
    );
    expect(SECURITY_MATRIX.every((entry) => entry.evidence.endsWith(".test.ts"))).toBe(true);
    expect(SECURITY_MATRIX.every((entry) => entry.status === "covered")).toBe(true);
  });

  it("同Session跨Workflow及同Definition多Run并发不串Message/RunSpec/Outbox", async () => {
    const snapshot = await concurrentSnapshot();
    const runs = Object.values(snapshot.entities.runs);
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.runKind === "planning")).toHaveLength(2);
    expect(runs.filter((run) => run.runKind === "note_capture")).toHaveLength(1);
    expect(new Set(runs.map((run) => run.sourceMessageId))).toHaveLength(3);
    expect(new Set(runs.map((run) => run.workflowRunSpecId))).toHaveLength(3);
    expect(
      new Set(
        Object.values(snapshot.outbox)
          .filter((entry) => entry.kind === "workflow_start")
          .map((entry) => entry.productRunId),
      ),
    ).toEqual(new Set(runs.map((run) => run.productRunId)));
    expect(auditProductIntegrity(snapshot)).toMatchObject({ ok: true, issues: [] });
  });

  it("新command不能用相同终态吞掉不同outcome，冲突时不新增Transition", async () => {
    const fixture = await createS7ApplicationFixture("s7sameoutcome");
    const { session } = await createProductSession(fixture.deps, {
      principalId: OWNER,
      commandId: fixture.command(),
      payload: {},
    });
    const submitted = await submitUserMessage(fixture.deps, {
      principalId: OWNER,
      sessionId: session.sessionId,
      commandId: fixture.command(),
      payload: { text: "验证相同终态的证据不能被覆盖" },
    });
    const before = (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const run = before.entities.runs[submitted.run.productRunId];
    if (run?.workflowRunSpecId === undefined) throw new Error("S7并发Fixture缺少RunSpec");
    const identity = {
      productRunId: run.productRunId,
      workflowRunSpecId: run.workflowRunSpecId,
      definitionNodeId: "planning.skills",
      executionPath: [],
      attemptNumber: 1,
    } as const;
    await transitionConfigurablePlanningNode(fixture.deps, {
      ...identity,
      commandId: fixture.command(),
      toStatus: "running",
      publicSummary: "开始解析脱敏技能目录",
    });
    const succeeded = await transitionConfigurablePlanningNode(fixture.deps, {
      ...identity,
      commandId: fixture.command(),
      toStatus: "succeeded",
      outcomeCode: "resolved",
      publicSummary: "技能目录已解析",
    });
    const afterSucceeded = (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const transitionCount = Object.values(afterSucceeded.entities.nodeRunTransitions).filter(
      (transition) => transition.workflowNodeRunId === succeeded.workflowNodeRunId,
    ).length;

    await expect(
      transitionConfigurablePlanningNode(fixture.deps, {
        ...identity,
        commandId: fixture.command(),
        toStatus: "succeeded",
        outcomeCode: "optional_unavailable",
        publicSummary: "技能目录不可用",
      }),
    ).rejects.toMatchObject({ code: "revision_conflict", httpStatus: 409 });

    const afterConflict = (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(afterConflict.entities.nodeRunTransitions).filter(
        (transition) => transition.workflowNodeRunId === succeeded.workflowNodeRunId,
      ),
    ).toHaveLength(transitionCount);
    expect(afterConflict.entities.workflowNodeRuns[succeeded.workflowNodeRunId]).toMatchObject({
      status: "succeeded",
      outcomeCode: "resolved",
      publicSummary: "技能目录已解析",
    });
  });

  it("跨owner Session/Run即使知道ID也不可读，unknown/prototype字段零写入", async () => {
    const fixture = await createS7ApplicationFixture("s7idor");
    const ownerApp = createApiApp({
      traceSink: null,
      product: { deps: fixture.deps, principalId: OWNER },
    });
    const otherApp = createApiApp({
      traceSink: null,
      product: { deps: fixture.deps, principalId: OTHER },
    });
    const created = await ownerApp.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: fixture.command(), payload: {} }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { session: { sessionId: string } };
    const submitted = await ownerApp.request(
      `/api/sessions/${session.session.sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: fixture.command(),
          payload: { text: "S7 IDOR Run" },
        }),
      },
    );
    expect(submitted.status).toBe(201);
    const body = (await submitted.json()) as { run: { productRunId: string } };
    const before = (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot
      .storeRevision;

    expect((await otherApp.request(`/api/sessions/${session.session.sessionId}`)).status).toBe(403);
    expect((await otherApp.request(`/api/runs/${body.run.productRunId}`)).status).toBe(403);
    const unknown = await ownerApp.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"commandId":"cmd_s7unknown1","payload":{"__proto__":{"admin":true},"extra":1}}',
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as object).toMatchObject({
      code: "validation_failed",
    });
    expect(
      (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot.storeRevision,
    ).toBe(before);
  });

  it("正文canary仅留在权威Message，Outbox/Receipt/Auditor不泄漏", async () => {
    const snapshot = await concurrentSnapshot();
    const canaries = ["s7_message_canary", "<script>"];
    const messages = JSON.stringify(snapshot.entities.messages);
    const transportFacts = JSON.stringify({
      outbox: snapshot.outbox,
      receipts: snapshot.commandReceipts,
      runSpecs: snapshot.entities.workflowRunSpecs,
      report: auditProductIntegrity(snapshot),
    });
    for (const canary of canaries) {
      expect(messages).toContain(canary);
      expect(transportFacts).not.toContain(canary);
    }
    expect(transportFacts).not.toMatch(
      /authorization|hook[_-]?token|workflow[_-]?run[_-]?id|pi[_-]?session|runtime[_-]?credential/iu,
    );
  });
});
