import { describe, expect, it } from "vitest";
import { commandEnvelopeSchema } from "./command.js";
import { chatEventEnvelopeSchema } from "./events.js";
import { problemDetailSchema } from "./problem-detail.js";

describe("command envelope contract", () => {
  it("要求commandId，expectedRevision可选", () => {
    const parsed = commandEnvelopeSchema.parse({
      commandId: "cmd_1",
      payload: { text: "hi" },
    });
    expect(parsed.expectedRevision).toBeUndefined();

    expect(() => commandEnvelopeSchema.parse({ payload: {} })).toThrow();
    expect(() =>
      commandEnvelopeSchema.parse({ commandId: "cmd_1", expectedRevision: -1, payload: {} }),
    ).toThrow();
  });
});

describe("problem detail contract", () => {
  it("校验错误族与状态码", () => {
    const ok = problemDetailSchema.parse({
      type: "https://chat.example/problems/revision-conflict",
      title: "Revision conflict",
      status: 409,
      code: "revision_conflict",
      requestId: "req_1",
      retryable: false,
      recoveryAction: "rehydrate_and_retry",
    });
    expect(ok.code).toBe("revision_conflict");

    expect(() =>
      problemDetailSchema.parse({
        type: "t",
        title: "t",
        status: 200,
        code: "internal",
        requestId: "req_1",
        retryable: false,
        recoveryAction: "none",
      }),
    ).toThrow();
  });
});

describe("chat event envelope contract", () => {
  const base = {
    schemaVersion: "1",
    eventId: "evt_1",
    sequence: 1,
    occurredAt: "2026-08-06T00:00:00.000Z",
    productSessionId: "psn_1",
    productRunId: "run_1",
  };

  it("接受AG-UI兼容payload", () => {
    const parsed = chatEventEnvelopeSchema.parse({
      ...base,
      payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1", delta: "你好" },
    });
    expect(parsed.payload.type).toBe("TEXT_MESSAGE_CONTENT");
  });

  it("拒绝未知payload类型、非递增sequence形状和运行时私有ID字段", () => {
    expect(() =>
      chatEventEnvelopeSchema.parse({ ...base, payload: { type: "NOT_A_EVENT" } }),
    ).toThrow();
    expect(() =>
      chatEventEnvelopeSchema.parse({
        ...base,
        sequence: 0,
        payload: { type: "RUN_STARTED" },
      }),
    ).toThrow();
    // Envelope不得携带Workflow/pi私有身份。
    expect(() =>
      chatEventEnvelopeSchema.parse({
        ...base,
        workflowRunId: "wf_1",
        payload: { type: "RUN_STARTED" },
      }),
    ).toThrow();
  });
});
