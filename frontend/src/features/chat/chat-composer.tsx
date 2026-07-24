import { ArrowUp, CircleStop, Workflow as WorkflowIcon, X } from "lucide-react";
import type { FormEventHandler, KeyboardEventHandler } from "react";
import type { RunStatus, RuntimeConnectionStatus } from "../../use-chat-agent";
import type { WorkflowDefinition } from "../workflow/workflow-api";

interface RetrySource {
  forceRestart?: boolean;
  prompt: string;
  runId: string;
}

interface ChatComposerProps {
  activeSessionAvailable: boolean;
  connectionStatus: RuntimeConnectionStatus;
  draft: string;
  onCancelRetry: () => void;
  onChangeDraft: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onStop: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onWorkflowChange: (workflowId: string) => void;
  pendingReview: boolean;
  retrySource: RetrySource | null;
  selectableWorkflows: WorkflowDefinition[];
  selectedWorkflow: WorkflowDefinition;
  sessionLoading: boolean;
  status: RunStatus;
}

const CONNECTION_LABELS: Record<RuntimeConnectionStatus, string> = {
  reconnecting: "正在接回活动Run",
  replaying: "正在补齐事件",
  caught_up: "事件已同步",
  cursor_expired: "游标过期，已按Product事实恢复",
  idle: "",
};

export function ChatComposer({
  activeSessionAvailable,
  connectionStatus,
  draft,
  onCancelRetry,
  onChangeDraft,
  onKeyDown,
  onStop,
  onSubmit,
  onWorkflowChange,
  pendingReview,
  retrySource,
  selectableWorkflows,
  selectedWorkflow,
  sessionLoading,
  status,
}: ChatComposerProps) {
  return (
    <div className="composer-wrap">
      <form className="composer-stack" onSubmit={onSubmit}>
        <div className="workflow-selection-bar">
          <label>
            <WorkflowIcon size={14} />
            <span>Workflow</span>
            <select
              aria-label="选择本轮 Workflow"
              disabled={status !== "idle"}
              onChange={(event) => onWorkflowChange(event.target.value)}
              value={selectedWorkflow.id}
            >
              {selectableWorkflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name} · v{workflow.version}
                </option>
              ))}
            </select>
          </label>
          <small>发送后由此 Workflow 运行</small>
        </div>
        <div className="composer">
          <textarea
            aria-label="发送消息"
            disabled={status !== "idle" || !activeSessionAvailable || sessionLoading}
            onChange={(event) => onChangeDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={pendingReview ? "请先处理当前人工介入请求…" : "输入你想继续推进的事情…"}
            rows={1}
            value={draft}
          />
          {draft && status === "idle" && (
            <button
              aria-label="清空输入"
              className="clear-draft-button"
              onClick={() => onChangeDraft("")}
              type="button"
            >
              <X size={17} />
            </button>
          )}
          {status === "running" ? (
            <button
              aria-label="停止生成"
              className="send-button send-button--stop"
              onClick={onStop}
              type="button"
            >
              <CircleStop size={19} />
            </button>
          ) : (
            <button
              aria-label="发送"
              className="send-button"
              disabled={!draft.trim() || status !== "idle" || !activeSessionAvailable}
              type="submit"
            >
              <ArrowUp size={20} />
            </button>
          )}
        </div>
      </form>
      {retrySource && (
        <div className="retry-context">
          <span>
            {retrySource.forceRestart
              ? "结果未知的旧 Run 不会原样重试；再次发送会创建 Restart。"
              : "正在基于失败 Run 重新执行；修改 Prompt 会记录为 Restart。"}
          </span>
          <button onClick={onCancelRetry} type="button">
            取消关联
          </button>
        </div>
      )}
      <p className="composer-note">
        Enter 发送 · Product Session 保存历史 · 每次模型调用发送前审批
        {connectionStatus !== "idle" && ` · ${CONNECTION_LABELS[connectionStatus]}`}
      </p>
    </div>
  );
}
