import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonical-hash.js";
import {
  assertCanonicalNoteTags,
  assertNoteAggregateIntegrity,
  assertNoteCanRevise,
  assertNoteCandidateIntegrity,
  assertNoteCandidateSuccessor,
  assertNoteCandidateTransition,
  assertNoteCandidateUnchanged,
  assertNoteContentMarkdown,
  assertNoteDecisionBinding,
  assertNoteDraftIntegrity,
  assertNoteLifecycleTransition,
  assertNoteRevisionAppend,
  assertNoteRevisionIntegrity,
  assertNoteRevisionUnchanged,
  computeNoteCandidateSha256,
  computeNoteRevisionSha256,
  computeNoteSourceMessageSha256,
  normalizeNoteTagLabel,
  normalizeNoteTags,
  resolveNoteSourceText,
  type NoteCandidateSnapshotShape,
  type NoteDecisionKindShape,
  type NoteDecisionShape,
  type NoteDraftShape,
  type NoteRevisionSnapshotShape,
  type NoteSourceRefShape,
} from "./note.js";

const now = "2026-08-10T08:00:00.000Z";
const later = "2026-08-10T08:01:00.000Z";
const message = {
  messageId: "msg_noteSource1",
  sessionId: "psn_noteSession1",
  sessionSequence: 1,
  role: "user" as const,
  content: { format: "markdown" as const, text: "项目想法 🚀：做一个可配置工作流。" },
};
const fullMessageSource: NoteSourceRefShape = {
  kind: "full_message",
  sourceMessageId: message.messageId,
  sourceMessageSha256: computeNoteSourceMessageSha256(message),
};
const baseDraft: NoteDraftShape = {
  title: "可配置工作流",
  kind: "project_idea",
  contentMarkdown: "## 想法\n\n使用有限节点和人工审核。",
  tags: normalizeNoteTags(["AI", "工作流"]),
};

function makeRevision(
  input: {
    readonly id?: string;
    readonly noteId?: string;
    readonly sequence?: number;
    readonly draft?: NoteDraftShape;
    readonly sourceRefs?: readonly NoteSourceRefShape[];
    readonly actor?: string;
    readonly createdAt?: string;
  } = {},
): NoteRevisionSnapshotShape {
  const hashInput = {
    noteId: input.noteId ?? "nte_note1",
    noteRevision: input.sequence ?? 1,
    ...(input.draft ?? baseDraft),
    sourceRefs: input.sourceRefs ?? [fullMessageSource],
    createdByPrincipalId: input.actor ?? "usr_owner1",
  };
  return {
    noteRevisionId: input.id ?? "ntr_note1v1",
    ...hashInput,
    sha256: computeNoteRevisionSha256(hashInput),
    createdAt: input.createdAt ?? now,
  };
}

function makeCandidate(
  input: {
    readonly id?: string;
    readonly runId?: string;
    readonly sequence?: number;
    readonly supersedesCandidateId?: string;
    readonly draft?: NoteDraftShape;
    readonly sourceRefs?: readonly NoteSourceRefShape[];
    readonly status?: NoteCandidateSnapshotShape["status"];
    readonly failure?: { readonly code: string; readonly summary: string };
    readonly revision?: number;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } = {},
): NoteCandidateSnapshotShape {
  const immutable = {
    noteCandidateId: input.id ?? "ntc_candidate1",
    productRunId: input.runId ?? "run_note1",
    candidateSequence: input.sequence ?? 1,
    ...(input.supersedesCandidateId === undefined
      ? {}
      : { supersedesCandidateId: input.supersedesCandidateId }),
    proposed: input.draft ?? baseDraft,
    sourceRefs: input.sourceRefs ?? [fullMessageSource],
  };
  return {
    ...immutable,
    status: input.status ?? "under_review",
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    sha256: computeNoteCandidateSha256(immutable),
    revision: input.revision ?? 1,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function makeDecision(
  input: {
    readonly kind?: NoteDecisionKindShape;
    readonly runId?: string;
    readonly candidateId?: string;
    readonly candidateRevision?: number;
    readonly candidateSha256?: string;
    readonly revisionInstruction?: string;
    readonly reason?: string;
  } = {},
): NoteDecisionShape {
  return {
    noteDecisionId: "ntd_decision1",
    productRunId: input.runId ?? "run_note1",
    noteCandidateId: input.candidateId ?? "ntc_candidate1",
    candidateRevision: input.candidateRevision ?? 1,
    candidateSha256: input.candidateSha256 ?? makeCandidate().sha256,
    kind: input.kind ?? "confirm",
    ...(input.revisionInstruction === undefined
      ? {}
      : { revisionInstruction: input.revisionInstruction }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    principalId: "usr_owner1",
    commandId: "cmd_noteDecision1",
    revision: 1,
    createdAt: now,
  };
}

describe("Note Tag和正文边界", () => {
  it("按版本化NFKC、空白折叠和locale无关小写规范中英文Tag", () => {
    expect(normalizeNoteTagLabel("  ＡＩ　研究  ")).toEqual({
      key: "ai 研究",
      label: "AI 研究",
    });
    expect(normalizeNoteTagLabel("Cafe\u0301")).toEqual({ key: "café", label: "Café" });
    expect(normalizeNoteTagLabel("Release").key).toBe(normalizeNoteTagLabel("release").key);
  });

  it("拒绝同key不同label、重复Tag、控制字符和数量上限", () => {
    expect(() => normalizeNoteTags(["ＡＩ", "ai"])).toThrow("key重复");
    expect(() =>
      assertCanonicalNoteTags([
        { key: "ai", label: "AI" },
        { key: "ai", label: "ai" },
      ]),
    ).toThrow("key重复");
    expect(() => normalizeNoteTagLabel("bad\u0000tag")).toThrow("控制字符");
    expect(() =>
      normalizeNoteTags(Array.from({ length: 21 }, (_, index) => `tag-${index}`)),
    ).toThrow("数量超过上限");
  });

  it("Markdown支持链接、代码和原始文本，但明确拒绝空白、控制字符和超限", () => {
    expect(() =>
      assertNoteContentMarkdown(
        "[链接](https://example.com)\n\n```ts\nconst x = 1;\n```\n<script>x</script>",
      ),
    ).not.toThrow();
    expect(() => assertNoteContentMarkdown(" \n\t ")).toThrow("可见内容");
    expect(() => assertNoteContentMarkdown("正文\u0000")).toThrow("控制字符");
    expect(() => assertNoteContentMarkdown("x".repeat(100_000))).not.toThrow();
    expect(() => assertNoteContentMarkdown("x".repeat(100_001))).toThrow("超过上限");
  });
});

describe("Note来源选择", () => {
  it("从权威Message解析完整正文和UTF-16 Emoji选区", () => {
    expect(resolveNoteSourceText({ message, sourceRef: fullMessageSource })).toBe(
      message.content.text,
    );
    const startUtf16 = message.content.text.indexOf("🚀");
    const selectedText = message.content.text.slice(startUtf16, startUtf16 + 2);
    expect(
      resolveNoteSourceText({
        message,
        sourceRef: {
          kind: "utf16_range",
          sourceMessageId: message.messageId,
          sourceMessageSha256: computeNoteSourceMessageSha256(message),
          startUtf16,
          endUtf16: startUtf16 + 2,
          selectedTextSha256: sha256Hex(selectedText),
        },
      }),
    ).toBe("🚀");
  });

  it("拒绝陈旧Message、选区Hash、越界和切开代理对", () => {
    const startUtf16 = message.content.text.indexOf("🚀");
    const base = {
      kind: "utf16_range" as const,
      sourceMessageId: message.messageId,
      sourceMessageSha256: computeNoteSourceMessageSha256(message),
      startUtf16,
      endUtf16: startUtf16 + 2,
      selectedTextSha256: sha256Hex("🚀"),
    };
    expect(() =>
      resolveNoteSourceText({
        message,
        sourceRef: { ...base, sourceMessageSha256: "a".repeat(64) },
      }),
    ).toThrow("Message版本已变化");
    expect(() =>
      resolveNoteSourceText({
        message,
        sourceRef: { ...base, selectedTextSha256: "b".repeat(64) },
      }),
    ).toThrow("选区内容已变化");
    expect(() =>
      resolveNoteSourceText({ message, sourceRef: { ...base, endUtf16: 99_999 } }),
    ).toThrow("范围无效");
    expect(() =>
      resolveNoteSourceText({ message, sourceRef: { ...base, endUtf16: startUtf16 + 1 } }),
    ).toThrow("范围无效");
  });
});

describe("Note Revision不可变事实", () => {
  it("Hash对正文、kind、Tag和来源敏感，但createdAt不参与", () => {
    const revision = makeRevision();
    const changed = (patch: Partial<NoteDraftShape>, sourceRefs = revision.sourceRefs) =>
      computeNoteRevisionSha256({
        noteId: revision.noteId,
        noteRevision: revision.noteRevision,
        title: patch.title ?? revision.title,
        kind: patch.kind ?? revision.kind,
        contentMarkdown: patch.contentMarkdown ?? revision.contentMarkdown,
        tags: patch.tags ?? revision.tags,
        sourceRefs,
        createdByPrincipalId: revision.createdByPrincipalId,
      });
    expect(changed({ contentMarkdown: `${revision.contentMarkdown}\n更多` })).not.toBe(
      revision.sha256,
    );
    expect(changed({ kind: "learning" })).not.toBe(revision.sha256);
    expect(changed({ tags: normalizeNoteTags(["different"]) })).not.toBe(revision.sha256);
    expect(
      changed({}, [
        {
          ...fullMessageSource,
          sourceMessageSha256: "c".repeat(64),
        },
      ]),
    ).not.toBe(revision.sha256);
    expect(makeRevision({ createdAt: later }).sha256).toBe(revision.sha256);
  });

  it("只允许同Note顺序追加，并证明历史Revision逐字段不可变", () => {
    const first = makeRevision();
    const second = makeRevision({ id: "ntr_note1v2", sequence: 2, createdAt: later });
    expect(() => assertNoteRevisionAppend({ current: first, next: second })).not.toThrow();
    expect(() =>
      assertNoteRevisionAppend({
        current: first,
        next: makeRevision({ id: "ntr_note1v3", sequence: 3 }),
      }),
    ).toThrow("严格递增一版");
    expect(() =>
      assertNoteRevisionUnchanged({
        original: first,
        persisted: { ...first, contentMarkdown: "被覆盖的正文" },
      }),
    ).toThrow("不可修改");
  });

  it("currentRevision始终指向最高版本；归档保留历史且只有恢复可写", () => {
    const first = makeRevision();
    const second = makeRevision({ id: "ntr_note1v2", sequence: 2, createdAt: later });
    const note = {
      noteId: "nte_note1",
      ownerPrincipalId: "usr_owner1",
      sourceCandidateId: "ntc_candidate1",
      currentRevisionId: second.noteRevisionId,
      status: "active" as const,
      revision: 2,
      createdAt: now,
      updatedAt: later,
    };
    expect(() => assertNoteAggregateIntegrity({ note, revisions: [second, first] })).not.toThrow();
    expect(() =>
      assertNoteAggregateIntegrity({
        note: { ...note, currentRevisionId: first.noteRevisionId },
        revisions: [first, second],
      }),
    ).toThrow("最高已提交Revision");
    expect(() => assertNoteLifecycleTransition("active", "archived")).not.toThrow();
    expect(() => assertNoteLifecycleTransition("archived", "active")).not.toThrow();
    expect(() => assertNoteLifecycleTransition("archived", "archived")).toThrow();
    expect(() => assertNoteCanRevise({ status: "archived" })).toThrow("只能恢复");
  });
});

describe("Note Candidate与Decision绑定", () => {
  it("Candidate内容Hash与完整性稳定，状态变化不能覆盖候选正文", () => {
    const current = makeCandidate();
    const confirmed: NoteCandidateSnapshotShape = {
      ...current,
      status: "confirmed",
      revision: 2,
      updatedAt: later,
    };
    expect(() => assertNoteCandidateIntegrity(current)).not.toThrow();
    expect(() => assertNoteCandidateTransition({ current, next: confirmed })).not.toThrow();

    const changedDraft = { ...baseDraft, contentMarkdown: "偷偷覆盖" };
    const changed = makeCandidate({
      draft: changedDraft,
      status: "confirmed",
      revision: 2,
      updatedAt: later,
    });
    expect(() => assertNoteCandidateTransition({ current, next: changed })).toThrow("不能覆盖");
    expect(() =>
      assertNoteCandidateUnchanged({
        original: current,
        persisted: { ...current, updatedAt: later },
      }),
    ).toThrow("不能原地覆盖");
  });

  it("终态Candidate不能重开，successor严格同Run、顺序和旧身份", () => {
    const requested = makeCandidate({
      status: "revision_requested",
      revision: 2,
      updatedAt: later,
    });
    const successor = makeCandidate({
      id: "ntc_candidate2",
      sequence: 2,
      supersedesCandidateId: requested.noteCandidateId,
      updatedAt: "2026-08-10T08:02:00.000Z",
    });
    expect(() =>
      assertNoteCandidateSuccessor({ current: requested, next: successor }),
    ).not.toThrow();
    expect(() =>
      assertNoteCandidateSuccessor({
        current: requested,
        next: makeCandidate({
          id: "ntc_candidate2",
          runId: "run_other",
          sequence: 2,
          supersedesCandidateId: requested.noteCandidateId,
        }),
      }),
    ).toThrow("不能跨Product Run");
    expect(() =>
      assertNoteCandidateTransition({
        current: requested,
        next: {
          ...requested,
          status: "under_review",
          revision: 3,
          updatedAt: "2026-08-10T08:03:00.000Z",
        },
      }),
    ).toThrow("不允许revision_requested -> under_review");
  });

  it("接受精确绑定的三类Decision，拒绝旧Candidate、跨Run、旧revision/hash和错位说明", () => {
    const candidate = makeCandidate();
    expect(() => assertNoteDecisionBinding({ candidate, decision: makeDecision() })).not.toThrow();
    expect(() =>
      assertNoteDecisionBinding({
        candidate,
        decision: makeDecision({ kind: "request_revision", revisionInstruction: "补充来源" }),
      }),
    ).not.toThrow();
    expect(() =>
      assertNoteDecisionBinding({
        candidate,
        decision: makeDecision({ kind: "reject", reason: "不是长期笔记" }),
      }),
    ).not.toThrow();

    expect(() =>
      assertNoteDecisionBinding({
        candidate: makeCandidate({ status: "confirmed", revision: 2 }),
        decision: makeDecision(),
      }),
    ).toThrow("不能再次决定");
    expect(() =>
      assertNoteDecisionBinding({ candidate, decision: makeDecision({ runId: "run_other" }) }),
    ).toThrow("不属于指定Candidate");
    expect(() =>
      assertNoteDecisionBinding({ candidate, decision: makeDecision({ candidateRevision: 2 }) }),
    ).toThrow("已过期");
    expect(() =>
      assertNoteDecisionBinding({
        candidate,
        decision: makeDecision({ candidateSha256: "f".repeat(64) }),
      }),
    ).toThrow("已过期");
    expect(() =>
      assertNoteDecisionBinding({
        candidate,
        decision: makeDecision({ kind: "request_revision" }),
      }),
    ).toThrow("必须说明修改要求");
    expect(() =>
      assertNoteDecisionBinding({
        candidate,
        decision: makeDecision({ kind: "confirm", revisionInstruction: "错误字段" }),
      }),
    ).toThrow("只有request_revision");
  });

  it("错误kind、非canonical title和伪造Hash均失败关闭", () => {
    expect(() =>
      assertNoteDraftIntegrity({ ...baseDraft, kind: "reminder" as NoteDraftShape["kind"] }),
    ).toThrow("未知Note kind");
    expect(() => assertNoteDraftIntegrity({ ...baseDraft, title: "  未规范  " })).toThrow(
      "trim后的规范值",
    );
    expect(() =>
      assertNoteRevisionIntegrity({ ...makeRevision(), sha256: "0".repeat(64) }),
    ).toThrow("Hash不匹配");
  });
});
