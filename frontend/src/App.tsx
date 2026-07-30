import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { authenticatedFetch, subscribeAuthenticationRequired } from "./authentication-recovery";
import { AuthenticationRequired } from "./authentication-required";
import { ConfigurationCenter, type ConfigurationTab } from "./configuration-center";
import { AppTopbar } from "./features/chat/app-topbar";
import { ConversationPane, runLabel } from "./features/chat/conversation-pane";
import { getMessageText } from "./features/chat/message-bubble";
import { listDurableDecisionRequests } from "./features/governance/hitl-api";
import { ActivityRail, type PrimaryView } from "./features/home/activity-rail";
import type { HomeContinueItem } from "./features/home/home-api";
import { MobileNavigation } from "./features/mobile/mobile-navigation";
import { readSessionDraft, writeSessionDraft } from "./features/mobile/session-draft-storage";
import { useNetworkStatus } from "./features/mobile/use-network-status";
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
} from "./features/session/session-api";
import { SessionSidebar } from "./features/session/session-sidebar";
import { SessionSettingsPanel } from "./features/settings/session-settings-panel";
import { SystemInfoPanel } from "./features/settings/system-info-panel";
import { FeatureErrorBoundary } from "./features/shared/feature-error-boundary";
import {
  listWorkflows,
  type WorkflowDefinition,
  workflowEndpointUrl,
} from "./features/workflow/workflow-api";
import { PwaStatus } from "./pwa-status";
import { apiUrl } from "./runtime-config";
import type { ModelProviderOption } from "./use-chat-agent";
import { useChatAgent } from "./use-chat-agent";
import type { WorkbenchView } from "./workbench-nav";
import { CHAT_WORKFLOW } from "./workflow-run-projection";

const AgentPage = lazy(() =>
  import("./agent-page").then((module) => ({ default: module.AgentPage })),
);
const HomeView = lazy(() =>
  import("./features/home/home-view").then((module) => ({ default: module.HomeView })),
);
const HarnessWorkbench = lazy(() =>
  import("./harness-workbench").then((module) => ({ default: module.HarnessWorkbench })),
);
const HitlPage = lazy(() => import("./hitl-page").then((module) => ({ default: module.HitlPage })));
const ProtocolPage = lazy(() =>
  import("./features/protocols/protocol-page").then((module) => ({
    default: module.ProtocolPage,
  })),
);
const ModelCallReview = lazy(() =>
  import("./model-call-review").then((module) => ({ default: module.ModelCallReview })),
);
const ProductDecisionReview = lazy(() =>
  import("./product-decision-review").then((module) => ({
    default: module.ProductDecisionReview,
  })),
);
const ToolPage = lazy(() => import("./tool-page").then((module) => ({ default: module.ToolPage })));
const WorkflowPage = lazy(() =>
  import("./workflow-page").then((module) => ({ default: module.WorkflowPage })),
);
const WorkflowRunView = lazy(() =>
  import("./workflow-run-view").then((module) => ({ default: module.WorkflowRunView })),
);

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

function FeatureLoading({ label }: { label: string }) {
  return (
    <div className="feature-loading" role="status">
      <span className="thinking" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>正在加载{label}</span>
    </div>
  );
}

function App() {
  const [primaryView, setPrimaryView] = useState<PrimaryView>(() =>
    window.sessionStorage.getItem("chat.primary-view.v1") === "chat" ? "chat" : "home",
  );
  const [homeSearchQuery, setHomeSearchQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [providers, setProviders] = useState<ModelProviderOption[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ProductSession[]>([]);
  const [activeSession, setActiveSession] = useState<ProductSession | null>(null);
  const [activeRuns, setActiveRuns] = useState<ProductRun[]>([]);
  const [hydratedMessages, setHydratedMessages] = useState<ReturnType<typeof toAguiMessages>>([]);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 1180);
  const [workbenchOpen, setWorkbenchOpen] = useState(() => window.innerWidth > 920);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("workflow");
  const [pendingDecisionCount, setPendingDecisionCount] = useState(0);
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
  const [retrySource, setRetrySource] = useState<{
    runId: string;
    prompt: string;
    forceRestart?: boolean;
  } | null>(null);
  const networkStatus = useNetworkStatus();
  const selectableWorkflows = useMemo(() => {
    const values = workflowDefinitions.filter((value) => value.selectable);
    return values.length > 0 ? values : [CHAT_WORKFLOW];
  }, [workflowDefinitions]);
  const selectedWorkflow =
    selectableWorkflows.find((value) => value.id === selectedWorkflowId) ??
    selectableWorkflows[0] ??
    CHAT_WORKFLOW;

  useEffect(() => {
    window.sessionStorage.setItem("chat.primary-view.v1", primaryView);
  }, [primaryView]);

  useEffect(() => subscribeAuthenticationRequired(() => setAuthenticationRequired(true)), []);

  useEffect(() => {
    const focusHomeSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPrimaryView("home");
        window.requestAnimationFrame(() => document.getElementById("home-global-search")?.focus());
      }
    };
    window.addEventListener("keydown", focusHomeSearch);
    return () => window.removeEventListener("keydown", focusHomeSearch);
  }, []);

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
      setDraft(readSessionDraft(session.id));
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

  useEffect(() => {
    if (!activeSession?.id) return;
    writeSessionDraft(activeSession.id, draft);
  }, [activeSession?.id, draft]);

  const refreshActiveSession = useCallback(
    (hydrate = true) => {
      if (!activeSession?.id) return;
      if (!hydrate) {
        void Promise.all([
          getSession(activeSession.id),
          getSessionRuns(activeSession.id),
          listSessions(),
        ])
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
      void Promise.all([
        getSession(activeSession.id),
        getSessionMessages(activeSession.id),
        getSessionRuns(activeSession.id),
        listSessions(),
      ])
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
    },
    [activeSession?.id],
  );

  const {
    messages,
    status,
    connectionStatus,
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
    runtimeJob: activeRuns[0]?.runtime_job ?? null,
    onSessionSettled: refreshActiveSession,
  });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      authenticatedFetch(apiUrl("/api/health"), { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error("health check failed");
        return response.json() as Promise<Health>;
      }),
      authenticatedFetch(apiUrl("/api/model-providers"), { signal: controller.signal }).then(
        (response) => {
          if (!response.ok) throw new Error("provider catalog failed");
          return response.json() as Promise<ProviderCatalogResponse>;
        },
      ),
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
    let cancelled = false;
    if (!activeSession?.id) {
      setPendingDecisionCount(0);
      return undefined;
    }
    const load = () => {
      void listDurableDecisionRequests(activeSession.id)
        .then((values) => {
          if (!cancelled) setPendingDecisionCount(values.length);
        })
        .catch(() => {
          if (!cancelled) setPendingDecisionCount(0);
        });
    };
    load();
    const timer = window.setInterval(load, 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSession?.id]);

  const openWorkbench = (view: WorkbenchView) => {
    setPrimaryView("chat");
    setWorkbenchView(view);
    setWorkbenchOpen(true);
  };

  const closeWorkbench = () => {
    setPrimaryView("chat");
    setWorkbenchOpen(false);
    // The conversation trigger is mounted by the state change above. Restoring
    // focus makes closing the full-width mobile Workbench an explicit return
    // to Chat instead of dropping keyboard users at the document root.
    window.requestAnimationFrame(() => {
      document.getElementById("conversation-workbench-trigger")?.focus();
    });
  };

  const createNewConversation = async () => {
    if (status !== "idle" || workflowRunning) return;
    setSessionLoading(true);
    setPrimaryView("chat");
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
    setPrimaryView("chat");
    void hydrateSession(sessionId);
  };

  const continueFromHome = (item: HomeContinueItem) => {
    setDraft(`继续「${item.title}」：`);
    setPrimaryView("chat");
    setWorkbenchOpen(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送消息"]')?.focus();
    });
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
      setSessions((values) => values.map((value) => (value.id === updated.id ? updated : value)));
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

  // BP-27 触发：浏览器栈入口。用户点击发送按钮时触发。从UI组件捕获输入
  // （draft/status/activeSession/selectedWorkflow），传递给useChatAgent.send。
  // 跨边界：浏览器->FastAPI跨边界前的JS栈起点。
  // 对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#1
  const submit = () => {
    // DEBUG-BREAKPOINT-NOTE: BP-27
    // DEBUG-BREAKPOINT-NOTE: 触发: 浏览器栈入口。
    // DEBUG-BREAKPOINT-NOTE: 触发: 用户点击发送按钮时触发。
    // DEBUG-BREAKPOINT-NOTE: 触发: 从UI组件捕获输入（draft/status/activeSession/selectedWorkflow），传递给BP-28 useChatAgent.send。
    // DEBUG-BREAKPOINT-NOTE: 触发: 需要浏览器DevTools打开才能命中debugger语句。
    // DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：从断点停住到知道来路和下一跳#1。
    // DEBUG-BREAKPOINT-NOTE: 频率: 用户每次点击发送触发1次
    debugger; // DEBUG-BREAKPOINT: BP-27
    // 浏览器栈入口：用户点击发送，此处是JS侧第一个有状态判断的调用点。
    if (!draft.trim() || status !== "idle" || !activeSession || networkStatus === "offline") return;
    const text = draft;
    setDraft("");
    const control = retrySource
      ? {
          kind:
            retrySource.forceRestart || text.trim() !== retrySource.prompt.trim()
              ? ("restart" as const)
              : ("retry" as const),
          sourceRunId: retrySource.runId,
        }
      : undefined;
    setRetrySource(null);
    setLastSubmittedPrompt(text);
    setLastSubmittedWorkflowId(selectedWorkflow.id);
    openWorkbench("workflow");
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
      {
        kind: run.failure_code === "context_source_stale" ? "restart" : "retry",
        sourceRunId: run.id,
      },
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

  const runtimeLabel = health?.runtime_mode === "model" ? health.model : "确定性启动 Agent";
  const busy = status === "running" || status === "saving";
  const latestRun = activeRuns[0] ?? null;
  const latestAssistantOutput = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const retryableLatestRun =
    latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status)
      ? latestRun
      : null;
  const interactionBusy = status !== "idle" || workflowRunning;
  const modelCallReview =
    pendingReview &&
    pendingReview.review_kind !== "product_decision" &&
    pendingReview.review_kind !== "tool_execution"
      ? pendingReview
      : null;
  const productDecisionReview =
    pendingReview?.review_kind === "product_decision" ? pendingReview : null;

  return (
    <div className="app-shell">
      <AppTopbar
        backendReachable={!healthError}
        homeActive={primaryView === "home"}
        homeSearchQuery={homeSearchQuery}
        interactionBusy={interactionBusy}
        networkStatus={networkStatus}
        onNewConversation={() => void createNewConversation()}
        onOpenConfiguration={() => openConfiguration()}
        onOpenProjects={() => openWorkbench("projects")}
        onOpenSidebar={() => {
          setPrimaryView("chat");
          setSidebarOpen(true);
        }}
        onOpenWorkflow={() => openWorkbench("workflow")}
        onHomeSearchChange={setHomeSearchQuery}
        workflow={selectedWorkflow}
      />

      <div className="primary-shell">
        <ActivityRail
          activeView={primaryView}
          onOpenApprovals={() => openConfiguration("hitl")}
          onOpenChat={() => {
            setPrimaryView("chat");
            setWorkbenchOpen(false);
          }}
          onOpenGarden={() => openWorkbench("knowledge")}
          onOpenHome={() => setPrimaryView("home")}
          onOpenWorkflow={() => openWorkbench("workflow")}
          pendingDecisionCount={pendingDecisionCount}
        />
        {primaryView === "home" ? (
          <FeatureErrorBoundary featureName="主页" resetKey="home">
            <Suspense fallback={<FeatureLoading label="主页" />}>
              <HomeView
                onContinue={continueFromHome}
                onOpenArtifacts={() => openWorkbench("workflow")}
                onOpenGarden={() => openWorkbench("knowledge")}
                onOpenProjects={() => openWorkbench("projects")}
                searchQuery={homeSearchQuery}
              />
            </Suspense>
          </FeatureErrorBoundary>
        ) : (
          <div
            className={`workspace-layout ${sidebarCollapsed ? "workspace-layout--sidebar-collapsed" : ""}`}
          >
            <SessionSidebar
              activeSessionId={activeSession?.id ?? null}
              healthError={healthError}
              interactionBusy={interactionBusy}
              onCloseMobile={() => setSidebarOpen(false)}
              onCollapse={() => setSidebarCollapsed(true)}
              onCreate={() => void createNewConversation()}
              onExpand={() => setSidebarCollapsed(false)}
              onOpen={openSession}
              sessions={sessions}
              sidebarCollapsed={sidebarCollapsed}
              sidebarOpen={sidebarOpen}
            />

            <div
              className={`collaboration-surface ${workbenchOpen ? "collaboration-surface--workbench" : ""}`}
            >
              <ConversationPane
                activeSession={activeSession}
                busy={busy}
                connectionStatus={connectionStatus}
                dispatchRecovery={dispatchRecovery}
                draft={draft}
                error={error}
                healthError={healthError}
                networkStatus={networkStatus}
                latestRun={latestRun}
                messages={messages}
                onCancelRetry={() => setRetrySource(null)}
                onChangeDraft={setDraft}
                onEditAndRestart={editAndRestartRun}
                onOpenWorkbench={() => openWorkbench("workflow")}
                onRetry={retryRun}
                onReturnDispatchPrompt={() => {
                  const prompt = returnDispatchPrompt();
                  if (prompt !== null) {
                    setDraft(prompt);
                    if (latestRun)
                      setRetrySource({
                        runId: latestRun.id,
                        prompt,
                        forceRestart: dispatchRecovery?.status === "outcome_unknown",
                      });
                  }
                }}
                onStop={() => void stop()}
                onSubmit={submit}
                onWorkflowChange={setSelectedWorkflowId}
                pendingReview={pendingReview}
                retrySource={retrySource}
                retryableLatestRun={retryableLatestRun}
                runtimeLabel={health ? runtimeLabel : null}
                runtimeMode={health?.runtime_mode ?? null}
                selectableWorkflows={selectableWorkflows}
                selectedWorkflow={selectedWorkflow}
                sessionError={sessionError}
                sessionLoading={sessionLoading}
                status={status}
                workbenchOpen={workbenchOpen}
              />

              {workbenchOpen && (
                <FeatureErrorBoundary
                  featureName="右侧工作台"
                  onClose={closeWorkbench}
                  resetKey={`${activeSession?.id ?? "none"}:${workbenchView}`}
                >
                  <Suspense fallback={<FeatureLoading label="工作台" />}>
                    {workbenchView === "workflow" ? (
                      <WorkflowRunView
                        assistantOutput={
                          latestAssistantOutput ? getMessageText(latestAssistantOutput) : null
                        }
                        latestRun={latestRun}
                        onClose={closeWorkbench}
                        onViewChange={openWorkbench}
                        pendingDecisionCount={pendingDecisionCount}
                        pendingReview={pendingReview}
                        prompt={
                          modelCallReview?.origin_prompt ??
                          lastSubmittedPrompt ??
                          latestRun?.input_text ??
                          null
                        }
                        runStatus={status}
                        workflow={
                          status === "idle"
                            ? selectedWorkflow
                            : (selectableWorkflows.find(
                                (value) => value.id === lastSubmittedWorkflowId,
                              ) ?? selectedWorkflow)
                        }
                      />
                    ) : activeSession ? (
                      <HarnessWorkbench
                        onClose={closeWorkbench}
                        onViewChange={openWorkbench}
                        sessionId={activeSession.id}
                        view={workbenchView}
                      />
                    ) : null}
                  </Suspense>
                </FeatureErrorBoundary>
              )}
            </div>
          </div>
        )}
      </div>
      <MobileNavigation
        activeWorkbenchView={workbenchView}
        onOpenHome={() => setPrimaryView("home")}
        onOpenChat={closeWorkbench}
        onOpenConfiguration={() => openConfiguration()}
        onOpenResources={() => openWorkbench("projects")}
        onOpenWorkflow={() => openWorkbench("workflow")}
        primaryView={primaryView}
        workbenchOpen={workbenchOpen}
      />
      <PwaStatus />
      {authenticationRequired && <AuthenticationRequired />}

      {modelCallReview && (
        <Suspense fallback={<FeatureLoading label="模型请求审批" />}>
          <ModelCallReview
            busy={busy}
            card={modelCallReview}
            onAbandon={() => {
              void abandon().then((prompt) => {
                if (prompt !== null) setDraft(prompt);
              });
            }}
            onApprove={() => void approve()}
            onRevise={(providerId, providerRequest) => void revise(providerId, providerRequest)}
            requestError={error}
          />
        </Suspense>
      )}

      {productDecisionReview && (
        <Suspense fallback={<FeatureLoading label="人工决定" />}>
          <ProductDecisionReview
            busy={busy}
            card={productDecisionReview}
            key={productDecisionReview.approval_id}
            onDecision={(decision, changes) => void decideProduct(decision, changes)}
            requestError={error}
          />
        </Suspense>
      )}

      <Suspense fallback={<FeatureLoading label="配置中心" />}>
        <ConfigurationCenter
          activeTab={configurationTab}
          onOpenChange={setConfigurationOpen}
          onTabChange={setConfigurationTab}
          open={configurationOpen}
          panels={{
            session: (
              <SessionSettingsPanel
                interactionBusy={interactionBusy}
                latestRun={latestRun}
                model={settingsModel}
                onArchive={() => void archiveActiveSession()}
                onModelChange={setSettingsModel}
                onProviderChange={(providerId) => {
                  const provider = providers.find((value) => value.id === providerId);
                  setSettingsProvider(providerId);
                  setSettingsModel(provider?.models[0]?.id ?? "");
                }}
                onSave={() => void saveSessionSettings()}
                onTitleChange={setSettingsTitle}
                provider={selectedProvider}
                providerId={settingsProvider}
                providers={providers}
                runLabel={runLabel}
                saving={settingsSaving}
                session={activeSession}
                title={settingsTitle}
              />
            ),
            protocol: (
              <FeatureErrorBoundary
                featureName="协作方法"
                resetKey={`protocol:${configurationOpen}:${configurationTab}`}
              >
                <ProtocolPage />
              </FeatureErrorBoundary>
            ),
            workflow: (
              <section className="configuration-feature-panel">
                <div className="configuration-context-note">
                  <strong>Workflow目录</strong>
                  <span>
                    标记为可选择的Workflow会出现在聊天输入区；演示与工具Workflow仍只在这里单独运行。
                  </span>
                </div>
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
                onAgentsChanged={() => {
                  void listWorkflows().then(setWorkflowDefinitions);
                }}
                providers={providers}
              />
            ),
            tool: (
              <ToolPage
                blocked={interactionBusy}
                onChanged={() => {
                  void listWorkflows().then(setWorkflowDefinitions);
                }}
                providers={providers}
              />
            ),
            hitl: (
              <HitlPage sessionId={activeSession?.id ?? null} workflowId={selectedWorkflow.id} />
            ),
            system: (
              <SystemInfoPanel
                aguiThreadId={threadId}
                health={health}
                healthError={healthError}
                runtimeLabel={runtimeLabel}
                sessionId={activeSession?.id ?? null}
              />
            ),
          }}
        />
      </Suspense>
    </div>
  );
}

export default App;
