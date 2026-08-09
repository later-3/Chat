import type {
  WorkflowDefinitionDetailDto,
  WorkflowDefinitionPublishedDto,
} from "@chat/contracts/public";
import type { DesignerConflictState } from "./designer-utils.js";
import { operationErrorText } from "./designer-utils.js";

export function DesignerToolbar({
  detail,
  definitions,
  definitionId,
  dirty,
  editing,
  saveBlocked,
  validationPending,
  serverValid,
  busy,
  canUndo,
  canRedo,
  notice,
  onDefinitionChange,
  onUndo,
  onRedo,
  onValidate,
  onSave,
  onPublish,
  onArchive,
}: {
  readonly detail: WorkflowDefinitionDetailDto | undefined;
  readonly definitions: readonly WorkflowDefinitionPublishedDto[];
  readonly definitionId: string;
  readonly dirty: boolean;
  readonly editing: boolean;
  readonly saveBlocked: boolean;
  readonly validationPending: boolean;
  readonly serverValid: boolean;
  readonly busy: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly notice: string | null;
  readonly onDefinitionChange: (definitionId: string) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onValidate: () => void;
  readonly onSave: () => void;
  readonly onPublish: () => void;
  readonly onArchive: () => void;
}) {
  const allowed = detail?.compatibility === "editable" ? detail.allowedActions : [];
  const canLifecycle =
    detail?.ownerKind === "principal" &&
    allowed.some((action) => action === "archive" || action === "restore");
  return (
    <header className="workflow-designer-toolbar">
      <div>
        <span className="eyebrow">受约束 Definition Designer</span>
        <h2>{detail?.title ?? "选择一个工作流"}</h2>
        <p>拖放只产生语义操作；没有自由连线、代码、HTTP 或 JSON 编辑器。</p>
      </div>
      <label>
        Definition
        <select
          aria-label="选择要设计的 Definition"
          value={definitionId}
          onChange={(event) => onDefinitionChange(event.target.value)}
        >
          {definitions.map((definition) => (
            <option key={definition.workflowDefinitionId} value={definition.workflowDefinitionId}>
              {definition.title} · {definition.ownerKind === "system" ? "系统只读" : "我的"}
            </option>
          ))}
          {detail !== undefined &&
            !definitions.some(
              (candidate) => candidate.workflowDefinitionId === detail.workflowDefinitionId,
            ) && <option value={detail.workflowDefinitionId}>{detail.title} · 草稿</option>}
        </select>
      </label>
      <div className="designer-toolbar-actions" role="toolbar" aria-label="设计器操作">
        <button type="button" disabled={!canUndo || !editing} onClick={onUndo}>
          撤销
        </button>
        <button type="button" disabled={!canRedo || !editing} onClick={onRedo}>
          重做
        </button>
        <button type="button" disabled={!editing || validationPending} onClick={onValidate}>
          {validationPending ? "校验中…" : "服务端校验"}
        </button>
        <button
          type="button"
          disabled={!editing || !dirty || saveBlocked || busy !== null}
          onClick={onSave}
        >
          保存草稿
        </button>
        <button
          type="button"
          disabled={
            !editing ||
            dirty ||
            !serverValid ||
            detail?.currentDraftRevision === undefined ||
            !allowed.includes("publish") ||
            busy !== null
          }
          onClick={onPublish}
        >
          发布
        </button>
        <button
          type="button"
          disabled={!canLifecycle || detail?.publishedRevision === undefined || busy !== null}
          onClick={onArchive}
        >
          {detail?.status === "archived" ? "恢复" : "归档"}
        </button>
      </div>
      <div className="designer-state-line" role="status">
        {dirty ? "有未保存语义修改" : "已与服务器基线一致"}
        {notice === null ? "" : ` · ${notice}`}
      </div>
    </header>
  );
}

export function DesignerCopyPanel({
  detail,
  title,
  description,
  busy,
  onTitleChange,
  onDescriptionChange,
  onCopy,
}: {
  readonly detail: WorkflowDefinitionDetailDto | undefined;
  readonly title: string;
  readonly description: string;
  readonly busy: string | null;
  readonly onTitleChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onCopy: () => void;
}) {
  if (detail?.ownerKind !== "system" || detail.publishedRevision === undefined) return null;
  return (
    <section className="designer-copy-panel" aria-label="复制系统 Definition">
      <strong>System Definition 只读</strong>
      <label>
        副本名称
        <input value={title} onChange={(event) => onTitleChange(event.target.value)} />
      </label>
      <label>
        说明
        <input value={description} onChange={(event) => onDescriptionChange(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={title.trim() === "" || description.trim() === "" || busy !== null}
        onClick={onCopy}
      >
        创建可编辑副本
      </button>
    </section>
  );
}

export function DesignerConflictPanel({
  conflict,
  busy,
  onReload,
  onReapply,
  onCopy,
}: {
  readonly conflict: DesignerConflictState | null;
  readonly busy: string | null;
  readonly onReload: () => void;
  readonly onReapply: () => void;
  readonly onCopy: () => void;
}) {
  if (conflict === null) return null;
  return (
    <section className="designer-conflict" role="alert" aria-label="Definition 版本冲突">
      <h3>服务器版本已变化</h3>
      <p>本地 {conflict.operations.length} 个语义操作仍保留；不会做文本 JSON merge。</p>
      {conflict.failedOperation !== undefined && (
        <p>
          第 {conflict.failedOperation.index + 1} 个操作失效：
          {operationErrorText(conflict.failedOperation.code)}
        </p>
      )}
      <div>
        <button type="button" onClick={onReload}>
          查看并加载最新版本
        </button>
        <button type="button" onClick={onReapply}>
          基于最新版本重应用
        </button>
        <button
          type="button"
          disabled={conflict.latest.publishedRevision === undefined || busy !== null}
          onClick={onCopy}
        >
          另存为副本并重应用
        </button>
      </div>
    </section>
  );
}
