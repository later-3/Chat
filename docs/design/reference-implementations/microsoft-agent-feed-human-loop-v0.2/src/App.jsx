import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppsRegular,
  ArrowClockwiseRegular,
  ArrowLeftRegular,
  ArrowMaximizeRegular,
  BotRegular,
  CheckmarkCircleRegular,
  CheckboxCheckedRegular,
  CheckboxUncheckedRegular,
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
  activeStatuses,
  agents,
  applyTransition,
  cloneInitialFeedItems,
  evidenceCatalog,
  feedbackRequirements,
  getAgent,
  getEvidence,
  getHumanActionSet,
  getProject,
  getRecordProjection,
  getSummary,
  getSystemActionSet,
  groupForStatus,
  projects,
  resourceCatalog,
  selectFeedItems,
  terminalStatuses,
} from "./agentFeedModel.js";

const typeLabels = {
  decision: "Decision",
  assistance: "Assistance",
  candidate: "Project Update",
  outcome_unknown: "Run issue",
  delegation: "Delegation",
  review: "Review",
  run_result: "Run result",
};

const statusLabels = {
  waiting_human: "Waiting on human",
  waiting_agent: "Waiting on Agent",
  candidate_editable: "Candidate",
  outcome_unknown: "Outcome unknown",
  reconciliation_found: "Result found",
  reconciling: "Reconciling",
  decision_committed: "Decision committed",
  resuming: "Resuming",
  running: "Running",
  delegation_ready: "Ready to delegate",
  delegated: "Delegated",
  evidence_returned: "Evidence returned",
  succeeded: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  dismissed: "Dismissed",
  reconciled: "Reconciled",
};

function readRoute() {
  const query = new URLSearchParams(window.location.search);
  const tab = ["attention", "active", "history"].includes(query.get("tab")) ? query.get("tab") : "attention";
  return {
    tab,
    taskId: query.get("task") || (window.matchMedia("(max-width: 850px)").matches ? "" : "task-decision-retry"),
    mode: query.get("mode") === "full" ? "full" : "side",
    agentId: agents.some((agent) => agent.id === query.get("agent")) ? query.get("agent") : "all",
    projectId: projects.some((project) => project.id === query.get("project")) ? query.get("project") : "all",
    view: query.get("view") === "record" ? "record" : "task",
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

function StatusIcon({ state }) {
  if (["failed", "canceled", "dismissed"].includes(state)) return <DismissRegular aria-hidden="true" />;
  if (["succeeded", "reconciled"].includes(state)) return <CheckmarkCircleRegular aria-hidden="true" />;
  return <ArrowClockwiseRegular aria-hidden="true" />;
}

function AppNavigation() {
  const unavailable = "This reference keeps the Agent Feed human-loop journey in scope.";
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
            <span>Agent supervision</span>
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
  const tabs = [
    ["attention", "Needs attention", summary.attention],
    ["active", "Active", summary.active],
    ["history", "Recent results", summary.history],
  ];
  return (
    <div className="feed-tabs" role="tablist" aria-label="Feed status">
      {tabs.map(([id, label, count]) => (
        <button
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={tab === id ? "feed-tab feed-tab--selected" : "feed-tab"}
          onClick={() => onChange(id)}
          key={id}
        >
          {label} <span>{count}</span>
        </button>
      ))}
    </div>
  );
}

function FilterPopover({ agentId, projectId, onAgentChange, onProjectChange, onClose }) {
  const panelRef = useRef(null);
  useEffect(() => {
    panelRef.current?.querySelector("select")?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="filter-popover" role="dialog" aria-modal="false" aria-label="Filter agent tasks" ref={panelRef}>
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
            <option value={agent.id} key={agent.id}>{agent.name}</option>
          ))}
        </select>
      </label>
      <label>
        Project
        <select value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
          <option value="all">All projects</option>
          {projects.map((project) => (
            <option value={project.id} key={project.id}>{project.name}</option>
          ))}
        </select>
      </label>
      <button type="button" className="text-button" onClick={() => { onAgentChange("all"); onProjectChange("all"); }}>
        Clear all filters
      </button>
    </div>
  );
}

function FeedItem({ item, selected, onSelect, itemRef }) {
  const agent = getAgent(item.currentOwnerAgentId || item.agentId);
  const project = getProject(item.projectId);
  return (
    <button
      type="button"
      className={`feed-item feed-item--${groupForStatus(item.status)} ${selected ? "feed-item--selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
      data-item-id={item.id}
      ref={itemRef}
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
        <span className="feed-item__meta">{agent.name} · {item.relativeTime}</span>
        <span className={`status-chip status-chip--${item.status}`}><StatusIcon state={item.status} /> {statusLabels[item.status]}</span>
      </span>
      <ChevronRightRegular className="feed-item__chevron" aria-hidden="true" />
    </button>
  );
}

function EmptyFeed({ hasFilters, onClear }) {
  return (
    <div className="empty-feed">
      <CheckmarkCircleRegular />
      <strong>{hasFilters ? "No tasks match these filters" : "No items in this view"}</strong>
      <span>{hasFilters ? "Try a different Agent or Project." : "Tasks move here only when their typed state changes."}</span>
      {hasFilters && <button type="button" className="secondary-button" onClick={onClear}>Clear filters</button>}
    </div>
  );
}

function AgentFilterColumn({ agentId, onChange, items }) {
  return (
    <aside className="agent-filter-column" aria-label="Filter by agent">
      <h2>Agents</h2>
      <button type="button" className={agentId === "all" ? "agent-filter agent-filter--selected" : "agent-filter"} onClick={() => onChange("all")}>
        <span className="avatar-stack" aria-hidden="true">{agents.slice(0, 3).map((agent) => <Avatar agent={agent} size="tiny" key={agent.id} />)}</span>
        <span><strong>All agents</strong><small>4 participants</small></span>
        {agentId === "all" && <CheckmarkCircleRegular />}
      </button>
      {agents.map((agent) => {
        const owned = items.filter((item) => !terminalStatuses.has(item.status) && (item.currentOwnerAgentId || item.agentId) === agent.id).length;
        return (
          <button type="button" className={agentId === agent.id ? "agent-filter agent-filter--selected" : "agent-filter"} onClick={() => onChange(agent.id)} key={agent.id}>
            <Avatar agent={agent} size="small" />
            <span><strong>{agent.name}</strong><small>{owned ? `${owned} current responsibility` : "No current responsibility"}</small></span>
            {agentId === agent.id && <CheckmarkCircleRegular />}
          </button>
        );
      })}
      <div className="agent-status-note">
        <InfoRegular />
        <span><strong>Projection only</strong>Agent presence and coordination messages do not create Product facts.</span>
      </div>
    </aside>
  );
}

function EvidenceList({ evidenceIds, title = "Evidence" }) {
  if (!evidenceIds?.length) return null;
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      <ul className="evidence-list">
        {evidenceIds.map((id) => {
          const evidence = getEvidence(id);
          return <li key={id}><DocumentRegular /><span><strong>{evidence?.label || id}</strong><small>{evidence?.kind} · {evidence?.source}</small></span></li>;
        })}
      </ul>
    </section>
  );
}

function RunTimeline({ run }) {
  if (!run) return null;
  return (
    <section className="detail-section run-timeline" aria-label={`Run ${run.id} timeline`}>
      <div className="section-heading">
        <div><h3>Run timeline</h3><p>{run.id}</p></div>
        <span className={`status-chip status-chip--${run.state}`}><StatusIcon state={run.state} /> {statusLabels[run.state] || run.state}</span>
      </div>
      <div className="ownership-line"><strong>Next owner</strong><span>{run.nextOwner}</span></div>
      <ol>
        {run.timeline.map((entry) => (
          <li className={`timeline-step timeline-step--${entry.state}`} key={entry.id}>
            <span className="timeline-marker"><StatusIcon state={entry.state} /></span>
            <span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DecisionContent({ item }) {
  return (
    <>
      <section className="detail-section decision-card">
        <div className="section-heading"><h3>Decision candidate</h3><span>High impact</span></div>
        <div className="revision-grid">
          <div><span>Revision</span><strong>{item.revision}</strong></div>
          <div><span>Content hash</span><strong>{item.hash}</strong></div>
          <div><span>Scope</span><strong>{item.scope}</strong></div>
        </div>
        <div className="policy-copy"><span>Proposed policy</span><p>{item.policyText}</p></div>
      </section>
      {item.diff && (
        <section className="detail-section diff-card">
          <div className="section-heading"><div><h3>Revision {item.previousRevision.revision} → {item.revision} diff</h3><p>New hash {item.hash}</p></div><span>Agent response</span></div>
          <div className="diff-grid">
            <div className="diff-before"><span>Removed · revision {item.previousRevision.revision}</span><p>{item.diff.from}</p></div>
            <div className="diff-after"><span>Added · revision {item.revision}</span><p>{item.diff.to}</p></div>
          </div>
        </section>
      )}
      {item.agentResponses?.length > 0 && (
        <section className="detail-section">
          <h3>Response to feedback</h3>
          <ul className="response-list">
            {item.agentResponses.map((response) => <li key={response.requirementId}><CheckmarkCircleRegular /><span><strong>{response.label}</strong><small>{response.response}</small></span></li>)}
          </ul>
        </section>
      )}
      {item.latestFeedback && (
        <section className="detail-section feedback-receipt">
          <h3>Latest structured feedback</h3>
          <p>{item.latestFeedback.note}</p>
          <div className="metadata-row"><span>Scope</span><strong>{item.latestFeedback.scope}</strong></div>
          {item.latestFeedback.attachmentName && <div className="metadata-row"><span>Material</span><strong>{item.latestFeedback.attachmentName}</strong></div>}
        </section>
      )}
      <EvidenceList evidenceIds={item.evidenceIds} />
      <RunTimeline run={item.run} />
    </>
  );
}

function AssistanceContent({ item }) {
  return (
    <>
      <section className="detail-section request-card">
        <div className="section-heading"><div><h3>Assistance request</h3><p>{item.request.reason}</p></div><span>Human input</span></div>
        <ul className="plain-list">{item.request.requested.map((request) => <li key={request}>{request}</li>)}</ul>
      </section>
      {item.agentReceipt && (
        <section className="detail-section receipt-card">
          <div className="section-heading"><h3>Agent receipt</h3><span>Confirmed</span></div>
          <p>Evidence Scout received: “{item.agentReceipt.receivedContext}”</p>
          <ul className="plain-list">{item.agentReceipt.receivedResources.map((resource) => <li key={resource}>{resource}</li>)}</ul>
          <div className="metadata-row"><span>Manual result</span><strong>{item.agentReceipt.receivedManualResult.replaceAll("_", " ")}</strong></div>
          {item.agentReceipt.attachmentName && <div className="metadata-row"><span>Material</span><strong>{item.agentReceipt.attachmentName}</strong></div>}
        </section>
      )}
      <RunTimeline run={item.run} />
    </>
  );
}

function CandidateContent({ item, draft, onDraftChange }) {
  const isEditable = item.status === "candidate_editable";
  const recorded = item.accepted || item.candidate;
  return (
    <>
      <section className="detail-section data-entry-card">
        <div className="section-heading">
          <div><h3>{isEditable ? "Suggested Project Update" : item.outcome === "accepted" ? "Published Project Update" : "Dismissed candidate"}</h3><p>{isEditable ? "Edit before accepting. This is not a Project fact yet." : "This object is a read-only terminal record."}</p></div>
          <span>{isEditable ? "Candidate" : "Read only"}</span>
        </div>
        {isEditable ? (
          <div className="candidate-form">
            <label>Health<select value={draft.health} onChange={(event) => onDraftChange({ ...draft, health: event.target.value })}><option>On track</option><option>At risk</option><option>Off track</option></select></label>
            <label>Summary<textarea rows="4" value={draft.summary} onChange={(event) => onDraftChange({ ...draft, summary: event.target.value })} /></label>
            <label>Next step<input value={draft.nextStep} onChange={(event) => onDraftChange({ ...draft, nextStep: event.target.value })} /></label>
          </div>
        ) : (
          <dl className="candidate-readonly">
            <div><dt>Health</dt><dd>{recorded.health}</dd></div>
            <div><dt>Summary</dt><dd>{recorded.summary}</dd></div>
            <div><dt>Next step</dt><dd>{recorded.nextStep}</dd></div>
          </dl>
        )}
      </section>
      <section className="detail-section source-card">
        <h3>Sources</h3>
        <ul className="plain-list">{item.sources.map((source) => <li key={source}>{source}</li>)}</ul>
        <h3>Observed changes</h3>
        {item.observedChanges.length ? <ul className="plain-list">{item.observedChanges.map((change) => <li key={change}>{change}</li>)}</ul> : <p className="muted-copy">No observed changes were attached.</p>}
      </section>
    </>
  );
}

function OutcomeContent({ item }) {
  return (
    <>
      <section className="detail-section outcome-card">
        <div className="section-heading"><h3>Reconciliation boundary</h3><span>Never blind Retry</span></div>
        <dl>
          <div><dt>Command identity</dt><dd>{item.commandId}</dd></div>
          <div><dt>Request hash</dt><dd>{item.requestHash || "Recorded"}</dd></div>
          <div><dt>Provider hint</dt><dd>{item.providerHint || "Deployment API"}</dd></div>
          <div><dt>Provider result</dt><dd>{item.providerReference}</dd></div>
          <div><dt>Product state</dt><dd>{item.productState}</dd></div>
        </dl>
      </section>
      {item.queryEvidence && (
        <section className="detail-section query-evidence">
          <div className="section-heading"><h3>Provider query Evidence</h3><span>Read only</span></div>
          <div className="metadata-row"><span>Query</span><strong>{item.queryEvidence.request}</strong></div>
          <p>{item.queryEvidence.response}</p>
        </section>
      )}
      <EvidenceList evidenceIds={item.evidenceIds} />
      <RunTimeline run={item.run} />
    </>
  );
}

function DelegationContent({ item }) {
  const owner = getAgent(item.currentOwnerAgentId);
  return (
    <>
      <section className="detail-section delegation-map">
        <div className="section-heading"><div><h3>Delegation and dependency</h3><p>Visible to Project participants</p></div><span>{statusLabels[item.status]}</span></div>
        <div className="relationship-row">
          <div className="relationship-card"><span>Parent task</span><strong>{item.parentTask.label}</strong><small>{item.parentTask.id} · Project Pilot</small></div>
          <ChevronRightRegular aria-hidden="true" />
          <div className="relationship-card"><span>Delegated task</span><strong>{item.delegatedTask?.label || "Not created yet"}</strong><small>{item.delegatedTask?.id || "Delegate to continue"}</small></div>
          <ChevronRightRegular aria-hidden="true" />
          <div className="relationship-card"><span>Dependency</span><strong>{item.dependency.label}</strong><small>{item.dependency.state.replaceAll("_", " ")}</small></div>
        </div>
        <div className="owner-banner"><Avatar agent={owner} size="small" /><span><small>Current owner</small><strong>{owner.name}</strong></span></div>
      </section>
      {item.coordinationMessages.length > 0 && (
        <section className="detail-section coordination-log">
          <div className="section-heading"><h3>Coordination events</h3><span>Not Product facts</span></div>
          <ol>{item.coordinationMessages.map((message) => <li key={message.id}><strong>{getAgent(message.from)?.name || message.from} → {getAgent(message.to)?.name || message.to}</strong><p>{message.body}</p><small>{message.visibility} · coordination only</small></li>)}</ol>
        </section>
      )}
      <EvidenceList evidenceIds={item.evidenceIds} title="Returned Evidence" />
      <RunTimeline run={item.run} />
    </>
  );
}

function TerminalBanner({ item }) {
  if (!terminalStatuses.has(item.status)) return null;
  const copy = {
    succeeded: item.outcome === "accepted" ? "The candidate became a read-only authoritative record." : "The result is recorded on the related object.",
    failed: "No success fact was created. Start a new Run after fixing the cause.",
    canceled: item.outcome === "manual_disposition" ? "A manual disposition was recorded without a success fact." : "The operation stopped and cannot be resumed from this item.",
    dismissed: "No Product fact was created. Starting again creates a new candidate identity.",
    reconciled: "The provider result and Product fact are reconciled. There is no generic Undo.",
  };
  return (
    <section className={`terminal-banner terminal-banner--${item.status}`}>
      <StatusIcon state={item.status} />
      <div><strong>{statusLabels[item.status]}</strong><span>{copy[item.status]}</span></div>
    </section>
  );
}

function TaskActions({ item, onAction, onOpenComposer, actionTriggerRef }) {
  const actions = getHumanActionSet(item);
  if (!actions.length) return null;
  return (
    <footer className="detail-actions" aria-label="Available task actions">
      {actions.includes("approve_decision") && <button type="button" className="primary-button" onClick={() => onAction("approve_decision", { expectedRevision: item.revision, expectedHash: item.hash })}>Approve revision {item.revision}</button>}
      {actions.includes("submit_feedback") && <button type="button" className="secondary-button" onClick={() => onOpenComposer("feedback")} ref={actionTriggerRef}>Request changes</button>}
      {actions.includes("submit_assistance") && <button type="button" className="primary-button" onClick={() => onOpenComposer("assistance")} ref={actionTriggerRef}>Provide assistance</button>}
      {actions.includes("accept_candidate") && <button type="button" className="primary-button" onClick={() => onAction("accept_candidate")}>Accept Project Update</button>}
      {actions.includes("dismiss_candidate") && <button type="button" className="secondary-button" onClick={() => onAction("dismiss_candidate")}>Dismiss candidate</button>}
      {actions.includes("create_new_candidate") && <button type="button" className="primary-button" onClick={() => onAction("create_new_candidate")}>Create new candidate</button>}
      {actions.includes("start_reconciliation") && <button type="button" className="primary-button" onClick={() => onAction("start_reconciliation")}><ArrowClockwiseRegular /> Reconcile provider state</button>}
      {actions.includes("commit_reconciliation") && <button type="button" className="primary-button" onClick={() => onAction("commit_reconciliation")}>Commit Product fact</button>}
      {actions.includes("manual_disposition") && <button type="button" className="secondary-button" onClick={() => onOpenComposer("manual")} ref={actionTriggerRef}>Manual disposition</button>}
      {actions.includes("delegate") && <button type="button" className="primary-button" onClick={() => onAction("delegate")}>Delegate to Evidence Scout</button>}
      {actions.includes("add_direction") && <button type="button" className="secondary-button" onClick={() => onOpenComposer("direction")} ref={actionTriggerRef}>Add direction</button>}
      {actions.includes("reassign") && <button type="button" className="secondary-button" onClick={() => onOpenComposer("reassign")} ref={actionTriggerRef}>Reassign</button>}
      {actions.includes("stop_delegation") && <button type="button" className="danger-button" onClick={() => onAction("stop_delegation")}>Stop delegation</button>}
    </footer>
  );
}

function TaskDetail({ item, draft, onDraftChange, onAction, onOpenRecord, onBack, onOpenComposer, actionTriggerRef, recordTriggerRef }) {
  const agent = getAgent(item.currentOwnerAgentId || item.agentId);
  const project = getProject(item.projectId);
  return (
    <article className="task-detail" aria-labelledby="task-title">
      <div className="mobile-detail-back"><button type="button" className="text-button text-button--back" onClick={onBack}><ArrowLeftRegular /> Agent Feed</button></div>
      <div className="detail-header">
        <div><span className="detail-kicker">{item.category}</span><h2 id="task-title">{item.title}</h2></div>
        <IconButton label="More task options" disabled title="No additional task actions are available."><MoreHorizontalRegular /></IconButton>
      </div>
      <div className="task-attribution">
        <Avatar agent={agent} size="medium" />
        <div><strong>{agent.name}</strong><span>{agent.role}</span></div>
        <span className={`status-chip status-chip--${item.status}`}><StatusIcon state={item.status} /> {statusLabels[item.status]}</span>
      </div>
      <div className="detail-body">
        <div className="detail-summary"><p>{item.body}</p></div>
        <div className="object-strip">
          <ProjectMark project={project} />
          <div><span>Related authoritative object</span><strong>{item.relatedLabel}</strong></div>
          <button type="button" className="link-button" onClick={onOpenRecord} ref={recordTriggerRef}>Open record <OpenRegular /></button>
        </div>
        {item.type === "decision" && <DecisionContent item={item} />}
        {item.type === "assistance" && <AssistanceContent item={item} />}
        {item.type === "candidate" && <CandidateContent item={item} draft={draft} onDraftChange={onDraftChange} />}
        {item.type === "outcome_unknown" && <OutcomeContent item={item} />}
        {item.type === "delegation" && <DelegationContent item={item} />}
        {["review", "run_result"].includes(item.type) && <EvidenceList evidenceIds={item.evidenceIds} />}
        <TerminalBanner item={item} />
      </div>
      <TaskActions item={item} onAction={onAction} onOpenComposer={onOpenComposer} actionTriggerRef={actionTriggerRef} />
    </article>
  );
}

function RecordView({ item, onBack, onReturnFeed, backRef }) {
  const record = getRecordProjection(item);
  const project = getProject(item.projectId);
  return (
    <article className="record-view" aria-labelledby="record-title">
      <div className="record-commandbar">
        <button type="button" className="text-button text-button--back" onClick={onBack} ref={backRef}><ArrowLeftRegular /> Back to Agent task</button>
        <button type="button" className="secondary-button" onClick={onReturnFeed}>Return to Feed</button>
      </div>
      <header className="record-hero">
        <ProjectMark project={project} />
        <div><span>{record.objectType} · authoritative record</span><h2 id="record-title">{record.label}</h2><p>{project.name}</p></div>
        <span className={`status-chip status-chip--${item.status}`}><StatusIcon state={item.status} /> {statusLabels[item.status]}</span>
      </header>
      <div className="record-notice"><InfoRegular /><p><strong>Ownership boundary</strong>This record is owned by the Chat Product Store fixture. Agent Feed only projects its current state and returns here by object identity.</p></div>
      <div className="record-form">
        <section>
          <h3>Record identity</h3>
          <dl>
            <div><dt>Owner</dt><dd>{record.owner}</dd></div>
            <div><dt>State</dt><dd>{record.state}</dd></div>
            {record.revision && <div><dt>Revision</dt><dd>{record.revision}</dd></div>}
            {record.hash && <div><dt>Hash</dt><dd>{record.hash}</dd></div>}
            {record.runId && <div><dt>Linked Product Run</dt><dd>{record.runId}</dd></div>}
            {record.result && <div><dt>Result</dt><dd>{record.result}</dd></div>}
          </dl>
        </section>
        <section>
          <h3>Decision facts</h3>
          {record.decisionFacts.length ? <ul className="record-list">{record.decisionFacts.map((fact) => <li key={fact.id}><strong>{fact.id}</strong><span>revision {fact.revision} · {fact.hash} · {fact.outcome}</span></li>)}</ul> : <p className="muted-copy">No Decision fact has been committed for this object.</p>}
        </section>
        <section>
          <h3>Evidence references</h3>
          {record.evidenceIds.length ? <ul className="record-list">{record.evidenceIds.map((id) => <li key={id}><strong>{getEvidence(id)?.label || id}</strong><span>{id}</span></li>)}</ul> : <p className="muted-copy">No Evidence references are attached.</p>}
        </section>
        {item.run && <RunTimeline run={item.run} />}
      </div>
    </article>
  );
}

function Modal({ title, description, onClose, children, footer, initialFocusRef }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    (initialFocusRef?.current || dialog?.querySelector("input, textarea, select, button"))?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [initialFocusRef, onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description" ref={dialogRef}>
        <header className="modal__header"><div><h2 id="modal-title">{title}</h2><p id="modal-description">{description}</p></div><IconButton label="Close dialog" onClick={onClose}><DismissRegular /></IconButton></header>
        <div className="modal__body">{children}</div>
        <footer className="modal__footer">{footer}</footer>
      </section>
    </div>
  );
}

function FeedbackComposer({ item, onClose, onSubmit }) {
  const [note, setNote] = useState("");
  const [requirementIds, setRequirementIds] = useState(["no-blind-retry", "bind-provider-evidence", "show-resume-gate"]);
  const [evidenceIds, setEvidenceIds] = useState(item.evidenceIds.slice(0, 2));
  const [scope, setScope] = useState(item.scope);
  const [attachmentName, setAttachmentName] = useState(null);
  const noteRef = useRef(null);
  const toggle = (value, values, setter) => setter(values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]);
  const canSubmit = note.trim() && requirementIds.length && evidenceIds.length;
  return (
    <Modal
      title={`Request changes to revision ${item.revision}`}
      description="Structured task feedback only. This does not open a general chat or change the Decision fact by itself."
      onClose={onClose}
      initialFocusRef={noteRef}
      footer={<><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={!canSubmit} onClick={() => onSubmit({ note, requirementIds, evidenceIds, scope, attachmentName, expectedRevision: item.revision, expectedHash: item.hash })}>Submit feedback</button></>}
    >
      <label>Free-text feedback<textarea ref={noteRef} rows="4" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Explain what must change and why" /></label>
      <fieldset><legend>Structured changes</legend>{feedbackRequirements.map((requirement) => {
        const checked = requirementIds.includes(requirement.id);
        return <button type="button" role="checkbox" aria-checked={checked} className="check-row" key={requirement.id} onClick={() => toggle(requirement.id, requirementIds, setRequirementIds)}><span className="check-row__icon">{checked ? <CheckboxCheckedRegular /> : <CheckboxUncheckedRegular />}</span><span>{requirement.label}</span></button>;
      })}</fieldset>
      <fieldset><legend>Evidence to use</legend>{evidenceCatalog.slice(0, 4).map((evidence) => {
        const checked = evidenceIds.includes(evidence.id);
        return <button type="button" role="checkbox" aria-checked={checked} className="check-row" key={evidence.id} onClick={() => toggle(evidence.id, evidenceIds, setEvidenceIds)}><span className="check-row__icon">{checked ? <CheckboxCheckedRegular /> : <CheckboxUncheckedRegular />}</span><span>{evidence.label}<small>{evidence.kind} · {evidence.source}</small></span></button>;
      })}</fieldset>
      <label>Scope<select value={scope} onChange={(event) => setScope(event.target.value)}><option>One waiting deployment Run</option><option>All deployment Runs in Project Solution</option><option>Policy text only; do not resume a Run</option></select></label>
      <label>Supporting material<input type="file" accept=".md,.txt,.pdf" onChange={(event) => setAttachmentName(event.target.files?.[0]?.name || null)} /><small className="field-help">The fixture records the selected filename; it does not upload to a server.</small></label>
    </Modal>
  );
}

function AssistanceComposer({ item, onClose, onSubmit }) {
  const [context, setContext] = useState("");
  const [resourceIds, setResourceIds] = useState(["resource-source-record", "resource-permission-log"]);
  const [manualResult, setManualResult] = useState("access_confirmed");
  const [attachmentName, setAttachmentName] = useState(null);
  const contextRef = useRef(null);
  const toggleResource = (id) => setResourceIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  return (
    <Modal
      title="Submit assistance"
      description={`The response goes to ${getAgent(item.agentId).name} and resumes only this waiting Run.`}
      onClose={onClose}
      initialFocusRef={contextRef}
      footer={<><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={!context.trim() || !resourceIds.length} onClick={() => onSubmit({ context, resourceIds, manualResult, attachmentName })}>Submit assistance</button></>}
    >
      <label>Context for the Agent<textarea ref={contextRef} rows="4" value={context} onChange={(event) => setContext(event.target.value)} placeholder="Add the missing permission or source context" /></label>
      <fieldset><legend>Resources</legend>{resourceCatalog.map((resource) => {
        const checked = resourceIds.includes(resource.id);
        return <button type="button" role="checkbox" aria-checked={checked} className="check-row" key={resource.id} onClick={() => toggleResource(resource.id)}><span className="check-row__icon">{checked ? <CheckboxCheckedRegular /> : <CheckboxUncheckedRegular />}</span><span>{resource.label}<small>{resource.kind}</small></span></button>;
      })}</fieldset>
      <label>Manual action result<select value={manualResult} onChange={(event) => setManualResult(event.target.value)}><option value="access_confirmed">Access confirmed</option><option value="source_still_restricted">Source still restricted</option></select></label>
      <label>Supporting material<input type="file" accept=".md,.txt,.pdf" onChange={(event) => setAttachmentName(event.target.files?.[0]?.name || null)} /><small className="field-help">The fixture records only the filename.</small></label>
    </Modal>
  );
}

function PromptComposer({ mode, item, onClose, onSubmit }) {
  const [note, setNote] = useState("");
  const [agentId, setAgentId] = useState("research-navigator");
  const noteRef = useRef(null);
  const config = {
    direction: ["Add human direction", "Record a visible coordination event for the current owner.", "Add direction"],
    reassign: ["Reassign delegated task", "Change the current Agent owner without turning coordination into a Product fact.", "Reassign"],
    manual: ["Record manual disposition", "Close the reconciliation path without creating a Product success fact.", "Record disposition"],
  }[mode];
  return (
    <Modal
      title={config[0]}
      description={config[1]}
      onClose={onClose}
      initialFocusRef={mode === "reassign" ? undefined : noteRef}
      footer={<><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={mode !== "reassign" && !note.trim()} onClick={() => onSubmit(mode === "reassign" ? { agentId } : { note })}>{config[2]}</button></>}
    >
      {mode === "reassign" ? <label>New Agent owner<select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.filter((agent) => agent.id !== item.currentOwnerAgentId).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label> : <label>{mode === "manual" ? "Disposition" : "Direction"}<textarea ref={noteRef} rows="4" value={note} onChange={(event) => setNote(event.target.value)} /></label>}
    </Modal>
  );
}

function Toast({ notice, onClose }) {
  return (
    <div className={`toast ${notice.error ? "toast--error" : ""}`} role="status">
      {notice.error ? <DismissRegular /> : <CheckmarkCircleRegular />}
      <span>{notice.message}</span>
      <IconButton label="Dismiss notification" onClick={onClose}><DismissRegular /></IconButton>
    </div>
  );
}

export function App() {
  const initialRoute = useMemo(readRoute, []);
  const [items, setItems] = useState(cloneInitialFeedItems);
  const [tab, setTab] = useState(initialRoute.tab);
  const [selectedId, setSelectedId] = useState(initialRoute.taskId);
  const [mode, setMode] = useState(initialRoute.mode);
  const [agentId, setAgentId] = useState(initialRoute.agentId);
  const [projectId, setProjectId] = useState(initialRoute.projectId);
  const [view, setView] = useState(initialRoute.view);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [composer, setComposer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(items.filter((item) => item.candidate).map((item) => [item.id, { ...item.candidate }])));
  const noticeTimer = useRef(null);
  const systemTimer = useRef(null);
  const actionTriggerRef = useRef(null);
  const recordTriggerRef = useRef(null);
  const recordBackRef = useRef(null);
  const filterTriggerRef = useRef(null);
  const feedItemRefs = useRef(new Map());

  const summary = useMemo(() => getSummary(items), [items]);
  const visibleItems = useMemo(() => selectFeedItems(items, { tab, agentId, projectId }), [items, tab, agentId, projectId]);
  const selectedItem = selectedId ? items.find((item) => item.id === selectedId) || null : null;
  const hasFilters = agentId !== "all" || projectId !== "all";

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    query.set("tab", tab);
    if (selectedId) query.set("task", selectedId); else query.delete("task");
    query.set("mode", mode);
    if (agentId !== "all") query.set("agent", agentId); else query.delete("agent");
    if (projectId !== "all") query.set("project", projectId); else query.delete("project");
    if (view === "record") query.set("view", "record"); else query.delete("view");
    window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
  }, [tab, selectedId, mode, agentId, projectId, view]);

  useEffect(() => {
    if (selectedId && !visibleItems.some((item) => item.id === selectedId) && !selectedItem) setSelectedId(visibleItems[0]?.id || "");
  }, [selectedId, selectedItem, visibleItems]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || composer) return;
      if (view === "record") {
        event.preventDefault();
        setView("task");
        window.requestAnimationFrame(() => recordTriggerRef.current?.focus());
      } else if (window.matchMedia("(max-width: 850px)").matches && selectedId) {
        event.preventDefault();
        returnToFeed();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    window.clearTimeout(systemTimer.current);
    // Human input owns the pause. Opening a composer cancels the simulated Agent
    // clock so a delegated task cannot advance underneath an unfinished edit.
    if (composer) return undefined;
    const pending = items.find((item) => getSystemActionSet(item).length > 0);
    if (!pending) return undefined;
    const action = getSystemActionSet(pending)[0];
    const transitionDelay = pending.type === "delegation" ? 12000 : pending.type === "decision" ? 4200 : 3600;
    systemTimer.current = window.setTimeout(() => {
      const result = applyTransition(items, pending.id, action);
      if (!result.ok) return;
      setItems(result.items);
      if (selectedId === pending.id) setTab(groupForStatus(result.item.status));
      announce(result.notice);
    }, transitionDelay);
    return () => window.clearTimeout(systemTimer.current);
  }, [items, selectedId, composer]);

  useEffect(() => () => { window.clearTimeout(noticeTimer.current); window.clearTimeout(systemTimer.current); }, []);

  function announce(message, error = false) {
    window.clearTimeout(noticeTimer.current);
    setNotice({ message, error });
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000);
  }

  function runTransition(action, payload = {}) {
    if (!selectedItem) return;
    const effectivePayload = action === "accept_candidate" ? drafts[selectedItem.id] : payload;
    const result = applyTransition(items, selectedItem.id, action, effectivePayload || {});
    if (!result.ok) {
      announce(result.error, true);
      return;
    }
    setItems(result.items);
    const focusId = result.createdItemId || result.item.id;
    setSelectedId(focusId);
    setView("task");
    setTab(groupForStatus(result.item.status));
    if (result.createdItemId) setDrafts((current) => ({ ...current, [result.createdItemId]: { ...result.item.candidate } }));
    announce(result.notice);
  }

  function openComposer(type) {
    setComposer(type);
  }

  function closeComposer() {
    setComposer(null);
    window.requestAnimationFrame(() => actionTriggerRef.current?.focus());
  }

  function submitComposer(payload) {
    const actionByComposer = {
      feedback: "submit_feedback",
      assistance: "submit_assistance",
      direction: "add_direction",
      reassign: "reassign",
      manual: "manual_disposition",
    };
    const action = actionByComposer[composer];
    setComposer(null);
    runTransition(action, payload);
  }

  function changeTab(nextTab) {
    setTab(nextTab);
    setView("task");
    const next = selectFeedItems(items, { tab: nextTab, agentId, projectId })[0];
    setSelectedId(window.matchMedia("(max-width: 850px)").matches ? "" : next?.id || "");
  }

  function clearFilters() {
    setAgentId("all");
    setProjectId("all");
  }

  function selectTask(itemId) {
    setSelectedId(itemId);
    setView("task");
  }

  function returnToFeed() {
    const returningId = selectedId;
    setSelectedId("");
    setView("task");
    window.requestAnimationFrame(() => feedItemRefs.current.get(returningId)?.focus());
  }

  function openRecord() {
    setView("record");
    window.requestAnimationFrame(() => recordBackRef.current?.focus());
  }

  function backToTask() {
    setView("task");
    window.requestAnimationFrame(() => recordTriggerRef.current?.focus());
  }

  function refresh() {
    announce("Agent Feed refreshed. The current Product and Run projections are unchanged.");
  }

  return (
    <div className={`prototype-shell prototype-shell--${mode}`}>
      <header className="global-bar">
        <div className="global-bar__product"><span className="mobile-app-mark"><BotRegular /></span><strong>Power Apps</strong><span className="global-divider" /><span>Project Operations</span></div>
        <div className="global-search"><SearchRegular /><span>Search this app</span><kbd>⌘ K</kbd></div>
        <div className="global-bar__actions"><span>Human loop v0.2</span><span className="profile-chip">LX</span></div>
      </header>
      <AppNavigation />
      <main className="workspace">
        <header className="page-bar">
          <div><span className="breadcrumb">Workspace / Agent supervision</span><h1>Agent Feed</h1></div>
          <div className="page-bar__status"><span><i /> {summary.runningAgents} active</span><span>{agents.length} agents</span></div>
        </header>
        <div className="workspace-toolbar">
          <div><InfoRegular /><span>Feed items supervise typed work; Product and Run records remain authoritative.</span></div>
        </div>
        <div className="agent-feed-layout">
          {mode === "full" && <AgentFilterColumn agentId={agentId} onChange={setAgentId} items={items} />}
          <section className="feed-pane" aria-label="Agent tasks">
            <div className="feed-pane__heading">
              <div><span className="feed-kicker">Human · Agent · Run</span><h2>Agent Feed</h2></div>
              <div className="feed-pane__tools">
                <IconButton label="Refresh Agent Feed" onClick={refresh}><ArrowClockwiseRegular /></IconButton>
                <div className="popover-anchor">
                  <IconButton label="Filter Agent Feed" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} ref={filterTriggerRef}><FilterRegular /></IconButton>
                  {filtersOpen && <FilterPopover agentId={agentId} projectId={projectId} onAgentChange={setAgentId} onProjectChange={setProjectId} onClose={() => { setFiltersOpen(false); window.requestAnimationFrame(() => filterTriggerRef.current?.focus()); }} />}
                </div>
                <IconButton label={mode === "side" ? "Open full Agent Feed" : "Return to side pane"} onClick={() => setMode((current) => (current === "side" ? "full" : "side"))}>
                  {mode === "side" ? <ArrowMaximizeRegular /> : <PanelLeftExpandRegular />}
                </IconButton>
              </div>
            </div>
            <FeedTabs tab={tab} summary={summary} onChange={changeTab} />
            {hasFilters && <div className="active-filter"><FilterRegular /><span>{visibleItems.length} matching tasks</span><button type="button" onClick={clearFilters}>Clear</button></div>}
            <div className="feed-scroll" role="tabpanel">
              {visibleItems.length ? visibleItems.map((item) => <FeedItem key={item.id} item={item} selected={selectedId === item.id} onSelect={selectTask} itemRef={(node) => { if (node) feedItemRefs.current.set(item.id, node); }} />) : <EmptyFeed hasFilters={hasFilters} onClear={clearFilters} />}
              {visibleItems.length > 0 && <div className="feed-end">Showing all {visibleItems.length} items in this typed view</div>}
            </div>
          </section>
          <section className="detail-pane">
            {selectedItem ? (
              view === "record" ? (
                <RecordView item={selectedItem} onBack={backToTask} onReturnFeed={returnToFeed} backRef={recordBackRef} />
              ) : (
                <TaskDetail
                  item={selectedItem}
                  draft={drafts[selectedItem.id] || selectedItem.candidate || {}}
                  onDraftChange={(draft) => setDrafts((current) => ({ ...current, [selectedItem.id]: draft }))}
                  onAction={runTransition}
                  onOpenRecord={openRecord}
                  onBack={returnToFeed}
                  onOpenComposer={openComposer}
                  actionTriggerRef={actionTriggerRef}
                  recordTriggerRef={recordTriggerRef}
                />
              )
            ) : (
              <div className="detail-empty"><BotRegular /><strong>Select an Agent task</strong><span>Open a task to inspect who is waiting, the next owner, and the authoritative record.</span></div>
            )}
          </section>
        </div>
      </main>
      {composer === "feedback" && selectedItem && <FeedbackComposer item={selectedItem} onClose={closeComposer} onSubmit={submitComposer} />}
      {composer === "assistance" && selectedItem && <AssistanceComposer item={selectedItem} onClose={closeComposer} onSubmit={submitComposer} />}
      {["direction", "reassign", "manual"].includes(composer) && selectedItem && <PromptComposer mode={composer} item={selectedItem} onClose={closeComposer} onSubmit={submitComposer} />}
      {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
