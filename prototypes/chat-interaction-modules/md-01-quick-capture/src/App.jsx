import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Copy,
  FolderKanban,
  Home,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  Link2,
  MessageCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Sprout,
  WifiOff,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const SAMPLE_CAPTURE = "把学习复盘做成一张能持续更新的卡片";

function PrototypeMode({ offline, onChange }) {
  return (
    <div aria-label="原型场景" className="prototype-mode" role="group">
      <span>演示状态</span>
      <button
        aria-pressed={!offline}
        className={!offline ? "is-active" : ""}
        onClick={() => onChange(false)}
        type="button"
      >
        正常
      </button>
      <button
        aria-pressed={offline}
        className={offline ? "is-active is-risk" : ""}
        onClick={() => onChange(true)}
        type="button"
      >
        离线失败
      </button>
    </div>
  );
}

function ActivityRail({ onGarden }) {
  const items = [
    { icon: Home, label: "主页", active: true },
    { icon: LayoutDashboard, label: "工作台" },
    { icon: MessageCircle, label: "对话" },
    { icon: Workflow, label: "运行" },
    { icon: ShieldCheck, label: "审批" },
  ];

  return (
    <nav aria-label="主导航" className="activity-rail">
      <div className="activity-rail__main">
        {items.map(({ active, icon: Icon, label }) => (
          <button
            aria-current={active ? "page" : undefined}
            className={active ? "activity-rail__button is-active" : "activity-rail__button"}
            key={label}
            type="button"
          >
            <Icon aria-hidden="true" size={20} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <button
        className="activity-rail__button activity-rail__button--quiet"
        onClick={onGarden}
        type="button"
      >
        <Sprout aria-hidden="true" size={20} />
        <span>花园</span>
      </button>
    </nav>
  );
}

function MobileNavigation({ onCapture, onGarden }) {
  return (
    <>
      <button aria-label="快速捕获" className="mobile-capture" onClick={onCapture} type="button">
        <Plus aria-hidden="true" size={26} />
      </button>
      <nav aria-label="移动端主导航" className="mobile-navigation">
        <button aria-current="page" type="button">
          <Home aria-hidden="true" size={20} />
          <span>主页</span>
        </button>
        <button type="button">
          <MessageCircle aria-hidden="true" size={20} />
          <span>对话</span>
        </button>
        <button onClick={onGarden} type="button">
          <Sprout aria-hidden="true" size={20} />
          <span>花园</span>
        </button>
        <button type="button">
          <LayoutDashboard aria-hidden="true" size={20} />
          <span>工作台</span>
        </button>
        <button type="button">
          <Workflow aria-hidden="true" size={20} />
          <span>运行</span>
        </button>
      </nav>
    </>
  );
}

function HomeSurface({ candidateCount, onCapture, onGarden }) {
  return (
    <main className="home-surface">
      <section className="home-hero">
        <div>
          <p className="eyebrow">
            <Sparkles aria-hidden="true" size={16} />
            先留下，再决定它是什么
          </p>
          <h1>
            早上好，Later
            <span>今天想把什么先留下？</span>
          </h1>
          <p className="hero-copy">捕获不会启动 Workflow，也不会自动创建 Project 或 Work。</p>
          <button className="hero-capture" onClick={onCapture} type="button">
            <Plus aria-hidden="true" size={19} />
            快速捕获
            <kbd>⌘ ⇧ K</kbd>
          </button>
        </div>
        <div aria-label="今天" className="today-orb">
          <small>08 / 01</small>
          <strong>今天</strong>
          <span>{candidateCount} 条待整理</span>
        </div>
      </section>

      <section className="continue-section">
        <div className="section-heading">
          <div>
            <span>继续</span>
            <h2>不必重新交代，从上次的位置接着来</h2>
          </div>
          <button type="button">
            全部事项
            <ArrowRight aria-hidden="true" size={16} />
          </button>
        </div>
        <div className="continue-grid">
          <article className="continue-card continue-card--green">
            <div className="card-icon">
              <FolderKanban aria-hidden="true" size={22} />
            </div>
            <div>
              <small>PROJECT · 刚刚</small>
              <h3>Chat 90% 交互设计</h3>
              <p>下一步：确认快速捕获与 Idea 去向。</p>
              <span className="status-chip">MD-01 进行中</span>
            </div>
            <button aria-label="继续 Chat 交互设计" type="button">
              继续
              <ArrowRight aria-hidden="true" size={17} />
            </button>
          </article>
          <article className="continue-card continue-card--blue">
            <div className="card-icon">
              <BookOpen aria-hidden="true" size={22} />
            </div>
            <div>
              <small>LEARNING · 昨天</small>
              <h3>学习复盘方法</h3>
              <p>下一步：把零散记录整理成可回看的结构。</p>
              <span className="status-chip">等待继续</span>
            </div>
            <button aria-label="继续学习复盘方法" type="button">
              继续
              <ArrowRight aria-hidden="true" size={17} />
            </button>
          </article>
        </div>
      </section>

      <section className="garden-preview">
        <div className="garden-preview__icon">
          <Sprout aria-hidden="true" size={22} />
        </div>
        <div>
          <small>灵感花园 · 待整理</small>
          <h2>{candidateCount ? "有 1 条原话等你以后决定" : "一条原话也可以先被好好接住"}</h2>
          <p>
            {candidateCount
              ? "它还不是正式 Idea，也没有被自动变成任务。"
              : "类型、项目、日期都可以以后再补。"}
          </p>
        </div>
        <button onClick={candidateCount ? onGarden : onCapture} type="button">
          {candidateCount ? "查看待整理" : "捕获第一条"}
          <ChevronRight aria-hidden="true" size={17} />
        </button>
      </section>
    </main>
  );
}

function useDialogFocusTrap(initialSelector) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previousFocus = document.activeElement;
    const focusableSelector = "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";
    dialog.querySelector(initialSelector)?.focus();

    const keepFocusInside = (event) => {
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("keydown", keepFocusInside);
    return () => {
      dialog.removeEventListener("keydown", keepFocusInside);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [initialSelector]);

  return dialogRef;
}

function QuickCapture({ draft, onChangeDraft, onClose, onSave, offline, saveState, source, sourceSaved }) {
  const dialogRef = useDialogFocusTrap("[data-initial-focus]");
  const failed = saveState === "failed" || saveState === "empty";
  const [copyStatus, setCopyStatus] = useState("idle");

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <div className="capture-layer" role="presentation">
      <button
        aria-label="关闭快速捕获"
        className="capture-backdrop"
        disabled={saveState === "saving"}
        onClick={onClose}
        type="button"
      />
      <section aria-labelledby="capture-title" aria-modal="true" className="capture-sheet" ref={dialogRef} role="dialog">
        <header className="capture-sheet__header">
          <div>
            <span className="capture-kicker">
              <Inbox aria-hidden="true" size={15} />
              快速捕获
            </span>
            <h2 id="capture-title">先把原话留下</h2>
            <span className="scope-pill">MD-01 · 只审核捕获与去向</span>
          </div>
          <button aria-label="关闭" disabled={saveState === "saving"} onClick={onClose} type="button">
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        <label className="capture-field">
          <span>原始表达</span>
          <textarea
            aria-describedby="capture-help"
            data-initial-focus
            onChange={(event) => onChangeDraft(event.target.value)}
            placeholder="想到什么就写什么，不必先选类型…"
            rows={3}
            value={draft}
          />
        </label>

        <div className={sourceSaved ? "capture-destination is-source-saved" : "capture-destination"}>
          <div className="capture-destination__icon">
            {sourceSaved ? <MessageCircle aria-hidden="true" size={19} /> : <Lightbulb aria-hidden="true" size={19} />}
          </div>
          <div>
            <span>{sourceSaved ? "来源已保存 · MSG-01" : "保存后进入"}</span>
            <strong>{sourceSaved ? "待整理已撤回，可继续编辑副本" : "待整理 · 类型未定"}</strong>
          </div>
          <span className="candidate-pill">{sourceSaved ? "来源保留" : "尚未保存"}</span>
        </div>

        <p className="capture-help" id="capture-help">
          <Check aria-hidden="true" size={16} />
          {sourceSaved
            ? "原始 Message 仍已保存；编辑副本不会改写原文，重新放入待整理也不会创建第二份来源。"
            : `保存原文与来源（${source}）；不发送给模型，不自动创建 Project、Work 或正式 Idea。`}
        </p>

        {failed ? (
          <div aria-live="assertive" className="capture-error" role="alert">
            {saveState === "empty" ? (
              <CircleAlert aria-hidden="true" size={20} />
            ) : (
              <WifiOff aria-hidden="true" size={20} />
            )}
            <div>
              <strong>
                {saveState === "empty"
                  ? "还没有可保存的内容"
                  : sourceSaved ? "尚未重新放入待整理" : "尚未保存到 Chat"}
              </strong>
              <span>
                {saveState === "empty"
                  ? "输入一句原话后再保存。"
                  : sourceSaved
                    ? "原始 Message 仍已保存；这个副本留在输入框里，可恢复网络后重试。"
                    : "文字仍在这个输入框里；恢复网络后重试，或先复制出来。"}
              </span>
            </div>
          </div>
        ) : offline ? (
          <div className="offline-hint">
            <WifiOff aria-hidden="true" size={17} />
            当前为离线失败演示；点击保存可查看真实风险态。
          </div>
        ) : null}

        <footer className="capture-sheet__footer">
          <span>
            {sourceSaved
              ? "关闭只收起可编辑副本；原始 Message 仍保留。"
              : "关闭后本次页面内保留草稿；刷新恢复尚未实现。"}
          </span>
          <div>
            {saveState === "failed" ? (
              <>
                <button className="secondary-button" onClick={copyDraft} type="button">
                  <Copy aria-hidden="true" size={17} />
                  {copyStatus === "copied" ? "已复制" : copyStatus === "failed" ? "复制失败" : "复制原话"}
                </button>
                <button className="secondary-button" onClick={onSave} type="button">
                  <RefreshCw aria-hidden="true" size={17} />
                  重试
                </button>
              </>
            ) : null}
            {saveState !== "failed" ? (
              <button className="primary-button" disabled={saveState === "saving"} onClick={onSave} type="button">
                {saveState === "saving" ? (
                  <RefreshCw aria-hidden="true" className="spin" size={17} />
                ) : (
                  <Inbox aria-hidden="true" size={17} />
                )}
                {saveState === "saving"
                  ? sourceSaved ? "正在重新放入…" : "正在保存原话…"
                  : sourceSaved ? "重新放入待整理" : "保存原话"}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}

function GardenPanel({ accepted, capture, onAccept, onBack, onUndo, onUndoAccept }) {
  const dialogRef = useDialogFocusTrap("[data-initial-focus]");

  return (
    <div className="garden-layer">
      <button aria-label="关闭待整理" className="capture-backdrop" onClick={onBack} type="button" />
      <aside aria-labelledby="garden-title" aria-modal="true" className="garden-panel" ref={dialogRef} role="dialog">
        <header>
          <button aria-label="返回主页" data-initial-focus onClick={onBack} type="button">
            <ArrowLeft aria-hidden="true" size={19} />
          </button>
          <div>
            <span>灵感花园 · MD-01</span>
            <h2 id="garden-title">{accepted ? "正式 Idea" : "待整理"}</h2>
          </div>
          <span className="garden-count">{capture ? 1 : 0}</span>
        </header>

        {!capture ? (
          <div className="garden-empty">
            <Sprout aria-hidden="true" size={30} />
            <h3>还没有待整理原话</h3>
            <p>这里不会凭空生成 Idea。</p>
          </div>
        ) : (
          <article className={accepted ? "candidate-card is-accepted" : "candidate-card"}>
            <div className="candidate-card__status">
              {accepted ? <Sprout aria-hidden="true" size={16} /> : <Inbox aria-hidden="true" size={16} />}
              <span>{accepted ? "正式 Idea · 已确认" : "原话已保存 · 类型未定"}</span>
            </div>
            <blockquote>{capture.text}</blockquote>
            <div className="source-row">
              <MessageCircle aria-hidden="true" size={15} />
              来源：{capture.source} · {capture.sourceMessageId || "MSG-01"} · 原文保留
            </div>

            {accepted ? (
              <div className="accepted-actions">
                <p>这一步才把候选接受为正式 Note(kind=idea)。</p>
                <button onClick={onUndoAccept} type="button">
                  <RotateCcw aria-hidden="true" size={16} />
                  撤销接受，退回待整理
                </button>
              </div>
            ) : (
              <>
                <div className="organize-actions">
                  <button className="organize-primary" onClick={onAccept} type="button">
                    <Sprout aria-hidden="true" size={17} />
                    保留为 Idea
                  </button>
                  <button disabled title="对象选择器待后端实现" type="button">
                    <Link2 aria-hidden="true" size={17} />
                    <span>关联已有<small>待实现</small></span>
                  </button>
                  <button disabled title="升级协调与目标表单待后端实现" type="button">
                    <ArrowRight aria-hidden="true" size={17} />
                    <span>升级为…<small>待实现</small></span>
                  </button>
                </div>

                <button className="undo-capture" onClick={onUndo} type="button">
                  <RotateCcw aria-hidden="true" size={16} />
                  撤回待整理，把原话放回输入框
                </button>
              </>
            )}
          </article>
        )}

        <div className="garden-boundary">
          <CircleAlert aria-hidden="true" size={17} />
          <span>本原型只确认交互；候选、升级、幂等与回链后端合同均待实现。</span>
        </div>
      </aside>
    </div>
  );
}

function Toast({ onClose, onUndo, onView, toast }) {
  if (!toast) return null;
  return (
    <div aria-live="polite" className={`toast toast--${toast.kind}`} role="status">
      {toast.kind === "success" ? (
        <CheckCircle2 aria-hidden="true" size={20} />
      ) : (
        <RotateCcw aria-hidden="true" size={20} />
      )}
      <div>
        <strong>{toast.title}</strong>
        <span>{toast.detail}</span>
      </div>
      {toast.actions ? (
        <div className="toast-actions">
          <button onClick={onUndo} type="button">撤销</button>
          <button onClick={onView} type="button">查看</button>
        </div>
      ) : null}
      <button aria-label="关闭提示" className="toast-close" onClick={onClose} type="button">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

function getInitialToast(demoState) {
  if (demoState === "success") {
    return {
      actions: true,
      kind: "success",
      title: "原话已保存到待整理",
      detail: "类型未定 · 没有创建 Project 或 Work",
    };
  }
  if (demoState === "accepted") {
    return {
      actions: false,
      kind: "success",
      title: "已接受为正式 Idea",
      detail: "原话和来源仍保留；这一步才成为花园里的正式 Idea",
    };
  }
  if (demoState === "withdrawn") {
    return {
      actions: false,
      kind: "info",
      title: "已撤回待整理",
      detail: "原始 Message · MSG-01 仍已保存；输入框中是可编辑副本",
    };
  }
  if (demoState === "returned") {
    return {
      actions: false,
      kind: "info",
      title: "已撤销接受，退回待整理",
      detail: "原始 Message 与类型未定候选仍保留",
    };
  }
  return null;
}

export function App() {
  const demoState = new URLSearchParams(window.location.search).get("state");
  const hasSavedCapture = ["success", "garden", "accepted", "returned"].includes(demoState);
  const hasSavedSource = hasSavedCapture || demoState === "withdrawn";
  const [captureOpen, setCaptureOpen] = useState(demoState === "withdrawn" || !hasSavedCapture);
  const [gardenOpen, setGardenOpen] = useState(["garden", "accepted", "returned"].includes(demoState));
  const [draft, setDraft] = useState(SAMPLE_CAPTURE);
  const [offline, setOffline] = useState(
    () => demoState === "offline" || new URLSearchParams(window.location.search).get("offline") === "1",
  );
  const [saveState, setSaveState] = useState(demoState === "offline" ? "failed" : "idle");
  const [captureSource, setCaptureSource] = useState("原型默认演示");
  const [sourceSaved, setSourceSaved] = useState(hasSavedSource);
  const [capture, setCapture] = useState(
    hasSavedCapture ? { source: "原型默认演示", sourceMessageId: "MSG-01", text: SAMPLE_CAPTURE } : null,
  );
  const [accepted, setAccepted] = useState(demoState === "accepted");
  const [toast, setToast] = useState(() => getInitialToast(demoState));
  const saveTimer = useRef(null);

  useEffect(() => {
    const onShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const resumesSavedSource = sourceSaved && !capture;
        if (!resumesSavedSource) {
          setCaptureSource("键盘快捷键");
          setSourceSaved(false);
          setDraft("");
        }
        setGardenOpen(false);
        setToast(null);
        setCaptureOpen(true);
        setSaveState("idle");
      }
      if (event.key === "Escape") {
        if (captureOpen && saveState !== "saving") {
          setCaptureOpen(false);
        } else if (gardenOpen) {
          setGardenOpen(false);
          setToast(null);
        }
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [capture, captureOpen, gardenOpen, saveState, sourceSaved]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), toast.actions ? 10000 : 6500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const openCapture = (source = "全局捕获") => {
    const resumesSavedSource = sourceSaved && !capture;
    if (!resumesSavedSource) {
      setCaptureSource(source);
      setSourceSaved(false);
      setDraft("");
    }
    setGardenOpen(false);
    setToast(null);
    setSaveState("idle");
    setCaptureOpen(true);
  };

  const saveCapture = () => {
    if (!draft.trim()) {
      setSaveState("empty");
      return;
    }
    if (offline) {
      setSaveState("failed");
      return;
    }
    setSaveState("saving");
    saveTimer.current = window.setTimeout(() => {
      const wasAlreadySaved = sourceSaved;
      setCapture({ source: captureSource, sourceMessageId: "MSG-01", text: draft.trim() });
      setSourceSaved(true);
      setAccepted(false);
      setSaveState("idle");
      setCaptureOpen(false);
      setToast({
        actions: true,
        kind: "success",
        title: wasAlreadySaved ? "已重新放入待整理" : "原话已保存到待整理",
        detail: wasAlreadySaved
          ? "继续引用原始 Message · MSG-01，没有创建第二份来源"
          : "类型未定 · 没有创建 Project 或 Work",
      });
    }, 720);
  };

  const undoCapture = () => {
    if (capture) {
      setDraft(capture.text);
      setCaptureSource(capture.source);
    }
    setCapture(null);
    setSourceSaved(true);
    setAccepted(false);
    setGardenOpen(false);
    setCaptureOpen(true);
    setSaveState("idle");
    setToast({
      actions: false,
      kind: "info",
      title: "已撤回待整理",
      detail: "原始 Message · MSG-01 仍已保存；输入框中是可编辑副本",
    });
  };

  const viewCapture = () => {
    setToast(null);
    setCaptureOpen(false);
    setGardenOpen(true);
  };

  const acceptIdea = () => {
    setAccepted(true);
    setToast({
      actions: false,
      kind: "success",
      title: "已接受为正式 Idea",
      detail: "原话和来源仍保留；这一步才成为花园里的正式 Idea",
    });
  };

  const undoAccept = () => {
    setAccepted(false);
    setToast({
      actions: false,
      kind: "info",
      title: "已撤销接受，退回待整理",
      detail: "原始 Message 与类型未定候选仍保留",
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Sprout aria-hidden="true" size={21} /></span>
          <span><strong>Chat</strong><small>AI 协作产品</small></span>
        </div>
        <label className="global-search">
          <Search aria-hidden="true" size={18} />
          <input aria-label="全局搜索" placeholder="搜索项目、事项和知识…" />
          <kbd>⌘ K</kbd>
        </label>
        <div className="topbar-actions">
          <span className="prototype-label">MD-01 原型 · 后端待接入</span>
          <PrototypeMode offline={offline} onChange={(value) => { setOffline(value); setSaveState("idle"); setToast(null); }} />
          <button className="topbar-capture" onClick={() => openCapture("顶栏捕获")} type="button">
            <Plus aria-hidden="true" size={18} />
            捕获
          </button>
        </div>
      </header>

      <div className="workspace-shell">
        <ActivityRail onGarden={() => { setCaptureOpen(false); setGardenOpen(true); }} />
        <HomeSurface
          candidateCount={capture && !accepted ? 1 : 0}
          onCapture={() => openCapture("主页快速捕获")}
          onGarden={viewCapture}
        />
      </div>

      <MobileNavigation onCapture={() => openCapture("手机浮动捕获")} onGarden={viewCapture} />

      {captureOpen ? (
        <QuickCapture
          draft={draft}
          offline={offline}
          onChangeDraft={(value) => { setDraft(value); if (saveState !== "saving") setSaveState("idle"); }}
          onClose={() => setCaptureOpen(false)}
          onSave={saveCapture}
          saveState={saveState}
          source={captureSource}
          sourceSaved={sourceSaved}
        />
      ) : null}

      {gardenOpen ? (
        <GardenPanel
          accepted={accepted}
          capture={capture}
          onAccept={acceptIdea}
          onBack={() => setGardenOpen(false)}
          onUndo={undoCapture}
          onUndoAccept={undoAccept}
        />
      ) : null}

      <Toast onClose={() => setToast(null)} onUndo={undoCapture} onView={viewCapture} toast={toast} />
    </div>
  );
}
