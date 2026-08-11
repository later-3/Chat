import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteCandidateReviewDto, NoteRevisionInput, RunDto } from "@chat/contracts/public";
import { ApiProblemError, apiSubmitNoteDecision } from "../api/client.js";
import {
  clearNoteDraft,
  noteReviewDraftKey,
  pendingNoteDecisionKey,
  readNoteRevisionDraft,
  readPendingNoteDecision,
  writeNoteRevisionDraft,
  writePendingNoteDecision,
} from "../notes/note-drafts.js";
import { useCurrentNoteCandidate } from "../notes/use-notes.js";
import { NoteMarkdown } from "./NoteMarkdown.js";

const KIND_LABEL = {
  idea: "想法",
  project_idea: "项目想法",
  learning: "学习",
  general: "一般笔记",
} as const;

function newCommandId() {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}` as never;
}

function draftFrom(candidate: NoteCandidateReviewDto): NoteRevisionInput {
  return {
    title: candidate.proposed.title,
    kind: candidate.proposed.kind,
    contentMarkdown: candidate.proposed.contentMarkdown,
    tagLabels: candidate.proposed.tags.map((tag) => tag.label),
  };
}

function sameDraft(left: NoteRevisionInput, right: NoteRevisionInput): boolean {
  return (
    left.title === right.title &&
    left.kind === right.kind &&
    left.contentMarkdown === right.contentMarkdown &&
    left.tagLabels.join("\u0000") === right.tagLabels.join("\u0000")
  );
}

function tagsText(value: readonly string[]): string {
  return value.join(", ");
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function decisionProblem(error: ApiProblemError | null): string | null {
  if (error === null) return null;
  if (error.recoveryAction === "retry_same_command")
    return "结果待确认；可用同一命令重试，不会创建第二个决定。";
  if (error.recoveryAction === "rehydrate_and_retry")
    return "候选或运行版本已变化。草稿仍保留，请基于最新候选重新决定。";
  return `决定未提交（${error.code}）。`;
}

/** S2 Inspector内唯一的 Note 审核表单；编辑确认只提交editedProposal，服务端创建successor。 */
export function NoteReviewContent({
  sessionId,
  run,
}: {
  readonly sessionId: string;
  readonly run: RunDto;
}) {
  const candidateQuery = useCurrentNoteCandidate(run.productRunId, run.status === "waiting_human");
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<NoteRevisionInput | null>(null);
  const [instruction, setInstruction] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const initialized = useRef<string | null>(null);
  const reviewKey = noteReviewDraftKey(sessionId, run.productRunId);
  const pendingKey = pendingNoteDecisionKey(sessionId, run.productRunId);
  const candidate = candidateQuery.data;

  useEffect(() => {
    if (candidate === undefined || initialized.current === candidate.noteCandidateId) return;
    initialized.current = candidate.noteCandidateId;
    setDraft(readNoteRevisionDraft(window.localStorage, reviewKey) ?? draftFrom(candidate));
    setError(null);
  }, [candidate, reviewKey]);

  const editable =
    candidate?.status === "under_review" && candidate.allowedActions.includes("confirm");
  const proposed = candidate === undefined ? null : draftFrom(candidate);
  const changed = draft !== null && proposed !== null && !sameDraft(draft, proposed);
  const sourceSummary = useMemo(
    () =>
      candidate?.sourceRefs.map((source) =>
        source.kind === "full_message"
          ? `完整消息 ${source.sourceMessageId}`
          : `消息选区 ${source.sourceMessageId} · UTF-16 ${source.startUtf16}-${source.endUtf16}`,
      ) ?? [],
    [candidate],
  );

  function update(next: NoteRevisionInput) {
    setDraft(next);
    writeNoteRevisionDraft(window.localStorage, reviewKey, next);
  }

  async function submit(kind: "confirm" | "request_revision" | "reject", retry = false) {
    if (candidate === undefined || !editable || submitting) return;
    const pending = retry ? readPendingNoteDecision(window.localStorage, pendingKey) : null;
    const payload =
      pending?.payload ??
      (kind === "confirm"
        ? {
            productRunId: run.productRunId as never,
            noteCandidateId: candidate.noteCandidateId,
            candidateRevision: candidate.revision,
            candidateSha256: candidate.sha256,
            kind,
            ...(changed && draft !== null ? { editedProposal: draft } : {}),
          }
        : kind === "request_revision"
          ? {
              productRunId: run.productRunId as never,
              noteCandidateId: candidate.noteCandidateId,
              candidateRevision: candidate.revision,
              candidateSha256: candidate.sha256,
              kind,
              revisionInstruction: instruction.trim(),
            }
          : {
              productRunId: run.productRunId as never,
              noteCandidateId: candidate.noteCandidateId,
              candidateRevision: candidate.revision,
              candidateSha256: candidate.sha256,
              kind,
              ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
            });
    if (payload.kind === "request_revision" && payload.revisionInstruction.trim() === "") return;
    const commandId = pending?.commandId ?? newCommandId();
    const expectedRevision = pending?.expectedRevision ?? run.revision;
    writePendingNoteDecision(window.localStorage, pendingKey, {
      commandId,
      expectedRevision,
      payload,
    });
    setSubmitting(true);
    setError(null);
    try {
      await apiSubmitNoteDecision({
        productRunId: run.productRunId,
        commandId,
        expectedRevision,
        payload,
      });
      clearNoteDraft(window.localStorage, pendingKey);
      clearNoteDraft(window.localStorage, reviewKey);
      await queryClient.invalidateQueries({
        queryKey: ["chat-note-api.v1", "note-candidate", run.productRunId],
      });
      await queryClient.invalidateQueries({ queryKey: ["real-run", run.productRunId] });
    } catch (caught) {
      setError(caught instanceof ApiProblemError ? caught : null);
    } finally {
      setSubmitting(false);
    }
  }

  if (candidateQuery.isPending)
    return <p className="workflow-inspector-empty">正在读取笔记候选…</p>;
  if (candidateQuery.isError || candidate === undefined) {
    return (
      <p className="workflow-data-inconsistent" role="alert">
        无法读取本次运行的笔记候选；不会用本地草稿代替服务端审核事实。
      </p>
    );
  }
  if (!editable || draft === null) {
    return (
      <p className="workflow-review-resolution">
        该笔记候选已{candidate.status === "confirmed" ? "确认" : "结束"}，不能重新提交决定。
      </p>
    );
  }

  return (
    <section className="note-review-content" aria-label="笔记候选审核">
      <header>
        <span className="eyebrow">候选笔记 · 尚未成为正式笔记</span>
        <p>确认后才会创建不可变的正式 Note Revision；编辑确认会生成新的候选版本。</p>
      </header>
      <label>
        标题
        <input
          value={draft.title}
          maxLength={200}
          onChange={(event) => update({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        类型
        <select
          value={draft.kind}
          onChange={(event) =>
            update({ ...draft, kind: event.target.value as NoteRevisionInput["kind"] })
          }
        >
          {Object.entries(KIND_LABEL).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        标签（逗号分隔；服务端会生成 canonical key）
        <input
          value={tagsText(draft.tagLabels)}
          onChange={(event) => update({ ...draft, tagLabels: parseTags(event.target.value) })}
        />
      </label>
      <label>
        Markdown 正文
        <textarea
          rows={10}
          value={draft.contentMarkdown}
          onChange={(event) => update({ ...draft, contentMarkdown: event.target.value })}
        />
      </label>
      <NoteMarkdown value={draft.contentMarkdown} label="Markdown 源码预览" />
      <section className="note-source-summary" aria-label="候选来源">
        <strong>来源引用</strong>
        <ul>
          {sourceSummary.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <label>
        请求修订说明（仅在请求修订时提交）
        <textarea
          rows={2}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <label>
        拒绝理由（可选）
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {decisionProblem(error) !== null && (
        <p className="error-note" role="alert">
          {decisionProblem(error)}
        </p>
      )}
      <div className="project-candidate-actions">
        <button
          className="small-button"
          type="button"
          disabled={submitting || instruction.trim() === ""}
          onClick={() => void submit("request_revision")}
        >
          请求修订
        </button>
        <button
          className="small-button"
          type="button"
          disabled={submitting}
          onClick={() => void submit("reject")}
        >
          拒绝候选
        </button>
        <button
          className="send-button"
          type="button"
          disabled={submitting}
          onClick={() => void submit("confirm")}
        >
          {submitting ? "正在提交…" : changed ? "确认编辑后的候选" : "确认并创建正式笔记"}
        </button>
      </div>
      {error?.recoveryAction === "retry_same_command" && (
        <button
          className="small-button"
          type="button"
          disabled={submitting}
          onClick={() => void submit("confirm", true)}
        >
          用同一命令重试
        </button>
      )}
    </section>
  );
}
