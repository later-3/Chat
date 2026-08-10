import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppsRegular,
  ArrowClockwiseRegular,
  ArrowLeftRegular,
  ArrowMaximizeRegular,
  BotRegular,
  CheckmarkCircleRegular,
  ChevronRightRegular,
  DataBarVerticalRegular,
  DismissRegular,
  DocumentRegular,
  FilterRegular,
  HomeRegular,
  InfoRegular,
  MoreHorizontalRegular,
  OpenRegular,
  PanelLeftExpandRegular,
  SearchRegular,
  SettingsRegular,
} from "@fluentui/react-icons";
import {
  agents,
  finishReconciliation,
  getActionSet,
  getAgent,
  getProject,
  getSummary,
  initialFeedItems,
  projects,
  selectFeedItems,
  transitionFeedItem,
} from "./agentFeedModel.js";

const typeLabels = {
  decision: "Decision",
  assistance: "Assistance",
  data_entry: "Data entry",
  outcome_unknown: "Run issue",
  review: "Review",
};

const priorityLabels = {
  critical: "Critical",
  high: "High impact",
  medium: "Normal",
  low: "Informational",
};

function readRoute() {
  const query = new URLSearchParams(window.location.search);
  return {
    tab: query.get("tab") === "completed" ? "completed" : "needs",
    taskId: query.get("task") || (window.matchMedia("(max-width: 850px)").matches ? "" : "task-decision-retry"),
    mode: query.get("mode") === "full" ? "full" : "side",
    agentId: agents.some((agent) => agent.id === query.get("agent")) ? query.get("agent") : "all",
    projectId: projects.some((project) => project.id === query.get("project")) ? query.get("project") : "all",
  };
}

function Avatar({ agent, size = "medium" }) {
  return <img className={`avatar avatar--${size}`} src={agent.image} alt="" />;
}

function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={props.disabled ? props.title : label} {...props}>
      {children}
    </button>
  );
}

function ProjectMark({ project }) {
  return (
    <span className="project-mark" style={{ "--project-color": project.color }} aria-hidden="true">
      {project.code}
    </span>
  );
}

function AppNavigation() {
  const unavailable = "This reference keeps the Agent Feed journey in scope.";
  return (
    <>
      <aside className="app-rail" aria-label="Microsoft application rail">
        <button type="button" className="rail-button" aria-label="App launcher unavailable in this reference" disabled title={unavailable}>
          <AppsRegular />
        </button>
        <button type="button" className="rail-button rail-button--selected" aria-label="Project Operations current app" disabled title="Current app">
          <span className="power-apps-mark">P</span>
        </button>
        <div className="rail-spacer" />
        <button type="button" className="rail-button" disabled title={unavailable} aria-label="Settings unavailable in this reference">
          <SettingsRegular />
        </button>
      </aside>
      <nav className="sitemap" aria-label="Project Operations navigation">
        <div className="sitemap__brand">
          <span className="brand-tile">PO</span>
          <div>
            <strong>Project Operations</strong>
            <span>Chat reference lab</span>
          </div>
        </div>
        <div className="sitemap__group-label">Workspace</div>
        <button type="button" className="sitemap__item" disabled title={unavailable}>
          <HomeRegular /> <span>Home</span>
        </button>
        <button type="button" className="sitemap__item sitemap__item--selected" aria-current="page" disabled title="Current page">
          <BotRegular /> <span>Agent Feed</span>
        </button>
        <button type="button" className="sitemap__item" disabled title={unavailable}>
          <DocumentRegular /> <span>Projects</span>
        </button>
        <button type="button" className="sitemap__item" disabled title={unavailable}>
          <DataBarVerticalRegular /> <span>Runs</span>
        </button>
        <div className="sitemap__group-label">Recent projects</div>
        {projects.slice(0, 3).map((project) => (
          <button key={project.id} type="button" className="sitemap__item sitemap__project" disabled title={unavailable}>
            <ProjectMark project={project} /> <span>{project.name}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

function FeedTabs({ tab, summary, onChange }) {
  return (
    <div className="feed-tabs" role="tablist" aria-label="Feed status">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "needs"}
        className={tab === "needs" ? "feed-tab feed-tab--selected" : "feed-tab"}
        onClick={() => onChange("needs")}
      >
        Needs attention <span>{summary.needs}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "completed"}
        className={tab === "completed" ? "feed-tab feed-tab--selected" : "feed-tab"}
        onClick={() => onChange("completed")}
      >
        Completed <span>{summary.completed}</span>
      </button>
    </div>
  );
}

function FilterPopover({ agentId, projectId, onAgentChange, onProjectChange, onClose }) {
  return (
    <div className="filter-popover" role="dialog" aria-modal="false" aria-label="Filter agent tasks">
      <div className="popover-heading">
        <strong>Filter tasks</strong>
        <IconButton label="Close filters" onClick={onClose}>
          <DismissRegular />
        </IconButton>
      </div>
      <label>
        Agent
        <select value={agentId} onChange={(event) => onAgentChange(event.target.value)}>
          <option value="all">All agents</option>
          {agents.map((agent) => (
            <option value={agent.id} key={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Project
        <select value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
          <option value="all">All projects</option>
          {projects.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          onAgentChange("all");
          onProjectChange("all");
        }}
      >
        Clear all filters
      </button>
    </div>
  );
}

function FeedItem({ item, selected, onSelect }) {
  const agent = getAgent(item.agentId);
  const project = getProject(item.projectId);
  return (
    <button
      type="button"
      className={`feed-item ${selected ? "feed-item--selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
    >
      <span className={`priority-stripe priority-stripe--${item.priority}`} aria-hidden="true" />
      <Avatar agent={agent} size="small" />
      <span className="feed-item__copy">
        <span className="feed-item__eyebrow">
          <span>{typeLabels[item.type]}</span>
          <span aria-hidden="true">·</span>
          <span>{project.name}</span>
        </span>
        <strong>{item.title}</strong>
        <span className="feed-item__summary">{item.summary}</span>
        <span className="feed-item__meta">
          {agent.name} · {item.relativeTime}
        </span>
      </span>
      <ChevronRightRegular className="feed-item__chevron" aria-hidden="true" />
    </button>
  );
}

function EmptyFeed({ hasFilters, onClear }) {
  return (
    <div className="empty-feed">
      <CheckmarkCircleRegular />
      <strong>{hasFilters ? "No tasks match these filters" : "You’re all caught up"}</strong>
      <span>{hasFilters ? "Try a different agent or project." : "New agent tasks will appear here."}</span>
      {hasFilters && (
        <button type="button" className="secondary-button" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function AgentFilterColumn({ agentId, onChange }) {
  return (
    <aside className="agent-filter-column" aria-label="Filter by agent">
      <h2>Agents</h2>
      <button type="button" className={agentId === "all" ? "agent-filter agent-filter--selected" : "agent-filter"} onClick={() => onChange("all")}>
        <span className="avatar-stack" aria-hidden="true">
          {agents.slice(0, 3).map((agent) => (
            <Avatar agent={agent} size="tiny" key={agent.id} />
          ))}
        </span>
        <span><strong>All agents</strong><small>4 available</small></span>
        {agentId === "all" && <CheckmarkCircleRegular />}
      </button>
      {agents.map((agent) => (
        <button
          type="button"
          className={agentId === agent.id ? "agent-filter agent-filter--selected" : "agent-filter"}
          onClick={() => onChange(agent.id)}
          key={agent.id}
        >
          <Avatar agent={agent} size="small" />
          <span><strong>{agent.name}</strong><small>{agent.role}</small></span>
          {agentId === agent.id && <CheckmarkCircleRegular />}
        </button>
      ))}
      <div className="agent-status-note">
        <InfoRegular />
        <span><strong>2 agents active</strong>Task state comes from project and run facts, not from agent presence.</span>
      </div>
    </aside>
  );
}

function EvidenceList({ evidence }) {
  if (!evidence?.length) return null;
  return (
    <section className="detail-section">
      <h3>Evidence</h3>
      <ul className="evidence-list">
        {evidence.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}

function relatedSceneFor(item) {
  const objectType = item.relatedLabel?.split(" · ")[0];
  if (objectType === "Evidence" || objectType === "Reference") return "knowledge";
  if (objectType === "Project Update") return "updates";
  if (objectType === "Work" || objectType === "Run") return "work";
  return "room";
}

function navigateToRelatedRecord(item) {
  window.parent.postMessage(
    {
      type: "chat:navigate",
      scene: relatedSceneFor(item),
      context: {
        itemId: item.id,
        projectId: item.projectId,
        agentId: item.agentId,
        objectType: item.relatedLabel?.split(" · ")[0],
        relatedLabel: item.relatedLabel,
        revision: item.revision,
        hash: item.hash,
        commandId: item.commandId,
      },
    },
    window.location.origin,
  );
}

function TaskDetail({ item, draft, onDraftChange, onAction, onOpenRecord, onBack }) {
  const agent = getAgent(item.agentId);
  const project = getProject(item.projectId);
  const actions = getActionSet(item);
  const isWaiting = item.status === "in_progress" || item.status === "reconciling";
  const recordedCandidate = item.accepted || item.candidate || draft;
  return (
    <article className="task-detail" aria-labelledby="task-title">
      <div className="mobile-detail-back"><button type="button" className="text-button text-button--back" onClick={onBack}><ArrowLeftRegular /> Agent Feed</button></div>
      <div className="detail-header">
        <div>
          <span className="detail-kicker">{item.category}</span>
          <h2 id="task-title">{item.title}</h2>
        </div>
        <IconButton label="More task options" disabled title="No additional task actions in this reference."><MoreHorizontalRegular /></IconButton>
      </div>
      <div className="task-attribution">
        <Avatar agent={agent} size="medium" />
        <div><strong>{agent.name}</strong><span>{agent.role}</span></div>
        <span className={`agent-state agent-state--${agent.state}`}>{agent.state}</span>
      </div>
      <div className="detail-body">
        <div className="detail-summary"><p>{item.body}</p></div>
        <div className="object-strip">
          <ProjectMark project={project} />
          <div><span>Related project</span><strong>{project.name}</strong></div>
          <button type="button" className="link-button" onClick={onOpenRecord}>Open record <OpenRegular /></button>
        </div>

        {item.type === "decision" && (
          <section className="detail-section decision-card">
            <div className="section-heading"><h3>Decision candidate</h3><span>High impact</span></div>
            <div className="revision-grid"><div><span>Revision</span><strong>{item.revision}</strong></div><div><span>Content hash</span><strong>{item.hash}</strong></div><div><span>Scope</span><strong>One waiting run</strong></div></div>
            {item.userNote && <div className="agent-working"><ArrowClockwiseRegular /> {item.userNote}</div>}
          </section>
        )}

        {item.steps && (
          <section className="detail-section"><h3>Requested steps</h3><ol className="steps-list">{item.steps.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}</ol></section>
        )}

        {item.type === "data_entry" && (
          <section className="detail-section data-entry-card">
            <div className="section-heading"><div><h3>{item.status === "completed" ? "Recorded Project Update" : "Suggested Project Update"}</h3><p>{item.status === "completed" ? "This candidate is now a read-only task outcome." : "Edit before accepting. This is not a project fact yet."}</p></div><span>{item.status === "completed" ? "Read only" : "Candidate"}</span></div>
            {item.status === "completed" ? (
              <dl className="candidate-readonly">
                <div><dt>Health</dt><dd>{recordedCandidate.health}</dd></div>
                <div><dt>Summary</dt><dd>{recordedCandidate.summary}</dd></div>
                <div><dt>Next step</dt><dd>{recordedCandidate.nextStep}</dd></div>
              </dl>
            ) : (
              <>
                <label>Health<select value={draft.health} onChange={(event) => onDraftChange({ ...draft, health: event.target.value })}><option>On track</option><option>At risk</option><option>Off track</option></select></label>
                <label>Summary<textarea rows="4" value={draft.summary} onChange={(event) => onDraftChange({ ...draft, summary: event.target.value })} /></label>
                <label>Next step<input value={draft.nextStep} onChange={(event) => onDraftChange({ ...draft, nextStep: event.target.value })} /></label>
              </>
            )}
          </section>
        )}

        {item.type === "outcome_unknown" && (
          <section className="detail-section outcome-card">
            <div className="section-heading"><h3>Reconciliation boundary</h3><span>Never blind retry</span></div>
            <dl><div><dt>Command identity</dt><dd>{item.commandId}</dd></div><div><dt>Provider result</dt><dd>{item.providerReference}</dd></div><div><dt>Product state</dt><dd>{item.status === "completed" ? "Reconciled" : "Outcome unknown"}</dd></div></dl>
          </section>
        )}

        <EvidenceList evidence={item.evidence} />

        {item.status === "completed" && (
          <section className={`completion-banner completion-banner--${item.outcome || "succeeded"}`}>
            <CheckmarkCircleRegular /><div><strong>{item.category}</strong><span>{item.outcome === "dismissed" ? "No product fact was created." : "The task result is recorded on the related object."}</span></div>
          </section>
        )}
        {isWaiting && (
          <section className="working-banner"><ArrowClockwiseRegular /><div><strong>{item.category}</strong><span>{item.type === "outcome_unknown" ? "Checking provider state without sending another command." : "The Agent owns the next step; no human action is required now."}</span></div></section>
        )}
      </div>
      {actions.length > 0 && (
        <footer className="detail-actions">
          {actions.includes("approve") && <button type="button" className="primary-button" onClick={() => onAction("approve")}>Approve revision {item.revision}</button>}
          {actions.includes("request_changes") && <button type="button" className="secondary-button" onClick={() => onAction("request_changes")}>Request changes</button>}
          {actions.includes("complete") && <button type="button" className="primary-button" onClick={() => onAction("complete")}>Complete</button>}
          {actions.includes("accept") && <button type="button" className="primary-button" onClick={() => onAction("accept")}>Accept and complete</button>}
          {actions.includes("dismiss") && <button type="button" className="secondary-button" onClick={() => onAction("dismiss")}>Dismiss</button>}
          {actions.includes("reconcile") && <button type="button" className="primary-button" onClick={() => onAction("reconcile")}><ArrowClockwiseRegular /> Reconcile provider state</button>}
        </footer>
      )}
    </article>
  );
}

function Toast({ notice, onClose }) {
  return (
    <div className="toast" role="status">
      <CheckmarkCircleRegular />
      <span>{notice}</span>
      <IconButton label="Dismiss notification" onClick={onClose}><DismissRegular /></IconButton>
    </div>
  );
}

export function App() {
  const initialRoute = useMemo(readRoute, []);
  const [items, setItems] = useState(initialFeedItems);
  const [tab, setTab] = useState(initialRoute.tab);
  const [selectedId, setSelectedId] = useState(initialRoute.taskId);
  const [mode, setMode] = useState(initialRoute.mode);
  const [agentId, setAgentId] = useState(initialRoute.agentId);
  const [projectId, setProjectId] = useState(initialRoute.projectId);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(initialFeedItems.filter((item) => item.candidate).map((item) => [item.id, item.candidate])));
  const noticeTimer = useRef(null);

  const summary = useMemo(() => getSummary(items), [items]);
  const visibleItems = useMemo(() => selectFeedItems(items, { tab, agentId, projectId }), [items, tab, agentId, projectId]);
  const selectedItem = selectedId ? items.find((item) => item.id === selectedId) || null : null;
  const hasFilters = agentId !== "all" || projectId !== "all";

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    query.set("tab", tab);
    if (selectedId) query.set("task", selectedId);
    else query.delete("task");
    query.set("mode", mode);
    if (agentId !== "all") query.set("agent", agentId);
    else query.delete("agent");
    if (projectId !== "all") query.set("project", projectId);
    else query.delete("project");
    window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
  }, [tab, selectedId, mode, agentId, projectId]);

  useEffect(() => {
    if (selectedId && !visibleItems.some((item) => item.id === selectedId)) {
      setSelectedId(visibleItems[0]?.id || "");
    }
  }, [selectedId, visibleItems]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  function announce(message) {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => {
      setNotice(null);
    }, 10000);
  }

  function selectTask(itemId) {
    setSelectedId(itemId);
  }

  function changeTab(nextTab) {
    setTab(nextTab);
    const next = selectFeedItems(items, { tab: nextTab, agentId, projectId })[0];
    setSelectedId(next?.id || "");
  }

  function clearFilters() {
    setAgentId("all");
    setProjectId("all");
  }

  function handleAction(action) {
    if (!selectedItem) return;
    const payload = action === "accept" ? drafts[selectedItem.id] : action === "request_changes" ? { note: "Address the result-unknown evidence before proposing revision 8." } : {};
    const result = transitionFeedItem(items, selectedItem.id, action, payload);
    setItems(result.items);
    announce(result.notice);
    if (action === "reconcile") {
      window.setTimeout(() => {
        setItems((current) => finishReconciliation(current, selectedItem.id));
        setTab("completed");
        announce("Provider confirmed the deployment. Product state is reconciled.");
      }, 1000);
      return;
    }
    if (["approve", "complete", "accept", "dismiss"].includes(action)) setTab("completed");
  }

  function refresh() {
    announce("Agent Feed refreshed. No newer tasks were found.");
  }

  return (
    <div className={`prototype-shell prototype-shell--${mode}`}>
      <header className="global-bar">
        <div className="global-bar__product"><span className="mobile-app-mark"><BotRegular /></span><strong>Power Apps</strong><span className="global-divider" /><span>Project Operations</span></div>
        <div className="global-search"><SearchRegular /><span>Search this app</span><kbd>⌘ K</kbd></div>
        <div className="global-bar__actions"><span>Chat product lab</span><span className="profile-chip">LX</span></div>
      </header>
      <AppNavigation />
      <main className="workspace">
        <header className="page-bar">
          <div><span className="breadcrumb">Workspace / Agent supervision</span><h1>Agent Feed</h1></div>
          <div className="page-bar__status"><span><i /> {summary.running} running</span><span>{agents.length} agents</span></div>
        </header>
        <div className="workspace-toolbar">
          <div><InfoRegular /><span>Tasks are projections of project, run, decision and evidence records.</span></div>
        </div>
        <div className="agent-feed-layout">
          {mode === "full" && <AgentFilterColumn agentId={agentId} onChange={setAgentId} />}
          <section className="feed-pane" aria-label="Agent tasks">
            <div className="feed-pane__heading">
              <div><span className="feed-kicker">Your work across agents</span><h2>Agent Feed</h2></div>
              <div className="feed-pane__tools">
                <IconButton label="Refresh Agent Feed" onClick={refresh}><ArrowClockwiseRegular /></IconButton>
                <div className="popover-anchor">
                  <IconButton label="Filter Agent Feed" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}><FilterRegular /></IconButton>
                  {filtersOpen && <FilterPopover agentId={agentId} projectId={projectId} onAgentChange={setAgentId} onProjectChange={setProjectId} onClose={() => setFiltersOpen(false)} />}
                </div>
                <IconButton label={mode === "side" ? "Open full Agent Feed" : "Return to side pane"} onClick={() => setMode((current) => (current === "side" ? "full" : "side"))}>
                  {mode === "side" ? <ArrowMaximizeRegular /> : <PanelLeftExpandRegular />}
                </IconButton>
              </div>
            </div>
            <FeedTabs tab={tab} summary={summary} onChange={changeTab} />
            {hasFilters && <div className="active-filter"><FilterRegular /><span>{visibleItems.length} matching tasks</span><button type="button" onClick={clearFilters}>Clear</button></div>}
            <div className="feed-scroll" role="tabpanel">
              {visibleItems.length ? visibleItems.map((item) => <FeedItem key={item.id} item={item} selected={selectedId === item.id} onSelect={selectTask} />) : <EmptyFeed hasFilters={hasFilters} onClear={clearFilters} />}
              {visibleItems.length > 0 && <div className="feed-end">Showing all {visibleItems.length} tasks</div>}
            </div>
          </section>
          <section className="detail-pane">
            {selectedItem ? (
              <TaskDetail
                item={selectedItem}
                draft={drafts[selectedItem.id] || selectedItem.candidate || {}}
                onDraftChange={(draft) => setDrafts((current) => ({ ...current, [selectedItem.id]: draft }))}
                onAction={handleAction}
                onOpenRecord={() => navigateToRelatedRecord(selectedItem)}
                onBack={() => setSelectedId("")}
              />
            ) : (
              <div className="detail-empty"><BotRegular /><strong>Select an Agent task</strong><span>Open a task to review its context and available actions.</span></div>
            )}
          </section>
        </div>
      </main>
      {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
