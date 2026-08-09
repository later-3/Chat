import { forwardRef, useEffect, useMemo, useRef, useState } from "react";

const initialTasks = [
  {
    id: "travel-guide",
    title: "Borrow Emma’s travel guide",
    project: "Vacation in Rome",
    note: "Emma said the new edition has the best neighborhood walks.",
    checklist: ["Ask Emma when she is home", "Pick it up after work"],
    evening: false,
  },
  {
    id: "expense",
    title: "Finish expense report",
    project: "Work",
    note: "Add the train receipt and send the report to Finance.",
    checklist: ["Add missing receipt", "Review totals", "Submit to Finance"],
    evening: false,
    deadline: "today",
  },
  {
    id: "conference",
    title: "Confirm conference call for Friday",
    project: "Work",
    note: "Confirm the time with the London team.",
    checklist: ["Check time zones", "Send final invite"],
    evening: false,
  },
  {
    id: "lunch",
    title: "Organize team lunch",
    project: "Onboard Julia",
    note: "Find somewhere close to the office with outdoor tables.",
    checklist: ["Choose a place", "Book for six people"],
    evening: false,
  },
  {
    id: "milestones",
    title: "Review milestones from last quarter",
    project: "Prepare Presentation",
    note: "Pull out the three lessons that matter for the new plan.",
    checklist: ["Read the notes", "Mark key decisions", "Share the summary"],
    evening: false,
  },
  {
    id: "dinner",
    title: "Make dinner reservation",
    project: "Throw Party for Eve",
    note: "A quiet table for four, around 7:30.",
    checklist: ["Check two restaurants", "Confirm with Eve"],
    evening: true,
  },
  {
    id: "field-trip",
    title: "Pack bag for Olivia’s field trip",
    project: "Family",
    note: "The bus leaves at 08:15 tomorrow.",
    checklist: ["Water bottle", "Rain jacket", "Lunch box"],
    evening: true,
    checklistMark: true,
  },
  {
    id: "nutrition",
    title: "Read article about nutrition",
    project: "Run a Marathon",
    note: "Save any useful notes for next week’s meal plan.",
    checklist: ["Read the article", "Capture three notes"],
    evening: true,
    attachment: true,
  },
];

const navigation = [
  { id: "inbox", label: "Inbox", icon: "fa-solid fa-inbox", tone: "blue", count: "2" },
  { id: "today", label: "Today", icon: "fa-solid fa-star", tone: "yellow", badge: "1", count: "7" },
  { id: "upcoming", label: "Upcoming", icon: "fa-solid fa-calendar-days", tone: "pink" },
  { id: "anytime", label: "Anytime", icon: "fa-solid fa-layer-group", tone: "teal" },
  { id: "someday", label: "Someday", icon: "fa-solid fa-box-archive", tone: "olive" },
  {
    id: "logbook",
    label: "Logbook",
    icon: "fa-solid fa-square-check",
    tone: "green",
    separated: true,
  },
];

const areas = [
  { name: "Family", items: ["Vacation in Rome", "Throw Party for Eve", "Buy a New Bike"] },
  {
    name: "Work",
    items: ["Prepare Presentation", "Onboard Julia", "Write User Guide", "Order Team T-Shirts"],
  },
  { name: "Hobbies", items: ["Learn Basic Italian", "Run a Marathon"] },
];

const whenOptions = [
  { value: "today", label: "Today", hint: "Today", icon: "fa-solid fa-star", tone: "yellow" },
  {
    value: "evening",
    label: "This Evening",
    hint: "Tonight",
    icon: "fa-solid fa-moon",
    tone: "blue",
  },
  {
    value: "tomorrow",
    label: "Tomorrow",
    hint: "Mon, Aug 10",
    icon: "fa-solid fa-calendar-day",
    tone: "pink",
  },
  {
    value: "someday",
    label: "Someday",
    hint: "No start date",
    icon: "fa-solid fa-box-archive",
    tone: "olive",
  },
  {
    value: "clear",
    label: "Clear",
    hint: "Move to Anytime",
    icon: "fa-solid fa-xmark",
    tone: "gray",
  },
];

function Icon({ className, label }) {
  return <i className={className} aria-hidden={label ? undefined : "true"} aria-label={label} />;
}

function TrafficLights() {
  return (
    <div className="traffic-lights" aria-label="Window controls">
      <Icon className="fa-solid fa-circle traffic red" />
      <Icon className="fa-solid fa-circle traffic amber" />
      <Icon className="fa-solid fa-circle traffic green" />
    </div>
  );
}

function Checkbox({ checked, onChange, label }) {
  return (
    <button
      className={`task-checkbox${checked ? " checked" : ""}`}
      onClick={onChange}
      aria-label={label}
      aria-pressed={checked}
    >
      <Icon className={checked ? "fa-solid fa-circle-check" : "fa-regular fa-square"} />
    </button>
  );
}

export function App() {
  const [scale, setScale] = useState(1);
  const [view, setView] = useState("today");
  const [tasks, setTasks] = useState(initialTasks);
  const [selectedId, setSelectedId] = useState(null);
  const [whenOpen, setWhenOpen] = useState(false);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [toast, setToast] = useState(null);
  const [completedSnapshot, setCompletedSnapshot] = useState(null);
  const searchRef = useRef(null);

  useEffect(() => {
    const resize = () =>
      setScale(Math.min(1, (window.innerWidth - 72) / 1188, (window.innerHeight - 64) / 1028));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setQuickFindOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (event.key === "Escape") {
        setQuickFindOpen(false);
        setWhenOpen(false);
        setSelectedId(null);
        return;
      }
      const target = event.target;
      if (
        !quickFindOpen &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.length === 1 &&
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        setQuickFindOpen(true);
        setQuery(event.key);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [quickFindOpen]);

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;
  const daytime = tasks.filter((task) => !task.evening && !task.completed);
  const evening = tasks.filter((task) => task.evening && !task.completed);

  const quickResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const isSubsequence = (needle, haystack) => {
      let cursor = 0;
      for (const character of haystack) {
        if (character === needle[cursor]) cursor += 1;
        if (cursor === needle.length) return true;
      }
      return needle.length === 0;
    };
    const destinations = [
      {
        type: "list",
        id: "today",
        title: "Today",
        icon: "fa-solid fa-star",
        tone: "yellow",
        meta: "8",
      },
      ...areas.flatMap((area) => [
        { type: "area", id: area.name, title: area.name, icon: "fa-solid fa-cube", tone: "gray" },
        ...area.items.map((item) => ({
          type: "project",
          id: item,
          title: item,
          icon: "fa-solid fa-circle-half-stroke",
          tone: "gray",
        })),
      ]),
      ...tasks.map((task) => ({
        type: "task",
        id: task.id,
        title: task.title,
        icon: "fa-regular fa-square",
        tone: "gray",
        meta: task.project,
      })),
    ];
    if (!normalized) return destinations.slice(0, 7);
    return destinations
      .filter((item) => {
        const title = item.title.toLowerCase();
        const meta = item.meta?.toLowerCase() ?? "";
        return (
          title.includes(normalized) ||
          meta.includes(normalized) ||
          isSubsequence(normalized, title)
        );
      })
      .slice(0, 8);
  }, [query, tasks]);

  const announce = (message, action) => {
    setToast({ message, action });
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => setToast(null), 8000);
  };

  const completeTask = (task) => {
    setTasks((items) =>
      items.map((item) => (item.id === task.id ? { ...item, completed: true } : item)),
    );
    setCompletedSnapshot(task);
    if (selectedId === task.id) setSelectedId(null);
    setWhenOpen(false);
    announce(`Completed “${task.title}”`, "Undo");
  };

  const undoComplete = () => {
    if (!completedSnapshot) return;
    setTasks((items) =>
      items.map((item) =>
        item.id === completedSnapshot.id ? { ...completedSnapshot, completed: false } : item,
      ),
    );
    setToast(null);
    setCompletedSnapshot(null);
  };

  const chooseWhen = (value) => {
    if (!selectedTask) return;
    setCompletedSnapshot(selectedTask);
    if (value === "evening") {
      setTasks((items) =>
        items.map((item) =>
          item.id === selectedTask.id
            ? { ...item, evening: true, scheduled: "This Evening" }
            : item,
        ),
      );
      announce(`Moved “${selectedTask.title}” to This Evening`, "Undo");
    } else if (value === "today") {
      setTasks((items) =>
        items.map((item) =>
          item.id === selectedTask.id ? { ...item, evening: false, scheduled: "Today" } : item,
        ),
      );
      announce(`Moved “${selectedTask.title}” to Today`);
    } else if (value === "tomorrow" || value === "someday" || value === "clear") {
      setTasks((items) =>
        items.map((item) =>
          item.id === selectedTask.id ? { ...item, completed: true, scheduled: value } : item,
        ),
      );
      const destination =
        value === "tomorrow" ? "Tomorrow" : value === "someday" ? "Someday" : "Anytime";
      announce(`Moved “${selectedTask.title}” to ${destination}`, "Undo");
      setCompletedSnapshot(selectedTask);
      setSelectedId(null);
    }
    setWhenOpen(false);
  };

  const addTask = () => {
    const title = newTaskTitle.trim();
    if (!title) return;
    setTasks((items) => [
      { id: `new-${Date.now()}`, title, project: "Inbox", note: "", checklist: [], evening: false },
      ...items,
    ]);
    setNewTaskOpen(false);
    setNewTaskTitle("");
    announce(`Added “${title}” to Today`);
  };

  const chooseQuickResult = (item) => {
    setQuickFindOpen(false);
    setQuery("");
    if (item.type === "task") {
      setView("today");
      setSelectedId(item.id);
    } else if (item.id === "today") {
      setView("today");
      setSelectedId(null);
    } else {
      setView(item.id);
      setSelectedId(null);
    }
  };

  return (
    <main className="stage">
      <div className="scaled-window" style={{ width: 1188 * scale, height: 1028 * scale }}>
        <section
          className="things-window"
          style={{ transform: `scale(${scale})` }}
          aria-label="Things Today reference prototype"
        >
          <aside className="sidebar">
            <TrafficLights />
            <nav className="primary-nav" aria-label="Things lists">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={`nav-row${view === item.id ? " active" : ""}${item.separated ? " separated" : ""}`}
                  onClick={() => {
                    setView(item.id);
                    setSelectedId(null);
                    setWhenOpen(false);
                  }}
                >
                  <span className={`nav-icon ${item.tone}`}>
                    <Icon className={item.icon} />
                  </span>
                  <span className="nav-label">{item.label}</span>
                  <span className="nav-numbers">
                    {item.badge && <span className="badge">{item.badge}</span>}
                    {item.count && <span className="count">{item.count}</span>}
                  </span>
                </button>
              ))}
            </nav>

            <nav className="area-nav" aria-label="Areas and projects">
              {areas.map((area) => (
                <section className="area-group" key={area.name}>
                  <button
                    className={`area-title${view === area.name ? " current" : ""}`}
                    onClick={() => setView(area.name)}
                  >
                    <Icon className="fa-solid fa-cube" />
                    <span>{area.name}</span>
                  </button>
                  {area.items.map((item) => (
                    <button
                      key={item}
                      className={`project-row${view === item ? " current" : ""}`}
                      onClick={() => setView(item)}
                    >
                      <Icon className="fa-solid fa-circle-half-stroke" />
                      <span>{item}</span>
                    </button>
                  ))}
                </section>
              ))}
            </nav>

            <button className="new-list-button">
              <Icon className="fa-solid fa-plus" />
              <span>New List</span>
            </button>
            <button className="sidebar-settings" aria-label="List settings">
              <Icon className="fa-solid fa-sliders" />
            </button>
          </aside>

          <section className="content-shell">
            <button className="open-new-window" aria-label="Open in new window">
              <Icon className="fa-regular fa-clone" />
            </button>

            {view === "today" ? (
              <TodayView
                daytime={daytime}
                evening={evening}
                selectedTask={selectedTask}
                whenOpen={whenOpen}
                onSelectTask={(id) => {
                  setSelectedId((current) => (current === id ? null : id));
                  setWhenOpen(false);
                }}
                onComplete={completeTask}
                onOpenWhen={() => setWhenOpen((open) => !open)}
                onChooseWhen={chooseWhen}
                onCloseDetail={() => {
                  setSelectedId(null);
                  setWhenOpen(false);
                }}
                newTaskOpen={newTaskOpen}
                newTaskTitle={newTaskTitle}
                onNewTaskTitle={setNewTaskTitle}
                onAddTask={addTask}
                onCancelNewTask={() => {
                  setNewTaskOpen(false);
                  setNewTaskTitle("");
                }}
              />
            ) : (
              <ProjectView
                title={view}
                tasks={tasks.filter((task) => task.project === view)}
                onBack={() => setView("today")}
                onSelectTask={(id) => {
                  setView("today");
                  setSelectedId(id);
                }}
              />
            )}

            <footer className="bottom-toolbar" aria-label="Things actions">
              <button
                className="tool-button"
                aria-label="New to-do"
                onClick={() => {
                  setView("today");
                  setNewTaskOpen(true);
                  setSelectedId(null);
                }}
              >
                <Icon className="fa-solid fa-plus" />
              </button>
              <button
                className="tool-button"
                aria-label="When"
                onClick={() =>
                  selectedTask
                    ? setWhenOpen((open) => !open)
                    : announce("Open a to-do before choosing When")
                }
              >
                <Icon className="fa-regular fa-calendar-days" />
              </button>
              <button
                className="tool-button"
                aria-label="Move"
                onClick={() =>
                  selectedTask
                    ? setWhenOpen((open) => !open)
                    : announce("Open a to-do before moving it")
                }
              >
                <Icon className="fa-solid fa-arrow-right" />
              </button>
              <button
                className="tool-button"
                aria-label="Quick Find"
                onClick={() => {
                  setQuickFindOpen(true);
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <Icon className="fa-solid fa-magnifying-glass" />
              </button>
            </footer>
          </section>

          {quickFindOpen && (
            <QuickFind
              ref={searchRef}
              query={query}
              onQuery={setQuery}
              results={quickResults}
              onClose={() => {
                setQuickFindOpen(false);
                setQuery("");
              }}
              onChoose={chooseQuickResult}
            />
          )}

          {toast && (
            <div className="toast" role="status">
              <span>{toast.message}</span>
              {toast.action && <button onClick={undoComplete}>{toast.action}</button>}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function TodayView({
  daytime,
  evening,
  selectedTask,
  whenOpen,
  onSelectTask,
  onComplete,
  onOpenWhen,
  onChooseWhen,
  onCloseDetail,
  newTaskOpen,
  newTaskTitle,
  onNewTaskTitle,
  onAddTask,
  onCancelNewTask,
}) {
  return (
    <div className="today-view">
      <header className="today-heading">
        <Icon className="fa-solid fa-star heading-star" />
        <h1>Today</h1>
      </header>

      <section className="calendar-events" aria-label="Calendar events">
        <div className="event birthday">
          <span className="event-mark">I</span>
          <span>Ben’s birthday</span>
        </div>
        <div className="event blue">
          <span>07:00</span>
          <span>Hit the gym with Lucas</span>
        </div>
        <div className="event blue">
          <span>08:30</span>
          <span>Coffee with Emma</span>
        </div>
        <div className="event green">
          <span>11:00</span>
          <span>Team meeting</span>
        </div>
        <div className="event green">
          <span>15:30</span>
          <span>Budget review</span>
        </div>
      </section>

      <section className="task-section daytime-section" aria-label="Daytime to-dos">
        {newTaskOpen && (
          <div className="new-task-row">
            <Icon className="fa-regular fa-square" />
            <input
              autoFocus
              value={newTaskTitle}
              onChange={(event) => onNewTaskTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onAddTask();
                if (event.key === "Escape") onCancelNewTask();
              }}
              placeholder="New To-Do"
              aria-label="New to-do title"
            />
            <button onClick={onAddTask}>Add</button>
          </div>
        )}
        {daytime.map((task) => (
          <TaskBlock
            key={task.id}
            task={task}
            selected={selectedTask?.id === task.id}
            whenOpen={selectedTask?.id === task.id && whenOpen}
            onSelect={() => onSelectTask(task.id)}
            onComplete={() => onComplete(task)}
            onOpenWhen={onOpenWhen}
            onChooseWhen={onChooseWhen}
            onClose={onCloseDetail}
          />
        ))}
      </section>

      <section className="evening-section" aria-label="This Evening">
        <div className="evening-heading">
          <Icon className="fa-solid fa-moon" />
          <h2>This Evening</h2>
          <span className="rule" />
        </div>
        {evening.map((task) => (
          <TaskBlock
            key={task.id}
            task={task}
            selected={selectedTask?.id === task.id}
            whenOpen={selectedTask?.id === task.id && whenOpen}
            onSelect={() => onSelectTask(task.id)}
            onComplete={() => onComplete(task)}
            onOpenWhen={onOpenWhen}
            onChooseWhen={onChooseWhen}
            onClose={onCloseDetail}
            compact
          />
        ))}
      </section>
    </div>
  );
}

function TaskBlock({
  task,
  selected,
  whenOpen,
  onSelect,
  onComplete,
  onOpenWhen,
  onChooseWhen,
  onClose,
  compact,
}) {
  if (selected) {
    return (
      <article className={`task-detail${compact ? " compact-detail" : ""}`}>
        <div className="detail-main-row">
          <Checkbox checked={false} onChange={onComplete} label={`Complete ${task.title}`} />
          <div className="detail-copy">
            <input className="detail-title" value={task.title} readOnly aria-label="To-do title" />
            <textarea className="detail-note" value={task.note} readOnly aria-label="Notes" />
          </div>
          <button className="detail-close" aria-label="Close to-do" onClick={onClose}>
            <Icon className="fa-solid fa-xmark" />
          </button>
        </div>
        {task.checklist.length > 0 && (
          <div className="checklist">
            {task.checklist.map((item) => (
              <div className="checklist-row" key={item}>
                <Icon className="fa-regular fa-circle" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        )}
        <div className="detail-footer">
          <button className="when-button active" onClick={onOpenWhen} aria-expanded={whenOpen}>
            <Icon className={task.evening ? "fa-solid fa-moon" : "fa-solid fa-star"} />
            <span>{task.evening ? "This Evening" : "Today"}</span>
          </button>
          <div className="detail-actions">
            <button aria-label="Tags">
              <Icon className="fa-solid fa-tag" />
            </button>
            <button aria-label="Deadline">
              <Icon className="fa-regular fa-flag" />
            </button>
          </div>
        </div>
        {whenOpen && <WhenPopover onChoose={onChooseWhen} />}
      </article>
    );
  }

  return (
    <div className="task-row">
      <Checkbox checked={false} onChange={onComplete} label={`Complete ${task.title}`} />
      <button className="task-copy" onClick={onSelect}>
        <span className="task-title">
          {task.title}
          {task.checklistMark && <Icon className="fa-solid fa-list-ul row-meta-icon" />}
          {task.attachment && <Icon className="fa-regular fa-file row-meta-icon" />}
        </span>
        <span className="task-project">{task.project}</span>
      </button>
      {task.deadline && (
        <button className="deadline-chip" onClick={onSelect}>
          <Icon className="fa-solid fa-flag" />
          <span>{task.deadline}</span>
        </button>
      )}
    </div>
  );
}

function WhenPopover({ onChoose }) {
  const [dateQuery, setDateQuery] = useState("");
  const naturalSuggestions = [
    { label: "in 3 days", hint: "Sun", value: "tomorrow" },
    { label: "in 3 weeks", hint: "Thu, Jun 8", value: "tomorrow" },
    { label: "in 3 months", hint: "Fri, Aug 18", value: "tomorrow" },
  ];

  return (
    <div
      className={`when-popover${dateQuery ? " natural" : ""}`}
      role="dialog"
      aria-label="Choose when"
    >
      <label className="when-search">
        <Icon className="fa-solid fa-magnifying-glass" />
        <input
          value={dateQuery}
          onChange={(event) => setDateQuery(event.target.value)}
          placeholder="Type a date"
          aria-label="Type a natural language date"
        />
      </label>
      <div className="when-options">
        {dateQuery
          ? naturalSuggestions.map((option, index) => (
              <button
                key={option.label}
                className={index === 0 ? "suggestion-selected" : ""}
                onClick={() => onChoose(option.value)}
              >
                <span className="when-icon pink">
                  <Icon className="fa-solid fa-calendar-days" />
                </span>
                <span className="when-label">{option.label}</span>
                <span className="when-hint">{option.hint}</span>
              </button>
            ))
          : whenOptions.map((option) => (
              <button key={option.value} onClick={() => onChoose(option.value)}>
                <span className={`when-icon ${option.tone}`}>
                  <Icon className={option.icon} />
                </span>
                <span className="when-label">{option.label}</span>
                <span className="when-hint">{option.hint}</span>
              </button>
            ))}
      </div>
    </div>
  );
}

const QuickFind = forwardRef(function QuickFind(
  { query, onQuery, results, onClose, onChoose },
  ref,
) {
  return (
    <div className="quick-find" role="dialog" aria-label="Quick Find">
      <label className="quick-input">
        <Icon className="fa-solid fa-magnifying-glass" />
        <input
          ref={ref}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Quick Find"
          aria-label="Quick Find"
        />
        <button onClick={onClose} aria-label="Close Quick Find">
          <Icon className="fa-solid fa-xmark" />
        </button>
      </label>
      <div className="quick-results">
        {results.map((item, index) => (
          <button
            key={`${item.type}-${item.id}`}
            className={index === 0 ? "highlighted" : ""}
            onClick={() => onChoose(item)}
          >
            <span className={`quick-icon ${item.tone}`}>
              <Icon className={item.icon} />
            </span>
            <span className="quick-title">{item.title}</span>
            {item.id === "today" && <span className="quick-badge">1</span>}
            {item.meta && <span className="quick-meta">{item.meta}</span>}
          </button>
        ))}
        <button className="continue-search">
          <Icon className="fa-solid fa-magnifying-glass" />
          <span>Continue Search</span>
        </button>
      </div>
    </div>
  );
});

function ProjectView({ title, tasks, onBack, onSelectTask }) {
  const presentationSections = [
    {
      title: "Slides and notes",
      tasks: [
        { title: "Review the story and simplify the opening", id: "milestones" },
        { title: "Update slide layouts", marks: ["fa-regular fa-file", "fa-solid fa-list-ul"] },
        { title: "Review quarterly data with Olivia", starred: true },
        { title: "Print handouts for attendees", date: "May 25" },
      ],
    },
    {
      title: "Preparation",
      tasks: [
        { title: "Email John for presentation tips" },
        { title: "Check out book recommendations", marks: ["fa-regular fa-file"] },
        { title: "Time a full rehearsal", tag: "Important" },
        { title: "Do a practice run with Eric" },
        { title: "Confirm presentation time", tag: "Important" },
      ],
    },
    { title: "Facilities", tasks: [{ title: "Book the conference room" }] },
  ];
  const sections =
    title === "Prepare Presentation"
      ? presentationSections
      : [{ title: "To-Dos", tasks: tasks.map((task) => ({ title: task.title, id: task.id })) }];

  return (
    <div className="project-view">
      <button className="project-back" onClick={onBack}>
        <Icon className="fa-solid fa-chevron-left" />
        <span>Today</span>
      </button>
      <header>
        <Icon className="fa-solid fa-circle-notch project-heading-icon" />
        <h1>{title}</h1>
        <button className="project-more" aria-label="Project menu">
          <Icon className="fa-solid fa-ellipsis" />
        </button>
      </header>
      <p className="project-intro">
        Keep the talk and slides simple: what are the three things about this that everyone should
        remember?
      </p>
      <div className="project-filters">
        <button className="selected">All</button>
        <button>Important</button>
        <button>Diane</button>
      </div>
      <div className="project-sections">
        {sections.map((section) => (
          <section className="project-list" key={section.title}>
            <div className="project-section-heading">
              <h2>{section.title}</h2>
              <button aria-label={`${section.title} menu`}>
                <Icon className="fa-solid fa-ellipsis" />
              </button>
            </div>
            {section.tasks.length ? (
              section.tasks.map((task) => (
                <button key={task.title} onClick={() => task.id && onSelectTask(task.id)}>
                  <Icon className="fa-regular fa-square" />
                  {task.starred && <Icon className="fa-solid fa-star project-task-star" />}
                  {task.date && <span className="project-date">{task.date}</span>}
                  <span className="project-task-title">{task.title}</span>
                  {task.marks?.map((mark) => (
                    <Icon key={mark} className={`project-task-mark ${mark}`} />
                  ))}
                  {task.tag && <span className="project-tag">{task.tag}</span>}
                </button>
              ))
            ) : (
              <p className="empty-project">No to-dos in this project yet.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
