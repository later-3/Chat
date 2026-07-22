import type { Message } from "@ag-ui/core";
import {
  Archive,
  ArrowUp,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Menu,
  MessageSquarePlus,
  PanelRightOpen,
  Settings2,
  Sparkles,
  RotateCcw,
  UserRound,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ModelCallReview } from "./model-call-review";
import { AgentPage } from "./agent-page";
import {
  ConfigurationCenter,
  type ConfigurationTab,
} from "./configuration-center";
import type { ModelProviderOption } from "./use-chat-agent";
import {
  createSession,
  getSession,
  getSessionMessages,
  getSessionRuns,
  listSessions,
  type ProductRun,
  type ProductSession,
  toAguiMessages,
  updateSession,
} from "./session-api";
import { useChatAgent } from "./use-chat-agent";
import { listWorkflows, workflowEndpointUrl, type WorkflowDefinition } from "./workflow-api";
import { WorkflowPage } from "./workflow-page";
import { CHAT_WORKFLOW } from "./workflow-run-projection";
import { WorkflowRunView } from "./workflow-run-view";
import { ToolPage } from "./tool-page";
import { HitlPage } from "./hitl-page";
import { ProductDecisionReview } from "./product-decision-review";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

interface Health {
  status: string;
  service: string;
  version: string;
  agent_framework: string;
  protocol: string;
  runtime_mode: "bootstrap" | "model";
  model: string | null;
  model_call_approval: "every_call" | "not_applicable";
  product_sessions: "sqlite";
}

interface ProviderCatalogResponse {
  default_provider_id: string | null;
  default_model: string | null;
  providers: ModelProviderOption[];
}

function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const text = getMessageText(message);
  if (!text || !["user", "assistant"].includes(message.role)) return null;

  return (
    <article className={`message-row ${isUser ? "message-row--user" : ""}`}>
      <div className={`avatar ${isUser ? "avatar--user" : "avatar--assistant"}`}>
        {isUser ? <UserRound size={16} /> : <Sparkles size={16} />}
      </div>
      <div className={`message ${isUser ? "message--user" : "message--assistant"}`}><p>{text}</p></div>
    </article>
  );
}

function runLabel(status: string): string {
  const labels: Record<string, string> = {
    accepted: "已接纳",
    running: "运行中",
    waiting_approval: "等待模型请求审批",
    succeeded: "已完成",
    failed: "已失败",
    cancelled: "已取消",
    outcome_unknown: "结果未知，需要确认",
    abandoned: "已放弃",
    interrupted: "已中断",
  };
  return labels[status] ?? status;
}

function App() {
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [providers, setProviders] = useState<ModelProviderOption[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ProductSession[]>([]);
  const [activeSession, setActiveSession] = useState<ProductSession | null>(null);
  const [activeRuns, setActiveRuns] = useState<ProductRun[]>([]);
  const [hydratedMessages, setHydratedMessages] = useState<Message[]>([]);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 1180);
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [configurationTab, setConfigurationTab] = useState<ConfigurationTab>("session");
  const [settingsTitle, setSettingsTitle] = useState("");
  const [settingsProvider, setSettingsProvider] = useState("");
  const [settingsModel, setSettingsModel] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinition[]>([]);
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(CHAT_WORKFLOW.id);
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState<string | null>(null);
  const [lastSubmittedWorkflowId, setLastSubmittedWorkflowId] = useState<string>(CHAT_WORKFLOW.id);
  const [retrySource, setRetrySource] = useState<{ runId: string; prompt: string; forceRestart?: boolean } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const selectableWorkflows = useMemo(() => {
    const values = workflowDefinitions.filter((value) => value.selectable);
    return values.length > 0 ? values : [CHAT_WORKFLOW];
  }, [workflowDefinitions]);
  const selectedWorkflow = selectableWorkflows.find((value) => value.id === selectedWorkflowId)
    ?? selectableWorkflows[0]
    ?? CHAT_WORKFLOW;

  const hydrateSession = useCallback(async (sessionId: string) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const [session, productMessages, runs] = await Promise.all([
        getSession(sessionId),
        getSessionMessages(sessionId),
        getSessionRuns(sessionId),
      ]);
      setActiveSession(session);
      setHydratedMessages(toAguiMessages(productMessages));
      setActiveRuns(runs);
      setHydrationVersion((value) => value + 1);
      setLastSubmittedPrompt(null);
      setSidebarOpen(false);
    } catch (loadError) {
      setSessionError(loadError instanceof Error ? loadError.message : "加载会话失败");
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const refreshActiveSession = useCallback((hydrate = true) => {
    if (!activeSession?.id) return;
    if (!hydrate) {
      void Promise.all([getSession(activeSession.id), getSessionRuns(activeSession.id), listSessions()])
        .then(([session, runs, sessionList]) => {
          setActiveSession(session);
          setActiveRuns(runs);
          setSessions(sessionList);
        })
        .catch((loadError: unknown) => {
          setSessionError(loadError instanceof Error ? loadError.message : "刷新会话失败");
        });
      return;
    }
    void Promise.all([getSession(activeSession.id), getSessionMessages(activeSession.id), getSessionRuns(activeSession.id), listSessions()])
      .then(([session, productMessages, runs, sessionList]) => {
        setActiveSession(session);
        setHydratedMessages(toAguiMessages(productMessages));
        setActiveRuns(runs);
        setSessions(sessionList);
        setHydrationVersion((value) => value + 1);
      })
      .catch((loadError: unknown) => {
        setSessionError(loadError instanceof Error ? loadError.message : "刷新会话失败");
      });
  }, [activeSession?.id]);

  const {
    messages,
    status,
    error,
    pendingReview,
    dispatchRecovery,
    threadId,
    send,
    approve,
    revise,
    abandon,
    decideProduct,
    stop,
    returnDispatchPrompt,
    recoverFromError,
  } = useChatAgent({
    sessionId: activeSession?.id ?? null,
    hydratedMessages,
    hydrationVersion,
    onSessionSettled: refreshActiveSession,
  });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(`${API_BASE_URL}/api/health`, { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error("health check failed");
        return response.json() as Promise<Health>;
      }),
      fetch(`${API_BASE_URL}/api/model-providers`, { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error("provider catalog failed");
        return response.json() as Promise<ProviderCatalogResponse>;
      }),
      listWorkflows(),
    ])
      .then(([healthValue, catalog, workflows]) => {
        setHealth(healthValue);
        setProviders(catalog.providers);
        setDefaultProviderId(catalog.default_provider_id);
        setDefaultModel(catalog.default_model);
        setWorkflowDefinitions(workflows);
        setHealthError(false);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setHealthError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectableWorkflows.some((value) => value.id === selectedWorkflowId)) {
      setSelectedWorkflowId(selectableWorkflows[0]?.id ?? CHAT_WORKFLOW.id);
    }
  }, [selectableWorkflows, selectedWorkflowId]);

  useEffect(() => {
    let cancelled = false;
    void listSessions()
      .then(async (values) => {
        if (cancelled) return;
        const available = values.length > 0 ? values : [await createSession()];
        if (cancelled) return;
        setSessions(available);
        await hydrateSession(available[0].id);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setSessionError(loadError instanceof Error ? loadError.message : "初始化会话失败");
          setSessionLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateSession]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const createNewConversation = async () => {
    if (status !== "idle" || workflowRunning) return;
    setDraft("");
    setSessionLoading(true);
    try {
      const created = await createSession();
      setSessions((values) => [created, ...values]);
      await hydrateSession(created.id);
    } catch (createError) {
      setSessionError(createError instanceof Error ? createError.message : "创建会话失败");
      setSessionLoading(false);
    }
  };

  const openSession = (sessionId: string) => {
    if (status !== "idle" || workflowRunning || sessionId === activeSession?.id) return;
    setDraft("");
    void hydrateSession(sessionId);
  };

  const openConfiguration = (tab: ConfigurationTab = "session") => {
    if (activeSession) {
      setSettingsTitle(activeSession.title);
      setSettingsProvider(activeSession.model_provider_id ?? "");
      setSettingsModel(activeSession.model ?? "");
    }
    setConfigurationTab(tab);
    setConfigurationOpen(true);
  };

  const selectedProvider = providers.find((provider) => provider.id === settingsProvider) ?? null;

  const saveSessionSettings = async () => {
    if (!activeSession || !settingsTitle.trim()) return;
    setSettingsSaving(true);
    try {
      const changes: {
        title: string;
        model_provider_id?: string | null;
        model?: string | null;
      } = { title: settingsTitle };
      if (settingsProvider && settingsModel) {
        changes.model_provider_id = settingsProvider;
        changes.model = settingsModel;
      } else {
        changes.model_provider_id = defaultProviderId;
        changes.model = defaultModel;
      }
      const updated = await updateSession(activeSession.id, changes);
      setActiveSession(updated);
      setSessions((values) => values.map((value) => value.id === updated.id ? updated : value));
    } catch (saveError) {
      setSessionError(saveError instanceof Error ? saveError.message : "保存会话设置失败");
    } finally {
      setSettingsSaving(false);
    }
  };

  const archiveActiveSession = async () => {
    if (!activeSession || status !== "idle" || workflowRunning) return;
    setSettingsSaving(true);
    try {
      await updateSession(activeSession.id, { archived: true });
      let remaining = await listSessions();
      if (remaining.length === 0) remaining = [await createSession()];
      setSessions(remaining);
      setConfigurationOpen(false);
      await hydrateSession(remaining[0].id);
    } catch (archiveError) {
      setSessionError(archiveError instanceof Error ? archiveError.message : "归档会话失败");
    } finally {
      setSettingsSaving(false);
    }
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || status !== "idle" || !activeSession) return;
    const text = draft;
    setDraft("");
    const control = retrySource
      ? {
          kind: retrySource.forceRestart || text.trim() !== retrySource.prompt.trim() ? "restart" as const : "retry" as const,
          sourceRunId: retrySource.runId,
        }
      : undefined;
    setRetrySource(null);
    setLastSubmittedPrompt(text);
    setLastSubmittedWorkflowId(selectedWorkflow.id);
    setWorkbenchOpen(true);
    void send(text, control, {
      endpointUrl: workflowEndpointUrl(selectedWorkflow.endpoint),
      workflowId: selectedWorkflow.id,
      workflowVersion: selectedWorkflow.version,
    });
  };

  const retryRun = (run: ProductRun) => {
    if (!run.input_text || status === "running" || status === "saving") return;
    recoverFromError();
    setRetrySource(null);
    setLastSubmittedWorkflowId(selectedWorkflow.id);
    void send(
      run.input_text,
      { kind: "retry", sourceRunId: run.id },
      {
        endpointUrl: workflowEndpointUrl(selectedWorkflow.endpoint),
        workflowId: selectedWorkflow.id,
        workflowVersion: selectedWorkflow.version,
      },
    );
  };

  const editAndRestartRun = (run: ProductRun) => {
    if (!run.input_text || status === "running" || status === "saving") return;
    recoverFromError();
    setRetrySource({ runId: run.id, prompt: run.input_text });
    setDraft(run.input_text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const runtimeLabel = health?.runtime_mode === "model" ? health.model : "确定性启动 Agent";
  const busy = status === "running" || status === "saving";
  const latestRun = activeRuns[0] ?? null;
  const latestAssistantOutput = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const retryableLatestRun = latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status)
    ? latestRun
    : null;
  const interactionBusy = status !== "idle" || workflowRunning;
  const modelCallReview = pendingReview && pendingReview.review_kind !== "product_decision" && pendingReview.review_kind !== "tool_execution"
    ? pendingReview
    : null;
  const productDecisionReview = pendingReview?.review_kind === "product_decision" ? pendingReview : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button aria-label="打开会话列表" className="mobile-menu-button" onClick={() => setSidebarOpen(true)} type="button"><Menu size={18} /></button>
          <span className="brand-mark"><Bot size={19} /></span>
          <div><p className="brand-name">Chat</p><p className="brand-subtitle">AI 协作产品</p></div>
        </div>
        <button className="topbar-workflow" onClick={() => setWorkbenchOpen(true)} type="button">
          <WorkflowIcon size={15} />
          <span><small>本轮 Workflow</small><strong>{selectedWorkflow.name}</strong></span>
          <span>v{selectedWorkflow.version}</span>
        </button>
        <div className="topbar-actions">
          <button className="icon-button labeled-on-wide" disabled={interactionBusy} onClick={() => void createNewConversation()} type="button">
            <MessageSquarePlus size={17} /><span>新对话</span>
          </button>
          <button className="icon-button labeled-on-wide" onClick={() => openConfiguration()} type="button"><Settings2 size={18} /><span>配置</span></button>
        </div>
      </header>

      <div className={`workspace-layout ${sidebarCollapsed ? "workspace-layout--sidebar-collapsed" : ""}`}>
        {sidebarOpen && <button aria-label="关闭会话列表" className="session-sidebar-backdrop" onClick={() => setSidebarOpen(false)} type="button" />}
        <aside className={`session-sidebar ${sidebarOpen ? "session-sidebar--open" : ""}`} aria-label="会话列表">
          <div className="session-sidebar-heading">
            <div><span>PRODUCT SESSIONS</span><strong>会话</strong></div>
            <div>
              <button aria-label="创建会话" disabled={interactionBusy} onClick={() => void createNewConversation()} type="button"><MessageSquarePlus size={16} /></button>
              <button aria-label="收起会话列表" className="sidebar-collapse-button" onClick={() => setSidebarCollapsed(true)} type="button"><ChevronLeft size={16} /></button>
            </div>
          </div>
          <div className="session-list">
            {sessions.map((session) => (
              <button
                className={`session-item ${session.id === activeSession?.id ? "session-item--active" : ""}`}
                disabled={interactionBusy && session.id !== activeSession?.id}
                key={session.id}
                onClick={() => openSession(session.id)}
                type="button"
              >
                <span className="session-item-icon"><Bot size={14} /></span>
                <span className="session-item-copy"><strong>{session.title}</strong><small>会话版本 {session.revision} · {session.active_run_id ? "运行中" : "历史可打开"}</small></span>
                {session.id === activeSession?.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className="session-sidebar-foot">
            <span className={`status-dot ${healthError ? "status-dot--error" : ""}`} />
            <span>{healthError ? "后端未连接" : `${sessions.length} 个活动会话`}</span>
          </div>
        </aside>
        {sidebarCollapsed && (
          <button aria-label="展开会话列表" className="session-rail-toggle" onClick={() => setSidebarCollapsed(false)} type="button"><ChevronRight size={16} /><span>会话</span></button>
        )}

        <div className={`collaboration-surface ${workbenchOpen ? "collaboration-surface--workbench" : ""}`}>
          <main className="chat-layout">
            <div className="conversation-header">
              <div><strong>{activeSession?.title ?? "正在加载会话"}</strong><span>{activeSession ? `会话版本 ${activeSession.revision} · ${activeSession.channel.toUpperCase()}` : "Product Store"}</span></div>
              <div className="conversation-header-actions">
                {latestRun && <span className={`run-badge run-badge--${latestRun.status}`}>{runLabel(latestRun.status)}</span>}
                {!workbenchOpen && <button aria-label="打开 Workflow Run 工作台" onClick={() => setWorkbenchOpen(true)} type="button"><PanelRightOpen size={16} />工作台</button>}
              </div>
            </div>
            <section className="conversation" aria-label="对话消息">
            {sessionLoading ? (
              <div className="empty-state"><div className="thinking" role="status"><span /><span /><span /><span className="sr-only">正在恢复会话</span></div></div>
            ) : messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><Sparkles size={25} /></div>
                <p className="eyebrow">可持续推进的 AI 协作</p>
                <h1>从一句话开始，<br />把事情真正推进下去。</h1>
                <p className="empty-copy">
                  {health?.runtime_mode === "model"
                    ? "输入会先保存到Product Session；每一次模型调用都会暂停，确认完整请求后才发送。"
                    : "当前未配置模型，因此使用确定性启动Agent验证MAF、AG-UI与Product Session链路。"}
                </p>
                <div className="runtime-pill"><span className={`status-dot ${healthError ? "status-dot--error" : ""}`} />{healthError ? "后端未连接" : health ? runtimeLabel : "正在检查后端"}</div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
                {busy && <div className="thinking" role="status"><span /><span /><span /><span className="sr-only">正在处理</span></div>}
                {error && !pendingReview && !dispatchRecovery && <div className="error-banner" role="alert">{error}</div>}
                {sessionError && <div className="error-banner" role="alert">{sessionError}</div>}
                {dispatchRecovery && (
                  <div className={`dispatch-recovery dispatch-recovery--${dispatchRecovery.status}`} role="alert">
                    <strong>{dispatchRecovery.status === "outcome_unknown" ? "模型调用结果未知" : "模型调用已明确失败"}</strong>
                    <p>{dispatchRecovery.message}</p>
                    {dispatchRecovery.status === "outcome_unknown" && <p>重新发送可能产生重复调用或费用，请先确认Provider侧没有留下结果。</p>}
                    <small>错误代码：{dispatchRecovery.errorCode ?? "unavailable"}</small>
                    <button onClick={() => { const prompt = returnDispatchPrompt(); if (prompt !== null) { setDraft(prompt); if (latestRun) setRetrySource({ runId: latestRun.id, prompt, forceRestart: dispatchRecovery.status === "outcome_unknown" }); } }} type="button">返回输入框，由我确认 Provider 结果后决定</button>
                  </div>
                )}
                {!dispatchRecovery && !pendingReview && retryableLatestRun?.input_text && (
                  <div className="run-recovery" role="group" aria-label="失败Run恢复操作">
                    <div>
                      <strong>{runLabel(retryableLatestRun.status)}的Run可以显式处理</strong>
                      <p>旧Run和Attempt会保留；再次执行会创建有血缘的新Run，并重新进入发送前审批。</p>
                    </div>
                    <div>
                      <button onClick={() => retryRun(retryableLatestRun)} type="button"><RotateCcw size={14} />原样重试</button>
                      <button onClick={() => editAndRestartRun(retryableLatestRun)} type="button">修改后重新运行</button>
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
            </section>

            <div className="composer-wrap">
              <form className="composer-stack" onSubmit={submit}>
                <div className="workflow-selection-bar">
                  <label>
                    <WorkflowIcon size={14} />
                    <span>Workflow</span>
                    <select aria-label="选择本轮 Workflow" disabled={status !== "idle"} onChange={(event) => setSelectedWorkflowId(event.target.value)} value={selectedWorkflow.id}>
                      {selectableWorkflows.map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>{workflow.name} · v{workflow.version}</option>
                      ))}
                    </select>
                  </label>
                  <small>发送后由此 Workflow 运行</small>
                </div>
                <div className="composer">
                  <textarea
                    aria-label="发送消息"
                    autoFocus
                    disabled={status !== "idle" || !activeSession || sessionLoading}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={pendingReview ? "请先处理当前人工介入请求…" : "输入你想继续推进的事情…"}
                    rows={1}
                    value={draft}
                  />
                  {draft && status === "idle" && <button aria-label="清空输入" className="clear-draft-button" onClick={() => setDraft("")} type="button"><X size={17} /></button>}
                  {status === "running"
                    ? <button aria-label="停止生成" className="send-button send-button--stop" onClick={() => void stop()} type="button"><CircleStop size={19} /></button>
                    : <button aria-label="发送" className="send-button" disabled={!draft.trim() || status !== "idle" || !activeSession} type="submit"><ArrowUp size={20} /></button>}
                </div>
              </form>
              {retrySource && <div className="retry-context"><span>{retrySource.forceRestart ? "结果未知的旧 Run 不会原样重试；再次发送会创建 Restart。" : "正在基于失败 Run 重新执行；修改 Prompt 会记录为 Restart。"}</span><button onClick={() => setRetrySource(null)} type="button">取消关联</button></div>}
              <p className="composer-note">Enter 发送 · Product Session 保存历史 · 每次模型调用发送前审批</p>
            </div>
          </main>

          {workbenchOpen && (
            <WorkflowRunView
              assistantOutput={latestAssistantOutput ? getMessageText(latestAssistantOutput) : null}
              latestRun={latestRun}
              onClose={() => setWorkbenchOpen(false)}
              pendingReview={pendingReview}
              prompt={modelCallReview?.origin_prompt ?? lastSubmittedPrompt ?? latestRun?.input_text ?? null}
              runStatus={status}
              workflow={status === "idle"
                ? selectedWorkflow
                : selectableWorkflows.find((value) => value.id === lastSubmittedWorkflowId) ?? selectedWorkflow}
            />
          )}
        </div>
      </div>

      {modelCallReview && (
        <ModelCallReview
          busy={busy}
          card={modelCallReview}
          onAbandon={() => { void abandon().then((prompt) => { if (prompt !== null) setDraft(prompt); }); }}
          onApprove={() => void approve()}
          onRevise={(providerId, providerRequest) => void revise(providerId, providerRequest)}
          requestError={error}
        />
      )}

      {productDecisionReview && (
        <ProductDecisionReview
          busy={busy}
          card={productDecisionReview}
          key={productDecisionReview.approval_id}
          onDecision={(decision, changes) => void decideProduct(decision, changes)}
          requestError={error}
        />
      )}

      <ConfigurationCenter
        activeTab={configurationTab}
        onOpenChange={setConfigurationOpen}
        onTabChange={setConfigurationTab}
        open={configurationOpen}
        panels={{
          session: (
            <section className="configuration-section session-configuration">
              <header><p className="eyebrow">PRODUCT SESSION</p><h2>当前会话</h2><p>配置会话名称和默认模型。每次真实模型请求仍会单独进入发送前审批。</p></header>
              <label className="settings-field"><span>会话名称</span><input maxLength={160} onChange={(event) => setSettingsTitle(event.target.value)} value={settingsTitle} /></label>
              {providers.length > 0 && (
                <div className="settings-grid">
                  <label className="settings-field"><span>Provider</span><select onChange={(event) => { const provider = providers.find((value) => value.id === event.target.value); setSettingsProvider(event.target.value); setSettingsModel(provider?.models[0]?.id ?? ""); }} value={settingsProvider}><option value="">使用系统默认</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
                  <label className="settings-field"><span>模型</span><select disabled={!selectedProvider} onChange={(event) => setSettingsModel(event.target.value)} value={settingsModel}><option value="">选择模型</option>{selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
                </div>
              )}
              <dl className="system-grid session-facts">
                <div><dt>Product Session ID</dt><dd className="mono">{activeSession?.id ?? "—"}</dd></div>
                <div><dt>会话版本</dt><dd>{activeSession?.revision ?? "—"}</dd></div>
                <div><dt>最近 Product Run</dt><dd>{latestRun ? `${runLabel(latestRun.status)} · ${latestRun.attempts.length} 次尝试` : "尚无"}</dd></div>
              </dl>
              <div className="settings-actions">
                <button className="archive-button" disabled={settingsSaving || interactionBusy} onClick={() => void archiveActiveSession()} type="button"><Archive size={15} />归档会话</button>
                <button className="save-settings-button" disabled={settingsSaving || !settingsTitle.trim()} onClick={() => void saveSessionSettings()} type="button">{settingsSaving ? "保存中…" : "保存会话配置"}</button>
              </div>
            </section>
          ),
          workflow: (
            <section className="configuration-feature-panel">
              <div className="configuration-context-note"><strong>Workflow目录</strong><span>标记为可选择的Workflow会出现在聊天输入区；演示与工具Workflow仍只在这里单独运行。</span></div>
              <WorkflowPage
                blocked={status !== "idle"}
                definitions={workflowDefinitions}
                hydratedMessages={hydratedMessages}
                hydrationVersion={hydrationVersion}
                onRunningChange={setWorkflowRunning}
                onSessionSettled={refreshActiveSession}
                session={activeSession}
              />
            </section>
          ),
          agent: (
            <AgentPage
              blocked={interactionBusy}
              onAgentsChanged={() => { void listWorkflows().then(setWorkflowDefinitions); }}
              providers={providers}
            />
          ),
          tool: (
            <ToolPage
              blocked={interactionBusy}
              onChanged={() => { void listWorkflows().then(setWorkflowDefinitions); }}
              providers={providers}
            />
          ),
          hitl: (
            <HitlPage
              sessionId={activeSession?.id ?? null}
              workflowId={selectedWorkflow.id}
            />
          ),
          system: (
            <section className="configuration-section">
              <header><p className="eyebrow">SYSTEM BOUNDARIES</p><h2>系统与运行时</h2><p>Product DB 保存产品事实；AG-UI 传递 Agent Run 事件；MAF 管理 Agent 与 Workflow 运行语义。</p></header>
              <dl className="system-grid">
                <div><dt>后端</dt><dd>{healthError ? "未连接" : health?.status ?? "检查中"}</dd></div>
                <div><dt>Product Store</dt><dd>{health?.product_sessions ?? "—"}</dd></div>
                <div><dt>运行模式</dt><dd>{health?.runtime_mode ?? "—"}</dd></div>
                <div><dt>Agent Runtime</dt><dd>{runtimeLabel ?? "—"}</dd></div>
                <div><dt>模型请求审批</dt><dd>{health?.model_call_approval === "every_call" ? "每次调用" : "不适用"}</dd></div>
                <div><dt>实时协议</dt><dd>{health?.protocol?.toUpperCase() ?? "AG-UI"}</dd></div>
                <div><dt>Product Session</dt><dd className="mono">{activeSession?.id ?? "—"}</dd></div>
                <div><dt>AG-UI Thread</dt><dd className="mono">{threadId}</dd></div>
              </dl>
            </section>
          ),
        }}
      />
    </div>
  );
}

export default App;
