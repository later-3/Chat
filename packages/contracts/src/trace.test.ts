import { describe, expect, it } from "vitest";
import {
  TRACE_EVENT_NAMES,
  TRACE_REDACTED,
  isSensitiveAttributeKey,
  redactAttributes,
  traceEventSchema,
} from "./trace.js";

function validEvent() {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    level: "info",
    eventName: TRACE_EVENT_NAMES.httpCommandReceived,
    traceId: "trace_1",
    spanId: "span_1",
    outcome: "unknown",
    attributes: {},
  };
}

describe("traceEventSchema", () => {
  it("接受任务书§7.2的全部公共字段", () => {
    const event = traceEventSchema.parse({
      ...validEvent(),
      parentSpanId: "span_0",
      requestId: "req_1",
      productSessionId: "session_1",
      interactionId: "interaction_1",
      productRunId: "run_1",
      attemptId: "attempt_1",
      commandId: "cmd_1",
      workflowDefinitionVersion: "1",
      planRevision: 2,
      durationMs: 12.5,
      errorCode: "conflict",
    });
    expect(event.productRunId).toBe("run_1");
    expect(event.planRevision).toBe(2);
  });

  it("拒绝未知schemaVersion、非法eventName与负durationMs", () => {
    expect(traceEventSchema.safeParse({ ...validEvent(), schemaVersion: 2 }).success).toBe(false);
    expect(traceEventSchema.safeParse({ ...validEvent(), eventName: "HTTP COMMAND" }).success).toBe(
      false,
    );
    expect(traceEventSchema.safeParse({ ...validEvent(), eventName: "no-dot" }).success).toBe(
      false,
    );
    expect(traceEventSchema.safeParse({ ...validEvent(), durationMs: -1 }).success).toBe(false);
    expect(traceEventSchema.safeParse({ ...validEvent(), outcome: "ok" }).success).toBe(false);
  });

  it("任务书§7.3事件名全部符合命名规则", () => {
    for (const name of Object.values(TRACE_EVENT_NAMES)) {
      expect(traceEventSchema.safeParse({ ...validEvent(), eventName: name }).success, name).toBe(
        true,
      );
    }
  });
});

describe("isSensitiveAttributeKey", () => {
  it("识别密钥、Token、Cookie、Prompt、Payload和隐藏推理", () => {
    for (const key of [
      "authorization",
      "Authorization",
      "x-api-key",
      "apiKey",
      "DASHSCOPE_API_KEY",
      "cookie",
      "Set-Cookie",
      "hookToken",
      "access_token",
      "password",
      "clientSecret",
      "prompt",
      "providerPayload",
      "hiddenReasoning",
    ]) {
      expect(isSensitiveAttributeKey(key), key).toBe(true);
    }
  });

  it("放行普通字段与Token Usage", () => {
    for (const key of [
      "http.method",
      "provider",
      "model",
      "endpointHost",
      "tokenUsage",
      "requestIdHeader",
      "durationMs",
    ]) {
      expect(isSensitiveAttributeKey(key), key).toBe(false);
    }
  });
});

describe("redactAttributes", () => {
  it("递归脱敏敏感键并保留可观察字段", () => {
    const redacted = redactAttributes({
      provider: "bailian",
      model: "qwen3.7-plus",
      tokenUsage: { promptTokens: 10, completionTokens: 20 },
      nested: { authorization: "Bearer sk-xxx", list: [{ cookie: "a=1" }, "ok"] },
    });
    expect(redacted["provider"]).toBe("bailian");
    expect(redacted["tokenUsage"]).toEqual({ promptTokens: 10, completionTokens: 20 });
    expect((redacted["nested"] as Record<string, unknown>)["authorization"]).toBe(TRACE_REDACTED);
    const list = (redacted["nested"] as Record<string, unknown>)["list"] as unknown[];
    expect((list[0] as Record<string, unknown>)["cookie"]).toBe(TRACE_REDACTED);
    expect(list[1]).toBe("ok");
  });

  it("截断超长字符串并标记截断长度", () => {
    const redacted = redactAttributes({ body: "x".repeat(1500) });
    const body = redacted["body"] as string;
    expect(body.length).toBeLessThan(1500);
    expect(body).toContain("[truncated 500 chars]");
  });

  it("不可序列化值转为字符串", () => {
    const redacted = redactAttributes({ fn: () => 1, undef: undefined });
    expect(typeof redacted["fn"]).toBe("string");
    expect(typeof redacted["undef"]).toBe("string");
  });
});
