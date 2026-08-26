import { describe, expect, it } from "vitest";
import { commandEnvelopeSchema } from "./command.js";
import { chatEventEnvelopeSchema } from "./events.js";
import { problemDetailSchema } from "./problem-detail.js";
import {
  beginRunAttemptRequestSchema,
  beginRunAttemptResponseSchema,
  completeRunAttemptRequestSchema,
} from "./internal-runtime.js";

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
    expect(() =>
      commandEnvelopeSchema.parse({
        commandId: "cmd_1",
        payload: {},
        provider: "bailian",
        model: "qwen3.7-plus",
      }),
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
    expect(() => problemDetailSchema.parse({ ...ok, secret: "must-not-be-accepted" })).toThrow();
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

  it("接受官方AG-UI形状的payload", () => {
    const parsed = chatEventEnvelopeSchema.parse({
      ...base,
      payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1", delta: "你好" },
    });
    expect(parsed.payload.type).toBe("TEXT_MESSAGE_CONTENT");

    const runStarted = chatEventEnvelopeSchema.parse({
      ...base,
      payload: { type: "RUN_STARTED", threadId: "psn_1", runId: "run_1", timestamp: 1785000000000 },
    });
    expect(runStarted.payload.type).toBe("RUN_STARTED");

    // Tool Call投影属于采用范围。
    const toolCall = chatEventEnvelopeSchema.parse({
      ...base,
      payload: { type: "TOOL_CALL_START", toolCallId: "tc_1", toolCallName: "read_file" },
    });
    expect(toolCall.payload.type).toBe("TOOL_CALL_START");
  });

  it("拒绝与官方AG-UI不兼容的payload", () => {
    // timestamp必须是epoch毫秒数字，不是ISO字符串。
    expect(() =>
      chatEventEnvelopeSchema.parse({
        ...base,
        payload: {
          type: "RUN_STARTED",
          threadId: "psn_1",
          runId: "run_1",
          timestamp: "2026-08-06",
        },
      }),
    ).toThrow();
    // RUN_STARTED缺少必需的threadId/runId。
    expect(() =>
      chatEventEnvelopeSchema.parse({ ...base, payload: { type: "RUN_STARTED" } }),
    ).toThrow();
    expect(() =>
      chatEventEnvelopeSchema.parse({
        ...base,
        payload: { type: "RUN_FINISHED", threadId: "psn_1" },
      }),
    ).toThrow();
  });

  it("排除隐藏推理与RAW透传事件", () => {
    for (const type of ["REASONING_START", "THINKING_START", "RAW"]) {
      expect(() =>
        chatEventEnvelopeSchema.parse({ ...base, payload: { type, messageId: "msg_1" } }),
      ).toThrow();
    }
  });

  it("拒绝未知payload类型、非递增sequence形状和运行时私有ID字段", () => {
    expect(() =>
      chatEventEnvelopeSchema.parse({ ...base, payload: { type: "NOT_A_EVENT" } }),
    ).toThrow();
    expect(() =>
      chatEventEnvelopeSchema.parse({
        ...base,
        sequence: 0,
        payload: { type: "RUN_STARTED", threadId: "psn_1", runId: "run_1" },
      }),
    ).toThrow();
    // Envelope不得携带Workflow/pi私有身份。
    expect(() =>
      chatEventEnvelopeSchema.parse({
        ...base,
        workflowRunId: "wf_1",
        payload: { type: "RUN_STARTED", threadId: "psn_1", runId: "run_1" },
      }),
    ).toThrow();
  });
});

describe("private runtime attempt contracts", () => {
  const begin = {
    schemaVersion: "chat-internal-runtime.v1",
    commandId: "cmd_attempt1",
    productRunId: "run_attempt1",
    kind: "execution",
    executionContractId: "exc_attempt1",
    stepId: "step-1",
    dependencyRefs: [],
    promptTemplateVersion: "executor-prompt.v1",
    modelConfigVersion: "bailian.qwen3.7-plus.v1",
  };

  it("begin只接受证据完整的execution attempt", () => {
    expect(beginRunAttemptRequestSchema.safeParse(begin).success).toBe(true);
    expect(beginRunAttemptRequestSchema.safeParse({ ...begin, kind: "planning" }).success).toBe(
      false,
    );
    const missingContract: Partial<typeof begin> = { ...begin };
    delete missingContract.executionContractId;
    expect(beginRunAttemptRequestSchema.safeParse(missingContract).success).toBe(false);
    expect(
      beginRunAttemptRequestSchema.safeParse({
        ...begin,
        inputManifestSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("begin响应只返回Application解析的当前步骤条目", () => {
    const response = {
      schemaVersion: "chat-internal-runtime.v1",
      attemptId: "att_attempt1",
      inputManifestSha256: "a".repeat(64),
      contextItems: [
        {
          refId: "mrs_attempt1",
          revision: 1,
          sha256: "b".repeat(64),
          title: "已冻结事实",
          kind: "world_model",
          layer: "L2",
          tags: ["project"],
          content: "只读正文",
        },
      ],
    };
    expect(beginRunAttemptResponseSchema.safeParse(response).success).toBe(true);
    const promptAssemblyRef = {
      promptAssemblyId: "pma_attempt1",
      sha256: "e".repeat(64),
      definitionNodeId: "planning.execute",
      nodeAssemblySha256: "f".repeat(64),
    };
    expect(
      beginRunAttemptResponseSchema.safeParse({ ...response, promptAssemblyRef }).success,
    ).toBe(true);
    expect(
      beginRunAttemptResponseSchema.safeParse({
        ...response,
        promptAssemblyRef: { ...promptAssemblyRef, systemPromptAppend: "不得进入Workflow响应" },
      }).success,
    ).toBe(false);
    expect(
      beginRunAttemptResponseSchema.safeParse({
        ...response,
        promptAssemblyRef: { ...promptAssemblyRef, nodeAssemblySha256: "bad" },
      }).success,
    ).toBe(false);
    expect(
      beginRunAttemptResponseSchema.safeParse({
        ...response,
        contextItems: [
          {
            contextKind: "project",
            refId: "pcx_attempt1",
            revision: 1,
            sha256: "c".repeat(64),
            title: "Aurora",
            projectId: "prj_attempt1",
            projectRevision: 2,
            snapshot: {
              name: "Aurora",
              summary: "项目上下文",
              goal: "形成下一阶段计划",
              scopeIn: [],
              scopeOut: [],
              successCriteria: ["可审核"],
              status: "active",
              methodProfileId: "small-project.v1",
              stage: {
                key: "delivery",
                name: "交付",
                goal: "完成交付",
                successCriteria: ["测试通过"],
                status: "active",
              },
              milestones: [],
              activeWorks: [],
            },
          },
          {
            contextKind: "rule",
            refId: "rrv_attempt1",
            revision: 3,
            sha256: "d".repeat(64),
            ruleId: "rul_attempt1",
            content: "每个结论必须绑定证据。",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      beginRunAttemptResponseSchema.safeParse({
        ...response,
        contextItems: [{ ...response.contextItems[0], endpoint: "private" }],
      }).success,
    ).toBe(false);
  });

  it("complete用判别联合绑定outcome与errorCode", () => {
    const base = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_attempt2",
      attemptId: "att_attempt1",
    };
    expect(completeRunAttemptRequestSchema.safeParse({ ...base, outcome: "success" }).success).toBe(
      true,
    );
    expect(
      completeRunAttemptRequestSchema.safeParse({
        ...base,
        outcome: "failure",
        errorCode: "execution.failed",
      }).success,
    ).toBe(true);
    expect(completeRunAttemptRequestSchema.safeParse({ ...base, outcome: "running" }).success).toBe(
      false,
    );
    expect(completeRunAttemptRequestSchema.safeParse({ ...base, outcome: "failure" }).success).toBe(
      false,
    );
    expect(
      completeRunAttemptRequestSchema.safeParse({
        ...base,
        outcome: "success",
        errorCode: "must_not_exist",
      }).success,
    ).toBe(false);
  });
});
