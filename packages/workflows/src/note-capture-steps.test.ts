import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import { setWorkflowRuntimeContext } from "./runtime-context.js";
import { generateAndPublishNoteCandidateStep } from "./note-capture-steps.js";

const SHA = "a".repeat(64);

function prepared() {
  return {
    schemaVersion: "chat-internal-runtime.v1",
    productRunId: "run_notestep1",
    workflowRunSpecId: "wrs_notestep1",
    source: {
      kind: "full_message",
      sourceMessageId: "msg_notestep1",
      sourceMessageSha256: SHA,
    },
    sourceText: "私密来源正文",
    defaultKind: "project_idea",
    suggestedTagLabels: ["项目"],
    priorCandidate: {
      noteCandidateId: "ntc_prior1",
      candidateSequence: 1,
      proposed: {
        title: "旧标题",
        kind: "idea",
        contentMarkdown: "旧正文",
        tags: [{ key: "旧", label: "旧" }],
      },
      sha256: "b".repeat(64),
    },
    revisionInstruction: "改成项目想法",
  } as never;
}

function installContext(input: {
  readonly noteCapture?: ReturnType<typeof vi.fn>;
  readonly api?: Record<string, ReturnType<typeof vi.fn>>;
  readonly events?: unknown[];
}) {
  const events = input.events ?? [];
  const api = input.api ?? {};
  setWorkflowRuntimeContext({
    api: api as never,
    bindings: {} as never,
    memoryBackends: { list: () => [], get: () => undefined },
    trace: (event) => events.push(event),
    now: () => "2026-08-10T00:00:00.000Z",
    bailian: {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      endpointHost: "example.invalid",
    },
    planner: vi.fn() as never,
    noteCapture: (input.noteCapture ?? vi.fn()) as never,
    executor: vi.fn() as never,
  });
  return { api, events };
}

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("Note Capture耐久Steps", () => {
  it("准备输入只读Application边界，pi单次调用注入修订上下文且Trace不含正文", async () => {
    const capture = vi.fn(async () => ({
      kind: "candidate" as const,
      candidate: {
        title: "新标题",
        kind: "project_idea" as const,
        contentMarkdown: "新正文",
        tagLabels: ["项目"],
      },
      durationMs: 12,
      providerCallCount: 1,
      providerMeta: {
        httpStatus: 200,
        providerRequestId: "provider-note-1",
        providerStopReason: "toolUse" as const,
        toolCallCount: 1,
      },
      usage: { inputTokens: 20, outputTokens: 10 },
    }));
    const publish = vi.fn(async () => ({
      candidate: {
        schemaVersion: "chat-note-api.v1",
        noteCandidateId: "ntc_stable1",
        productRunId: "run_notestep1",
        candidateSequence: 2,
        proposed: { title: "新标题", kind: "project_idea", contentMarkdown: "新正文", tags: [] },
        sourceRefs: [],
        sha256: SHA,
        status: "under_review",
        revision: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        allowedActions: ["confirm", "request_revision", "reject"],
      },
      review: { outcome: "waiting_human" as const },
    }));
    const api = {
      prepareNoteCaptureInput: vi.fn(async () => prepared()),
      publishNoteCandidate: publish,
    };
    const events: unknown[] = [];
    installContext({ noteCapture: capture, api, events });
    const result = await generateAndPublishNoteCandidateStep({
      productRunId: "run_notestep1",
      attemptId: "att_notestep1",
      workflowRunSpecId: "wrs_notestep1",
      maxCharacters: 4_000,
      allowCustomTags: true,
    });

    expect(result).toEqual({
      status: "published",
      candidate: { noteCandidateId: "ntc_stable1", candidateSequence: 2, sha256: SHA },
      review: { outcome: "waiting_human" },
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        captureInput: expect.objectContaining({
          sourceText: "私密来源正文",
          priorCandidate: expect.objectContaining({ tagLabels: ["旧"] }),
          revisionInstruction: "改成项目想法",
        }),
      }),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("provider.request.completed");
    expect(serialized).toContain("pi.node.completed");
    expect(serialized).not.toContain("私密来源正文");
    expect(serialized).not.toContain("旧正文");
    expect(
      (
        generateAndPublishNoteCandidateStep as typeof generateAndPublishNoteCandidateStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(0);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.stringMatching(/^cmd_[a-f0-9]{32}$/u),
        proposed: expect.objectContaining({ title: "新标题" }),
      }),
    );
  });

  it("Provider结果未知作为可序列化失败返回，Step自身不触发SDK重试", async () => {
    const capture = vi.fn(async () => ({
      kind: "provider_failed" as const,
      errorCode: "provider.stream_interrupted" as const,
      durationMs: 10,
      providerCallCount: 1,
      providerMeta: { providerRequestId: "provider-note-unknown" },
    }));
    installContext({
      noteCapture: capture,
      api: { prepareNoteCaptureInput: vi.fn(async () => prepared()) },
    });
    const result = await generateAndPublishNoteCandidateStep({
      productRunId: "run_notestep1",
      attemptId: "att_notestep1",
      workflowRunSpecId: "wrs_notestep1",
      maxCharacters: 4_000,
      allowCustomTags: true,
    });
    expect(result).toEqual({ status: "failed", errorCode: "provider.stream_interrupted" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("allowCustomTags关闭时拒绝建议集外标签，开启时允许同一候选", async () => {
    const capture = vi.fn(async () => ({
      kind: "candidate" as const,
      candidate: {
        title: "自定义标签候选",
        kind: "project_idea" as const,
        contentMarkdown: "正文",
        tagLabels: ["自定义"],
      },
      durationMs: 8,
      providerCallCount: 1,
      providerMeta: {
        httpStatus: 200,
        providerRequestId: "provider-note-tags-1",
        providerStopReason: "toolUse" as const,
        toolCallCount: 1,
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const publish = vi.fn(async () => ({
      candidate: {
        noteCandidateId: "ntc_tags1",
        candidateSequence: 2,
        sha256: SHA,
      },
      review: { outcome: "waiting_human" as const },
    }));
    installContext({
      noteCapture: capture,
      api: {
        prepareNoteCaptureInput: vi.fn(async () => prepared()),
        publishNoteCandidate: publish,
      },
    });
    const identity = {
      productRunId: "run_notestep1",
      attemptId: "att_notestep1",
      workflowRunSpecId: "wrs_notestep1",
      maxCharacters: 4_000,
    };

    const blocked = await generateAndPublishNoteCandidateStep({
      ...identity,
      allowCustomTags: false,
    });
    const allowed = await generateAndPublishNoteCandidateStep({
      ...identity,
      allowCustomTags: true,
    });

    expect(blocked).toEqual({
      status: "failed",
      errorCode: "model.candidate.capability_violation",
    });
    expect(allowed).toMatchObject({ status: "published" });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
