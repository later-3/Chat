import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createHook: vi.fn(),
  loadRunSpec: vi.fn(),
  recordNode: vi.fn(),
  generateCandidate: vi.fn(),
  claimHook: vi.fn(),
  loadDecision: vi.fn(),
  commitNote: vi.fn(),
  commitRunFailure: vi.fn(),
}));

vi.mock("workflow", () => ({ defineHook: () => ({ create: mocked.createHook }) }));
vi.mock("./configurable-planning-steps.js", () => ({
  loadNoteCaptureRunSpecStep: mocked.loadRunSpec,
  recordConfigurablePlanningNodeStep: mocked.recordNode,
}));
vi.mock("./note-capture-steps.js", () => ({
  generateAndPublishNoteCandidateStep: mocked.generateCandidate,
  claimNoteDecisionHookStep: mocked.claimHook,
  loadNoteDecisionStep: mocked.loadDecision,
  commitConfirmedNoteStep: mocked.commitNote,
}));
vi.mock("./workflow-result-steps.js", () => ({ commitRunFailureStep: mocked.commitRunFailure }));

import { noteCaptureWorkflow } from "./note-capture-workflow.js";

const SHA = "a".repeat(64);

const task = (definitionNodeId: string, nodeType: string, config = {}) => ({
  kind: "task",
  definitionNodeId,
  nodeType,
  schemaVersion: 1,
  config,
});

function runSpecFixture(
  maxIterations = 2,
  reviewMode: "manual" | "auto_continue_if_policy_allows" = "manual",
) {
  const nodes = [
    ["note.extract", "note.extract", { maxCharacters: 4_000 }],
    ["note.classify", "note.classify", { allowCustomTags: true }],
    ["note.review", "human.note_review", { reviewMode: "manual" }],
    ["note.commit", "note.commit", {}],
  ] as const;
  return {
    semanticRoot: {
      kind: "sequence",
      elements: [
        {
          kind: "bounded_loop",
          body: {
            kind: "sequence",
            elements: nodes.slice(0, 3).map(([id, type, config]) => task(id, type, config)),
          },
          outcomeFromDefinitionNodeId: "note.review",
          continueOutcomes: ["request_revision"],
          exitOutcomes: ["approved", "rejected"],
          maxIterations,
          exceededPolicy: "fail",
        },
        task("note.commit", "note.commit"),
      ],
    },
    nodeResolutions: nodes.map(([definitionNodeId, nodeType, config]) => ({
      definitionNodeId,
      nodeType,
      schemaVersion: 1,
      config,
      activation: "enabled",
    })),
    reviewResolutions: [
      reviewMode === "manual"
        ? { definitionNodeId: "note.review", mode: "manual", actor: "user" }
        : {
            definitionNodeId: "note.review",
            mode: "auto_continue_if_policy_allows",
            actor: "system_policy",
            policyRef: { resourceId: "rul_systemnotelowriskv1", revision: 1, sha256: SHA },
          },
    ],
    limits: { runtime: { maxNodeExecutions: 32, maxWaits: 4 } },
  } as never;
}

function candidate(sequence: number, id = `ntc_note${String(sequence)}`) {
  return {
    noteCandidateId: id,
    candidateSequence: sequence,
    sha256: SHA,
  };
}

describe("正式Note Capture Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRunSpec.mockResolvedValue(runSpecFixture());
    mocked.recordNode.mockResolvedValue(undefined);
    let publishSequence = 0;
    mocked.generateCandidate.mockImplementation(async () => {
      publishSequence += 1;
      return {
        status: "published",
        candidate: candidate(publishSequence),
        review: { outcome: "waiting_human" },
      };
    });
    let hookSequence = 0;
    mocked.createHook.mockImplementation(() => {
      hookSequence += 1;
      const signal = Promise.resolve({
        hookNoteCandidateId: `ntc_note${String(hookSequence)}`,
        noteCandidateId: `ntc_note${String(hookSequence)}`,
        noteDecisionId: `ntd_note${String(hookSequence)}`,
      });
      return {
        getConflict: async () => null,
        then: signal.then.bind(signal),
        [Symbol.dispose]: () => undefined,
      };
    });
    mocked.claimHook.mockResolvedValue(undefined);
    mocked.loadDecision
      .mockResolvedValueOnce({
        candidate: candidate(1),
        decision: { noteDecisionId: "ntd_note1", kind: "request_revision" },
      })
      .mockResolvedValueOnce({
        // edited confirm由Application创建successor；Runner只消费返回的权威Candidate identity。
        candidate: candidate(3, "ntc_edited3"),
        decision: { noteDecisionId: "ntd_note2", kind: "confirm" },
      });
    mocked.commitNote.mockResolvedValue(undefined);
    mocked.commitRunFailure.mockResolvedValue(undefined);
  });

  it("request_revision两轮后以edited successor提交，且不重复分类模型调用", async () => {
    const result = await noteCaptureWorkflow({
      schemaVersion: "note-capture-workflow-input.v1",
      productRunId: "run_noteworkflow1",
      attemptId: "att_noteworkflow1",
      workflowRunSpecId: "wrs_noteworkflow1",
    });

    expect(result.outcome).toBe("note_committed");
    expect(mocked.generateCandidate).toHaveBeenCalledTimes(2);
    expect(mocked.claimHook).toHaveBeenCalledTimes(2);
    expect(mocked.commitNote).toHaveBeenCalledWith(
      expect.objectContaining({ noteCandidateId: "ntc_edited3" }),
    );
    expect(mocked.commitRunFailure).not.toHaveBeenCalled();
    const classifySuccesses = mocked.recordNode.mock.calls
      .map(([call]) => call)
      .filter((call) => call.definitionNodeId === "note.classify" && call.toStatus === "succeeded");
    expect(classifySuccesses).toHaveLength(2);
    expect(classifySuccesses.every((call) => call.publicSummary.includes("未重复调用模型"))).toBe(
      true,
    );
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .filter(
          (call) =>
            call.definitionNodeId === "note.review" || call.definitionNodeId === "note.commit",
        ),
    ).toEqual([]);
  });

  it("拒绝后不进入commit，产品Decision已经拥有rejected终态", async () => {
    mocked.loadDecision.mockReset().mockResolvedValue({
      candidate: candidate(1),
      decision: { noteDecisionId: "ntd_reject1", kind: "reject" },
    });
    const result = await noteCaptureWorkflow({
      schemaVersion: "note-capture-workflow-input.v1",
      productRunId: "run_noteworkflow1",
      attemptId: "att_noteworkflow1",
      workflowRunSpecId: "wrs_noteworkflow1",
    });
    expect(result.outcome).toBe("rejected");
    expect(mocked.commitNote).not.toHaveBeenCalled();
    expect(mocked.commitRunFailure).not.toHaveBeenCalled();
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .some((call) => call.definitionNodeId === "note.review"),
    ).toBe(false);
  });

  it("修订超过冻结BoundedLoop上限时失败关闭", async () => {
    mocked.loadRunSpec.mockResolvedValue(runSpecFixture(1));
    mocked.loadDecision.mockReset().mockResolvedValue({
      candidate: candidate(1),
      decision: { noteDecisionId: "ntd_revision1", kind: "request_revision" },
    });
    const result = await noteCaptureWorkflow({
      schemaVersion: "note-capture-workflow-input.v1",
      productRunId: "run_noteworkflow1",
      attemptId: "att_noteworkflow1",
      workflowRunSpecId: "wrs_noteworkflow1",
    });
    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "note_revision_limit_reached",
    });
    expect(mocked.commitRunFailure).toHaveBeenCalledTimes(1);
    expect(mocked.generateCandidate).toHaveBeenCalledTimes(1);
  });

  it("权威Policy允许时不创建Hook或Decision并直接提交Candidate", async () => {
    mocked.loadRunSpec.mockResolvedValue(runSpecFixture(2, "auto_continue_if_policy_allows"));
    mocked.generateCandidate.mockResolvedValue({
      status: "published",
      candidate: candidate(1),
      review: {
        outcome: "auto_continued",
        policyResolutionRef: {
          workflowPolicyResolutionId: "wpr_noteallowed1",
          revision: 1,
          sha256: SHA,
        },
      },
    });

    const result = await noteCaptureWorkflow({
      schemaVersion: "note-capture-workflow-input.v1",
      productRunId: "run_noteautoallowed1",
      attemptId: "att_noteautoallowed1",
      workflowRunSpecId: "wrs_noteautoallowed1",
    });

    expect(result.outcome).toBe("note_committed");
    expect(mocked.createHook).not.toHaveBeenCalled();
    expect(mocked.claimHook).not.toHaveBeenCalled();
    expect(mocked.loadDecision).not.toHaveBeenCalled();
    expect(mocked.commitNote).toHaveBeenCalledWith(
      expect.objectContaining({ noteCandidateId: "ntc_note1" }),
    );
  });

  it("权威Policy拒绝时进入现有人工Hook，确认后提交同一Candidate", async () => {
    mocked.loadRunSpec.mockResolvedValue(runSpecFixture(2, "auto_continue_if_policy_allows"));
    mocked.generateCandidate.mockResolvedValue({
      status: "published",
      candidate: candidate(1),
      review: {
        outcome: "policy_denied_waiting_human",
        policyResolutionRef: {
          workflowPolicyResolutionId: "wpr_notedenied1",
          revision: 1,
          sha256: SHA,
        },
      },
    });
    mocked.loadDecision.mockReset().mockResolvedValue({
      candidate: candidate(1),
      decision: { noteDecisionId: "ntd_note1", kind: "confirm" },
    });

    const result = await noteCaptureWorkflow({
      schemaVersion: "note-capture-workflow-input.v1",
      productRunId: "run_noteautodenied1",
      attemptId: "att_noteautodenied1",
      workflowRunSpecId: "wrs_noteautodenied1",
    });

    expect(result.outcome).toBe("note_committed");
    expect(mocked.createHook).toHaveBeenCalledTimes(1);
    expect(mocked.claimHook).toHaveBeenCalledTimes(1);
    expect(mocked.loadDecision).toHaveBeenCalledTimes(1);
    expect(mocked.commitNote).toHaveBeenCalledTimes(1);
  });
});
