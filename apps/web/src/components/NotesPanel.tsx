import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteDetailDto, NoteRevisionInput } from "@chat/contracts/public";
import { ApiProblemError, apiArchiveNote, apiRestoreNote, apiReviseNote } from "../api/client.js";
import {
  clearNoteDraft,
  noteRevisionDraftKey,
  pendingNoteMutationKey,
  readNoteRevisionDraft,
  readPendingNoteMutation,
  writeNoteRevisionDraft,
  writePendingNoteMutation,
  type PendingNoteMutation,
} from "../notes/note-drafts.js";
import { useNote, useNoteHistory, useNotes } from "../notes/use-notes.js";
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

function toDraft(note: NoteDetailDto): NoteRevisionInput {
  const revision = note.currentRevision;
  return {
    title: revision.title,
    kind: revision.kind,
    contentMarkdown: revision.contentMarkdown,
    tagLabels: revision.tags.map((tag) => tag.label),
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

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function NoteDetail({
  noteId,
  sessionId,
  onBack,
}: {
  readonly noteId: string;
  readonly sessionId: string;
  readonly onBack: () => void;
}) {
  const note = useNote(noteId);
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const history = useNoteHistory({
    noteId,
    ...(historyCursor === undefined ? {} : { cursor: historyCursor }),
  });
  const [draft, setDraft] = useState<NoteRevisionInput | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [saving, setSaving] = useState(false);
  const key = noteRevisionDraftKey(sessionId, noteId);
  const pendingKey = pendingNoteMutationKey(sessionId, noteId);
  const [pendingMutation, setPendingMutation] = useState<PendingNoteMutation | null>(() =>
    readPendingNoteMutation(window.localStorage, pendingKey),
  );

  useEffect(() => {
    if (note.data === undefined) return;
    setDraft(readNoteRevisionDraft(window.localStorage, key) ?? toDraft(note.data));
  }, [key, note.data?.currentRevision.noteRevisionId]);

  if (note.isPending) return <p className="loading-note">正在读取正式笔记…</p>;
  if (note.isError || note.data === undefined)
    return (
      <p className="error-note" role="alert">
        笔记不可读取或你没有查看权限。
        <button className="small-button" onClick={onBack}>
          返回列表
        </button>
      </p>
    );
  const item = note.data;
  const allowed = item.allowedActions as readonly string[];
  const current = item.currentRevision;
  const currentDraft = toDraft(item);
  const update = (next: NoteRevisionInput) => {
    setDraft(next);
    writeNoteRevisionDraft(window.localStorage, key, next);
  };
  function settleMutationFailure(caught: unknown) {
    const problem = caught instanceof ApiProblemError ? caught : null;
    setError(problem);
    if (problem !== null && problem.recoveryAction !== "retry_same_command") {
      clearNoteDraft(window.localStorage, pendingKey);
      setPendingMutation(null);
      if (problem.recoveryAction === "rehydrate_and_retry") {
        void queryClient.invalidateQueries({ queryKey: ["chat-note-api.v1", "note", noteId] });
      }
    }
  }

  async function save(retry = false) {
    if (draft === null || saving || !allowed.includes("revise")) return;
    const existing = retry ? pendingMutation : null;
    if ((!retry && pendingMutation !== null) || (existing !== null && existing.kind !== "revise")) {
      return;
    }
    const mutation: PendingNoteMutation = existing ?? {
      kind: "revise",
      commandId: newCommandId(),
      expectedRevision: item.revision,
      payload: {
        currentRevisionId: current.noteRevisionId,
        currentRevisionSha256: current.sha256,
        revision: draft,
      },
    };
    writePendingNoteMutation(window.localStorage, pendingKey, mutation);
    setPendingMutation(mutation);
    setSaving(true);
    setError(null);
    try {
      await apiReviseNote({
        noteId: item.noteId,
        commandId: mutation.commandId,
        expectedRevision: mutation.expectedRevision,
        payload: mutation.payload,
      });
      clearNoteDraft(window.localStorage, pendingKey);
      setPendingMutation(null);
      clearNoteDraft(window.localStorage, key);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["chat-note-api.v1", "note", noteId] });
      await queryClient.invalidateQueries({ queryKey: ["chat-note-api.v1", "notes"] });
    } catch (caught) {
      settleMutationFailure(caught);
    } finally {
      setSaving(false);
    }
  }
  async function lifecycle(action: "archive" | "restore", retry = false) {
    if (saving) return;
    const existing = retry ? pendingMutation : null;
    if ((!retry && pendingMutation !== null) || (existing !== null && existing.kind !== action)) {
      return;
    }
    const mutation: PendingNoteMutation = existing ?? {
      kind: action,
      commandId: newCommandId(),
      expectedRevision: item.revision,
      payload: {
        currentRevisionId: current.noteRevisionId,
        currentRevisionSha256: current.sha256,
      },
    };
    writePendingNoteMutation(window.localStorage, pendingKey, mutation);
    setPendingMutation(mutation);
    setSaving(true);
    setError(null);
    try {
      const input = {
        noteId: item.noteId,
        commandId: mutation.commandId,
        expectedRevision: mutation.expectedRevision,
        payload: mutation.payload,
      };
      await (action === "archive" ? apiArchiveNote(input) : apiRestoreNote(input));
      clearNoteDraft(window.localStorage, pendingKey);
      setPendingMutation(null);
      await queryClient.invalidateQueries({ queryKey: ["chat-note-api.v1", "note", noteId] });
      await queryClient.invalidateQueries({ queryKey: ["chat-note-api.v1", "notes"] });
    } catch (caught) {
      settleMutationFailure(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="notes-detail" aria-label="笔记详情">
      <header className="notes-detail-header">
        <button className="small-button" onClick={onBack}>
          返回笔记
        </button>
        <span className="eyebrow">
          {item.status === "archived" ? "已归档正式笔记" : "正式笔记"}
        </span>
        <h3>{current.title}</h3>
        <p>
          Revision {current.noteRevision} · 更新于 {formatTime(item.updatedAt)}
        </p>
      </header>
      <div className="note-tags">
        {current.tags.map((tag) => (
          <span key={tag.key} title={tag.key}>
            #{tag.label}
          </span>
        ))}
      </div>
      <NoteMarkdown value={current.contentMarkdown} />
      <section className="note-source-summary" aria-label="来源引用">
        <strong>来源引用</strong>
        <ul>
          {current.sourceRefs.map((source) => (
            <li key={`${source.sourceMessageId}:${source.kind}`}>
              {source.kind === "full_message"
                ? `完整消息 ${source.sourceMessageId}`
                : `消息选区 ${source.sourceMessageId} · UTF-16 ${source.startUtf16}-${source.endUtf16}`}
            </li>
          ))}
        </ul>
        <p>来源正文仍受原消息权限控制；这里不复制正文。</p>
      </section>
      {error !== null && (
        <p className="error-note" role="alert">
          {error.recoveryAction === "rehydrate_and_retry"
            ? "版本冲突：已保留本地草稿，请阅读新版本后再提交。"
            : error.recoveryAction === "retry_same_command"
              ? "命令结果待确认；请用同一命令重试。"
              : `操作未完成（${error.code}）。`}
        </p>
      )}
      {pendingMutation !== null && (
        <div className="workflow-composer-note" role="status">
          <span>
            存在结果待确认的
            {pendingMutation.kind === "revise"
              ? "修订"
              : pendingMutation.kind === "archive"
                ? "归档"
                : "恢复"}
            命令；不会生成新的命令身份。
          </span>
          <button
            className="small-button"
            type="button"
            disabled={saving}
            onClick={() =>
              pendingMutation.kind === "revise"
                ? void save(true)
                : void lifecycle(pendingMutation.kind, true)
            }
          >
            用同一命令重试
          </button>
        </div>
      )}
      {allowed.includes("revise") && (
        <section className="note-edit-section" aria-label="修订正式笔记">
          <div>
            <h4>修订</h4>
            <button className="small-button" onClick={() => setEditing((value) => !value)}>
              {editing ? "取消编辑" : "编辑当前 Revision"}
            </button>
          </div>
          {editing && draft !== null && (
            <div className="note-edit-form">
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
                标签（逗号分隔）
                <input
                  value={draft.tagLabels.join(", ")}
                  onChange={(event) =>
                    update({ ...draft, tagLabels: parseTags(event.target.value) })
                  }
                />
              </label>
              <label>
                Markdown 正文
                <textarea
                  rows={9}
                  value={draft.contentMarkdown}
                  onChange={(event) => update({ ...draft, contentMarkdown: event.target.value })}
                />
              </label>
              {!sameDraft(draft, currentDraft) && (
                <p className="workflow-composer-note">保存会创建新 Revision，原版本保持可追溯。</p>
              )}
              <button
                className="send-button"
                disabled={saving || pendingMutation !== null || sameDraft(draft, currentDraft)}
                onClick={() => void save()}
              >
                {saving ? "正在保存…" : "保存新 Revision"}
              </button>
            </div>
          )}
        </section>
      )}
      <div className="project-candidate-actions">
        {allowed.includes("archive") && (
          <button
            className="small-button"
            disabled={saving || pendingMutation !== null}
            onClick={() => void lifecycle("archive")}
          >
            归档笔记
          </button>
        )}
        {allowed.includes("restore") && (
          <button
            className="send-button"
            disabled={saving || pendingMutation !== null}
            onClick={() => void lifecycle("restore")}
          >
            恢复笔记
          </button>
        )}
      </div>
      <section className="note-history" aria-label="修订历史">
        <button
          className="small-button"
          aria-expanded={historyOpen}
          onClick={() => {
            setHistoryOpen((value) => !value);
            setHistoryCursor(undefined);
          }}
        >
          {historyOpen ? "收起修订历史" : "展开修订历史"}
        </button>
        {historyOpen &&
          (history.isPending ? (
            <p>正在读取历史…</p>
          ) : history.isError ? (
            <p className="error-note">修订历史读取失败。</p>
          ) : (
            <>
              <ol>
                {(history.data?.items ?? []).map((revision) => (
                  <li key={revision.noteRevisionId}>
                    <strong>
                      Revision {revision.noteRevision} · {revision.title}
                    </strong>
                    <span>
                      {KIND_LABEL[revision.kind]} · {formatTime(revision.createdAt)}
                    </span>
                    <div className="note-tags">
                      {revision.tags.map((tag) => (
                        <span key={tag.key}>#{tag.label}</span>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              {history.data?.nextCursor !== undefined && (
                <button
                  className="small-button"
                  onClick={() => setHistoryCursor(history.data?.nextCursor)}
                >
                  加载更早版本
                </button>
              )}
            </>
          ))}
      </section>
    </section>
  );
}

export function NotesPanel({ sessionId }: { readonly sessionId: string }) {
  const [kind, setKind] = useState<"" | "idea" | "project_idea" | "learning" | "general">("");
  const [tagKey, setTagKey] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const query = useNotes({
    ...(cursor === undefined ? {} : { cursor }),
    ...(kind === "" ? {} : { kind }),
    ...(tagKey.trim() === "" ? {} : { tagKey: tagKey.trim() }),
    status,
  });
  const items = query.data?.items ?? [];
  const filterSummary = useMemo(
    () =>
      `${status === "active" ? "活跃" : "已归档"}${kind === "" ? "" : ` · ${KIND_LABEL[kind]}`}${tagKey.trim() === "" ? "" : ` · #${tagKey.trim()}`}`,
    [kind, status, tagKey],
  );
  if (selectedNoteId !== null)
    return (
      <NoteDetail
        noteId={selectedNoteId}
        sessionId={sessionId}
        onBack={() => setSelectedNoteId(null)}
      />
    );
  return (
    <section className="notes-panel" aria-label="笔记">
      <header>
        <div>
          <span className="eyebrow">Notes</span>
          <h3>正式笔记</h3>
          <p>只有已确认的 Note Revision 才会出现在这里；候选仍在运行审核中。</p>
        </div>
      </header>
      <form
        className="notes-filter"
        onSubmit={(event) => {
          event.preventDefault();
          setCursor(undefined);
        }}
      >
        <label>
          状态
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as "active" | "archived");
              setCursor(undefined);
            }}
          >
            <option value="active">活跃</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label>
          类型
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
              setCursor(undefined);
            }}
          >
            <option value="">全部类型</option>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag key
          <input
            value={tagKey}
            placeholder="canonical key"
            onChange={(event) => setTagKey(event.target.value)}
          />
        </label>
        <button className="small-button" type="submit">
          应用筛选
        </button>
      </form>
      <p className="workflow-composer-note">当前筛选：{filterSummary}</p>
      {query.isPending ? (
        <p className="loading-note">正在读取笔记…</p>
      ) : query.isError ? (
        <p className="error-note" role="alert">
          笔记列表读取失败。
          <button className="small-button" onClick={() => void query.refetch()}>
            重新读取
          </button>
        </p>
      ) : items.length === 0 ? (
        <div className="work-empty">
          <h4>还没有匹配的正式笔记</h4>
          <p>从对话选择 Note Capture 后，候选经人工确认或允许的 Policy auto 后才会出现。</p>
        </div>
      ) : (
        <ol className="notes-list">
          {items.map((item) => (
            <li key={item.noteId}>
              <button className="note-card" onClick={() => setSelectedNoteId(item.noteId)}>
                <span className="eyebrow">
                  {item.status === "archived" ? "已归档" : KIND_LABEL[item.currentRevision.kind]}
                </span>
                <strong>{item.currentRevision.title}</strong>
                <span>
                  {item.currentRevision.sourceCount} 个来源 · {formatTime(item.updatedAt)}
                </span>
                <span className="note-tags">
                  {item.currentRevision.tags.map((tag) => (
                    <em key={tag.key}>#{tag.label}</em>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {query.data?.nextCursor !== undefined && (
        <button className="small-button" onClick={() => setCursor(query.data?.nextCursor)}>
          加载下一页
        </button>
      )}
    </section>
  );
}
