import { useEffect, useRef, useState } from "react";
import type {
  MessageDto,
  PlanDto,
  ProjectIntakeProposal,
  ProjectManagementProposal,
  RunDto,
  SubmitMessagePayload,
} from "@chat/contracts/public";
import { ApiProblemError } from "../api/client.js";
import { readDraft, writeDraft } from "../drafts/draft-store.js";
import { pendingSendPayload } from "../real/real-storage.js";
import type { RealChainState } from "../real/use-real-chain.js";
import { PlanPanel } from "./PlanPanel.js";
import { ContextPicker } from "./ContextPicker.js";
import { ChatMessageItem } from "./ChatMessageItem.js";
import { useProjectChain } from "../real/use-project-chain.js";
import { ProjectManagementControls } from "./ProjectManagementControls.js";

type ProjectChain = ReturnType<typeof useProjectChain>;

/**
 * 真实规划—确认—执行工作区（M3最小真实前端闭环）。
 *
 * 规则：
 * - 桌面对话 + 工作双栏；375px“对话 / 工作”切换。
 * - 正式Assistant Message只来自Message Query；不从超时、动画、
 *   Workflow返回值或本地状态猜测成功。
 * - Provider/模型由服务端Profile配置，浏览器不选择也不绑定具体实现。
 * - 发送失败保留草稿；Decision失败保留修改意见并展示recoveryAction。
 */

type MobilePane = "chat" | "work";

const RUN_PHASE_LABEL: Record<string, string> = {
  queued: "已接收，排队中",
  planning: "正在规划",
  plan_review: "等待你确认计划",
  executing: "正在执行已批准计划",
  validating: "正在验证结果",
  completed: "已完成",
  rejected: "已拒绝并结束",
};

const RUN_STATUS_LABEL: Record<
  RunDto["status"],
  { label: string; tone: "success" | "warning" | "danger" }
> = {
  pending: { label: "已接收", tone: "warning" },
  running: { label: "进行中", tone: "warning" },
  waiting_human: { label: "等待你的决定", tone: "warning" },
  succeeded: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "danger" },
  outcome_unknown: { label: "结果未知，正在对账", tone: "danger" },
};

function problemText(error: ApiProblemError | null): string | null {
  if (error === null) return null;
  switch (error.recoveryAction) {
    case "retry_same_command":
      return "网络结果未知，请用同一命令重试（不会重复提交）。";
    case "rehydrate_and_retry":
      return "状态已变化，正在为你刷新，请确认后再试。";
    case "contact_support":
      return "服务暂时不可用，请稍后联系支持。";
    default:
      return `操作未完成（${error.code}）。`;
  }
}

function RealChatPane({
  chain,
  sessionId,
  connected,
  onOpenWork,
  projects,
}: {
  chain: RealChainState;
  sessionId: string;
  connected: boolean;
  onOpenWork: () => void;
  projects: ProjectChain;
}) {
  const [draft, setDraft] = useState(() => readDraft(window.localStorage, sessionId));
  const [context, setContext] = useState<SubmitMessagePayload["context"]>(() =>
    chain.pendingSend === null ? undefined : pendingSendPayload(chain.pendingSend).context,
  );
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const [awaitingOutcome, setAwaitingOutcome] = useState(false);
  const [composerMode, setComposerMode] = useState<"task" | "project" | "manage">("task");
  const [managementKind, setManagementKind] = useState<"action" | "decision" | "contribution">(
    "decision",
  );
  const [rootId, setRootId] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const messages: readonly MessageDto[] = chain.messages.data?.items ?? [];
  const sending = chain.sending;
  const projectRootId = rootId || projects.roots.data?.[0]?.rootId || "";
  const canSend =
    connected &&
    draft.trim().length > 0 &&
    !sending &&
    !projects.beginning &&
    !projects.beginningManagement &&
    chain.canStartNewRun &&
    (composerMode === "task" ||
      (composerMode === "project" && projectRootId !== "") ||
      (composerMode === "manage" && projects.activeProjectId !== null));
  const frozenPendingContext =
    chain.pendingSend === null ? undefined : pendingSendPayload(chain.pendingSend).context;

  useEffect(() => {
    if (frozenPendingContext !== undefined) setContext(frozenPendingContext);
  }, [frozenPendingContext]);

  useEffect(() => {
    if (listRef.current !== null) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length]);

  // 发送成功后才清空草稿；失败时草稿与commandId都保留供手动重试
  useEffect(() => {
    if (!awaitingOutcome) return;
    if (chain.sendError !== null) {
      setAwaitingOutcome(false);
      return;
    }
    if (chain.pendingSend === null && !chain.sending) {
      setAwaitingOutcome(false);
      setDraft("");
      // Context 是“本轮”输入，提交成功后不应静默影响下一轮；
      // 当前 Run 已冻结的来源仍由工作区中的 PlanPanel 展示。
      setContext(undefined);
      writeDraft(window.localStorage, sessionId, "");
    }
  }, [awaitingOutcome, chain.pendingSend, chain.sendError, chain.sending, sessionId]);

  function updateDraft(text: string) {
    setDraft(text);
    writeDraft(window.localStorage, sessionId, text);
  }

  function send() {
    if (!canSend) return;
    setContextEditorOpen(false);
    if (composerMode === "project") {
      projects.begin({ text: draft.trim(), rootId: projectRootId });
      updateDraft("");
      onOpenWork();
      return;
    }
    if (composerMode === "manage") {
      projects.beginManagement({ text: draft.trim(), kind: managementKind });
      updateDraft("");
      onOpenWork();
      return;
    }
    setAwaitingOutcome(true);
    chain.sendMessage(draft.trim(), context);
  }

  function retrySend() {
    if (sending) return;
    setAwaitingOutcome(true);
    chain.retryPendingSend();
  }

  return (
    <section className="pane chat-pane" aria-label="持续对话">
      <header className="pane-header">
        <div>
          <h2>真实规划会话</h2>
          <p>规划—确认—执行闭环 · 状态来自服务端</p>
        </div>
        <button className="pane-button" onClick={onOpenWork}>
          查看当前工作
        </button>
      </header>
      <div className="chat-stream">
        {chain.messages.isError && (
          <p className="error-note" role="alert">
            消息读取失败。
            <button className="small-button" onClick={() => void chain.messages.refetch()}>
              重新读取
            </button>
          </p>
        )}
        <ol className="chat-message-list" ref={listRef}>
          {messages.length === 0 && (
            <li className="chat-empty">
              还没有正式消息。发送你的目标后，系统会先规划，再请你确认，最后交付正式结果。
            </li>
          )}
          {messages.map((message) => (
            <ChatMessageItem
              key={message.messageId}
              message={message}
              chain={chain}
              backends={chain.memoryBackends.data ?? []}
            />
          ))}
        </ol>
      </div>
      <div className="composer">
        <div className="composer-inner">
          <div className="composer-mode" role="group" aria-label="消息用途">
            <button
              className={composerMode === "task" ? "small-button active" : "small-button"}
              onClick={() => setComposerMode("task")}
              type="button"
            >
              推进任务
            </button>
            <button
              className={composerMode === "project" ? "small-button active" : "small-button"}
              onClick={() => setComposerMode("project")}
              type="button"
            >
              建立项目
            </button>
            <button
              className={composerMode === "manage" ? "small-button active" : "small-button"}
              onClick={() => setComposerMode("manage")}
              type="button"
              disabled={projects.activeProjectId === null}
            >
              管理项目
            </button>
          </div>
          <div className="model-fixed-label" aria-label="模型配置">
            模型由服务端配置
          </div>
          {composerMode === "task" ? (
            <ContextPicker
              backends={chain.memoryBackends.data ?? []}
              loading={chain.memoryBackends.isPending}
              disabled={sending || chain.pendingSend !== null || !chain.canStartNewRun}
              value={frozenPendingContext ?? context}
              onChange={setContext}
              expanded={contextEditorOpen}
              onExpandedChange={setContextEditorOpen}
            />
          ) : composerMode === "project" ? (
            <label className="project-root-picker">
              <span>真实项目资源</span>
              <select
                aria-label="项目资源"
                value={projectRootId}
                onChange={(event) => setRootId(event.target.value)}
              >
                {(projects.roots.data ?? []).map((root) => (
                  <option key={root.rootId} value={root.rootId}>
                    {root.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="project-root-picker">
              <span>项目管理动作</span>
              <select
                aria-label="项目管理动作"
                value={managementKind}
                onChange={(event) =>
                  setManagementKind(event.target.value as "action" | "decision" | "contribution")
                }
              >
                <option value="decision">记录决定</option>
                <option value="action">新增待办</option>
                <option value="contribution">记录贡献</option>
              </select>
            </label>
          )}
          <div className="composer-row">
            <textarea
              className="composer-input"
              aria-label="消息输入框"
              placeholder={
                composerMode === "project"
                  ? "描述项目目标、范围和当前诉求…"
                  : composerMode === "manage"
                    ? "用自然语言说明要记录的决定、待办或贡献…"
                    : "描述你要推进的事…"
              }
              rows={2}
              value={draft}
              onFocus={() => setContextEditorOpen(false)}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button className="send-button" aria-label="发送" disabled={!canSend} onClick={send}>
              {sending || projects.beginning || projects.beginningManagement
                ? "发送中…"
                : composerMode === "project"
                  ? "生成建项方案"
                  : composerMode === "manage"
                    ? "生成管理方案"
                    : "发送"}
            </button>
          </div>
          {chain.pendingSend !== null && chain.sendError !== null && (
            <p className="composer-offline-note" role="alert">
              {problemText(chain.sendError)}
              <button className="small-button" onClick={retrySend} disabled={sending}>
                用同一命令重试
              </button>
            </p>
          )}
          {!connected && (
            <p className="composer-offline-note">
              当前离线，草稿已保存在此设备，联网后请手动发送。
            </p>
          )}
          {!chain.canStartNewRun && chain.pendingSend === null && !sending && (
            <p className="composer-offline-note">
              当前工作尚未结束；请先在工作区完成计划审核，结束后再发送下一条消息。
            </p>
          )}
          <div aria-live="polite" className="sr-status">
            {sending ? "正在提交到服务端…" : ""}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProjectPanel({ projects }: { projects: ProjectChain }) {
  const candidate = projects.candidate.data;
  const workspace = projects.project.data;
  const [proposal, setProposal] = useState<ProjectIntakeProposal | null>(null);
  const [managementProposal, setManagementProposal] = useState<ProjectManagementProposal | null>(
    null,
  );
  useEffect(() => {
    if (candidate?.candidateKind === "intake" && candidate.status === "under_review") {
      setProposal(candidate.proposal);
    }
    if (candidate?.candidateKind === "management" && candidate.status === "under_review") {
      setManagementProposal(candidate.proposal);
    }
  }, [candidate]);

  return (
    <section className="project-panel" aria-label="项目管理">
      <header className="project-panel-header">
        <div>
          <h3>项目</h3>
          <p>真实资源、参与者、工作、决定与证据</p>
        </div>
        <select
          aria-label="选择项目"
          value={projects.activeProjectId ?? ""}
          onChange={(event) => projects.chooseProject(event.target.value)}
        >
          <option value="">选择项目</option>
          {(projects.projects.data ?? []).map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
      </header>
      {projects.beginError !== null && (
        <p className="error-note">建项请求未能提交，请刷新后重试。</p>
      )}
      {projects.managementBeginError !== null && (
        <p className="error-note">项目管理消息未能生成Candidate，请刷新后重试。</p>
      )}
      {candidate?.candidateKind === "intake" && candidate.status === "queued" && (
        <p className="loading-note">正在理解诉求并观察真实项目资源…</p>
      )}
      {candidate?.candidateKind === "intake" && candidate.status === "failed" && (
        <p className="error-note" role="alert">
          建项理解或资源观察失败（{candidate.failureCode}）。原消息已保留，请修复配置后重新发起。
        </p>
      )}
      {candidate?.candidateKind === "intake" &&
        candidate.status === "under_review" &&
        proposal !== null && (
          <div className="project-candidate-card">
            <span className="eyebrow">建项方案 · 等待你的确认</span>
            <label>
              项目名称
              <input
                value={proposal.name}
                onChange={(event) => setProposal({ ...proposal, name: event.target.value })}
              />
            </label>
            <label>
              项目目标
              <textarea
                rows={3}
                value={proposal.goal}
                onChange={(event) => setProposal({ ...proposal, goal: event.target.value })}
              />
            </label>
            <p>{proposal.method.rationale}</p>
            <dl className="project-evidence-grid">
              <div>
                <dt>分支</dt>
                <dd>{candidate.resource.branch}</dd>
              </div>
              <div>
                <dt>提交</dt>
                <dd>{candidate.resource.headSha.slice(0, 8)}</dd>
              </div>
              <div>
                <dt>文档</dt>
                <dd>{candidate.resource.documentCount}</dd>
              </div>
              <div>
                <dt>脚本</dt>
                <dd>{candidate.resource.scriptCount}</dd>
              </div>
            </dl>
            <div className="project-candidate-actions">
              <button
                className="small-button"
                disabled={projects.deciding}
                onClick={() => projects.revise(proposal)}
              >
                保存修改
              </button>
              <button
                className="small-button"
                disabled={projects.deciding}
                onClick={() => projects.reject("用户拒绝建项方案")}
              >
                拒绝
              </button>
              <button
                className="send-button"
                disabled={projects.deciding}
                onClick={projects.confirm}
              >
                确认建立项目
              </button>
            </div>
          </div>
        )}
      {candidate?.candidateKind === "management" &&
        candidate.status === "under_review" &&
        managementProposal !== null && (
          <div className="project-candidate-card" aria-label="项目管理方案">
            <span className="eyebrow">项目管理方案 · 等待你的确认</span>
            {managementProposal.kind === "decision" ? (
              <>
                <label>
                  决定问题
                  <input
                    value={managementProposal.question}
                    onChange={(event) =>
                      setManagementProposal({
                        ...managementProposal,
                        question: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  最终选择
                  <textarea
                    rows={2}
                    value={managementProposal.choice}
                    onChange={(event) =>
                      setManagementProposal({
                        ...managementProposal,
                        options: [event.target.value],
                        choice: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  决定理由
                  <textarea
                    rows={2}
                    value={managementProposal.rationale}
                    onChange={(event) =>
                      setManagementProposal({
                        ...managementProposal,
                        rationale: event.target.value,
                      })
                    }
                  />
                </label>
              </>
            ) : managementProposal.kind === "action" ? (
              <label>
                待办标题
                <input
                  value={managementProposal.title}
                  onChange={(event) =>
                    setManagementProposal({ ...managementProposal, title: event.target.value })
                  }
                />
              </label>
            ) : (
              <label>
                贡献摘要
                <textarea
                  rows={2}
                  value={managementProposal.summary}
                  onChange={(event) =>
                    setManagementProposal({ ...managementProposal, summary: event.target.value })
                  }
                />
              </label>
            )}
            {projects.managementDecisionError !== null && (
              <p className="error-note">Candidate状态已变化，请刷新后重新确认。</p>
            )}
            <div className="project-candidate-actions">
              <button
                className="small-button"
                disabled={projects.decidingManagement}
                onClick={() => projects.reviseManagement(managementProposal)}
              >
                保存管理方案
              </button>
              <button
                className="small-button"
                disabled={projects.decidingManagement}
                onClick={() => projects.rejectManagement("用户拒绝项目管理方案")}
              >
                拒绝管理方案
              </button>
              <button
                className="send-button"
                disabled={projects.decidingManagement}
                onClick={projects.confirmManagement}
              >
                确认写入项目账本
              </button>
            </div>
          </div>
        )}
      {workspace !== undefined && (
        <div className="project-workspace-card">
          <span className="eyebrow">{workspace.project.stageName}</span>
          <h3>{workspace.project.name}</h3>
          <p>{workspace.project.goal}</p>
          <div className="project-metrics">
            <span>{workspace.project.participantCount} 位参与者</span>
            <span>{workspace.project.activeWorkCount} 项工作</span>
            <span>{workspace.project.openActionCount} 个待办</span>
          </div>
          {projects.manageError !== null && (
            <p className="error-note" role="alert">
              项目操作未提交；服务端状态可能已变化，请刷新后重试。
            </p>
          )}
          <ProjectManagementControls
            workspace={workspace}
            disabled={projects.managing}
            onManage={projects.manage}
          />
          <h4>最近决定</h4>
          <ul className="project-decision-list">
            {workspace.decisions.slice(0, 5).map((decision) => (
              <li key={decision.projectDecisionId}>
                <strong>{decision.question}</strong>
                <span>{decision.choice}</span>
              </li>
            ))}
          </ul>
          <h4>最近贡献</h4>
          <ul className="project-decision-list">
            {workspace.contributions.slice(0, 5).map((contribution) => (
              <li key={contribution.projectContributionId}>
                <strong>{contribution.summary}</strong>
                <span>{contribution.evidenceStatus}</span>
              </li>
            ))}
          </ul>
          <h4>时间线</h4>
          <ul className="project-decision-list">
            {(projects.timeline.data ?? []).slice(0, 8).map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <span>{item.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RunStatusBanner({ run }: { run: RunDto }) {
  const status = RUN_STATUS_LABEL[run.status];
  return (
    <div className="run-status-banner" data-tone={status.tone} role="status">
      <span className="status-dot" aria-hidden="true" />
      <strong>{status.label}</strong>
      <span>{RUN_PHASE_LABEL[run.phase] ?? run.phase}</span>
      {run.failure !== undefined && <span className="run-failure">{run.failure.summary}</span>}
    </div>
  );
}

export function RealWorkspace({ chain, connected }: { chain: RealChainState; connected: boolean }) {
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const sessionId = chain.sessionId;
  const projects = useProjectChain(window.localStorage, sessionId);
  const run = chain.run.data ?? null;
  const plans: readonly PlanDto[] = chain.plans.data ?? [];
  const approval = chain.approval.data ?? null;
  const runProblem = chain.run.error instanceof ApiProblemError ? chain.run.error : null;

  if (chain.bootstrapping) {
    return (
      <main className="workspace-view active" aria-label="真实规划会话">
        <p className="loading-note">正在创建真实会话…</p>
      </main>
    );
  }
  if (chain.bootstrapError !== null || sessionId === null) {
    return (
      <main className="workspace-view active" aria-label="真实规划会话">
        <p className="error-note" role="alert">
          无法连接 Chat 服务创建真实会话。请确认服务已启动后刷新重试。
        </p>
      </main>
    );
  }

  return (
    <main className="workspace-view active session-view" aria-label="真实规划会话">
      <div className="mobile-pane-tabs" role="tablist" aria-label="会话区域">
        <button
          role="tab"
          aria-selected={mobilePane === "chat"}
          className={mobilePane === "chat" ? "active" : ""}
          onClick={() => setMobilePane("chat")}
        >
          对话
        </button>
        <button
          role="tab"
          aria-selected={mobilePane === "work"}
          className={mobilePane === "work" ? "active" : ""}
          onClick={() => setMobilePane("work")}
        >
          工作
        </button>
      </div>
      <div className="session-grid layout-split real-grid" data-mobile-pane={mobilePane}>
        <RealChatPane
          chain={chain}
          sessionId={sessionId}
          connected={connected}
          onOpenWork={() => setMobilePane("work")}
          projects={projects}
        />
        <section className="pane work-pane" aria-label="工作窗口">
          <div className="work-body real-work-body">
            <ProjectPanel projects={projects} />
            {chain.run.isError ? (
              <p className="error-note" role="alert">
                当前工作读取失败（{runProblem?.code ?? "network_unknown"}）。
                <button className="small-button" onClick={() => void chain.run.refetch()}>
                  重新读取
                </button>
                {runProblem?.code === "not_found" && (
                  <button className="small-button" onClick={chain.clearStaleActiveRun}>
                    移除失效的本地定位
                  </button>
                )}
              </p>
            ) : run === null ? (
              <div className="work-empty">
                <h3>当前没有进行中的工作</h3>
                <p>发送一条消息后，这里会显示规划、确认与执行的真实状态。</p>
              </div>
            ) : (
              <>
                <RunStatusBanner run={run} />
                {(chain.plans.isError || chain.approval.isError) && (
                  <p className="error-note" role="alert">
                    计划或审批读取失败，请重新读取后再决定。
                    <button
                      className="small-button"
                      onClick={() => {
                        void chain.plans.refetch();
                        void chain.approval.refetch();
                      }}
                    >
                      重新读取
                    </button>
                  </p>
                )}
                <PlanPanel chain={chain} run={run} plans={plans} approval={approval} />
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
