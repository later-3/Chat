import { afterEach, describe, expect, it } from "vitest";
import { piExecutorEventSchema } from "@chat/pi-runtime";
import type { RunActivityEventInput, TraceEventInput } from "@chat/contracts";
import { emitPiExecutorTrace } from "./pi-executor-trace.js";
import { setWorkflowRuntimeContext } from "./runtime-context.js";

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("Pi Executor Journal -> Chat Trace", () => {
  it("会话显示内容只进入Activity，Debug Trace只保留Hash且使用Pi实际endpoint", () => {
    const emitted: TraceEventInput[] = [];
    const activities: RunActivityEventInput[] = [];
    setWorkflowRuntimeContext({
      trace: (event: TraceEventInput) => emitted.push(event),
      activity: (event: RunActivityEventInput) => activities.push(event),
    } as never);
    const scope = {
      productRunId: "run_traceprojection1",
      attemptId: "att_traceprojection1",
      promptTemplateVersion: "executor-1.0.0",
      modelConfigVersion: "bailian-qwen-1.0.0",
    };
    const common = {
      operationId: "pio_traceprojection1",
      timestamp: "2026-08-18T00:00:00.000Z",
      sessionId: "pis_traceprojection1",
    };
    emitPiExecutorTrace(
      scope,
      piExecutorEventSchema.parse({
        ...common,
        sequence: 1,
        type: "provider.started",
        requestIndex: 1,
        endpointHost: "coding.dashscope.aliyuncs.com",
        inputSha256: "a".repeat(64),
      }),
    );
    emitPiExecutorTrace(
      scope,
      piExecutorEventSchema.parse({
        ...common,
        sequence: 2,
        type: "tool.intent_persisted",
        turnIndex: 0,
        toolCallId: "call_bash_1",
        toolName: "bash",
        inputSha256: "b".repeat(64),
        inputDisplay: '{"command":"pnpm test","path":"src/index.ts"}',
        inputDisplayTruncated: false,
      }),
    );
    emitPiExecutorTrace(
      scope,
      piExecutorEventSchema.parse({
        ...common,
        sequence: 3,
        type: "tool.completed",
        turnIndex: 0,
        toolCallId: "call_bash_1",
        toolName: "bash",
        resultSha256: "c".repeat(64),
        resultDisplay: "42 tests passed",
        resultDisplayTruncated: false,
        durationMs: 123,
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        eventName: "provider.request.started",
        endpointHost: "coding.dashscope.aliyuncs.com",
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        eventName: "pi.tool.intent_persisted",
        inputSha256: "b".repeat(64),
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        eventName: "pi.tool.completed",
        resultSha256: "c".repeat(64),
        durationMs: 123,
      }),
    );
    expect(JSON.stringify(emitted)).not.toContain("pnpm test");
    expect(JSON.stringify(emitted)).not.toContain("42 tests passed");
    expect(activities).toContainEqual(
      expect.objectContaining({
        activityType: "tool",
        phase: "started",
        inputDisplay: '{"command":"pnpm test","path":"src/index.ts"}',
      }),
    );
    expect(activities).toContainEqual(
      expect.objectContaining({
        activityType: "tool",
        phase: "completed",
        resultDisplay: "42 tests passed",
        durationMs: 123,
      }),
    );
  });
});
