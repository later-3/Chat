import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";

const avatars = {
  geoff: "/assets/avatars/geoff.jpg",
  kimberly: "/assets/avatars/kimberly.jpg",
  alex: "/assets/avatars/alex.jpg",
  christina: "/assets/avatars/christina.jpg",
  marcus: "/assets/avatars/marcus.jpg",
  sofia: "/assets/avatars/sofia.jpg",
  daniel: "/assets/avatars/daniel.jpg",
  maya: "/assets/avatars/maya.jpg",
  noah: "/assets/avatars/noah.jpg",
  zoe: "/assets/avatars/zoe.jpg",
};

const projects = [
  {
    id: "enormicom",
    name: "Enormicom HQ",
    note: "Where everybody knows your name.",
    access: "All-access",
    starred: true,
  },
  {
    id: "website",
    name: "Website Redesign",
    note: "Nine to Thrive",
    people: ["geoff", "kimberly", "alex", "christina", "sofia", "maya"],
    starred: true,
  },
  {
    id: "gh-designs",
    name: "GH Designs: Logo Redesign",
    note: "GH Designs: Lead: Sofía | Phase 2",
    access: "All-access",
    starred: true,
  },
  {
    id: "demo",
    name: "A fun demo",
    note: "",
    people: ["geoff"],
    starred: true,
  },
  {
    id: "cycle-2",
    name: "Cycle 2: Product Updates",
    note: "",
    access: "All-access",
    decorated: true,
    starred: false,
  },
  {
    id: "accounting",
    name: "Accounting Team",
    note: "We know where the money is at!",
    access: "All-access",
    starred: false,
  },
  {
    id: "meetup",
    name: "Company Meetup: Austin, TX",
    note: "May 18th–22nd",
    footer: "26 people",
    starred: false,
  },
  {
    id: "cycle-1",
    name: "Cycle 1: Marketing",
    note: "",
    access: "All-access",
    starred: false,
  },
];

const activity = [
  {
    when: "7:00am",
    icon: "fa-check",
    tone: "green",
    people: ["kimberly"],
    lead: "Kimberly R.",
    text: "added 3 to-dos to",
    link: "New to-do list",
    project: "My Project",
  },
  {
    when: "May 25",
    icon: "fa-list",
    tone: "green",
    people: ["geoff"],
    lead: "Geoff C.",
    text: "completed 2 subtasks on",
    link: "Send contract to client",
    project: "GH Designs: Logo Redesign",
  },
  {
    when: "May 25",
    icon: "fa-comment",
    tone: "cyan",
    people: ["kimberly", "alex", "christina", "marcus"],
    lead: "Kimberly R., Alex Z., Christina M., and 6 others",
    text: "were chatting in",
    link: "Chat",
    project: "The Enormicom Podcast",
  },
  {
    when: "May 25",
    icon: "fa-calendar-day",
    tone: "pink",
    people: ["geoff"],
    lead: "Geoff C.",
    text: "rescheduled 2 events in",
    link: "Schedule",
    project: "Enormicom HQ",
  },
  {
    when: "May 25",
    icon: "fa-file",
    tone: "yellow",
    people: ["kimberly"],
    lead: "Kimberly R.",
    text: "posted a document:",
    link: "Podcast Stats",
    project: "The Enormicom Podcast",
  },
];

const tools = [
  { id: "message", name: "Message Board", image: "/assets/basecamp-tools/message-board.webp" },
  { id: "docs", name: "Docs & Files", image: "/assets/basecamp-tools/docs-files.webp" },
  { id: "todos", name: "Project Tasks", image: "/assets/basecamp-tools/to-dos.webp" },
  { id: "chat", name: "Chat", image: "/assets/basecamp-tools/chat.webp" },
  { id: "schedule", name: "Schedule", image: "/assets/basecamp-tools/schedule.webp" },
  { id: "cards", name: "Workflow", image: "/assets/basecamp-tools/card-table.webp" },
];

const daytimeTodos = [
  {
    title: "Run project kickoff and define scope",
    owner: "Geoff C.",
    due: "Fri, Jul 31",
    done: false,
  },
  {
    title: "Gather brand assets, photos, and copy from client",
    owner: "Daniel Y.",
    due: "Fri, Jul 31",
    done: false,
  },
  {
    title: "Walk client through visual mockups for sign-off",
    owner: "Kurt H.",
    due: "Aug 7",
    done: false,
  },
  {
    title: "Revise mockups based on client feedback",
    owner: "Daniel Y.",
    due: "Aug 14",
    done: false,
  },
  { title: "Document discovery decisions", owner: "Leah B.", due: "Completed", done: true },
];

const launchTodos = [
  { title: "Build homepage and global navigation", owner: "Daniel Y.", due: "Aug 14", done: false },
  { title: "Build out key pages", owner: "Geoff C.", due: "Aug 21", done: false },
  {
    title: "QA across browsers and mobile breakpoints",
    owner: "Leah B.",
    due: "Aug 28",
    done: false,
  },
  {
    title: "Deploy to production and hand off credentials",
    owner: "Kurt H.",
    due: "Sep 4",
    done: false,
  },
];

function readView() {
  const view = new URLSearchParams(window.location.search).get("view");
  return ["home", "project", "todos", "todo"].includes(view) ? view : "home";
}

function Avatar({ name, size = "small", title }) {
  return <img className={`avatar avatar--${size}`} src={avatars[name]} alt={title || ""} />;
}

function Icon({ name }) {
  return <i aria-hidden="true" className={`fa-solid ${name}`} />;
}

function HomeHeader({ onHome }) {
  return (
    <header className="home-header" aria-label="Global navigation">
      <nav className="home-header__nav">
        <button type="button" className="plain-nav" onClick={() => {}}>
          <Icon name="fa-chart-line" />
          Activity
        </button>
        <button type="button" className="plain-nav" onClick={() => {}}>
          <Icon name="fa-calendar-day" />
          Calendar
        </button>
        <button type="button" className="brand-nav" onClick={onHome}>
          <img src="/assets/marks/basecamp-mask.svg" alt="" />
          <strong>Basecamp</strong>
        </button>
        <button type="button" className="plain-nav" onClick={() => {}}>
          <Icon name="fa-chart-pie" />
          Reports
        </button>
        <button type="button" className="plain-nav" onClick={() => {}}>
          <Icon name="fa-earth-americas" />
          Everything
        </button>
      </nav>
    </header>
  );
}

function ProjectCard({ project, starred, onStar, onOpen }) {
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
              <>
                We know where the <Icon name="fa-sack-dollar" /> is at!
              </>
            ) : (
              project.note
            )}
          </span>
        )}
      </button>
      <button
        className={`star-button ${starred ? "star-button--active" : ""}`}
        type="button"
        aria-label={`${starred ? "Unstar" : "Star"} ${project.name}`}
        aria-pressed={starred}
        onClick={onStar}
      >
        <Icon name="fa-star" />
      </button>
      {project.people && (
        <div className="project-card__people" aria-label={`${project.people.length} people`}>
          {project.people.map((person) => (
            <Avatar key={person} name={person} size="tiny" />
          ))}
        </div>
      )}
      {project.access && <span className="access-chip">{project.access}</span>}
      {project.footer && <strong className="project-card__footer">{project.footer}</strong>}
    </article>
  );
}

function ActivityItem({ item, onOpen }) {
  return (
    <li className="activity-item">
      <span className="activity-item__dot" aria-hidden="true" />
      <time>{item.when}</time>
      <div className="activity-item__copy">
        <span className={`activity-type activity-type--${item.tone}`}>
          <Icon name={item.icon} />
        </span>
        <span className="activity-avatars">
          {item.people.slice(0, 3).map((person) => (
            <Avatar key={person} name={person} size="micro" />
          ))}
        </span>
        <strong>{item.lead}</strong> {item.text}{" "}
        <button type="button" className="inline-link" onClick={onOpen}>
          {item.link}
        </button>
        <span> — {item.project}</span>
      </div>
    </li>
  );
}

function HomeScreen({ navigate }) {
  const [query, setQuery] = useState("");
  const [starred, setStarred] = useState(
    () => new Set(projects.filter((project) => project.starred).map((project) => project.id)),
  );
  const [themeIndex, setThemeIndex] = useState(0);
  const [notice, setNotice] = useState("");
  const searchRef = useRef(null);
  const filtered = useMemo(
    () =>
      projects.filter((project) =>
        `${project.name} ${project.note}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );

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

  const nudge = (message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 1800);
  };

  return (
    <div className={`home-screen home-screen--theme-${themeIndex}`}>
      <HomeHeader onHome={() => navigate("home")} />
      <main className="home-layout">
        <aside className="admin-column" aria-label="Account actions">
          <h1>Good morning, Geoff</h1>
          <div className="admin-actions">
            <button type="button" onClick={() => nudge("New project flow opened")}>
              <Icon name="fa-plus" />
              Make a new project
            </button>
            <button type="button" onClick={() => nudge("Folder organizer opened")}>
              <Icon name="fa-folder" />
              Add a folder
            </button>
            <button type="button" onClick={() => nudge("Invite form opened")}>
              <Icon name="fa-user-group" />
              Invite people to the account
            </button>
            <button type="button" onClick={() => nudge("Adminland opened")}>
              <Icon name="fa-key" />
              Adminland
            </button>
          </div>
          <button
            type="button"
            className="theme-drop"
            aria-label="Change background color"
            onClick={() => setThemeIndex((value) => (value + 1) % 3)}
          >
            <Icon name="fa-droplet" />
          </button>
        </aside>

        <section className="project-board" aria-label="Projects">
          <img className="account-mark" src="/assets/marks/enormicom-e-tight.png" alt="Enormicom" />
          <label className="jump-search">
            <span className="sr-only">Search or jump</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search or jump to a project, person, or recent page"
            />
            {query && <kbd>esc</kbd>}
          </label>
          <div className="project-grid">
            {filtered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                starred={starred.has(project.id)}
                onStar={() =>
                  setStarred((current) => {
                    const next = new Set(current);
                    next.has(project.id) ? next.delete(project.id) : next.add(project.id);
                    return next;
                  })
                }
                onOpen={() => navigate(project.id === "enormicom" ? "project" : "project")}
              />
            ))}
          </div>
          {filtered.length === 0 && <p className="empty-search">No projects match “{query}”.</p>}
        </section>

        <aside className="activity-column" aria-label="Most recent activity">
          <h2>
            Most recent activity <span>—</span>{" "}
            <button type="button" className="view-all">
              View all
            </button>
          </h2>
          <ol className="activity-list">
            {activity.map((item) => (
              <ActivityItem
                key={`${item.when}-${item.link}`}
                item={item}
                onOpen={() => navigate("todo")}
              />
            ))}
          </ol>
          <strong className="active-count">7 people active in the last 24 hours</strong>
          <div className="active-people">
            {["kimberly", "geoff", "alex", "christina", "marcus", "sofia", "maya"].map((person) => (
              <Avatar key={person} name={person} size="small" />
            ))}
          </div>
        </aside>
      </main>

      <button type="button" className="support-link" onClick={() => nudge("Support opened")}>
        <Icon name="fa-circle-question" />
        Support
      </button>
      <footer className="my-bar" aria-label="Personal navigation">
        <Avatar name="geoff" size="profile" title="Geoff" />
        <nav>
          <button type="button">My Tasks</button>
          <button type="button">My Events</button>
          <button type="button">Do Today</button>
          <button type="button">My Bookmarks</button>
          <button type="button">My Notes</button>
        </nav>
        <button type="button" className="new-for-you">
          <span>5</span>New for you
        </button>
      </footer>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function ProjectHeader({ navigate, goBack, crumb, backTo = "home" }) {
  return (
    <header className="project-header">
      <button type="button" className="project-brand" onClick={() => navigate("home")}>
        <img src="/assets/marks/basecamp-mask.svg" alt="" />
        <strong>Basecamp</strong>
      </button>
      {crumb ? (
        <div className="project-crumb">
          Enormicom HQ <span>/</span> {crumb}
        </div>
      ) : (
        <div />
      )}
      <button type="button" className="back-button" onClick={() => goBack(backTo)}>
        <Icon name="fa-arrow-left" />
        Back
      </button>
    </header>
  );
}

function ProjectRoom({ navigate, goBack }) {
  const [starred, setStarred] = useState(true);
  return (
    <div className="project-app">
      <ProjectHeader navigate={navigate} goBack={goBack} />
      <main className="project-room">
        <div className="project-room__title">
          <div>
            <p>Project</p>
            <h1>Enormicom HQ</h1>
            <span>Where everybody knows your name.</span>
          </div>
          <button
            type="button"
            className={`project-star ${starred ? "project-star--active" : ""}`}
            onClick={() => setStarred((value) => !value)}
            aria-pressed={starred}
            aria-label="Star Enormicom HQ"
          >
            <Icon name="fa-star" />
          </button>
        </div>
        <div className="project-presence">
          {["geoff", "kimberly", "alex", "christina", "sofia", "maya"].map((person) => (
            <Avatar key={person} name={person} size="small" />
          ))}
          <span>12 people have access</span>
        </div>
        <section className="tool-grid" aria-label="Project tools">
          {tools.map((tool) => (
            <button
              className="tool-card"
              type="button"
              key={tool.id}
              onClick={() => (tool.id === "todos" ? navigate("todos") : undefined)}
            >
              <span className="tool-card__label">{tool.name}</span>
              <img src={tool.image} alt="" />
              {tool.id !== "todos" && <span className="tool-card__hint">Preview</span>}
            </button>
          ))}
        </section>
        <section className="external-links" aria-label="External links">
          <h2>External links</h2>
          <div>
            <button type="button">
              <Icon name="fa-shapes" />
              <span>
                <strong>Design Playground</strong>
                <small>figma.com/board</small>
              </span>
            </button>
            <button type="button">
              <Icon name="fa-folder-open" />
              <span>
                <strong>Client Files</strong>
                <small>drive.google.com</small>
              </span>
            </button>
            <button type="button">
              <Icon name="fa-video" />
              <span>
                <strong>Weekly Meeting Link</strong>
                <small>zoom.us</small>
              </span>
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function HillChart() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const chart = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: ["", "", "", "", "", "", "", "", ""],
        datasets: [
          {
            data: [8, 18, 55, 92, 100, 92, 55, 18, 8],
            borderColor: "rgba(205, 220, 226, .6)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.42,
          },
          {
            data: [null, null, 55, null, null, null, null, null, null],
            pointBackgroundColor: "#ef7047",
            pointBorderWidth: 0,
            pointRadius: 7,
            showLine: false,
          },
          {
            data: [null, null, null, 92, null, null, null, null, null],
            pointBackgroundColor: "#39aebd",
            pointBorderWidth: 0,
            pointRadius: 7,
            showLine: false,
          },
          {
            data: [null, null, null, null, 100, null, null, null, null],
            pointBackgroundColor: "#4b8be6",
            pointBorderWidth: 0,
            pointRadius: 7,
            showLine: false,
          },
          {
            data: [null, null, null, null, null, null, 55, null, null],
            pointBackgroundColor: "#e08a2f",
            pointBorderWidth: 0,
            pointRadius: 7,
            showLine: false,
          },
          {
            data: [null, null, null, null, null, null, null, 18, null],
            pointBackgroundColor: "#69b46c",
            pointBorderWidth: 0,
            pointRadius: 7,
            showLine: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, min: 0, max: 110 } },
      },
    });
    return () => chart.destroy();
  }, []);
  return <canvas ref={canvasRef} aria-label="Project hill chart" role="img" />;
}

function TodoRow({ todo, onOpen }) {
  return (
    <li className={`todo-row ${todo.done ? "todo-row--done" : ""}`}>
      <button
        type="button"
        className="todo-check"
        aria-label={`${todo.done ? "Reopen" : "Complete"} ${todo.title}`}
      >
        <Icon name={todo.done ? "fa-circle-check" : "fa-circle"} />
      </button>
      <button type="button" className="todo-title" onClick={onOpen}>
        {todo.title}
      </button>
      <span className="todo-meta">
        <Avatar
          name={
            todo.owner.startsWith("Geoff")
              ? "geoff"
              : todo.owner.startsWith("Daniel")
                ? "daniel"
                : todo.owner.startsWith("Leah")
                  ? "kimberly"
                  : "marcus"
          }
          size="micro"
        />
        {todo.owner}
      </span>
      <time>{todo.due}</time>
    </li>
  );
}

function TodosView({ navigate, goBack }) {
  return (
    <div className="project-app">
      <ProjectHeader navigate={navigate} goBack={goBack} crumb="Project Tasks" backTo="project" />
      <main className="tool-view">
        <div className="tool-view__heading">
          <div>
            <p>Enormicom HQ</p>
            <h1>Project Tasks</h1>
          </div>
          <button type="button" className="quiet-button">
            <Icon name="fa-bookmark" />
            Bookmark
          </button>
        </div>
        <div className="tool-filters">
          <button type="button">
            View as <Icon name="fa-chevron-down" />
          </button>
          <button type="button">Filter…</button>
        </div>
        <section className="hill-panel">
          <div className="hill-chart">
            <HillChart />
          </div>
          <div className="hill-labels">
            <span>
              <i className="hill-dot hill-dot--red" />
              Internal — Invoicing
            </span>
            <span>
              <i className="hill-dot hill-dot--cyan" />
              Build & Launch
            </span>
            <span>
              <i className="hill-dot hill-dot--blue" />
              Design
            </span>
            <span>
              <i className="hill-dot hill-dot--orange" />
              Copywriting
            </span>
            <span>
              <i className="hill-dot hill-dot--green" />
              Discovery & Design
            </span>
          </div>
          <footer>
            <button type="button">Update</button>
            <span>
              Updated Monday at 1:38pm · <u>See history</u>
            </span>
            <span>3 / 3</span>
          </footer>
        </section>
        <button type="button" className="add-todo">
          <Icon name="fa-square-plus" />
          Add a to-do
        </button>
        <TodoGroup
          title="Discovery & Design"
          description="Client kickoff, content gathering, sitemap, and visual design."
          todos={daytimeTodos}
          navigate={navigate}
        />
        <TodoGroup
          title="Build & Launch"
          description="Front-end build, QA, SEO/analytics setup, and production launch."
          todos={launchTodos}
          navigate={navigate}
          tone="cyan"
        />
      </main>
    </div>
  );
}

function TodoGroup({ title, description, todos, navigate, tone = "green" }) {
  return (
    <section className="todo-group">
      <h2>
        <span className={`group-dot group-dot--${tone}`} />
        {title}
      </h2>
      <p>{description}</p>
      <ul>
        {todos.map((todo) => (
          <TodoRow key={todo.title} todo={todo} onOpen={() => navigate("todo")} />
        ))}
      </ul>
      <button type="button" className="group-add">
        Add a to-do
      </button>
    </section>
  );
}

function TodoDetail({ navigate, goBack }) {
  const [completed, setCompleted] = useState(false);
  return (
    <div className="project-app">
      <ProjectHeader
        navigate={navigate}
        goBack={goBack}
        crumb="Project Tasks / Discovery & Design"
        backTo="todos"
      />
      <main className="todo-detail">
        <header>
          <h1>Run project kickoff and define scope</h1>
          <div className="detail-actions">
            <button
              type="button"
              className={completed ? "complete-button complete-button--done" : "complete-button"}
              onClick={() => setCompleted((value) => !value)}
            >
              <Icon name={completed ? "fa-square-check" : "fa-square"} />
              {completed ? "Completed" : "Mark as complete"}
            </button>
            <span>
              Added by <Avatar name="geoff" size="micro" /> Geoff C. on July 23
            </span>
          </div>
        </header>
        <dl className="detail-facts">
          <dt>Assigned to</dt>
          <dd>
            <Avatar name="geoff" size="micro" />
            Geoff C.
          </dd>
          <dt>When done</dt>
          <dd>
            <Avatar name="kimberly" size="micro" />
            Leah B. <Avatar name="marcus" size="micro" />
            Kurt H. <Avatar name="sofia" size="micro" />
            Sofía C.
          </dd>
          <dt>Due on</dt>
          <dd>
            <Icon name="fa-calendar" />
            Fri, Jul 31
          </dd>
          <dt>Notes</dt>
          <dd>
            <button type="button" className="file-attachment">
              <Icon name="fa-file-lines" />
              <span>
                <strong>Kickoff Notes.md</strong>
                <small>27.9 KB · Download</small>
              </span>
            </button>
          </dd>
          <dt>Subtasks</dt>
          <dd>
            <ul className="subtasks">
              <li className="is-done">
                <Icon name="fa-circle-check" />
                Schedule call with client and stakeholders <Avatar name="geoff" size="micro" />
              </li>
              <li>
                <Icon name="fa-circle" />
                Confirm goals, audience, and success criteria{" "}
                <Avatar name="kimberly" size="micro" />
              </li>
              <li>
                <Icon name="fa-circle" />
                Agree on timeline, milestones, and sign-off <Avatar name="kimberly" size="micro" />
              </li>
            </ul>
            <button type="button" className="add-subtask">
              Add a new subtask
            </button>
          </dd>
        </dl>
        <section className="comments" aria-label="Comments">
          <Comment avatar="geoff" name="Geoff Collier" role="Head of Design" time="Today 10:55am">
            Kickoff call is booked. I’ve got client project lead and their ops manager confirmed. I
            asked about their marketing lead too, but haven’t heard back yet, so I’ll chase that.
          </Comment>
          <Comment
            avatar="kimberly"
            name="Leah Bernstein"
            role="Customer Advocate"
            time="Today 10:57am"
          >
            Nice, thanks Geoff. Please do keep chasing the marketing lead — last time we didn’t find
            out about their campaign timeline until three weeks in.
          </Comment>
          <Comment
            avatar="marcus"
            name="Kurt Holloway"
            role="Customer Advocate"
            time="Today 11:01am"
          >
            There’s nothing between kickoff and showing the client mockups. That’s a long stretch
            with no check-in. If we’ve misread the brief, we won’t find out until we’ve already put
            in a lot of work.
          </Comment>
        </section>
      </main>
    </div>
  );
}

function Comment({ avatar, name, role, time, children }) {
  return (
    <article className="comment">
      <Avatar name={avatar} size="medium" />
      <div>
        <p>
          <strong>{name}</strong>{" "}
          <span>
            {role} · {time}
          </span>
        </p>
        <div>{children}</div>
        <button type="button" aria-label={`More actions for ${name}`}>
          <Icon name="fa-ellipsis" />
        </button>
      </div>
    </article>
  );
}

export function App() {
  const [view, setView] = useState(readView);

  useEffect(() => {
    if (!window.history.state?.view) {
      window.history.replaceState({ view }, "", window.location.href);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => setView(readView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.shiftKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        navigate("home");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const navigate = (nextView, mode = "push") => {
    const next = new URL(window.location.href);
    next.searchParams.set("view", nextView);
    const state = { view: nextView, previousView: mode === "push" ? view : undefined };
    if (mode === "replace") window.history.replaceState(state, "", next);
    else window.history.pushState(state, "", next);
    setView(nextView);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const goBack = (fallbackView) => {
    if (window.history.state?.previousView) {
      window.history.back();
    } else {
      navigate(fallbackView, "replace");
    }
  };

  if (view === "project") return <ProjectRoom navigate={navigate} goBack={goBack} />;
  if (view === "todos") return <TodosView navigate={navigate} goBack={goBack} />;
  if (view === "todo") return <TodoDetail navigate={navigate} goBack={goBack} />;
  return <HomeScreen navigate={navigate} />;
}
