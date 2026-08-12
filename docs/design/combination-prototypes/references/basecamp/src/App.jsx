import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "./vendor/chart/chart.js";
import {
  addComment,
  addChatMessage,
  addDocument,
  addHillUpdate,
  addMessageReply,
  addMessageThread,
  addScheduleEvent,
  addSubtask,
  addToolItem,
  addWorkflowCard,
  aggregateViews,
  avatars,
  createFolder,
  createInitialState,
  createProject,
  createTodo,
  filterTodos,
  listDefinitions,
  moveWorkflowCard,
  people,
  personById,
  projectById,
  quickFind,
  removeComment,
  todoById,
  todosForProject,
  toggleProjectStar,
  toggleSubtask,
  toggleTodo,
  toggleTodoBookmark,
  toolCatalog,
  updateTodo,
} from "./basecampModel.js";

const combinationModes = new Set(["room-linear", "room-basecamp", "work-linear"]);
const linearWorkModes = new Set(["room-linear", "work-linear"]);

function compositionMode() {
  return new URLSearchParams(window.location.search).get("composition") || "";
}

function inCombination() {
  return combinationModes.has(compositionMode());
}

function delegatesWorkToHost() {
  return linearWorkModes.has(compositionMode());
}

function isBasecampWorkRoute(route) {
  return route.view === "todo"
    || (route.view === "tool" && route.toolId === "todos")
    || (route.view === "aggregate" && route.aggregateId === "my-tasks");
}

function hostSceneForRoute(route) {
  if (!combinationModes.has(compositionMode())) return "";
  if ((route.view === "aggregate" && ["calendar", "my-events"].includes(route.aggregateId)) || (route.view === "tool" && route.toolId === "schedule")) return "calendar";
  if (route.view === "aggregate" && route.aggregateId === "do-today") return "today";
  if (delegatesWorkToHost() && isBasecampWorkRoute(route)) return "work";
  return "";
}

function postHostRoute(scene, { projectId = "", workId = "" } = {}) {
  const current = new URLSearchParams(window.location.search);
  const target = new URLSearchParams();
  const composition = compositionMode();
  if (combinationModes.has(composition)) target.set("composition", composition);
  target.set("scene", scene);
  if (projectId) target.set("project", projectId);
  if (workId) target.set("work", workId);
  if (current.get("theme")) target.set("theme", current.get("theme"));
  window.parent.postMessage({ type: "chat:route", scene, url: `?${target.toString()}` }, window.location.origin);
}

function postHostScene(scene, route) {
  postHostRoute(scene, { projectId: route.projectId, workId: scene === "work" ? route.todoId : "" });
}

const allowedViews = new Set(["home", "folder", "aggregate", "project", "tool", "todo"]);

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view") || "home";
  if (rawView === "todos") {
    return { view: "tool", projectId: params.get("project") || "enormicom", toolId: "todos" };
  }
  if (rawView === "todo") {
    return {
      view: "todo",
      projectId: params.get("project") || "enormicom",
      toolId: "todos",
      todoId: params.get("todo") || "kickoff",
    };
  }
  const view = allowedViews.has(rawView) ? rawView : "home";
  return {
    view,
    projectId: params.get("project") || "enormicom",
    toolId: params.get("tool") || "todos",
    todoId: params.get("todo") || "kickoff",
    aggregateId: params.get("section") || "activity",
    folderId: params.get("folder") || "client-work",
    personId: params.get("person") || "",
  };
}

function routeUrl(route) {
  const url = new URL(window.location.href);
  const context = new URLSearchParams(url.search);
  url.search = "";
  url.hash = "";
  for (const key of ["composition", "embedded", "theme"]) {
    if (context.has(key)) url.searchParams.set(key, context.get(key));
  }
  url.searchParams.set("view", route.view);
  if (["project", "tool", "todo"].includes(route.view) && route.projectId) url.searchParams.set("project", route.projectId);
  if (["tool", "todo"].includes(route.view) && route.toolId) url.searchParams.set("tool", route.toolId);
  if (route.view === "todo" && route.todoId) url.searchParams.set("todo", route.todoId);
  if (route.view === "aggregate" && route.aggregateId) url.searchParams.set("section", route.aggregateId);
  if (route.view === "aggregate" && route.personId) url.searchParams.set("person", route.personId);
  if (route.view === "folder" && route.folderId) url.searchParams.set("folder", route.folderId);
  return url;
}

function Icon({ name }) {
  return <i aria-hidden="true" className={`fa-solid ${name}`} />;
}

function Avatar({ name, size = "small", title }) {
  return <img className={`avatar avatar--${size}`} src={avatars[name] || avatars.geoff} alt={title || ""} />;
}

function HomeHeader({ navigate, active }) {
  const links = [
    ["activity", "fa-chart-line", "Activity"],
    ["calendar", "fa-calendar-day", "Calendar"],
    ["reports", "fa-chart-pie", "Reports"],
    ["everything", "fa-earth-americas", "Everything"],
  ];
  return (
    <header className="home-header" aria-label="Global navigation">
      <nav className="home-header__nav">
        {links.slice(0, 2).map(([id, icon, label]) => (
          <button
            type="button"
            key={id}
            className={`plain-nav ${active === id ? "is-active" : ""}`}
            onClick={() => id === "calendar" && inCombination() ? postHostRoute("calendar") : navigate({ view: "aggregate", aggregateId: id })}
          >
            <Icon name={icon} />
            {label}
          </button>
        ))}
        <button type="button" className="brand-nav" aria-label="Basecamp" onClick={() => navigate({ view: "home" })}>
          <img src="/reference-assets/basecamp/marks/basecamp-mask.svg" alt="" />
          <strong>Basecamp</strong>
        </button>
        {links.slice(2).map(([id, icon, label]) => (
          <button
            type="button"
            key={id}
            className={`plain-nav ${active === id ? "is-active" : ""}`}
            onClick={() => navigate({ view: "aggregate", aggregateId: id })}
          >
            <Icon name={icon} />
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

function ProjectCard({ project, onStar, onOpen }) {
  return (
    <article className="project-card">
      <button className="project-card__body" type="button" onClick={onOpen}>
        <span className="project-card__name">
          {project.decorated && <Icon name="fa-star" />}
          {project.name}
          {project.decorated && <Icon name="fa-star" />}
        </span>
        {project.note && (
          <span className="project-card__note">
            {project.id === "accounting" ? (
              <>We know where the <Icon name="fa-sack-dollar" /> is at!</>
            ) : project.note}
          </span>
        )}
      </button>
      <button
        className={`star-button ${project.starred ? "star-button--active" : ""}`}
        type="button"
        aria-label={`${project.starred ? "Unstar" : "Star"} ${project.name}`}
        aria-pressed={project.starred}
        onClick={onStar}
      >
        <Icon name="fa-star" />
      </button>
      {project.people?.length > 0 && (
        <div className="project-card__people" aria-label={`${project.people.length} people`}>
          {project.people.slice(0, 6).map((person) => <Avatar key={person} name={person} size="tiny" />)}
        </div>
      )}
      {project.access && <span className="access-chip">{project.access}</span>}
      {project.footer && <strong className="project-card__footer">{project.footer}</strong>}
    </article>
  );
}

function ActivityItem({ item, state, navigate }) {
  const project = projectById(state, item.projectId);
  return (
    <li className="activity-item">
      <span className="activity-item__dot" aria-hidden="true" />
      <time>{item.when}</time>
      <div className="activity-item__copy">
        <span className={`activity-type activity-type--${item.tone}`}><Icon name={item.icon} /></span>
        <span className="activity-avatars">
          {item.people.slice(0, 3).map((person) => <Avatar key={person} name={person} size="micro" />)}
        </span>
        <strong>{item.lead}</strong> {item.text}{" "}
        <button type="button" className="inline-link" onClick={() => navigate(item.target)}>{item.link}</button>
        <span> — {project.name}</span>
      </div>
    </li>
  );
}

function HomeScreen({ state, setState, navigate, openDialog }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const searchRef = useRef(null);
  const results = useMemo(() => quickFind(state, query), [state, query]);
  const visibleProjects = useMemo(() => {
    if (!query.trim()) return state.projects;
    const needle = query.toLowerCase();
    return state.projects.filter((project) => `${project.name} ${project.note}`.toLowerCase().includes(needle));
  }, [query, state.projects]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const chooseResult = (result) => {
    setQuery("");
    navigate(result.target);
  };

  const handleSearchKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      searchRef.current?.blur();
    }
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setHighlighted((value) => (value + 1) % results.length);
    }
    if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setHighlighted((value) => (value - 1 + results.length) % results.length);
    }
    if (event.key === "Enter" && results[highlighted]) {
      event.preventDefault();
      chooseResult(results[highlighted]);
    }
  };

  return (
    <div className={`home-screen home-screen--theme-${state.themeIndex}`}>
      <HomeHeader navigate={navigate} />
      <main className="home-layout">
        <aside className="admin-column" aria-label="Account actions">
          <h1>Good morning, Geoff</h1>
          <div className="admin-actions">
            <button type="button" onClick={() => openDialog({ type: "new-project" })}><Icon name="fa-plus" />Make a new project</button>
            <button type="button" onClick={() => openDialog({ type: "new-folder" })}><Icon name="fa-folder" />Add a folder</button>
            <button type="button" onClick={() => openDialog({ type: "invite" })}><Icon name="fa-user-group" />Invite people to the account</button>
            <button type="button" onClick={() => openDialog({ type: "admin" })}><Icon name="fa-key" />Adminland</button>
          </div>
          <button
            type="button"
            className="theme-drop"
            aria-label="Change background color"
            onClick={() => setState((current) => ({ ...current, themeIndex: (current.themeIndex + 1) % 3 }))}
          ><Icon name="fa-droplet" /></button>
        </aside>

        <section className="project-board" aria-label="Projects">
          <img className="account-mark" src="/reference-assets/basecamp/marks/enormicom-e-tight.png" alt="Enormicom" />
          <div className="jump-search-wrap">
            <label className="jump-search">
              <span className="sr-only">Search or jump</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
                onKeyDown={handleSearchKey}
                placeholder="Search or jump to a project, person, or recent page"
                aria-controls="jump-results"
                aria-expanded={Boolean(query)}
              />
              {query && <kbd>esc</kbd>}
            </label>
            {query && (
              <div className="jump-results" id="jump-results" role="listbox" aria-label="Search results">
                {results.length ? results.map((result, index) => (
                  <button
                    type="button"
                    key={`${result.type}-${result.id}`}
                    className={index === highlighted ? "is-highlighted" : ""}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => chooseResult(result)}
                    role="option"
                    aria-selected={index === highlighted}
                  >
                    <span><strong>{result.title}</strong><small>{result.subtitle}</small></span>
                    <em>{result.type}</em>
                  </button>
                )) : <p>No projects, people, pages, or to-dos match “{query}”.</p>}
              </div>
            )}
          </div>
          {!query.trim() && state.folders.length > 0 && (
            <section className="folder-shelf" aria-label="Project folders">
              <div className="folder-shelf__heading"><strong>Folders</strong><span>Group related projects without changing where the work lives.</span></div>
              <div className="folder-shelf__list">
                {state.folders.map((folder) => (
                  <button type="button" key={folder.id} onClick={() => navigate({ view: "folder", folderId: folder.id })}>
                    <span className="folder-icon"><Icon name="fa-folder" /></span>
                    <span><strong>{folder.name}</strong><small>{folder.projectIds.length} projects</small></span>
                    <Icon name="fa-chevron-right" />
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="project-grid">
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onStar={() => setState((current) => toggleProjectStar(current, project.id))}
                onOpen={() => navigate({ view: "project", projectId: project.id })}
              />
            ))}
          </div>
          {visibleProjects.length === 0 && <p className="empty-search">No project cards match “{query}”. Use the result menu above to jump to people, pages, and to-dos.</p>}
        </section>

        <aside className="activity-column" aria-label="Most recent activity">
          <h2>Most recent activity <span>—</span>{" "}<button type="button" className="view-all" onClick={() => navigate({ view: "aggregate", aggregateId: "activity" })}>View all</button></h2>
          <ol className="activity-list">
            {state.activity.map((item) => <ActivityItem key={item.id} item={item} state={state} navigate={navigate} />)}
          </ol>
          <strong className="active-count">7 people active in the last 24 hours</strong>
          <div className="active-people">
            {["kimberly", "geoff", "alex", "christina", "marcus", "sofia", "maya"].map((person) => <Avatar key={person} name={person} size="small" />)}
          </div>
        </aside>
      </main>

      <button type="button" className="support-link" onClick={() => openDialog({ type: "support" })}><Icon name="fa-circle-question" />Support</button>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function FolderView({ state, setState, route, navigate, goBack }) {
  const folder = state.folders.find((item) => item.id === route.folderId) || state.folders[0];
  const projects = folder ? state.projects.filter((project) => folder.projectIds.includes(project.id)) : [];
  const activity = folder ? state.activity.filter((item) => folder.projectIds.includes(item.projectId)) : [];
  return (
    <div className={`folder-screen home-screen--theme-${state.themeIndex}`}>
      <HomeHeader navigate={navigate} />
      <main className="folder-shell">
        <header className="folder-heading">
          <button type="button" className="aggregate-back" onClick={() => goBack({ view: "home" })}><Icon name="fa-arrow-left" />Home</button>
          <div><p>Folder</p><h1><Icon name="fa-folder" />{folder?.name || "Folder"}</h1><span>Projects and recent activity in this part of your workspace.</span></div>
        </header>
        <section className="folder-projects" aria-label={`${folder?.name || "Folder"} projects`}>
          {projects.length ? projects.map((project) => <ProjectCard key={project.id} project={project} onStar={() => setState((current) => toggleProjectStar(current, project.id))} onOpen={() => navigate({ view: "project", projectId: project.id })} />) : <EmptyState icon="fa-folder-open" title="This folder is ready" copy="New folders start empty so you can decide which projects belong together." />}
        </section>
        <section className="folder-activity">
          <h2>Activity in this folder</h2>
          {activity.length ? <ol className="activity-list activity-list--large">{activity.map((item) => <ActivityItem key={item.id} item={item} state={state} navigate={navigate} />)}</ol> : <p>No recent activity in this folder.</p>}
        </section>
      </main>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function MyBar({ state, navigate }) {
  const links = [
    ["my-tasks", "My Tasks", "fa-list-check"],
    ["my-events", "My Events", "fa-calendar"],
    ["do-today", "Do Today", "fa-sun"],
    ["bookmarks", "My Bookmarks", "fa-bookmark"],
    ["notes", "My Notes", "fa-note-sticky"],
  ];
  const unread = state.notifications.filter((item) => !item.read).length;
  return (
    <footer className="my-bar" aria-label="Personal navigation">
      <Avatar name="geoff" size="profile" title="Geoff" />
      <nav>
        {links.map(([id, label, icon]) => (
          <button type="button" key={id} title={label} onClick={() => {
            if (id === "my-events" && inCombination()) return postHostRoute("calendar");
            if (id === "do-today" && inCombination()) return postHostRoute("today");
            if (id === "my-tasks" && delegatesWorkToHost()) return postHostRoute("work");
            return navigate({ view: "aggregate", aggregateId: id });
          }}>
            <Icon name={icon} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <button type="button" className="new-for-you" onClick={() => navigate({ view: "aggregate", aggregateId: "notifications" })}>
        <span>{unread}</span><strong>New for you</strong>
      </button>
    </footer>
  );
}

function ProjectHeader({ project, crumb, navigate, goBack, backRoute }) {
  return (
    <header className="project-header">
      <button type="button" className="project-brand" aria-label="Basecamp" onClick={() => navigate({ view: "home" })}>
        <img src="/reference-assets/basecamp/marks/basecamp-mask.svg" alt="" /><strong>Basecamp</strong>
      </button>
      <div className="project-crumb">{project.name}{crumb && <><span>/</span>{crumb}</>}</div>
      <button type="button" className="back-button" onClick={() => goBack(backRoute)}><Icon name="fa-arrow-left" />Back</button>
    </header>
  );
}

function ProjectRoom({ state, setState, route, navigate, goBack, openDialog }) {
  const project = projectById(state, route.projectId);
  return (
    <div className={`project-app project-app--theme-${state.themeIndex}`}>
      <ProjectHeader project={project} navigate={navigate} goBack={goBack} backRoute={{ view: "home" }} />
      <main className="project-room">
        <div className="project-room__title">
          <div><p>Project</p><h1>{project.name}</h1><span>{project.note}</span></div>
          <button
            type="button"
            className={`project-star ${project.starred ? "project-star--active" : ""}`}
            onClick={() => setState((current) => toggleProjectStar(current, project.id))}
            aria-pressed={project.starred}
            aria-label={`${project.starred ? "Unstar" : "Star"} ${project.name}`}
          ><Icon name="fa-star" /></button>
        </div>
        <div className="project-presence">
          {project.people.slice(0, 6).map((person) => <Avatar key={person} name={person} size="small" />)}
          <span>{Math.max(project.people.length, 1)} people have access</span>
        </div>
        <section className="tool-grid" aria-label="Project tools">
          {toolCatalog.map((tool) => (
            <button className="tool-card" type="button" key={tool.id} onClick={() => {
              if (tool.id === "schedule" && inCombination()) return postHostRoute("calendar", { projectId: project.id });
              // In every composition the host owns the canonical Work scene. In the
              // Basecamp-work variant that scene routes straight back to this same To-do UI,
              // while keeping the shell label and URL consistent with what is visible.
              if (tool.id === "todos" && inCombination()) return postHostRoute("work", { projectId: project.id });
              return navigate({ view: "tool", projectId: project.id, toolId: tool.id });
            }}>
              <span className="tool-card__label">{tool.name}</span>
              <img src={tool.image} alt="" />
              <span className="tool-card__hint">Open</span>
            </button>
          ))}
        </section>
        <section className="external-links" aria-label="External links">
          <h2>External links</h2>
          <div>
            {[
              ["fa-shapes", "Design Playground", "figma.com/board"],
              ["fa-folder-open", "Client Files", "drive.google.com"],
              ["fa-video", "Weekly Meeting Link", "zoom.us"],
            ].map(([icon, label, host]) => (
              <button type="button" key={label} onClick={() => openDialog({ type: "external", label, host })}>
                <Icon name={icon} /><span><strong>{label}</strong><small>{host}</small></span>
              </button>
            ))}
          </div>
        </section>
      </main>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function AggregateView({ state, setState, route, navigate, goBack, announce }) {
  const definition = aggregateViews.find((view) => view.id === route.aggregateId) || aggregateViews[0];
  const [report, setReport] = useState("Upcoming assignments");
  const [noteDraft, setNoteDraft] = useState("");
  const dated = state.todos.filter((todo) => todo.due && !todo.done).sort((a, b) => a.due.localeCompare(b.due));
  const scheduled = state.scheduleEvents.slice().sort((a, b) => a.date.localeCompare(b.date));
  const myTasks = state.todos.filter((todo) => todo.ownerId === "geoff" && !todo.done);
  const openTodo = (todo) => navigate({ view: "todo", projectId: todo.projectId, toolId: "todos", todoId: todo.id });
  const toolCount = (toolId) => ({
    message: state.messageThreads.length,
    docs: state.documents.length,
    todos: state.todos.length,
    chat: state.chatMessages.length,
    schedule: state.scheduleEvents.length,
    cards: state.workflowCards.length,
  })[toolId] || 0;

  const addNote = () => {
    if (!noteDraft.trim()) return;
    setState((current) => ({ ...current, notes: [noteDraft.trim(), ...current.notes] }));
    setNoteDraft("");
    announce("Private note added");
  };

  return (
    <div className={`aggregate-screen aggregate-screen--theme-${state.themeIndex}`}>
      <HomeHeader navigate={navigate} active={definition.id} />
      <main className="aggregate-shell">
        <header className="aggregate-heading">
          <button type="button" className="aggregate-back" onClick={() => goBack({ view: "home" })}><Icon name="fa-arrow-left" />Home</button>
          <div><p>{definition.eyebrow}</p><h1><Icon name={definition.icon} />{definition.title}</h1><span>{definition.description}</span></div>
        </header>

        {definition.id === "activity" && (
          <section className="aggregate-card"><ol className="activity-list activity-list--large">{state.activity.map((item) => <ActivityItem key={item.id} item={item} state={state} navigate={navigate} />)}</ol></section>
        )}
        {(definition.id === "calendar" || definition.id === "my-events") && (
          <section className="calendar-grid">
            {scheduled.map((event) => <button type="button" key={event.id} className="calendar-item" onClick={() => navigate({ view: "tool", projectId: event.projectId, toolId: "schedule" })}><time>{event.dateLabel}</time><span><strong>{event.title}</strong><small>{event.kind} · {projectById(state, event.projectId).name}</small></span></button>)}
            {dated.map((todo) => <button type="button" key={todo.id} className="calendar-item" onClick={() => openTodo(todo)}><time>{todo.dueLabel}</time><span><strong>{todo.title}</strong><small>{projectById(state, todo.projectId).name}</small></span></button>)}
          </section>
        )}
        {definition.id === "reports" && (
          <div className="report-layout">
            <nav className="report-nav" aria-label="Reports">
              {["Upcoming assignments", "Overdue to-dos", "Tasks added/completed", "Someone’s activity", "Hilltop View"].map((label) => <button type="button" key={label} className={report === label ? "is-active" : ""} onClick={() => setReport(label)}>{label}</button>)}
            </nav>
            <section className="aggregate-card report-result"><p>Selected report</p><h2>{report}</h2><strong>{report === "Upcoming assignments" ? dated.length : report === "Overdue to-dos" ? 2 : state.projects.length} items</strong><span>Use Project Tasks to open and update the underlying work.</span></section>
          </div>
        )}
        {definition.id === "everything" && (
          <section className="everything-grid">{toolCatalog.map((tool) => <button type="button" key={tool.id} onClick={() => {
            if (tool.id === "schedule" && inCombination()) return postHostRoute("calendar", { projectId: "enormicom" });
            if (tool.id === "todos" && delegatesWorkToHost()) return postHostRoute("work", { projectId: "enormicom" });
            return navigate({ view: "tool", projectId: "enormicom", toolId: tool.id });
          }}><Icon name={tool.icon} /><span><strong>{tool.name}</strong><small>{toolCount(tool.id)} items across the account</small></span><Icon name="fa-arrow-right" /></button>)}</section>
        )}
        {(definition.id === "my-tasks" || definition.id === "do-today") && (
          <section className="aggregate-card personal-list">{(definition.id === "do-today" ? myTasks.slice(0, 3) : myTasks).map((todo) => <TodoRow key={todo.id} todo={todo} onOpen={() => openTodo(todo)} onToggle={() => setState((current) => toggleTodo(current, todo.id))} />)}</section>
        )}
        {definition.id === "bookmarks" && (
          <section className="aggregate-card personal-list">{state.todos.filter((todo) => todo.bookmarked).length ? state.todos.filter((todo) => todo.bookmarked).map((todo) => <TodoRow key={todo.id} todo={todo} onOpen={() => openTodo(todo)} onToggle={() => setState((current) => toggleTodo(current, todo.id))} />) : <EmptyState icon="fa-bookmark" title="Nothing bookmarked yet" copy="Open a to-do and choose Bookmark to keep it here." />}</section>
        )}
        {definition.id === "notes" && (
          <section className="notes-board"><div className="inline-composer"><input value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addNote()} placeholder="Write a private note…" /><button type="button" onClick={addNote} disabled={!noteDraft.trim()} title={!noteDraft.trim() ? "Write a note first" : "Add note"}>Add note</button></div>{state.notes.map((note, index) => <article key={`${note}-${index}`}><Icon name="fa-note-sticky" /><p>{note}</p></article>)}</section>
        )}
        {definition.id === "notifications" && (
          <section className="aggregate-card notification-list">
            <div className="notification-toolbar"><strong>{state.notifications.filter((item) => !item.read).length} unread</strong><button type="button" onClick={() => setState((current) => ({ ...current, notifications: current.notifications.map((item) => ({ ...item, read: true })) }))}>Mark all as read</button></div>
            {state.notifications.map((item) => <button type="button" key={item.id} className={item.read ? "is-read" : ""} onClick={() => { setState((current) => ({ ...current, notifications: current.notifications.map((notification) => notification.id === item.id ? { ...notification, read: true } : notification) })); navigate({ view: "todo", projectId: "enormicom", toolId: "todos", todoId: "kickoff" }); }}><span aria-hidden="true" /><strong>{item.text}</strong><Icon name="fa-arrow-right" /></button>)}
          </section>
        )}
      </main>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function EmptyState({ icon, title, copy }) {
  return <div className="empty-state"><Icon name={icon} /><h2>{title}</h2><p>{copy}</p></div>;
}

function HillChart({ updates }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const chart = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: ["", "", "", "", "", "", "", "", ""],
        datasets: [
          { data: [8, 18, 55, 92, 100, 92, 55, 18, 8], borderColor: "rgba(205, 220, 226, .6)", borderWidth: 2, pointRadius: 0, tension: 0.42 },
          { data: [null, null, 55, null, null, null, null, null, null], pointBackgroundColor: "#ef7047", pointBorderWidth: 0, pointRadius: 7, showLine: false },
          { data: [null, null, null, 92, null, null, null, null, null], pointBackgroundColor: "#39aebd", pointBorderWidth: 0, pointRadius: 7, showLine: false },
          { data: [null, null, null, null, 100, null, null, null, null], pointBackgroundColor: "#4b8be6", pointBorderWidth: 0, pointRadius: 7, showLine: false },
          { data: [null, null, null, null, null, null, 55, null, null], pointBackgroundColor: "#e08a2f", pointBorderWidth: 0, pointRadius: 7, showLine: false },
          { data: [null, null, null, null, null, null, null, Math.min(40, 18 + updates.length * 3), null], pointBackgroundColor: "#69b46c", pointBorderWidth: 0, pointRadius: 7, showLine: false },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, min: 0, max: 110 } } },
    });
    return () => chart.destroy();
  }, [updates.length]);
  return <canvas ref={canvasRef} aria-label="Project hill chart" role="img" />;
}

function ownerAvatar(ownerId) {
  return people.some((person) => person.id === ownerId) ? ownerId : "geoff";
}

function TodoRow({ todo, onOpen, onToggle }) {
  const owner = personById(todo.ownerId);
  return (
    <li className={`todo-row ${todo.done ? "todo-row--done" : ""}`}>
      <button type="button" className="todo-check" aria-label={`${todo.done ? "Reopen" : "Complete"} ${todo.title}`} onClick={onToggle}><Icon name={todo.done ? "fa-circle-check" : "fa-circle"} /></button>
      <button type="button" className="todo-title" onClick={onOpen}>{todo.title}</button>
      <span className="todo-meta"><Avatar name={ownerAvatar(todo.ownerId)} size="micro" />{owner.shortName}</span>
      <time>{todo.done ? "Completed" : todo.dueLabel}</time>
    </li>
  );
}

function TodoComposer({ projectId, listId, onAdd, onCancel }) {
  const [title, setTitle] = useState("");
  const [ownerId, setOwnerId] = useState("geoff");
  const [due, setDue] = useState("");
  const submit = () => {
    if (!title.trim()) return;
    onAdd({ projectId, listId, title, ownerId, due, dueLabel: due || "No due date" });
  };
  return (
    <div className="todo-composer">
      <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); if (event.key === "Escape") onCancel(); }} placeholder="Describe the to-do…" />
      <select aria-label="Assigned to" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>{people.slice(0, 6).map((person) => <option key={person.id} value={person.id}>{person.shortName}</option>)}</select>
      <input aria-label="Due date" type="date" value={due} onChange={(event) => setDue(event.target.value)} />
      <button type="button" className="primary-button" onClick={submit} disabled={!title.trim()} title={!title.trim() ? "Add a title first" : "Add to-do"}>Add</button>
      <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function TodosView({ state, setState, route, navigate, goBack, openDialog, announce }) {
  const project = projectById(state, route.projectId);
  const [viewMode, setViewMode] = useState("list");
  const [viewMenu, setViewMenu] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [status, setStatus] = useState("all");
  const [ownerId, setOwnerId] = useState("all");
  const [addingTo, setAddingTo] = useState("");
  const projectTodos = todosForProject(state, project.id);
  const visibleTodos = filterTodos(projectTodos, { status, ownerId });
  const listIds = [...new Set(projectTodos.map((todo) => todo.listId))];
  const isBookmarked = Boolean(state.toolBookmarks?.includes(`${project.id}:todos`));

  const toggleBookmark = () => setState((current) => {
    const key = `${project.id}:todos`;
    const currentBookmarks = current.toolBookmarks || [];
    return { ...current, toolBookmarks: currentBookmarks.includes(key) ? currentBookmarks.filter((item) => item !== key) : [...currentBookmarks, key] };
  });

  const addTodo = (input) => {
    setState((current) => createTodo(current, input));
    setAddingTo("");
    announce("To-do added to Project Tasks");
  };

  return (
    <div className={`project-app project-app--theme-${state.themeIndex}`}>
      <ProjectHeader project={project} crumb="Project Tasks" navigate={navigate} goBack={goBack} backRoute={{ view: "project", projectId: project.id }} />
      <main className="tool-view">
        <div className="tool-view__heading">
          <div><p>{project.name}</p><h1>Project Tasks</h1></div>
          <button type="button" className={`quiet-button ${isBookmarked ? "is-active" : ""}`} aria-pressed={isBookmarked} onClick={toggleBookmark}><Icon name="fa-bookmark" />{isBookmarked ? "Bookmarked" : "Bookmark"}</button>
        </div>
        <div className="tool-filters">
          <div className="popover-anchor">
            <button type="button" aria-expanded={viewMenu} onClick={() => setViewMenu((value) => !value)}>View as {viewMode[0].toUpperCase() + viewMode.slice(1)} <Icon name="fa-chevron-down" /></button>
            {viewMenu && <div className="mini-menu" role="menu">{["list", "people", "due date"].map((mode) => <button type="button" key={mode} role="menuitem" className={viewMode === mode ? "is-active" : ""} onClick={() => { setViewMode(mode); setViewMenu(false); }}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div>}
          </div>
          <button type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((value) => !value)}>Filter{status !== "all" || ownerId !== "all" ? " · Active" : "…"}</button>
        </div>
        {filterOpen && (
          <section className="filter-panel" aria-label="Filter Project Tasks">
            <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All</option><option value="open">Open</option><option value="done">Completed</option></select></label>
            <label>Assigned to<select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="all">Anyone</option>{people.slice(0, 6).map((person) => <option value={person.id} key={person.id}>{person.shortName}</option>)}</select></label>
            <button type="button" onClick={() => { setStatus("all"); setOwnerId("all"); }}>Clear filters</button>
          </section>
        )}
        <section className="hill-panel">
          <div className="hill-chart"><HillChart updates={state.hillUpdates} /></div>
          <div className="hill-labels">
            {["red|Internal — Invoicing", "cyan|Build & Launch", "blue|Design", "orange|Copywriting", "green|Discovery & Design"].map((value) => { const [tone, label] = value.split("|"); return <span key={label}><i className={`hill-dot hill-dot--${tone}`} />{label}</span>; })}
          </div>
          <footer>
            <button type="button" onClick={() => openDialog({ type: "hill-update" })}>Update</button>
            <span>Updated {state.hillUpdates[0].label} · <button type="button" className="inline-link" onClick={() => openDialog({ type: "hill-history" })}>See history</button></span>
            <span>{state.hillUpdates.length} updates</span>
          </footer>
        </section>
        <button type="button" className="add-todo" onClick={() => setAddingTo(listIds[0] || "next")}><Icon name="fa-square-plus" />Add a to-do</button>
        {addingTo === (listIds[0] || "next") && <TodoComposer projectId={project.id} listId={addingTo} onAdd={addTodo} onCancel={() => setAddingTo("")} />}
        <div className={`todo-lists todo-lists--${viewMode.replace(" ", "-")}`}>
          {listIds.map((listId) => {
            const definition = listDefinitions[listId] || { title: "Next up", description: "Current project work.", tone: "blue" };
            const items = visibleTodos.filter((todo) => todo.listId === listId);
            return (
              <section className="todo-group" key={listId}>
                <h2><span className={`group-dot group-dot--${definition.tone}`} />{definition.title}<small>{items.filter((todo) => !todo.done).length} open</small></h2>
                <p>{definition.description}</p>
                {items.length ? <ul>{items.map((todo) => <TodoRow key={todo.id} todo={todo} onToggle={() => setState((current) => toggleTodo(current, todo.id))} onOpen={() => navigate({ view: "todo", projectId: project.id, toolId: "todos", todoId: todo.id })} />)}</ul> : <p className="filtered-empty">No to-dos match these filters.</p>}
                <button type="button" className="group-add" onClick={() => setAddingTo(listId)}>Add a to-do</button>
                {addingTo === listId && listId !== (listIds[0] || "next") && <TodoComposer projectId={project.id} listId={listId} onAdd={addTodo} onCancel={() => setAddingTo("")} />}
              </section>
            );
          })}
        </div>
      </main>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function GenericToolView({ state, setState, route, navigate, goBack, openDialog, announce }) {
  const project = projectById(state, route.projectId);
  const tool = toolCatalog.find((item) => item.id === route.toolId) || toolCatalog[0];
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const hideUpdateThreads = delegatesWorkToHost();
  const messageCategories = hideUpdateThreads ? ["Announcements", "Decisions"] : ["Announcements", "Updates", "Decisions"];
  const [category, setCategory] = useState(hideUpdateThreads ? "Announcements" : "Updates");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [docQuery, setDocQuery] = useState("");
  const [scheduleMode, setScheduleMode] = useState("agenda");
  const [eventDate, setEventDate] = useState("2026-08-12");
  const chatInputRef = useRef(null);
  const messageThreads = state.messageThreads.filter((item) => item.projectId === project.id && (!hideUpdateThreads || item.category !== "Updates") && (categoryFilter === "All" || item.category === categoryFilter));
  const documents = state.documents.filter((item) => item.projectId === project.id && `${item.title} ${item.folder} ${item.type}`.toLowerCase().includes(docQuery.trim().toLowerCase()));
  const chatMessages = state.chatMessages.filter((item) => item.projectId === project.id);
  const scheduleEvents = state.scheduleEvents.filter((item) => item.projectId === project.id);
  const workflowCards = state.workflowCards.filter((item) => item.projectId === project.id);
  useEffect(() => {
    if (!hideUpdateThreads) return;
    if (category === "Updates") setCategory("Announcements");
    if (categoryFilter === "Updates") setCategoryFilter("All");
  }, [category, categoryFilter, hideUpdateThreads]);
  const addItem = () => {
    if (!draft.trim()) return;
    if (tool.id === "message") setState((current) => addMessageThread(current, { projectId: project.id, title: draft, category }));
    else if (tool.id === "docs") setState((current) => addDocument(current, { projectId: project.id, title: draft }));
    else if (tool.id === "chat") setState((current) => addChatMessage(current, project.id, draft));
    else if (tool.id === "schedule") setState((current) => addScheduleEvent(current, { projectId: project.id, title: draft, date: eventDate }));
    else if (tool.id === "cards") setState((current) => addWorkflowCard(current, { projectId: project.id, title: draft }));
    else setState((current) => addToolItem(current, tool.id, draft));
    setDraft("");
    setAdding(false);
    announce(`${tool.singular[0].toUpperCase() + tool.singular.slice(1)} added`);
  };
  const advanceCard = (card) => {
    const columnIndex = state.workflowColumns.findIndex((column) => column.id === card.columnId);
    const nextColumn = state.workflowColumns[Math.min(columnIndex + 1, state.workflowColumns.length - 1)];
    if (!nextColumn || nextColumn.id === card.columnId) return;
    setState((current) => moveWorkflowCard(current, card.id, nextColumn.id));
    announce(`${card.title} moved to ${nextColumn.title}`);
  };
  const toolIntro = tool.id === "message" ? "Post durable announcements and decisions, then keep the full discussion attached." : tool.id === "docs" ? "Find shared project reference material, preview it, and keep it organized." : tool.id === "chat" ? "Use a lightweight stream for quick coordination that does not need a formal record." : tool.id === "schedule" ? "See events and dated work together, then switch between agenda and calendar context." : "Move process-driven work through clear stages from request to done.";
  const topAction = tool.id === "chat" ? () => chatInputRef.current?.focus() : () => setAdding(true);
  return (
    <div className={`project-app project-app--theme-${state.themeIndex}`}>
      <ProjectHeader project={project} crumb={tool.name} navigate={navigate} goBack={goBack} backRoute={{ view: "project", projectId: project.id }} />
      <main className={`tool-view generic-tool generic-tool--${tool.id}`}>
        <div className="tool-view__heading"><div><p>{project.name}</p><h1>{tool.name}</h1></div><button type="button" className="primary-button" onClick={topAction}><Icon name={tool.id === "chat" ? "fa-arrow-down" : "fa-plus"} />{tool.id === "chat" ? "Jump to composer" : `New ${tool.singular}`}</button></div>
        <p className="tool-intro">{toolIntro}</p>
        {adding && <div className="tool-composer tool-composer--rich">
          <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addItem(); if (event.key === "Escape") setAdding(false); }} placeholder={`Add a ${tool.singular}…`} />
          {tool.id === "message" && <select aria-label="Message category" value={category} onChange={(event) => setCategory(event.target.value)}>{messageCategories.map((value) => <option key={value}>{value}</option>)}</select>}
          {tool.id === "schedule" && <input aria-label="Event date" type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} />}
          <button type="button" className="primary-button" disabled={!draft.trim()} title={!draft.trim() ? "Enter a title first" : `Add ${tool.singular}`} onClick={addItem}>Add</button><button type="button" className="secondary-button" onClick={() => setAdding(false)}>Cancel</button>
        </div>}

        {tool.id === "message" && <>
          <nav className="scenario-toolbar" aria-label="Message categories">{["All", ...messageCategories].map((value) => <button type="button" key={value} className={categoryFilter === value ? "is-active" : ""} onClick={() => setCategoryFilter(value)}>{value}</button>)}</nav>
          <section className="message-thread-list">{messageThreads.map((thread) => <button type="button" key={thread.id} onClick={() => openDialog({ type: "message-thread", threadId: thread.id })}><span className="tool-item-icon"><Icon name="fa-message" /></span><span><span className="message-meta"><em>{thread.category}</em>{thread.pinned && <em><Icon name="fa-thumbtack" />Pinned</em>}</span><strong>{thread.title}</strong><small>{personById(thread.authorId).shortName} · {thread.updated} · {thread.replies.length} replies</small></span><Icon name="fa-chevron-right" /></button>)}</section>
        </>}

        {tool.id === "docs" && <>
          <label className="docs-search"><Icon name="fa-magnifying-glass" /><input value={docQuery} onChange={(event) => setDocQuery(event.target.value)} placeholder="Find a document, file, link, or folder" /></label>
          <section className="document-grid">{documents.map((document) => <button type="button" key={document.id} onClick={() => openDialog({ type: "document-preview", documentId: document.id })}><span className="document-type"><Icon name={document.type === "PDF" ? "fa-file-pdf" : document.type === "Link" ? "fa-link" : "fa-file-lines"} /></span><span><em>{document.folder}</em><strong>{document.title}</strong><small>{document.type} · Updated {document.updated}</small></span></button>)}</section>
        </>}

        {tool.id === "chat" && <section className="chat-room" aria-label="Project chat">
          <div className="chat-day"><span>Today</span></div>
          <ol>{chatMessages.map((message) => <li key={message.id}><Avatar name={message.authorId} size="medium" /><div><p><strong>{personById(message.authorId).shortName}</strong><time>{message.time}</time></p><span>{message.body}</span></div></li>)}</ol>
          <div className="chat-composer"><Avatar name="geoff" size="medium" /><input ref={chatInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addItem()} placeholder="Type a quick message…" /><button type="button" className="primary-button" disabled={!draft.trim()} title={!draft.trim() ? "Write a message first" : "Send message"} onClick={addItem}>Send</button></div>
        </section>}

        {tool.id === "schedule" && <>
          <nav className="scenario-toolbar scenario-toolbar--split" aria-label="Schedule view"><span>{scheduleEvents.length} dated commitments</span><div>{["agenda", "calendar"].map((mode) => <button type="button" key={mode} className={scheduleMode === mode ? "is-active" : ""} onClick={() => setScheduleMode(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div></nav>
          {scheduleMode === "agenda" ? <section className="schedule-agenda">{scheduleEvents.map((event) => <article key={event.id}><time>{event.dateLabel}</time><span className="tool-item-icon"><Icon name="fa-calendar-day" /></span><span><em>{event.kind}</em><strong>{event.title}</strong><small>{event.time} · {project.name}</small></span></article>)}</section> : <section className="schedule-calendar">{scheduleEvents.map((event) => <article key={event.id}><time>{event.date.slice(-2)}</time><strong>{event.title}</strong><small>{event.time}</small></article>)}</section>}
        </>}

        {tool.id === "cards" && <section className="card-table">{state.workflowColumns.map((column, columnIndex) => {
          const cards = workflowCards.filter((card) => card.columnId === column.id);
          return <article key={column.id}><header><strong>{column.title}</strong><span>{cards.length} {cards.length === 1 ? "card" : "cards"}</span></header>{cards.map((card) => <div className="workflow-card" key={card.id}><button type="button" className="workflow-card__open" onClick={() => openDialog({ type: "tool-item", title: card.title, copy: `Workflow card in ${column.title}.` })}><strong>{card.title}</strong><span><Avatar name={card.ownerId} size="micro" />{personById(card.ownerId).shortName}</span></button>{columnIndex < state.workflowColumns.length - 1 && <button type="button" className="workflow-card__move" onClick={() => advanceCard(card)}>Move to {state.workflowColumns[columnIndex + 1].title}<Icon name="fa-arrow-right" /></button>}</div>)}<button type="button" className="card-add" onClick={() => setAdding(true)}>Add a card</button></article>;
        })}</section>}
      </main>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function TodoDetail({ state, setState, route, navigate, goBack, announce }) {
  const todo = todoById(state, route.todoId);
  const project = projectById(state, todo.projectId);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [menuId, setMenuId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);

  const addSubtaskItem = () => {
    if (!subtaskDraft.trim()) return;
    setState((current) => addSubtask(current, todo.id, subtaskDraft));
    setSubtaskDraft("");
    announce("Subtask added");
  };
  const addCommentItem = () => {
    if (!commentDraft.trim()) return;
    setState((current) => addComment(current, todo.id, commentDraft));
    setCommentDraft("");
    announce("Comment posted");
  };

  return (
    <div className={`project-app project-app--theme-${state.themeIndex}`}>
      <ProjectHeader project={project} crumb="Project Tasks / To-do" navigate={navigate} goBack={goBack} backRoute={{ view: "tool", projectId: project.id, toolId: "todos" }} />
      <main className="todo-detail">
        <header>
          <input className="detail-title-input" aria-label="To-do title" value={todo.title} onChange={(event) => setState((current) => updateTodo(current, todo.id, { title: event.target.value }))} />
          <div className="detail-actions">
            <button type="button" className={todo.done ? "complete-button complete-button--done" : "complete-button"} onClick={() => setState((current) => toggleTodo(current, todo.id))}><Icon name={todo.done ? "fa-square-check" : "fa-square"} />{todo.done ? "Completed" : "Mark as complete"}</button>
            <button type="button" className={`quiet-button ${todo.bookmarked ? "is-active" : ""}`} aria-pressed={todo.bookmarked} onClick={() => setState((current) => toggleTodoBookmark(current, todo.id))}><Icon name="fa-bookmark" />{todo.bookmarked ? "Bookmarked" : "Bookmark"}</button>
            <span>Added by <Avatar name={todo.createdBy} size="micro" />{personById(todo.createdBy).shortName} on {todo.createdLabel}</span>
          </div>
        </header>
        <dl className="detail-facts">
          <dt>Assigned to</dt>
          <dd><Avatar name={todo.ownerId} size="micro" /><select aria-label="Assigned to" value={todo.ownerId} onChange={(event) => setState((current) => updateTodo(current, todo.id, { ownerId: event.target.value }))}>{people.slice(0, 6).map((person) => <option key={person.id} value={person.id}>{person.shortName}</option>)}</select></dd>
          <dt>When done</dt>
          <dd><Avatar name="kimberly" size="micro" />Leah B. <Avatar name="marcus" size="micro" />Kurt H. <Avatar name="sofia" size="micro" />Sofía C.</dd>
          <dt>Due on</dt>
          <dd><Icon name="fa-calendar" /><input aria-label="Due on" type="date" value={todo.due} onChange={(event) => setState((current) => updateTodo(current, todo.id, { due: event.target.value, dueLabel: event.target.value || "No due date" }))} /></dd>
          <dt>Notes</dt>
          <dd className="detail-notes">
            {editingNotes ? <div className="notes-editor"><textarea autoFocus aria-label="To-do notes" value={todo.notes} onChange={(event) => setState((current) => updateTodo(current, todo.id, { notes: event.target.value }))} /><button type="button" onClick={() => setEditingNotes(false)}>Done editing</button></div> : <button type="button" className="notes-preview" onClick={() => setEditingNotes(true)}><span>{todo.notes || "Add notes"}</span><small>Edit notes</small></button>}
            <button type="button" className="file-attachment" onClick={() => announce("Kickoff Notes.md is ready in this prototype") }><Icon name="fa-file-lines" /><span><strong>Kickoff Notes.md</strong><small>27.9 KB · Preview attachment</small></span></button>
          </dd>
          <dt>Subtasks</dt>
          <dd className="subtask-cell">
            <ul className="subtasks">{todo.subtasks.map((subtask) => <li className={subtask.done ? "is-done" : ""} key={subtask.id}><button type="button" aria-label={`${subtask.done ? "Reopen" : "Complete"} ${subtask.title}`} onClick={() => setState((current) => toggleSubtask(current, todo.id, subtask.id))}><Icon name={subtask.done ? "fa-circle-check" : "fa-circle"} /></button><span>{subtask.title}</span><Avatar name={subtask.ownerId} size="micro" /></li>)}</ul>
            <div className="subtask-composer"><input value={subtaskDraft} onChange={(event) => setSubtaskDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addSubtaskItem()} placeholder="Add a new subtask…" /><button type="button" onClick={addSubtaskItem} disabled={!subtaskDraft.trim()} title={!subtaskDraft.trim() ? "Write a subtask first" : "Add subtask"}>Add</button></div>
          </dd>
        </dl>
        <section className="comments" aria-label="Comments">
          <div className="comment-composer"><Avatar name="geoff" size="medium" /><textarea value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="Add a comment…" /><button type="button" className="primary-button" onClick={addCommentItem} disabled={!commentDraft.trim()} title={!commentDraft.trim() ? "Write a comment first" : "Post comment"}>Post comment</button></div>
          {todo.comments.map((comment) => {
            const author = personById(comment.authorId);
            return (
              <article className="comment" key={comment.id}>
                <Avatar name={comment.authorId} size="medium" />
                <div>
                  <p><strong>{author.name}</strong>{" "}<span>{author.role} · {comment.time}</span></p>
                  {editingId === comment.id ? <div className="comment-edit"><textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} /><button type="button" onClick={() => { setState((current) => ({ ...current, todos: current.todos.map((item) => item.id === todo.id ? { ...item, comments: item.comments.map((entry) => entry.id === comment.id ? { ...entry, body: editDraft.trim() || entry.body } : entry) } : item) })); setEditingId(""); }}>Save</button><button type="button" onClick={() => setEditingId("")}>Cancel</button></div> : <div>{comment.body}</div>}
                  <button type="button" aria-label={`More actions for ${author.name}`} aria-expanded={menuId === comment.id} onClick={() => setMenuId((value) => value === comment.id ? "" : comment.id)}><Icon name="fa-ellipsis" /></button>
                  {menuId === comment.id && <div className="comment-menu" role="menu"><button type="button" role="menuitem" onClick={async () => { await navigator.clipboard?.writeText(`${window.location.href}#${comment.id}`); setMenuId(""); announce("Comment link copied"); }}>Copy link</button><button type="button" role="menuitem" onClick={() => { setEditingId(comment.id); setEditDraft(comment.body); setMenuId(""); }}>Edit</button><button type="button" role="menuitem" onClick={() => { setState((current) => removeComment(current, todo.id, comment.id)); setMenuId(""); announce("Comment removed"); }}>Remove</button></div>}
                </div>
              </article>
            );
          })}
        </section>
      </main>
      <MyBar state={state} navigate={navigate} />
    </div>
  );
}

function DialogShell({ title, copy, onClose, children }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header><div><h2 id="dialog-title">{title}</h2>{copy && <p>{copy}</p>}</div><button ref={closeRef} type="button" aria-label="Close dialog" onClick={onClose}><Icon name="fa-xmark" /></button></header>
        {children}
      </section>
    </div>
  );
}

function AppDialog({ overlay, close, state, setState, announce }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [hillSummary, setHillSummary] = useState("");
  if (!overlay) return null;

  if (overlay.type === "new-project") return <DialogShell title="Make a new project" copy="Start with a clear name and a short purpose." onClose={close}><div className="dialog-form"><label>Project name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label>Description<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="primary-button" disabled={!name.trim()} title={!name.trim() ? "Add a project name first" : "Create project"} onClick={() => { setState((current) => createProject(current, { name, note })); announce(`${name.trim()} created`); close(); }}>Create project</button><button type="button" className="secondary-button" onClick={close}>Cancel</button></div></div></DialogShell>;
  if (overlay.type === "new-folder") return <DialogShell title="Add a folder" copy="Folders organize your personal Home without changing project facts." onClose={close}><div className="dialog-form"><label>Folder name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="primary-button" disabled={!name.trim()} title={!name.trim() ? "Add a folder name first" : "Create folder"} onClick={() => { setState((current) => createFolder(current, name)); announce(`${name.trim()} folder added`); close(); }}>Add folder</button><button type="button" className="secondary-button" onClick={close}>Cancel</button></div></div></DialogShell>;
  if (overlay.type === "invite") return <DialogShell title="Invite people" copy="This prototype records the invitation locally; it does not send email." onClose={close}><div className="dialog-form"><label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="primary-button" disabled={!name.trim() || !email.includes("@")} title={!name.trim() || !email.includes("@") ? "Enter a name and valid email" : "Record invitation"} onClick={() => { setState((current) => ({ ...current, invitations: [...current.invitations, { id: `invite-${current.nextId}`, name: name.trim(), email: email.trim() }], nextId: current.nextId + 1 })); announce(`Invitation prepared for ${name.trim()}`); close(); }}>Prepare invitation</button><button type="button" className="secondary-button" onClick={close}>Cancel</button></div></div></DialogShell>;
  if (overlay.type === "admin") return <DialogShell title="Adminland" copy="Account-wide preferences for this reference prototype." onClose={close}><div className="setting-list"><label><input type="checkbox" checked={state.adminPreferences?.dailySummary ?? true} onChange={(event) => setState((current) => ({ ...current, adminPreferences: { ...(current.adminPreferences || {}), dailySummary: event.target.checked } }))} />Daily activity summary</label><label><input type="checkbox" checked={state.adminPreferences?.clientAccess ?? true} onChange={(event) => setState((current) => ({ ...current, adminPreferences: { ...(current.adminPreferences || {}), clientAccess: event.target.checked } }))} />Allow client access by default</label><button type="button" className="primary-button" onClick={() => { announce("Admin preferences saved"); close(); }}>Done</button></div></DialogShell>;
  if (overlay.type === "support") return <DialogShell title="How can we help?" copy="Choose a topic to see the prototype’s next step." onClose={close}><div className="support-topics">{["Finding my work", "Project settings", "To-do help"].map((topic) => <button type="button" key={topic} onClick={() => announce(`${topic} guide selected`)}><Icon name="fa-circle-question" /><span><strong>{topic}</strong><small>Open help topic</small></span></button>)}</div></DialogShell>;
  if (overlay.type === "external") return <DialogShell title={overlay.label} copy={`Safe preview for ${overlay.host}. No external service is connected.`} onClose={close}><div className="external-preview"><Icon name="fa-arrow-up-right-from-square" /><p>{overlay.host}</p><button type="button" disabled title="External services are intentionally disconnected in this reference prototype">Open external service</button></div></DialogShell>;
  if (overlay.type === "hill-update") return <DialogShell title="Update the Hill Chart" copy="Describe what moved and what remains uncertain." onClose={close}><div className="dialog-form"><label>Progress note<textarea autoFocus value={hillSummary} onChange={(event) => setHillSummary(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="primary-button" disabled={!hillSummary.trim()} title={!hillSummary.trim() ? "Add a progress note first" : "Save update"} onClick={() => { setState((current) => addHillUpdate(current, hillSummary)); announce("Hill Chart updated"); close(); }}>Save update</button><button type="button" className="secondary-button" onClick={close}>Cancel</button></div></div></DialogShell>;
  if (overlay.type === "hill-history") return <DialogShell title="Hill Chart history" copy="Every manual progress update stays visible." onClose={close}><ol className="history-list">{state.hillUpdates.map((update) => <li key={update.id}><strong>{update.label}</strong><span>{update.summary}</span></li>)}</ol></DialogShell>;
  if (overlay.type === "message-thread") {
    const thread = state.messageThreads.find((item) => item.id === overlay.threadId);
    if (!thread) return null;
    return <DialogShell title={thread.title} copy={`${thread.category} · ${personById(thread.authorId).shortName} · ${thread.updated}`} onClose={close}><article className="thread-detail"><p>{thread.body}</p><ol>{thread.replies.map((reply) => <li key={reply.id}><Avatar name={reply.authorId} size="small" /><div><strong>{personById(reply.authorId).shortName}</strong><time>{reply.time}</time><p>{reply.body}</p></div></li>)}</ol><div className="thread-reply"><textarea aria-label="Add a reply" placeholder="Add a reply to this discussion…" value={note} onChange={(event) => setNote(event.target.value)} /><button type="button" className="primary-button" disabled={!note.trim()} title={!note.trim() ? "Write a reply first" : "Post reply"} onClick={() => { setState((current) => addMessageReply(current, thread.id, note)); setNote(""); announce("Reply added to this message"); }}>Post reply</button></div></article></DialogShell>;
  }
  if (overlay.type === "document-preview") {
    const document = state.documents.find((item) => item.id === overlay.documentId);
    if (!document) return null;
    return <DialogShell title={document.title} copy={`${document.folder} · ${document.type} · Updated ${document.updated}`} onClose={close}><article className="document-preview"><Icon name={document.type === "PDF" ? "fa-file-pdf" : document.type === "Link" ? "fa-link" : "fa-file-lines"} /><div><strong>Reference preview</strong><p>{document.summary}</p><small>The underlying file service is intentionally disconnected; this preview demonstrates find-and-revisit behavior.</small></div><button type="button" className="secondary-button" onClick={() => { announce(`${document.title} bookmarked for the project`); close(); }}>Bookmark reference</button></article></DialogShell>;
  }
  if (overlay.type === "tool-item") return <DialogShell title={overlay.title} copy={overlay.copy} onClose={close}><div className="item-preview"><p>Discussion and details remain attached to this item.</p><textarea aria-label="Add a reply" placeholder="Add a reply…" value={note} onChange={(event) => setNote(event.target.value)} /><button type="button" className="primary-button" disabled={!note.trim()} title={!note.trim() ? "Write a reply first" : "Post reply"} onClick={() => { announce("Reply added to this preview"); close(); }}>Post reply</button></div></DialogShell>;
  return null;
}

export function App() {
  const [state, setState] = useState(createInitialState);
  const [route, setRoute] = useState(readRoute);
  const [overlay, setOverlay] = useState(null);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(null);
  const delegatedRouteRef = useRef("");

  const announce = (message) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2200);
  };

  const navigate = (nextRoute, mode = "push") => {
    const completeRoute = { projectId: "enormicom", toolId: "todos", todoId: "kickoff", aggregateId: "activity", folderId: "client-work", ...nextRoute };
    const hostScene = hostSceneForRoute(completeRoute);
    if (hostScene) {
      postHostScene(hostScene, completeRoute);
      return;
    }
    const url = routeUrl(completeRoute);
    if (mode === "replace") window.history.replaceState({ basecamp: true, route: completeRoute }, "", url);
    else window.history.pushState({ basecamp: true, route: completeRoute }, "", url);
    setRoute(completeRoute);
    setOverlay(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const goBack = (fallbackRoute) => {
    if (window.history.state?.basecamp) window.history.back();
    else navigate(fallbackRoute, "replace");
  };

  useEffect(() => {
    if (!window.history.state?.basecamp) window.history.replaceState({ basecamp: true, route }, "", window.location.href);
    const onPopState = () => { setRoute(readRoute()); setOverlay(null); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.shiftKey && event.key.toLowerCase() === "h") { event.preventDefault(); navigate({ view: "home" }); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const delegatedScene = hostSceneForRoute(route);
  useEffect(() => {
    if (!delegatedScene) {
      delegatedRouteRef.current = "";
      return;
    }
    const key = `${delegatedScene}:${route.view}:${route.projectId || ""}:${route.todoId || ""}:${route.aggregateId || ""}`;
    if (delegatedRouteRef.current === key) return;
    delegatedRouteRef.current = key;
    postHostScene(delegatedScene, route);
  }, [delegatedScene, route.aggregateId, route.projectId, route.todoId, route.view]);

  let screen;
  if (delegatedScene) screen = null;
  else if (route.view === "folder") screen = <FolderView state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} />;
  else if (route.view === "aggregate") screen = <AggregateView state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} announce={announce} />;
  else if (route.view === "project") screen = <ProjectRoom state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} openDialog={setOverlay} />;
  else if (route.view === "tool" && route.toolId === "todos") screen = <TodosView state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} openDialog={setOverlay} announce={announce} />;
  else if (route.view === "tool") screen = <GenericToolView state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} openDialog={setOverlay} announce={announce} />;
  else if (route.view === "todo") screen = <TodoDetail state={state} setState={setState} route={route} navigate={navigate} goBack={goBack} announce={announce} />;
  else screen = <HomeScreen state={state} setState={setState} navigate={navigate} openDialog={setOverlay} />;

  return <>{screen}<AppDialog key={overlay?.type || "none"} overlay={overlay} close={() => setOverlay(null)} state={state} setState={setState} announce={announce} />{notice && <div className="toast" role="status">{notice}</div>}</>;
}
