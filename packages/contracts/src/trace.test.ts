import { describe, expect, it } from "vitest";
import {
  TRACE_EVENT_NAMES,
  sha256Schema,
  traceEventSchema,
  traceObjectRefSchema,
} from "./trace.js";

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);

/** 合成泄漏标记：证明正文根本无法进入Trace，而不是写入后被脱敏。 */
const CONTENT_MARKER = "TRACE_CONTENT_MUST_NEVER_BE_WRITTEN";

function commonFields(eventName: string) {
  return {
    schemaVersion: 1,
    eventId: "evt_test-1",
    timestamp: new Date().toISOString(),
    level: "info",
    eventName,
    traceId: "trace_test-1",
    spanId: "span_test-1",
    outcome: "unknown",
  };
}

const validHttpCompleted = {
  ...commonFields(TRACE_EVENT_NAMES.httpCommandCompleted),
  outcome: "success",
  requestId: "req_test-1",
  httpMethod: "GET",
  routeTemplate: "/api/healthz",
  statusCode: 200,
  durationMs: 3,
};

const validProviderCompleted = {
  ...commonFields(TRACE_EVENT_NAMES.providerRequestCompleted),
  outcome: "success",
  productRunId: "run_abc123",
  provider: "bailian",
  model: "qwen3.7-plus",
  endpointHost: "dashscope.aliyuncs.com",
  operation: "chat_completion",
  httpStatus: 200,
  providerRequestId: "req-0a1b2c",
  tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  inputManifestSha256: SHA256_A,
  durationMs: 1234,
};

const validProductRunTransitioned = {
  ...commonFields(TRACE_EVENT_NAMES.productRunTransitioned),
  outcome: "success",
  productRunId: "run_abc123",
  fromStatus: "planning",
  toStatus: "awaiting_decision",
  fromPhase: "plan",
  toPhase: "approval",
  revision: 2,
};

const validDecisionCommitted = {
  ...commonFields(TRACE_EVENT_NAMES.decisionCommitted),
  outcome: "success",
  productRunId: "run_abc123",
  commandId: "cmd_abc123",
  decisionKind: "approve",
  decisionRef: { objectType: "decision", objectId: "dec_1", revision: 1, sha256: SHA256_B },
  planRef: { objectType: "plan", objectId: "plan_1", revision: 2, sha256: SHA256_A },
};

describe("traceEventSchema：每种正式事件的合法形状通过", () => {
  it.each([
    ["http.command.completed", validHttpCompleted],
    ["provider.request.completed", validProviderCompleted],
    ["product_run.transitioned", validProductRunTransitioned],
    ["decision.committed", validDecisionCommitted],
  ])("%s", (_label, event) => {
    const result = traceEventSchema.safeParse(event);
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true);
  });

  it("任务书§7.3每个事件名都有对应的严格Schema", () => {
    for (const name of Object.values(TRACE_EVENT_NAMES)) {
      const parsed = traceEventSchema.safeParse(commonFields(name));
      // 公共字段可能不满足事件专属必填字段，但判别必须命中（不得出现No matching discriminator）
      if (!parsed.success) {
        const discriminatorMiss = parsed.error.issues.some(
          (issue) => issue.code === "invalid_union",
        );
        expect(discriminatorMiss, `${name} 缺少严格Schema`).toBe(false);
      }
    }
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
    const event = { ...validHttpCompleted, [key]: CONTENT_MARKER };
    expect(traceEventSchema.safeParse(event).success).toBe(false);
  });

  it.each(contentKeys)("嵌套对象出现%s时Schema拒绝", (key) => {
    const event = {
      ...validProviderCompleted,
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, [key]: CONTENT_MARKER },
    };
    expect(traceEventSchema.safeParse(event).success).toBe(false);
  });

  it("error对象不允许携带原始message", () => {
    const event = {
      ...commonFields(TRACE_EVENT_NAMES.providerRequestFailed),
      outcome: "failure",
      provider: "bailian",
      model: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      operation: "chat_completion",
      error: { code: "provider.timeout", type: "TimeoutError", message: CONTENT_MARKER },
    };
    expect(traceEventSchema.safeParse(event).success).toBe(false);
  });

  it("旧版任意attributes事件被判别联合拒绝", () => {
    const legacy = {
      ...commonFields(TRACE_EVENT_NAMES.httpCommandCompleted),
      outcome: "success",
      attributes: { "http.method": "GET", body: CONTENT_MARKER },
    };
    expect(traceEventSchema.safeParse(legacy).success).toBe(false);
  });

  it("HTTP事件不记录请求Body、Query和原始URL", () => {
    for (const key of ["rawUrl", "url", "query", "requestBody", "body"]) {
      expect(traceEventSchema.safeParse({ ...validHttpCompleted, [key]: "x" }).success).toBe(false);
    }
    // 路由模板不允许query分隔符与点分文件路径
    expect(
      traceEventSchema.safeParse({ ...validHttpCompleted, routeTemplate: "/api/x?y=1" }).success,
    ).toBe(false);
  });

  it("Provider事件只接受白名单字段", () => {
    for (const key of ["messages", "tools", "systemPrompt", "responseText", "apiKey"]) {
      expect(
        traceEventSchema.safeParse({ ...validProviderCompleted, [key]: CONTENT_MARKER }).success,
        key,
      ).toBe(false);
    }
    // 模型与Provider被冻结为字面量
    expect(traceEventSchema.safeParse({ ...validProviderCompleted, model: "gpt-4o" }).success).toBe(
      false,
    );
    expect(
      traceEventSchema.safeParse({ ...validProviderCompleted, provider: "openai" }).success,
    ).toBe(false);
  });

  it("合成正文标记无法通过任何字段形状写入", () => {
    const attempts: unknown[] = [
      { ...validHttpCompleted, routeTemplate: CONTENT_MARKER },
      { ...validHttpCompleted, httpMethod: CONTENT_MARKER },
      { ...validProviderCompleted, endpointHost: CONTENT_MARKER },
      { ...validProviderCompleted, providerRequestId: CONTENT_MARKER },
      { ...validProductRunTransitioned, fromStatus: CONTENT_MARKER },
      { ...validDecisionCommitted, decisionKind: CONTENT_MARKER },
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

  it("对象引用严格且不允许多余字段", () => {
    expect(
      traceObjectRefSchema.safeParse({
        objectType: "plan",
        objectId: "plan_1",
        revision: 1,
        sha256: SHA256_A,
      }).success,
    ).toBe(true);
    expect(
      traceObjectRefSchema.safeParse({ objectType: "plan", objectId: "plan_1", text: "正文" })
        .success,
    ).toBe(false);
    expect(
      traceObjectRefSchema.safeParse({ objectType: "workflow_run", objectId: "wr_1" }).success,
    ).toBe(false);
  });
});
