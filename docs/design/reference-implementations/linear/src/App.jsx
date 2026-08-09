import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bell,
  CalendarBlank,
  CaretDown,
  CaretRight,
  ChartLineUp,
  ChatCircle,
  Check,
  CheckCircle,
  Circle,
  Clock,
  Columns,
  DotsThree,
  Eye,
  FileText,
  Folder,
  Funnel,
  Gauge,
  Tray,
  LinkSimple,
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Pulse,
  Robot,
  RocketLaunch,
  SlidersHorizontal,
  Smiley,
  Sparkle,
  SquaresFour,
  Tag,
  User,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";
import {
  addUpdateComment,
  createAgentDraft,
  createInitialState,
  discardDraft,
  editDraft,
  issueById,
  people,
  personById,
  projectById,
  publishDraft,
  pulseUpdates,
  reactToUpdate,
  setUpdateSchedule,
  startManualDraft,
  updateIssue,
  updatesForProject,
} from "./linearModel.js";

const views = new Set(["issues", "issue", "project", "pulse"]);

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const view = views.has(params.get("view")) ? params.get("view") : "issues";
  return {
    view,
    issueId: params.get("issue") || "issue-342",
    projectId: params.get("project") || "atlas",
    tab: params.get("tab") || "overview",
    feed: params.get("feed") || "for-me",
    peek: params.get("peek") === "1",
  };
}

function routeUrl(route) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", route.view);
  if (["issues", "issue"].includes(route.view)) url.searchParams.set("issue", route.issueId);
  if (route.view === "issues" && route.peek) url.searchParams.set("peek", "1");
  if (route.view === "project") {
    url.searchParams.set("project", route.projectId);
    url.searchParams.set("tab", route.tab);
  }
  if (route.view === "pulse") url.searchParams.set("feed", route.feed);
  return url;
}

function Avatar({ personId, size = "small" }) {
  const person = personById(personId);
  return <span className={`avatar avatar--${size} avatar--${person.color}`} title={person.name} aria-label={person.name}>{person.initials}</span>;
}

function StatusMark({ status }) {
  const icon = status === "Done" ? <Check size={11} weight="bold" /> : status === "Canceled" ? <X size={11} weight="bold" /> : status === "In progress" || status === "In review" ? <Circle size={12} weight="fill" /> : <Circle size={12} />;
  return <span className={`status-mark status-mark--${status.toLowerCase().replaceAll(" ", "-")}`}>{icon}<span>{status}</span></span>;
}

function HealthBadge({ health, stale = false }) {
  const label = health === "on-track" ? "On track" : health === "at-risk" ? "At risk" : "Off track";
  return <span className={`health-badge health-badge--${health} ${stale ? "health-badge--stale" : ""}`}><ChartLineUp size={14} weight="bold" /><span>{stale ? "Update missing" : label}</span></span>;
}

function Sidebar({ route, navigate }) {
  const navigation = [
    ["inbox", Tray, "Inbox"],
    ["issues", ListChecks, "My issues"],
    ["pulse", Waveform, "Pulse"],
  ];
  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <header className="workspace-switcher"><span className="workspace-mark"><SquaresFour size={18} weight="fill" /></span><strong>Northstar</strong><CaretDown size={14} /></header>
      <div className="sidebar-quick"><button type="button" disabled title="Global search is outside this focused reference path"><MagnifyingGlass size={17} />Search <kbd>Q</kbd></button><button type="button" disabled title="Issue creation is outside this focused reference path"><Plus size={17} />Create issue <kbd>C</kbd></button></div>
      <nav className="sidebar-nav">
        {navigation.map(([id, Icon, label]) => <button type="button" key={id} className={route.view === id || (id === "issues" && route.view === "issue") ? "is-active" : ""} disabled={id === "inbox"} title={id === "inbox" ? "Inbox triage is outside this focused reference path" : undefined} onClick={id === "pulse" ? () => navigate({ view: "pulse", feed: "for-me" }) : id === "issues" ? () => navigate({ view: "issues", issueId: route.issueId }) : undefined}><Icon size={17} /><span>{label}</span>{id === "inbox" && <em>3</em>}</button>)}
      </nav>
      <div className="sidebar-section"><p>Workspace</p><button type="button" className={route.view === "project" ? "is-active" : ""} onClick={() => navigate({ view: "project", projectId: "atlas", tab: "overview" })}><Folder size={17} /><span>Projects</span></button><button type="button" disabled title="Saved views are outside this focused reference path"><Columns size={17} /><span>Views</span></button></div>
      <div className="sidebar-section sidebar-section--favorites"><p>Favorites</p><button type="button" onClick={() => navigate({ view: "project", projectId: "atlas", tab: "overview" })}><span className="project-glyph project-glyph--violet">A</span><span>Atlas workspace refresh</span></button><button type="button" onClick={() => navigate({ view: "project", projectId: "relay", tab: "overview" })}><span className="project-glyph project-glyph--cyan">R</span><span>Relay reliability</span></button></div>
      <footer><Avatar personId="maya" /><span><strong>Maya Chen</strong><small>Product</small></span><DotsThree size={18} /></footer>
    </aside>
  );
}

function AppShell({ route, navigate, children }) {
  const [shellNotice, setShellNotice] = useState("");
  const shellTimer = useRef(null);
  const shellReferenceMessages = {
    "Project notifications": "Project notification settings are outside this focused reference path.",
    "Project menu": "Additional project actions are outside this focused reference path.",
    "Project brief": "Project brief opened in this reference context.",
    "Prototype review": "Prototype review opened in this reference context.",
  };
  useEffect(() => () => window.clearTimeout(shellTimer.current), []);
  const explainReferenceControl = (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const name = button.getAttribute("aria-label") || button.textContent.replace(/\s+/g, " ").trim();
    const message = shellReferenceMessages[name];
    if (!message) return;
    window.clearTimeout(shellTimer.current);
    setShellNotice(message);
    shellTimer.current = window.setTimeout(() => setShellNotice(""), 2400);
  };
  return <div className="linear-app" onClickCapture={explainReferenceControl}><Sidebar route={route} navigate={navigate} /><main className="app-main">{children}</main><nav className="mobile-nav" aria-label="Mobile navigation"><button type="button" onClick={() => navigate({ view: "issues", issueId: route.issueId })}><ListChecks size={20} /><span>Issues</span></button><button type="button" onClick={() => navigate({ view: "project", projectId: "atlas", tab: "overview" })}><Folder size={20} /><span>Projects</span></button><button type="button" onClick={() => navigate({ view: "pulse", feed: "for-me" })}><Waveform size={20} /><span>Pulse</span></button></nav>{shellNotice && <div className="toast" role="status">{shellNotice}</div>}</div>;
}

function IssueRow({ issue, selected, onSelect, onOpen, rowRef }) {
  return (
    <div ref={rowRef} className={`issue-row ${selected ? "is-selected" : ""}`} role="row" tabIndex={selected ? 0 : -1} onClick={onSelect} onDoubleClick={onOpen}>
      <span role="cell" className="issue-status"><StatusMark status={issue.status} /></span>
      <button type="button" role="cell" className="issue-title" onClick={(event) => { event.stopPropagation(); onOpen(); }}><span>{issue.key}</span><strong>{issue.title}</strong></button>
      <span role="cell" className="issue-label"><Tag size={13} />{issue.label}</span>
      <span role="cell" className="issue-cycle"><Gauge size={14} />{issue.cycle}</span>
      <span role="cell" className="issue-estimate">{issue.estimate}</span>
      <span role="cell" className="issue-assignee"><Avatar personId={issue.assigneeId} size="tiny" /></span>
      <button type="button" className="row-peek" aria-label={`Peek ${issue.title}`} title="Peek · Space" onClick={(event) => { event.stopPropagation(); onSelect(true); }}><Eye size={17} /></button>
    </div>
  );
}

function PeekCard({ issue, onClose, onOpen, onPrevious, onNext }) {
  return (
    <div className="peek-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="peek-card" role="dialog" aria-modal="true" aria-labelledby="peek-title">
        <header><span>{issue.key}</span><div><button type="button" aria-label="Previous issue" onClick={onPrevious}><ArrowUp size={16} /></button><button type="button" aria-label="Next issue" onClick={onNext}><ArrowDown size={16} /></button><button type="button" aria-label="Close Peek" onClick={onClose}><X size={17} /></button></div></header>
        <h2 id="peek-title">{issue.title}</h2>
        <div className="peek-properties"><StatusMark status={issue.status} /><span><WarningCircle size={14} />{issue.priority}</span><span><Avatar personId={issue.assigneeId} size="micro" />{personById(issue.assigneeId).name}</span><span><Gauge size={14} />{issue.cycle}</span><span><Tag size={13} />{issue.label}</span></div>
        <p>{issue.description}</p>
        <dl><div><dt>Estimate</dt><dd>{issue.estimate} points</dd></div><div><dt>Created</dt><dd>{issue.created}</dd></div><div><dt>Updated</dt><dd>{issue.updated}</dd></div></dl>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Esc</kbd> close</span><button type="button" onClick={onOpen}>Open full issue <CaretRight size={15} /></button></footer>
      </section>
    </div>
  );
}

function IssuesView({ state, setState, route, navigate }) {
  const [statusFilter, setStatusFilter] = useState("All");
  const rowRefs = useRef(new Map());
  const spaceStarted = useRef(0);
  const peekWasOpen = useRef(false);
  const selectedIssue = issueById(state, route.issueId);
  const visibleIssues = useMemo(() => statusFilter === "All" ? state.issues : state.issues.filter((issue) => issue.status === statusFilter), [state.issues, statusFilter]);
  const selectedIndex = Math.max(0, visibleIssues.findIndex((issue) => issue.id === selectedIssue.id));
  const setSelection = (issueId, openPeek = false) => navigate({ view: "issues", issueId, peek: openPeek || route.peek }, "replace");
  const moveSelection = (offset) => {
    const next = visibleIssues[(selectedIndex + offset + visibleIssues.length) % visibleIssues.length];
    if (next) navigate({ view: "issues", issueId: next.id, peek: route.peek }, "replace");
  };

  useEffect(() => {
    const keyDown = (event) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) { spaceStarted.current = Date.now(); peekWasOpen.current = route.peek; }
        if (!route.peek) navigate({ view: "issues", issueId: selectedIssue.id, peek: true }, "replace");
      }
      if (route.peek && event.key === "ArrowDown") { event.preventDefault(); moveSelection(1); }
      if (route.peek && event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1); }
      if (route.peek && event.key === "Escape") { event.preventDefault(); navigate({ view: "issues", issueId: selectedIssue.id, peek: false }, "replace"); }
    };
    const keyUp = (event) => {
      if (event.code !== "Space" || !spaceStarted.current) return;
      const held = Date.now() - spaceStarted.current;
      if (held >= 380 || peekWasOpen.current) navigate({ view: "issues", issueId: selectedIssue.id, peek: false }, "replace");
      spaceStarted.current = 0;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); };
  }, [route.peek, selectedIssue.id, selectedIndex, visibleIssues.length]);

  useEffect(() => { if (!route.peek) rowRefs.current.get(selectedIssue.id)?.focus(); }, [route.peek, selectedIssue.id]);

  return (
    <AppShell route={route} navigate={navigate}>
      <header className="page-header"><div><span>Workspace</span><h1>My issues</h1></div><div className="header-actions"><button type="button" disabled title="Notification settings are outside this focused reference path" aria-label="Notification settings"><Bell size={18} /></button><button type="button" disabled title="View controls are outside this focused reference path" aria-label="View controls"><SlidersHorizontal size={18} /></button><button type="button" className="primary-action" disabled title="Issue creation is outside this focused reference path"><Plus size={17} />New issue</button></div></header>
      <div className="view-toolbar"><div className="segmented"><button type="button" className="is-active" disabled title="Current view"><ListBullets size={16} />List</button><button type="button" disabled title="Board view is outside this focused reference path"><Columns size={16} />Board</button></div><div><label className="filter-select"><Funnel size={15} /><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>{["All", "Todo", "In progress", "In review", "Done", "Canceled"].map((status) => <option key={status}>{status}</option>)}</select></label><button type="button" className="peek-shortcut" onClick={() => navigate({ view: "issues", issueId: selectedIssue.id, peek: true }, "replace")}><Eye size={16} />Peek <kbd>Space</kbd></button></div></div>
      <section className="issue-table" role="table" aria-label="My issues"><header role="row"><span>Status</span><span>Issue</span><span>Label</span><span>Cycle</span><span>Pts</span><span>Owner</span><span /></header><div className="issue-group"><h2><CaretDown size={15} />Active <small>{visibleIssues.filter((issue) => !["Done", "Canceled"].includes(issue.status)).length}</small></h2>{visibleIssues.filter((issue) => !["Done", "Canceled"].includes(issue.status)).map((issue) => <IssueRow key={issue.id} issue={issue} selected={issue.id === selectedIssue.id} onSelect={(openPeek = false) => setSelection(issue.id, openPeek)} onOpen={() => navigate({ view: "issue", issueId: issue.id })} rowRef={(node) => node && rowRefs.current.set(issue.id, node)} />)}</div><div className="issue-group"><h2><CaretDown size={15} />Closed <small>{visibleIssues.filter((issue) => ["Done", "Canceled"].includes(issue.status)).length}</small></h2>{visibleIssues.filter((issue) => ["Done", "Canceled"].includes(issue.status)).map((issue) => <IssueRow key={issue.id} issue={issue} selected={issue.id === selectedIssue.id} onSelect={(openPeek = false) => setSelection(issue.id, openPeek)} onOpen={() => navigate({ view: "issue", issueId: issue.id })} rowRef={(node) => node && rowRefs.current.set(issue.id, node)} />)}</div></section>
      {route.peek && <PeekCard issue={selectedIssue} onClose={() => navigate({ view: "issues", issueId: selectedIssue.id, peek: false }, "replace")} onOpen={() => navigate({ view: "issue", issueId: selectedIssue.id })} onPrevious={() => moveSelection(-1)} onNext={() => moveSelection(1)} />}
    </AppShell>
  );
}

function IssueDetail({ state, setState, route, navigate, goBack, announce }) {
  const issue = issueById(state, route.issueId);
  return (
    <AppShell route={route} navigate={navigate}>
      <header className="detail-topbar"><button type="button" onClick={() => goBack({ view: "issues", issueId: issue.id })}><ArrowLeft size={17} />Back to issues</button><div><button type="button" onClick={async () => { await navigator.clipboard?.writeText(window.location.href); announce("Issue link copied"); }}><LinkSimple size={17} />Copy link</button><button type="button" disabled title="Additional issue actions are outside this focused reference path" aria-label="Additional issue actions"><DotsThree size={19} /></button></div></header>
      <article className="issue-detail"><header><span>{issue.key}</span><h1>{issue.title}</h1></header><div className="issue-detail__body"><section><p>{issue.description}</p><div className="detail-section"><h2>Activity</h2><div className="activity-entry"><Avatar personId="maya" /><div><strong>Maya Chen</strong><span>clarified the recovery behavior · 18 min ago</span><p>Keep the temporary view fast, but make the full detail a deliberate navigation step.</p></div></div></div></section><aside><label>Status<select value={issue.status} onChange={(event) => { setState((current) => updateIssue(current, issue.id, { status: event.target.value, updated: "Just now" })); announce("Issue status updated"); }}>{["Todo", "In progress", "In review", "Done", "Canceled"].map((status) => <option key={status}>{status}</option>)}</select></label><label>Assignee<select value={issue.assigneeId} onChange={(event) => setState((current) => updateIssue(current, issue.id, { assigneeId: event.target.value, updated: "Just now" }))}>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><dl><div><dt>Priority</dt><dd>{issue.priority}</dd></div><div><dt>Cycle</dt><dd>{issue.cycle}</dd></div><div><dt>Label</dt><dd>{issue.label}</dd></div><div><dt>Estimate</dt><dd>{issue.estimate} points</dd></div></dl></aside></div></article>
    </AppShell>
  );
}

function UpdateCard({ state, update, navigate, setState, openThread = true }) {
  const project = projectById(state, update.projectId);
  return <article className="update-card"><header><div><span className={`project-glyph project-glyph--${project.id === "atlas" ? "violet" : project.id === "relay" ? "cyan" : "amber"}`}>{project.name[0]}</span><button type="button" onClick={() => navigate({ view: "project", projectId: project.id, tab: "overview" })}>{project.name}</button></div><DotsThree size={18} /></header><div className="update-meta"><HealthBadge health={update.health} /><span><Avatar personId={update.authorId} size="micro" />{personById(update.authorId).name}</span><time>{update.created}</time>{update.assistedByAgent && <span className="assisted-label"><Sparkle size={13} />Agent-assisted</span>}</div><h2>{update.takeaway}</h2><div className="update-body">{update.body.split("\n").filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>{update.observedChanges.length > 0 && <details className="observed-changes"><summary>Observed changes since previous update</summary><ul>{update.observedChanges.map((change) => <li key={change}><CheckCircle size={15} />{change}</li>)}</ul></details>}<footer><button type="button" aria-label={`React with eyes to ${project.name} update`} onClick={() => setState((current) => reactToUpdate(current, update.id, "eyes"))}><Eye size={17} />{update.reactions.eyes || 0}</button><button type="button" aria-label={`React with rocket to ${project.name} update`} onClick={() => setState((current) => reactToUpdate(current, update.id, "rocket"))}><RocketLaunch size={17} />{update.reactions.rocket || 0}</button>{openThread && <button type="button" onClick={() => navigate({ view: "project", projectId: project.id, tab: "updates" })}><ChatCircle size={17} />{update.comments.length} comments</button>}<button type="button" disabled title="Use the two available reactions in this focused reference path" aria-label="More reactions"><Smiley size={17} /></button></footer></article>;
}

function UpdateComposer({ state, setState, project, onClose, announce }) {
  const draft = state.draft;
  useEffect(() => { if (!draft) setState((current) => startManualDraft(current, project.id)); }, []);
  if (!draft) return null;
  const canPublish = Boolean(draft.body.trim() && draft.health);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="update-composer" role="dialog" aria-modal="true" aria-labelledby="composer-title"><header><div><span>Project update</span><h2 id="composer-title">{project.name}</h2></div><button type="button" aria-label="Close update composer" onClick={onClose}><X size={19} /></button></header><div className="health-choice" role="radiogroup" aria-label="Project health">{[["on-track", "On track"], ["at-risk", "At risk"], ["off-track", "Off track"]].map(([health, label]) => <button type="button" role="radio" aria-checked={draft.health === health} className={draft.health === health ? "is-selected" : ""} key={health} onClick={() => setState((current) => editDraft(current, { health }))}><HealthBadge health={health} /><span>{label}</span></button>)}</div><div className="agent-draft-row"><div><Sparkle size={18} weight="fill" /><span><strong>Start from recent project context</strong><small>Issues, documents, discussions, and linked Slack summary</small></span></div><button type="button" onClick={() => { setState((current) => createAgentDraft(current, project.id)); announce("Agent candidate drafted — review before publishing"); }}><Robot size={17} />{draft.source === "agent" ? "Regenerate" : "Write with Agent"}</button></div>{draft.source === "agent" && <aside className="candidate-banner"><Sparkle size={17} /><div><strong>Agent candidate — not published</strong><span>Review the evidence and add your own judgment before publishing.</span></div></aside>}<textarea autoFocus aria-label="Project update narrative" value={draft.body} onChange={(event) => setState((current) => editDraft(current, { body: event.target.value }))} placeholder="Share progress, risks, and what happens next…" />{draft.sources.length > 0 && <section className="draft-sources"><h3>Sources used</h3>{draft.sources.map((source) => <span key={source}><FileText size={14} />{source}</span>)}</section>}{draft.observedChanges.length > 0 && <section className="draft-changes"><h3>Observed changes</h3>{draft.observedChanges.map((change) => <span key={change}><Check size={14} />{change}</span>)}</section>}<footer><button type="button" className="secondary" onClick={() => { setState(discardDraft); onClose(); }}>Discard</button><button type="button" className="publish" disabled={!canPublish} title={!canPublish ? "Choose health and write an update first" : "Publish project update"} onClick={() => { setState((current) => publishDraft(current)); announce("Project update published to Overview, history, and Pulse"); onClose(); }}>Publish update</button></footer></section></div>;
}

function ScheduleDialog({ project, setState, onClose, announce }) {
  const [schedule, setSchedule] = useState(project.updateSchedule);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-title"><header><div><h2 id="schedule-title">Update schedule</h2><p>Configure how often updates are expected on this project.</p></div><button type="button" aria-label="Close schedule" onClick={onClose}><X size={18} /></button></header><div className="schedule-options">{[["default", "Default", "Every week on Monday 11am–12pm"], ["custom", "Custom schedule", "Choose a cadence for this project"], ["never", "Never", "No update is expected"]].map(([mode, label, copy]) => <label key={mode}><input type="radio" name="schedule" checked={schedule.mode === mode} onChange={() => setSchedule({ ...schedule, mode })} /><span><strong>{label}</strong><small>{copy}</small></span></label>)}</div>{schedule.mode === "custom" && <div className="schedule-fields"><label>Frequency<select value={schedule.frequency} onChange={(event) => setSchedule({ ...schedule, frequency: event.target.value })}><option>Every week</option><option>Every 2 weeks</option><option>Every month</option></select></label><label>Day<select value={schedule.day} onChange={(event) => setSchedule({ ...schedule, day: event.target.value })}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day) => <option key={day}>{day}</option>)}</select></label><label>Time<select value={schedule.time} onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}><option>09:00–10:00</option><option>11:00–12:00</option><option>15:00–16:00</option></select></label></div>}<footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="button" className="publish" onClick={() => { setState((current) => setUpdateSchedule(current, project.id, schedule)); announce("Update schedule saved"); onClose(); }}>Save schedule</button></footer></section></div>;
}

function ProjectView({ state, setState, route, navigate, announce }) {
  const project = projectById(state, route.projectId);
  const updates = updatesForProject(state, project.id);
  const [composerOpen, setComposerOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const latest = updates[0];
  const updateDue = project.id === "relay";
  const tab = ["overview", "issues", "updates"].includes(route.tab) ? route.tab : "overview";
  return <AppShell route={route} navigate={navigate}><header className="project-header"><div className="project-heading"><span className={`project-glyph project-glyph--${project.id === "atlas" ? "violet" : project.id === "relay" ? "cyan" : "amber"}`}>{project.name[0]}</span><div><span>Project</span><h1>{project.name}</h1><p>{project.summary}</p></div></div><div className="header-actions"><button type="button" aria-label="Project notifications"><Bell size={18} /></button><button type="button" aria-label="Project menu"><DotsThree size={19} /></button><button type="button" className="primary-action" onClick={() => { setState((current) => startManualDraft(current, project.id)); setComposerOpen(true); }}><PencilSimple size={17} />Write update</button></div></header><div className="project-properties"><span><StatusMark status={project.status} /></span><span><Avatar personId={project.leadId} size="micro" />{personById(project.leadId).name}</span><span><CalendarBlank size={15} />{project.targetDate}</span><span><Gauge size={15} />{project.progress}%</span><button type="button" className={updateDue ? "is-due" : ""} onClick={() => setScheduleOpen(true)}><Clock size={15} />{updateDue ? "Update due" : project.updateSchedule.mode === "never" ? "No update expected" : project.updateSchedule.frequency}</button></div><nav className="project-tabs">{[["overview", "Overview"], ["issues", `Issues ${state.issues.filter((issue) => issue.projectId === project.id).length}`], ["updates", `Updates ${updates.length}`]].map(([id, label]) => <button type="button" className={tab === id ? "is-active" : ""} key={id} onClick={() => navigate({ view: "project", projectId: project.id, tab: id })}>{label}</button>)}</nav>{tab === "overview" && <div className="project-overview"><section className="overview-main"><div className="overview-section"><header><div><h2>Latest update</h2><span>Project health is a lead’s judgment, not an automatic completion score.</span></div>{latest && <HealthBadge health={latest.health} stale={updateDue} />}</header>{latest ? <UpdateCard state={state} update={latest} navigate={navigate} setState={setState} /> : <div className="empty-state"><ChartLineUp size={26} /><h3>No update yet</h3><p>The project lead can publish the first health judgment.</p></div>}</div><div className="overview-section"><header><div><h2>Milestones</h2><span>Plan progress without turning it into project health.</span></div></header><div className="milestone"><span><CheckCircle size={18} weight="fill" /></span><div><strong>Interaction model</strong><small>Completed Jul 28</small></div><em>100%</em></div><div className="milestone"><span><Circle size={18} weight="fill" /></span><div><strong>Implementation and QA</strong><small>Target Sep 5</small></div><em>{project.progress}%</em></div></div></section><aside className="project-aside"><section><h2>Resources</h2><button type="button"><FileText size={17} /><span><strong>Project brief</strong><small>Updated yesterday</small></span></button><button type="button"><LinkSimple size={17} /><span><strong>Prototype review</strong><small>figma.com</small></span></button></section><section><h2>Activity</h2><p><Avatar personId="maya" size="micro" />Maya changed progress to {project.progress}%</p><p><Avatar personId="roman" size="micro" />Roman completed LIN-319</p></section></aside></div>}{tab === "issues" && <section className="project-issues">{state.issues.filter((issue) => issue.projectId === project.id).map((issue) => <IssueRow key={issue.id} issue={issue} selected={false} onSelect={() => navigate({ view: "issues", issueId: issue.id, peek: true })} onOpen={() => navigate({ view: "issue", issueId: issue.id })} />)}</section>}{tab === "updates" && <section className="updates-history"><header><div><h2>Project update history</h2><p>Authored judgments and observed project changes remain distinct.</p></div><button type="button" className="primary-action" onClick={() => { setState((current) => startManualDraft(current, project.id)); setComposerOpen(true); }}><Plus size={17} />New update</button></header>{updates.map((update, index) => <div className="history-entry" key={update.id}><span className="history-line"><Circle size={13} weight="fill" /></span><UpdateCard state={state} update={update} navigate={navigate} setState={setState} /><div className="history-change"><Pulse size={15} /><span><strong>Observed project changes</strong><small>{update.observedChanges.join(" · ")}</small></span></div>{index === 0 && <div className="comment-box"><h3>Discussion</h3>{update.comments.map((comment) => <p key={comment.id}><Avatar personId={comment.authorId} size="micro" /><span><strong>{personById(comment.authorId).name}</strong>{comment.body}</span><time>{comment.created}</time></p>)}<div><input value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && commentDraft.trim()) { setState((current) => addUpdateComment(current, update.id, commentDraft)); setCommentDraft(""); } }} placeholder="Discuss this update…" /><button type="button" disabled={!commentDraft.trim()} onClick={() => { setState((current) => addUpdateComment(current, update.id, commentDraft)); setCommentDraft(""); }}>Comment</button></div></div>}</div>)}</section>}{composerOpen && <UpdateComposer state={state} setState={setState} project={project} onClose={() => { setComposerOpen(false); if (state.draft) setState(discardDraft); }} announce={announce} />}{scheduleOpen && <ScheduleDialog project={project} setState={setState} onClose={() => setScheduleOpen(false)} announce={announce} />}</AppShell>;
}

function PulseView({ state, setState, route, navigate, announce }) {
  const [subscribed, setSubscribed] = useState(false);
  const updates = pulseUpdates(state, route.feed);
  const feedLabel = route.feed === "popular" ? "Popular" : route.feed === "recent" ? "Recent" : route.feed.startsWith("custom:") ? state.userFeeds.find((feed) => `custom:${feed.id}` === route.feed)?.name || "Custom feed" : "For me";
  return <AppShell route={route} navigate={navigate}><header className="page-header"><div><span>Workspace</span><h1>Pulse</h1></div><div className="header-actions"><button type="button" aria-pressed={subscribed} onClick={() => { setSubscribed((current) => !current); announce(subscribed ? "Pulse subscription paused" : "Subscribed to Pulse summary"); }}><Bell size={18} />{subscribed ? "Subscribed" : "Subscribe"}</button><button type="button" disabled title="Additional Pulse actions are outside this focused reference path" aria-label="Additional Pulse actions"><DotsThree size={19} /></button></div></header><nav className="pulse-tabs">{[["for-me", "For me"], ["popular", "Popular"], ["recent", "Recent"]].map(([id, label]) => <button type="button" className={route.feed === id ? "is-active" : ""} key={id} onClick={() => navigate({ view: "pulse", feed: id })}>{label}</button>)}{state.userFeeds.map((feed) => <button type="button" className={route.feed === `custom:${feed.id}` ? "is-active" : ""} key={feed.id} onClick={() => navigate({ view: "pulse", feed: `custom:${feed.id}` })}>{feed.name}</button>)}<button type="button" aria-label="Create custom feed" title="Show the at-risk custom feed example" onClick={() => navigate({ view: "pulse", feed: "custom:feed-risk" })}><Plus size={16} /></button></nav><section className="pulse-layout"><aside><p>{feedLabel}</p><h2>{feedLabel === "For me" ? "Updates from projects connected to your work." : feedLabel === "Popular" ? "Recent updates with the most discussion and reactions." : feedLabel === "Recent" ? "All published updates, newest first." : "A personal view filtered to at-risk projects."}</h2>{feedLabel === "Popular" && <div className="feed-warning"><WarningCircle size={17} /><span>Engagement ordering is useful for exploration, but it is not the default responsibility view.</span></div>}</aside><div className="pulse-feed">{updates.map((update) => <UpdateCard key={update.id} state={state} update={update} navigate={navigate} setState={setState} />)}</div></section></AppShell>;
}

export function App() {
  const [state, setState] = useState(createInitialState);
  const [route, setRoute] = useState(readRoute);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(null);
  const announce = (message) => { window.clearTimeout(noticeTimer.current); setNotice(message); noticeTimer.current = window.setTimeout(() => setNotice(""), 2600); };
  const navigate = (next, mode = "push") => {
    const complete = { issueId: "issue-342", projectId: "atlas", tab: "overview", feed: "for-me", peek: false, ...next };
    const url = routeUrl(complete);
    if (mode === "replace") window.history.replaceState({ linear: true, route: complete }, "", url);
    else window.history.pushState({ linear: true, route: complete }, "", url);
    setRoute(complete);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const goBack = (fallback) => window.history.state?.linear ? window.history.back() : navigate(fallback, "replace");
  useEffect(() => { if (!window.history.state?.linear) window.history.replaceState({ linear: true, route }, "", window.location.href); const pop = () => setRoute(readRoute()); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  let screen;
  if (route.view === "issue") screen = <IssueDetail state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} announce={announce} />;
  else if (route.view === "project") screen = <ProjectView state={state} setState={setState} route={route} navigate={navigate} announce={announce} />;
  else if (route.view === "pulse") screen = <PulseView state={state} setState={setState} route={route} navigate={navigate} announce={announce} />;
  else screen = <IssuesView state={state} setState={setState} route={route} navigate={navigate} />;
  return <>{screen}{notice && <div className="toast" role="status">{notice}</div>}</>;
}
