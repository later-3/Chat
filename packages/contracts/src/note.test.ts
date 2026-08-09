import { describe, expect, it } from "vitest";
import {
  NOTE_API_SCHEMA_VERSION,
  NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS,
  archiveNotePayloadSchema,
  noteCandidateReviewDtoSchema,
  noteCandidateSchema,
  noteDecisionSchema,
  noteDetailDtoSchema,
  noteRevisionSchema,
  noteSchema,
  restoreNotePayloadSchema,
  reviseNotePayloadSchema,
  submitNoteDecisionPayloadSchema,
} from "./index.js";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const now = "2026-08-10T08:00:00.000Z";
const sourceRefs = [
  {
    kind: "full_message" as const,
    sourceMessageId: "msg_noteSource1",
    sourceMessageSha256: shaA,
  },
];
const proposed = {
  title: "工作流笔记",
  kind: "project_idea" as const,
  contentMarkdown: "## 想法\n\n用有限节点组合工作流。",
  tags: [
    { key: "ai", label: "AI" },
    { key: "工作流", label: "工作流" },
  ],
};

describe("Note持久合同", () => {
  it("接受Note、Revision、Candidate和严格绑定的三类Decision", () => {
    expect(
      noteSchema.parse({
        schemaVersion: "note.v1",
        noteId: "nte_note1",
        ownerPrincipalId: "usr_owner1",
        currentRevisionId: "ntr_note1v1",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).noteId,
    ).toBe("nte_note1");

    expect(
      noteRevisionSchema.parse({
        schemaVersion: "note-revision.v1",
        noteRevisionId: "ntr_note1v1",
        noteId: "nte_note1",
        noteRevision: 1,
        ...proposed,
        sourceRefs,
        createdByPrincipalId: "usr_owner1",
        sha256: shaB,
        createdAt: now,
      }).contentMarkdown,
    ).toContain("有限节点");

    expect(
      noteCandidateSchema.parse({
        schemaVersion: "note-candidate.v1",
        noteCandidateId: "ntc_candidate1",
        productRunId: "run_note1",
        candidateSequence: 1,
        proposed,
        sourceRefs,
        status: "under_review",
        sha256: shaA,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).status,
    ).toBe("under_review");

    const decisionBase = {
      schemaVersion: "note-decision.v1" as const,
      noteDecisionId: "ntd_decision1",
      productRunId: "run_note1",
      noteCandidateId: "ntc_candidate1",
      candidateRevision: 1,
      candidateSha256: shaA,
      principalId: "usr_owner1",
      commandId: "cmd_noteDecision1",
      revision: 1 as const,
      createdAt: now,
    };
    expect(noteDecisionSchema.parse({ ...decisionBase, kind: "confirm" }).kind).toBe("confirm");
    expect(
      noteDecisionSchema.parse({
        ...decisionBase,
        kind: "request_revision",
        revisionInstruction: "补充验收条件",
      }).kind,
    ).toBe("request_revision");
    expect(
      noteDecisionSchema.parse({ ...decisionBase, kind: "reject", reason: "不是笔记" }).kind,
    ).toBe("reject");
  });

  it("拒绝unknown字段、错误身份、kind、标题、正文、Tag和来源边界", () => {
    const revision = {
      schemaVersion: "note-revision.v1",
      noteRevisionId: "ntr_note1v1",
      noteId: "nte_note1",
      noteRevision: 1,
      ...proposed,
      sourceRefs,
      createdByPrincipalId: "usr_owner1",
      sha256: shaB,
      createdAt: now,
    };
    expect(() => noteRevisionSchema.parse({ ...revision, providerPayload: {} })).toThrow();
    expect(() => noteRevisionSchema.parse({ ...revision, noteId: "msg_wrong" })).toThrow();
    expect(() => noteRevisionSchema.parse({ ...revision, kind: "reminder" })).toThrow();
    expect(() => noteRevisionSchema.parse({ ...revision, title: "" })).toThrow();
    expect(() =>
      noteRevisionSchema.parse({
        ...revision,
        contentMarkdown: "x".repeat(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS + 1),
      }),
    ).toThrow();
    expect(() =>
      noteRevisionSchema.parse({
        ...revision,
        tags: [
          { key: "ai", label: "AI" },
          { key: "ai", label: "ai" },
        ],
      }),
    ).toThrow("重复Tag key");
    expect(() => noteRevisionSchema.parse({ ...revision, sourceRefs: [] })).toThrow();
    expect(() =>
      noteRevisionSchema.parse({
        ...revision,
        sourceRefs: [
          {
            kind: "utf16_range",
            sourceMessageId: "msg_noteSource1",
            sourceMessageSha256: shaA,
            startUtf16: 2,
            endUtf16: 2,
            selectedTextSha256: shaB,
          },
        ],
      }),
    ).toThrow("起点必须小于终点");
  });

  it("Decision按kind拒绝缺失、错位和内部字段", () => {
    const base = {
      schemaVersion: "note-decision.v1",
      noteDecisionId: "ntd_decision1",
      productRunId: "run_note1",
      noteCandidateId: "ntc_candidate1",
      candidateRevision: 1,
      candidateSha256: shaA,
      principalId: "usr_owner1",
      commandId: "cmd_noteDecision1",
      revision: 1,
      createdAt: now,
    };
    expect(() => noteDecisionSchema.parse({ ...base, kind: "request_revision" })).toThrow();
    expect(() =>
      noteDecisionSchema.parse({ ...base, kind: "confirm", revisionInstruction: "偷偷覆盖" }),
    ).toThrow();
    expect(() =>
      noteDecisionSchema.parse({ ...base, kind: "confirm", workflowHookToken: "secret" }),
    ).toThrow();
  });
});

describe("Note公开API合同", () => {
  it("写命令只接收revision绑定和用户可编辑字段", () => {
    const revisionInput = {
      title: "更新后的笔记",
      kind: "idea" as const,
      contentMarkdown: "正文和 `code`。",
      tagLabels: ["AI", "想法"],
    };
    expect(
      reviseNotePayloadSchema.parse({
        currentRevisionId: "ntr_note1v1",
        currentRevisionSha256: shaA,
        revision: revisionInput,
      }).revision.tagLabels,
    ).toEqual(["AI", "想法"]);
    expect(
      submitNoteDecisionPayloadSchema.parse({
        productRunId: "run_note1",
        noteCandidateId: "ntc_candidate1",
        candidateRevision: 1,
        candidateSha256: shaA,
        kind: "confirm",
        editedProposal: revisionInput,
      }).kind,
    ).toBe("confirm");
    expect(
      archiveNotePayloadSchema.parse({
        currentRevisionId: "ntr_note1v1",
        currentRevisionSha256: shaA,
      }),
    ).toEqual(
      restoreNotePayloadSchema.parse({
        currentRevisionId: "ntr_note1v1",
        currentRevisionSha256: shaA,
      }),
    );
  });

  it("公开DTO含安全Markdown和产品来源，但拒绝Runtime/Provider字段", () => {
    const currentRevision = {
      schemaVersion: NOTE_API_SCHEMA_VERSION,
      noteRevisionId: "ntr_note1v1",
      noteId: "nte_note1",
      noteRevision: 1,
      ...proposed,
      sourceRefs,
      createdByPrincipalId: "usr_owner1",
      sha256: shaA,
      createdAt: now,
    };
    const detail = {
      schemaVersion: NOTE_API_SCHEMA_VERSION,
      noteId: "nte_note1",
      status: "active",
      currentRevision,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      allowedActions: ["revise", "archive"],
    };
    expect(noteDetailDtoSchema.parse(detail).currentRevision.contentMarkdown).toContain("想法");
    expect(() =>
      noteDetailDtoSchema.parse({ ...detail, providerRequestId: "provider-1" }),
    ).toThrow();

    const candidateReview = {
      schemaVersion: NOTE_API_SCHEMA_VERSION,
      noteCandidateId: "ntc_candidate1",
      productRunId: "run_note1",
      candidateSequence: 1,
      proposed,
      sourceRefs,
      status: "under_review",
      sha256: shaA,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      allowedActions: ["confirm", "request_revision", "reject"],
    };
    expect(noteCandidateReviewDtoSchema.parse(candidateReview).status).toBe("under_review");
    expect(() =>
      noteCandidateReviewDtoSchema.parse({ candidateReview, runtimeSessionId: "pi_private" }),
    ).toThrow();
  });
});
