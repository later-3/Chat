import { describe, expect, it } from "vitest";
import {
  PROVIDER_PRE_REQUEST_ERROR_PREFIX,
  TRACE_EVENT_NAMES,
  decisionRefSchema,
  planRefSchema,
  sha256Schema,
  traceEventSchema,
  traceObjectRefSchema,
} from "./trace.js";
import { validTraceFixtures } from "./trace.fixtures.js";

const SHA256_A = "a".repeat(64);
/** 合成泄漏标记：证明正文根本无法进入Trace，而不是写入后被脱敏。 */
const CONTENT_MARKER = "TRACE_CONTENT_MUST_NEVER_BE_WRITTEN";

function fixtureOf(eventName: string): Record<string, unknown> {
  const found = validTraceFixtures.find((fixture) => fixture["eventName"] === eventName);
  if (!found) throw new Error(`缺少Fixture: ${eventName}`);
  return found;
}

describe("traceEventSchema：全部正式事件的合法Fixture通过", () => {
  it("Fixture覆盖任务书§7.3全部事件名", () => {
    const covered = new Set(validTraceFixtures.map((fixture) => fixture["eventName"]));
    for (const name of Object.values(TRACE_EVENT_NAMES)) {
      expect(covered.has(name), `${name} 缺少合法Fixture`).toBe(true);
    }
  });

  it.each(validTraceFixtures.map((fixture) => [fixture["eventName"] as string, fixture]))(
    "%s",
    (_name, fixture) => {
      const result = traceEventSchema.safeParse(fixture);
      expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true);
    },
  );
});

describe("traceEventSchema：outcome按事件名固定", () => {
  it.each([
    [TRACE_EVENT_NAMES.httpCommandReceived, "success"],
    [TRACE_EVENT_NAMES.providerRequestStarted, "success"],
    [TRACE_EVENT_NAMES.workflowHookWaiting, "failure"],
    [TRACE_EVENT_NAMES.httpCommandCompleted, "failure"],
    [TRACE_EVENT_NAMES.productCommitCommitted, "unknown"],
    [TRACE_EVENT_NAMES.executionValidated, "unknown"],
    [TRACE_EVENT_NAMES.httpCommandRejected, "failure"],
    [TRACE_EVENT_NAMES.executionRejected, "failure"],
    [TRACE_EVENT_NAMES.providerRequestFailed, "unknown"],
    [TRACE_EVENT_NAMES.memoryImportIntentCreated, "unknown"],
    [TRACE_EVENT_NAMES.memoryImportOutcomeUnknown, "failure"],
    [TRACE_EVENT_NAMES.memoryImportReconcileCompleted, "unknown"],
  ])("%s 不接受 outcome=%s", (eventName, wrongOutcome) => {
    const tampered = { ...fixtureOf(eventName), outcome: wrongOutcome };
    expect(traceEventSchema.safeParse(tampered).success).toBe(false);
  });
});

describe("traceEventSchema：pi节点类型与正式Runner一致", () => {
  it.each(["planner", "executor", "note_capture"] as const)("接受 %s", (nodeKind) => {
    expect(
      traceEventSchema.safeParse({
        ...fixtureOf(TRACE_EVENT_NAMES.piNodeStarted),
        nodeKind,
      }).success,
    ).toBe(true);
  });
});

describe("traceEventSchema：事件族关联字段强制", () => {
  it("Product Run事件缺productRunId被拒绝", () => {
    for (const name of [
      TRACE_EVENT_NAMES.productRunCreated,
      TRACE_EVENT_NAMES.productRunTransitioned,
    ]) {
      const tampered = { ...fixtureOf(name) };
      delete tampered["productRunId"];
      expect(traceEventSchema.safeParse(tampered).success, name).toBe(false);
    }
  });

  it("pi候选诊断只接受冻结字段和枚举错误码", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.piNodeFailed);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        candidateValidation: {
          stage: "tool_argument_schema",
          fields: ["output"],
          issueCodes: ["invalid_type", "output.missing"],
        },
      }).success,
    ).toBe(true);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        candidateValidation: {
          stage: "tool_argument_schema",
          fields: [CONTENT_MARKER],
          issueCodes: ["invalid_type"],
        },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        candidateValidation: {
          stage: "candidate_contract",
          fields: ["output"],
          issueCodes: [CONTENT_MARKER],
        },
      }).success,
    ).toBe(false);
  });

  it("Workflow/Provider/pi/执行/Commit事件缺productRunId或attemptId被拒绝", () => {
    for (const name of [
      TRACE_EVENT_NAMES.workflowStepStarted,
      TRACE_EVENT_NAMES.workflowHookWaiting,
      TRACE_EVENT_NAMES.providerRequestStarted,
      TRACE_EVENT_NAMES.piNodeStarted,
      TRACE_EVENT_NAMES.executionValidated,
      TRACE_EVENT_NAMES.productCommitStarted,
    ]) {
      for (const key of ["productRunId", "attemptId"]) {
        const tampered = { ...fixtureOf(name) };
        delete tampered[key];
        expect(traceEventSchema.safeParse(tampered).success, `${name}缺${key}`).toBe(false);
      }
    }
  });

  it("Workflow事件缺workflowDefinitionVersion被拒绝", () => {
    const tampered = { ...fixtureOf(TRACE_EVENT_NAMES.workflowStepCompleted) };
    delete tampered["workflowDefinitionVersion"];
    expect(traceEventSchema.safeParse(tampered).success).toBe(false);
  });

  it("Provider/pi事件缺promptTemplateVersion或modelConfigVersion被拒绝", () => {
    for (const name of [
      TRACE_EVENT_NAMES.providerRequestCompleted,
      TRACE_EVENT_NAMES.piNodeCompleted,
    ]) {
      for (const key of ["promptTemplateVersion", "modelConfigVersion"]) {
        const tampered = { ...fixtureOf(name) };
        delete tampered[key];
        expect(traceEventSchema.safeParse(tampered).success, `${name}缺${key}`).toBe(false);
      }
    }
  });

  it("Provider completed/failed缺durationMs被拒绝", () => {
    for (const name of [
      TRACE_EVENT_NAMES.providerRequestCompleted,
      TRACE_EVENT_NAMES.providerRequestFailed,
    ]) {
      const tampered = { ...fixtureOf(name) };
      delete tampered["durationMs"];
      expect(traceEventSchema.safeParse(tampered).success, name).toBe(false);
    }
  });

  it("Provider started/completed缺inputManifestSha256被拒绝", () => {
    for (const name of [
      TRACE_EVENT_NAMES.providerRequestStarted,
      TRACE_EVENT_NAMES.providerRequestCompleted,
    ]) {
      const tampered = { ...fixtureOf(name) };
      delete tampered["inputManifestSha256"];
      expect(traceEventSchema.safeParse(tampered).success, name).toBe(false);
    }
  });

  it("Provider failed缺manifest仅允许预请求失败族", () => {
    // 选择带manifest的fixture并删除，保留非预请求错误码 → 拒绝
    const withManifest = validTraceFixtures.find(
      (item) =>
        item["eventName"] === TRACE_EVENT_NAMES.providerRequestFailed &&
        item["inputManifestSha256"] !== undefined,
    );
    if (!withManifest) throw new Error("缺少带manifest的failed fixture");
    const tampered = { ...withManifest };
    delete tampered["inputManifestSha256"];
    expect(traceEventSchema.safeParse(tampered).success).toBe(false);
    // 预请求失败族允许无manifest
    const preRequest = validTraceFixtures.find(
      (item) =>
        item["eventName"] === TRACE_EVENT_NAMES.providerRequestFailed &&
        item["inputManifestSha256"] === undefined,
    );
    expect(preRequest).toBeDefined();
    expect(
      (preRequest?.["error"] as { code: string }).code.startsWith(
        PROVIDER_PRE_REQUEST_ERROR_PREFIX,
      ),
    ).toBe(true);
    expect(traceEventSchema.safeParse(preRequest).success).toBe(true);
  });

  it("Memory Import事件强制稳定身份、Hash、revision与终态耗时", () => {
    for (const name of [
      TRACE_EVENT_NAMES.memoryImportAccepted,
      TRACE_EVENT_NAMES.memoryImportMaterialized,
      TRACE_EVENT_NAMES.memoryImportOutcomeUnknown,
      TRACE_EVENT_NAMES.memoryImportFailed,
      TRACE_EVENT_NAMES.memoryImportReconcileCompleted,
      TRACE_EVENT_NAMES.memoryImportReconcileFailed,
    ]) {
      const fixture = fixtureOf(name);
      for (const key of [
        "memoryImportIntentId",
        "memoryImportResultId",
        "outboxId",
        "operationId",
        "backendId",
        "requestSha256",
        "intentRevision",
        "resultRevision",
        "durationMs",
      ]) {
        const tampered = { ...fixture };
        delete tampered[key];
        expect(traceEventSchema.safeParse(tampered).success, `${name}缺${key}`).toBe(false);
      }
    }
  });
});

describe("traceEventSchema：对象引用语义", () => {
  it("planRef只能是plan且必须携带revision+sha256", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.planCandidatePublished);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        planRef: { objectType: "message", objectId: "msg_1", sha256: SHA256_A },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        planRef: { objectType: "plan", objectId: "plan_1", sha256: SHA256_A },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        planRef: { objectType: "plan", objectId: "plan_1", revision: 1 },
      }).success,
    ).toBe(false);
  });

  it("decisionRef只能是decision且必须携带revision+sha256", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.decisionCommitted);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        decisionRef: { objectType: "artifact", objectId: "art_1", sha256: SHA256_A },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        decisionRef: { objectType: "decision", objectId: "dec_1", revision: 1 },
      }).success,
    ).toBe(false);
  });

  it("executionCandidateRef必须携带sha256", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.executionValidated);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        candidateRef: { objectType: "execution_candidate", objectId: "exc_1" },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        candidateRef: { objectType: "execution_candidate", objectId: "exc_1", sha256: "XYZ" },
      }).success,
    ).toBe(false);
  });

  it("approval.created不接受错误对象类型的planRef", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.approvalCreated);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        planRef: { objectType: "decision", objectId: "dec_1", revision: 1, sha256: SHA256_A },
      }).success,
    ).toBe(false);
  });

  it("context.assembly.completed必须按状态携带精确版本化ContextPackage引用", () => {
    const ready = fixtureOf(TRACE_EVENT_NAMES.contextAssemblyCompleted);
    expect(traceEventSchema.safeParse(ready).success).toBe(true);
    const withoutRef = { ...ready };
    delete withoutRef["contextPackageRef"];
    expect(traceEventSchema.safeParse(withoutRef).success).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...ready,
        contextPackageRef: {
          objectType: "context_package",
          objectId: "ctxp_1",
          sha256: SHA256_A,
        },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...ready,
        status: "none",
        memoryRequested: false,
        adoptedCount: 0,
        excludedCount: 0,
      }).success,
    ).toBe(false);
  });

  it("ref Schema独立测试：类型字面量与必填Hash", () => {
    expect(
      planRefSchema.safeParse({
        objectType: "plan",
        objectId: "plan_1",
        revision: 1,
        sha256: SHA256_A,
      }).success,
    ).toBe(true);
    expect(
      decisionRefSchema.safeParse({
        objectType: "plan",
        objectId: "plan_1",
        revision: 1,
        sha256: SHA256_A,
      }).success,
    ).toBe(false);
    expect(
      traceObjectRefSchema.safeParse({
        objectType: "artifact",
        objectId: "art_1",
        sha256: SHA256_A,
      }).success,
    ).toBe(true);
    expect(
      traceObjectRefSchema.safeParse({ objectType: "artifact", objectId: "art_1" }).success,
    ).toBe(false);
  });
});

describe("traceEventSchema：任意内容通道被关闭", () => {
  const contentKeys = [
    "body",
    "content",
    "message",
    "prompt",
    "request",
    "response",
    "payload",
    "reasoning",
    "attributes",
    "metadata",
    "details",
  ];

  it.each(contentKeys)("根部出现%s时Schema拒绝", (key) => {
    const event = { ...fixtureOf(TRACE_EVENT_NAMES.httpCommandCompleted), [key]: CONTENT_MARKER };
    expect(traceEventSchema.safeParse(event).success).toBe(false);
  });

  it.each(contentKeys)("嵌套对象出现%s时Schema拒绝", (key) => {
    const event = {
      ...fixtureOf(TRACE_EVENT_NAMES.providerRequestCompleted),
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, [key]: CONTENT_MARKER },
    };
    expect(traceEventSchema.safeParse(event).success).toBe(false);
  });

  it("error对象不允许携带原始message", () => {
    const event = {
      ...fixtureOf(TRACE_EVENT_NAMES.providerRequestFailed),
      error: { code: "provider.timeout", type: "TimeoutError", message: CONTENT_MARKER },
    };
    expect(traceEventSchema.safeParse(event).success).toBe(false);
  });

  it("旧版任意attributes事件被判别联合拒绝", () => {
    const legacy = {
      ...fixtureOf(TRACE_EVENT_NAMES.httpCommandCompleted),
      attributes: { "http.method": "GET", body: CONTENT_MARKER },
    };
    expect(traceEventSchema.safeParse(legacy).success).toBe(false);
  });

  it("HTTP事件不记录请求Body、Query和原始URL", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.httpCommandCompleted);
    for (const key of ["rawUrl", "url", "query", "requestBody", "body"]) {
      expect(traceEventSchema.safeParse({ ...fixture, [key]: "x" }).success).toBe(false);
    }
    expect(traceEventSchema.safeParse({ ...fixture, routeTemplate: "/api/x?y=1" }).success).toBe(
      false,
    );
  });

  it("Provider事件只接受白名单字段", () => {
    const fixture = fixtureOf(TRACE_EVENT_NAMES.providerRequestCompleted);
    expect(
      traceEventSchema.safeParse({
        ...fixture,
        providerStopReason: "toolUse",
        toolCallCount: 1,
      }).success,
    ).toBe(true);
    expect(
      traceEventSchema.safeParse({ ...fixture, providerStopReason: "unknown", toolCallCount: -1 })
        .success,
    ).toBe(false);
    for (const key of ["messages", "tools", "systemPrompt", "responseText", "apiKey"]) {
      expect(traceEventSchema.safeParse({ ...fixture, [key]: CONTENT_MARKER }).success, key).toBe(
        false,
      );
    }
    expect(traceEventSchema.safeParse({ ...fixture, model: "gpt-4o" }).success).toBe(false);
    expect(traceEventSchema.safeParse({ ...fixture, provider: "openai" }).success).toBe(false);
  });

  it("合成正文标记无法通过任何字段形状写入", () => {
    const attempts: unknown[] = [
      { ...fixtureOf(TRACE_EVENT_NAMES.httpCommandCompleted), routeTemplate: CONTENT_MARKER },
      { ...fixtureOf(TRACE_EVENT_NAMES.httpCommandCompleted), httpMethod: CONTENT_MARKER },
      { ...fixtureOf(TRACE_EVENT_NAMES.providerRequestCompleted), endpointHost: CONTENT_MARKER },
      {
        ...fixtureOf(TRACE_EVENT_NAMES.providerRequestCompleted),
        providerRequestId: CONTENT_MARKER,
      },
      { ...fixtureOf(TRACE_EVENT_NAMES.productRunTransitioned), fromStatus: CONTENT_MARKER },
      { ...fixtureOf(TRACE_EVENT_NAMES.decisionCommitted), decisionKind: CONTENT_MARKER },
      { ...fixtureOf(TRACE_EVENT_NAMES.memoryImportAccepted), backendId: CONTENT_MARKER },
      {
        ...fixtureOf(TRACE_EVENT_NAMES.memoryImportAccepted),
        externalObjectIdSha256: CONTENT_MARKER,
      },
    ];
    for (const attempt of attempts) {
      expect(traceEventSchema.safeParse(attempt).success).toBe(false);
    }
  });
});

describe("受限基础Schema", () => {
  it("sha256固定64位小写十六进制", () => {
    expect(sha256Schema.safeParse(SHA256_A).success).toBe(true);
    expect(sha256Schema.safeParse("A".repeat(64)).success).toBe(false);
    expect(sha256Schema.safeParse("abc").success).toBe(false);
  });
});
