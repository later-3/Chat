import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildQuickFindResults,
  builtInLists,
  cloneInitialThingsState,
  completeTask as completeTaskInModel,
  getNewTaskDefaults,
  getTasksForView,
  moveTask as moveTaskInModel,
  restoreTask,
  scheduleTask as scheduleTaskInModel,
  TODAY_DATE,
} from "./thingsModel.js";
import {
  Icon,
  NewListPopover,
  QuickFind,
  SettingsPopover,
  Sidebar,
  ThingsContent,
} from "./ThingsViews.jsx";

function initialViewFromLocation() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("view") || "today";
}

function taskDestinationLabel(value) {
  if (value === "today") return "Today";
  if (value === "evening") return "This Evening";
  if (value === "tomorrow") return "Tomorrow";
  if (value === "someday") return "Someday";
  if (value === "clear") return "Anytime";
  return value;
}

export function App() {
  const [scale, setScale] = useState(1);
  const [compact, setCompact] = useState(() => window.innerWidth <= 760);
  const [things, setThings] = useState(cloneInitialThingsState);
  const [view, setView] = useState(initialViewFromLocation);
  const [selectedId, setSelectedId] = useState(null);
  const [overlay, setOverlay] = useState(null);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [quickExtended, setQuickExtended] = useState(false);
  const [quickIndex, setQuickIndex] = useState(0);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskHeadingId, setNewTaskHeadingId] = useState(null);
  const [toast, setToast] = useState(null);
  const [movedOutInbox, setMovedOutInbox] = useState(0);
  const [filterTags, setFilterTags] = useState([]);
  const [expandedGroups, setExpandedGroups] = useState([]);
  const [settings, setSettings] = useState({ showCalendar: true, groupToday: false });
  const searchRef = useRef(null);
  const toastTimer = useRef(null);
  const quickTrigger = useRef(null);

  useEffect(() => {
    const resize = () => {
      const nextCompact = window.innerWidth <= 760;
      setCompact(nextCompact);
      setScale(
        nextCompact
          ? 1
          : Math.min(1, (window.innerWidth - 72) / 1188, (window.innerHeight - 64) / 1028),
      );
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const syncRoute = () => {
      const nextView = initialViewFromLocation();
      setView(nextView);
      setSelectedId(null);
      setOverlay(null);
      setNewTaskOpen(false);
      setNewTaskTitle("");
      setNewTaskHeadingId(null);
      setFilterTags([]);
    };
    window.addEventListener("popstate", syncRoute);
    window.addEventListener("hashchange", syncRoute);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener("hashchange", syncRoute);
    };
  }, []);

  const closeQuickFind = useCallback(() => {
    setQuickFindOpen(false);
    setQuery("");
    setQuickExtended(false);
    setQuickIndex(0);
    requestAnimationFrame(() => quickTrigger.current?.focus());
  }, []);

  const openQuickFind = useCallback((initialQuery = "", trigger = null) => {
    quickTrigger.current = trigger ?? document.activeElement;
    setOverlay(null);
    setQuickFindOpen(true);
    setQuery(initialQuery);
    setQuickExtended(false);
    setQuickIndex(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openQuickFind();
        return;
      }
      if (event.key === "Escape") {
        if (quickFindOpen) {
          event.preventDefault();
          closeQuickFind();
          return;
        }
        if (overlay) {
          event.preventDefault();
          setOverlay(null);
          return;
        }
        if (newTaskOpen) {
          event.preventDefault();
          setNewTaskOpen(false);
          setNewTaskTitle("");
          setNewTaskHeadingId(null);
          return;
        }
        if (selectedId) {
          event.preventDefault();
          setSelectedId(null);
        }
        return;
      }

      const target = event.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLButtonElement ||
        target?.isContentEditable;
      if (
        !quickFindOpen &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        /^[a-z0-9]$/i.test(event.key) &&
        !isTypingTarget
      ) {
        openQuickFind(event.key);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeQuickFind, newTaskOpen, openQuickFind, overlay, quickFindOpen, selectedId]);

  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const announce = useCallback((message, actionLabel, onAction) => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, actionLabel, onAction });
    toastTimer.current = window.setTimeout(() => setToast(null), 8000);
  }, []);

  const navigate = useCallback(
    (nextView) => {
      if (view === "inbox" && nextView !== "inbox") setMovedOutInbox(0);
      setView(nextView);
      setSelectedId(null);
      setOverlay(null);
      setNewTaskOpen(false);
      setNewTaskTitle("");
      setNewTaskHeadingId(null);
      setFilterTags([]);
      window.location.hash = `view=${encodeURIComponent(nextView)}`;
    },
    [view],
  );

  const selectedTask = things.tasks.find((task) => task.id === selectedId) ?? null;
  const visibleTasks = useMemo(() => getTasksForView(things, view), [things, view]);

  const effectiveTags = useCallback(
    (task) => {
      const inherited = [];
      if (task.parent.type === "project") {
        const project = things.projects.find((item) => item.id === task.parent.id);
        if (project) {
          inherited.push(...project.tags);
          const area = things.areas.find((item) => item.id === project.areaId);
          if (area) inherited.push(...area.tags);
        }
      } else if (task.parent.type === "area") {
        const area = things.areas.find((item) => item.id === task.parent.id);
        if (area) inherited.push(...area.tags);
      }
      return [...new Set([...task.tags, ...inherited])];
    },
    [things.areas, things.projects],
  );

  const filteredTasks = useMemo(
    () =>
      filterTags.length
        ? visibleTasks.filter((task) =>
            filterTags.every((tag) => effectiveTags(task).includes(tag)),
          )
        : visibleTasks,
    [effectiveTags, filterTags, visibleTasks],
  );

  const availableFilterTags = useMemo(
    () => [...new Set(visibleTasks.flatMap((task) => effectiveTags(task)))],
    [effectiveTags, visibleTasks],
  );

  const updateTask = useCallback((id, updater) => {
    setThings((current) => ({
      ...current,
      tasks: current.tasks.map((task) => {
        if (task.id !== id) return task;
        return typeof updater === "function" ? updater(task) : { ...task, ...updater };
      }),
    }));
  }, []);

  const completeTask = useCallback(
    (task, status = "completed") => {
      const before = structuredClone(task);
      setThings((current) => {
        const result = completeTaskInModel(current.tasks, task.id, TODAY_DATE, status);
        return { ...current, tasks: result.tasks };
      });
      setSelectedId(null);
      setOverlay(null);
      announce(
        `${status === "canceled" ? "Canceled" : "Completed"} “${task.title}”`,
        "Undo",
        () => {
          setThings((current) => ({ ...current, tasks: restoreTask(current.tasks, before) }));
          setToast(null);
        },
      );
    },
    [announce],
  );

  const reopenTask = useCallback(
    (task) => {
      const before = structuredClone(task);
      updateTask(task.id, {
        status: "open",
        isLogged: false,
        completedAt: undefined,
      });
      setSelectedId(null);
      announce(`Reopened “${task.title}”`, "Undo", () => {
        setThings((current) => ({ ...current, tasks: restoreTask(current.tasks, before) }));
        setToast(null);
      });
    },
    [announce, updateTask],
  );

  const scheduleTask = useCallback(
    (task, value) => {
      const before = structuredClone(task);
      setThings((current) => ({
        ...current,
        tasks: scheduleTaskInModel(current.tasks, task.id, value),
      }));
      if (task.isInbox) setMovedOutInbox((count) => count + 1);
      setSelectedId(null);
      setOverlay(null);
      announce(`Scheduled “${task.title}” for ${taskDestinationLabel(value)}`, "Undo", () => {
        setThings((current) => ({ ...current, tasks: restoreTask(current.tasks, before) }));
        if (task.isInbox) setMovedOutInbox((count) => Math.max(0, count - 1));
        setToast(null);
      });
    },
    [announce],
  );

  const moveTask = useCallback(
    (task, destination) => {
      const before = structuredClone(task);
      setThings((current) => ({
        ...current,
        tasks: moveTaskInModel(current.tasks, task.id, destination),
      }));
      if (task.isInbox) setMovedOutInbox((count) => count + 1);
      setSelectedId(null);
      setOverlay(null);
      announce(`Moved “${task.title}” to ${destination.label}`, "Undo", () => {
        setThings((current) => ({ ...current, tasks: restoreTask(current.tasks, before) }));
        if (task.isInbox) setMovedOutInbox((count) => Math.max(0, count - 1));
        setToast(null);
      });
    },
    [announce],
  );

  const setTaskDeadline = useCallback(
    (task, deadline) => {
      const before = structuredClone(task);
      updateTask(task.id, { deadline: deadline || undefined });
      setOverlay(null);
      announce(
        deadline ? `Deadline set for “${task.title}”` : `Cleared deadline for “${task.title}”`,
        "Undo",
        () => {
          setThings((current) => ({ ...current, tasks: restoreTask(current.tasks, before) }));
          setToast(null);
        },
      );
    },
    [announce, updateTask],
  );

  const setTaskTags = useCallback(
    (task, tags) => {
      updateTask(task.id, { tags });
      announce(`Updated tags for “${task.title}”`);
    },
    [announce, updateTask],
  );

  const toggleChecklist = useCallback(
    (task, checklistId) => {
      updateTask(task.id, (current) => ({
        ...current,
        checklist: current.checklist.map((item) =>
          item.id === checklistId ? { ...item, completed: !item.completed } : item,
        ),
      }));
    },
    [updateTask],
  );

  const addChecklistItem = useCallback(
    (task, title) => {
      const normalized = title.trim();
      if (!normalized) return;
      updateTask(task.id, (current) => ({
        ...current,
        checklist: [
          ...current.checklist,
          { id: `check-${Date.now()}`, title: normalized, completed: false },
        ],
      }));
    },
    [updateTask],
  );

  const removeChecklistItem = useCallback(
    (task, checklistId) => {
      updateTask(task.id, (current) => ({
        ...current,
        checklist: current.checklist.filter((item) => item.id !== checklistId),
      }));
    },
    [updateTask],
  );

  const addTag = useCallback((tag) => {
    const normalized = tag.trim();
    if (!normalized) return;
    setThings((current) =>
      current.tags.includes(normalized)
        ? current
        : { ...current, tags: [...current.tags, normalized] },
    );
  }, []);

  const duplicateTask = useCallback(
    (task) => {
      const copy = {
        ...structuredClone(task),
        id: `task-copy-${Date.now()}`,
        title: `${task.title} copy`,
        status: "open",
        isLogged: false,
        completedAt: undefined,
      };
      setThings((current) => ({ ...current, tasks: [copy, ...current.tasks] }));
      setOverlay(null);
      setSelectedId(copy.id);
      announce(`Duplicated “${task.title}”`);
    },
    [announce],
  );

  const createProjectForTask = useCallback(
    (task, title) => {
      const normalized = title.trim();
      if (!normalized) return;
      const projectId = `project-${Date.now()}`;
      setThings((current) => ({
        ...current,
        projects: [
          ...current.projects,
          {
            id: projectId,
            name: normalized,
            areaId: null,
            note: "Created from Move.",
            tags: [],
            start: "anytime",
            evening: false,
            status: "open",
            isLogged: false,
            headings: [],
          },
        ],
        tasks: current.tasks.map((item) =>
          item.id === task.id
            ? { ...item, parent: { type: "project", id: projectId }, headingId: undefined, isInbox: false }
            : item,
        ),
      }));
      if (task.isInbox) setMovedOutInbox((count) => count + 1);
      setOverlay(null);
      setSelectedId(null);
      announce(`Created “${normalized}” and moved “${task.title}”`);
    },
    [announce],
  );

  const startNewTask = useCallback((headingId = null) => {
    setOverlay(null);
    setSelectedId(null);
    setNewTaskHeadingId(headingId);
    setNewTaskOpen(true);
    requestAnimationFrame(() => document.querySelector("[data-new-task-input]")?.focus());
  }, []);

  const addTask = useCallback(() => {
    const title = newTaskTitle.trim();
    if (!title) return;
    const defaults = getNewTaskDefaults(view, things);
    const task = {
      id: `task-${Date.now()}`,
      title,
      ...defaults,
      headingId: newTaskHeadingId || undefined,
      note: "",
      checklist: [],
      status: "open",
      isLogged: false,
    };
    setThings((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    setNewTaskOpen(false);
    setNewTaskTitle("");
    setNewTaskHeadingId(null);
    const destination =
      view === "upcoming" || view === "tomorrow"
        ? "Tomorrow"
        : view === "logbook" || view.startsWith("logged-")
          ? "Inbox"
          : view.startsWith("project:")
            ? things.projects.find((project) => `project:${project.id}` === view)?.name
            : view.startsWith("area:")
              ? things.areas.find((area) => `area:${area.id}` === view)?.name
              : builtInLists.find((list) => list.id === view)?.label ?? "Inbox";
    announce(`Added “${title}” to ${destination || "Inbox"}`);
  }, [announce, newTaskHeadingId, newTaskTitle, things, view]);

  const createList = useCallback(
    ({ type, title, areaId }) => {
      const normalized = title.trim();
      if (!normalized) return;
      const id = `${type}-${Date.now()}`;
      if (type === "area") {
        setThings((current) => ({
          ...current,
          areas: [...current.areas, { id, name: normalized, tags: [] }],
        }));
        setOverlay(null);
        navigate(`area:${id}`);
        announce(`Created area “${normalized}”`);
        return;
      }
      setThings((current) => ({
        ...current,
        projects: [
          ...current.projects,
          {
            id,
            name: normalized,
            areaId: areaId || null,
            note: "",
            tags: [],
            start: "anytime",
            evening: false,
            status: "open",
            isLogged: false,
            headings: [],
          },
        ],
      }));
      setOverlay(null);
      navigate(`project:${id}`);
      announce(`Created project “${normalized}”`);
    },
    [announce, navigate],
  );

  const updateProject = useCallback((id, updater) => {
    setThings((current) => ({
      ...current,
      projects: current.projects.map((project) => {
        if (project.id !== id) return project;
        return typeof updater === "function" ? updater(project) : { ...project, ...updater };
      }),
    }));
  }, []);

  const reopenProject = useCallback(
    (project) => {
      updateProject(project.id, { status: "open", isLogged: false, completedAt: undefined });
      announce(`Reopened project “${project.name}”`);
      navigate(`project:${project.id}`);
    },
    [announce, navigate, updateProject],
  );

  const updateArea = useCallback((id, updater) => {
    setThings((current) => ({
      ...current,
      areas: current.areas.map((area) => {
        if (area.id !== id) return area;
        return typeof updater === "function" ? updater(area) : { ...area, ...updater };
      }),
    }));
  }, []);

  const projectAction = useCallback(
    (project, action, value) => {
      if (action === "duplicate") {
        const suffix = Date.now();
        const copyId = `project-copy-${suffix}`;
        const headings = project.headings.map((heading) => ({
          ...heading,
          id: `${heading.id}-copy-${suffix}`,
        }));
        const headingMap = new Map(
          project.headings.map((heading, index) => [heading.id, headings[index].id]),
        );
        const copies = things.tasks
          .filter((task) => task.parent.type === "project" && task.parent.id === project.id)
          .map((task) => ({
            ...structuredClone(task),
            id: `${task.id}-copy-${suffix}`,
            title: task.title,
            parent: { type: "project", id: copyId },
            headingId: task.headingId ? headingMap.get(task.headingId) : undefined,
            status: "open",
            isLogged: false,
            completedAt: undefined,
          }));
        setThings((current) => ({
          ...current,
          projects: [
            ...current.projects,
            { ...structuredClone(project), id: copyId, name: `${project.name} copy`, headings },
          ],
          tasks: [...current.tasks, ...copies],
        }));
        setOverlay(null);
        announce(`Duplicated “${project.name}”`);
        return;
      }
      if (action === "complete" || action === "cancel") {
        const status = action === "complete" ? "completed" : "canceled";
        updateProject(project.id, { status, isLogged: true, completedAt: TODAY_DATE });
        setThings((current) => ({
          ...current,
          tasks: current.tasks.map((task) =>
            task.parent.type === "project" && task.parent.id === project.id
              ? { ...task, status, isLogged: true, completedAt: TODAY_DATE }
              : task,
          ),
        }));
        setOverlay(null);
        navigate("today");
        announce(`${status === "completed" ? "Completed" : "Canceled"} “${project.name}”`);
        return;
      }
      if (action === "move") {
        updateProject(project.id, { areaId: value || null });
        setOverlay(null);
        announce(`Moved “${project.name}”`);
        return;
      }
      if (action === "schedule") {
        const patch =
          value === "someday"
            ? { start: "someday", startDate: undefined, evening: false }
            : value === "clear"
              ? { start: "anytime", startDate: undefined, evening: false }
              : {
                  start: "on-date",
                  startDate: value === "tomorrow" ? "2026-08-10" : TODAY_DATE,
                  evening: value === "evening",
                };
        updateProject(project.id, patch);
        setOverlay(null);
        announce(`Scheduled “${project.name}” for ${taskDestinationLabel(value)}`);
        return;
      }
      if (action === "deadline") {
        updateProject(project.id, { deadline: value || undefined });
        setOverlay(null);
        announce(value ? `Deadline set for “${project.name}”` : `Cleared project deadline`);
      }
    },
    [announce, navigate, things.tasks, updateProject],
  );

  const headingAction = useCallback(
    (project, heading, action, value) => {
      if (action === "rename") {
        updateProject(project.id, (current) => ({
          ...current,
          headings: current.headings.map((item) =>
            item.id === heading.id ? { ...item, title: value } : item,
          ),
        }));
        setOverlay(null);
        announce(`Renamed heading to “${value}”`);
        return;
      }
      if (action === "duplicate") {
        const copyId = `${heading.id}-copy-${Date.now()}`;
        updateProject(project.id, (current) => ({
          ...current,
          headings: [
            ...current.headings,
            { ...structuredClone(heading), id: copyId, title: `${heading.title} copy` },
          ],
        }));
        setThings((current) => ({
          ...current,
          tasks: [
            ...current.tasks,
            ...current.tasks
              .filter(
                (task) =>
                  task.parent.type === "project" &&
                  task.parent.id === project.id &&
                  task.headingId === heading.id,
              )
              .map((task) => ({
                ...structuredClone(task),
                id: `${task.id}-copy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                headingId: copyId,
                status: "open",
                isLogged: false,
              })),
          ],
        }));
        setOverlay(null);
        announce(`Duplicated heading “${heading.title}”`);
        return;
      }
      if (action === "archive") {
        updateProject(project.id, (current) => ({
          ...current,
          headings: current.headings.map((item) =>
            item.id === heading.id ? { ...item, archived: true } : item,
          ),
        }));
        setThings((current) => ({
          ...current,
          tasks: current.tasks.map((task) =>
            task.parent.type === "project" &&
            task.parent.id === project.id &&
            task.headingId === heading.id
              ? { ...task, status: "completed", isLogged: true, completedAt: TODAY_DATE }
              : task,
          ),
        }));
        setOverlay(null);
        announce(`Archived heading “${heading.title}”`);
        return;
      }
      if (action === "move") {
        const destination = things.projects.find((item) => item.id === value);
        if (!destination) return;
        updateProject(project.id, (current) => ({
          ...current,
          headings: current.headings.filter((item) => item.id !== heading.id),
        }));
        updateProject(destination.id, (current) => ({
          ...current,
          headings: [...current.headings, heading],
        }));
        setThings((current) => ({
          ...current,
          tasks: current.tasks.map((task) =>
            task.parent.type === "project" &&
            task.parent.id === project.id &&
            task.headingId === heading.id
              ? { ...task, parent: { type: "project", id: destination.id } }
              : task,
          ),
        }));
        setOverlay(null);
        announce(`Moved heading to “${destination.name}”`);
        return;
      }
      if (action === "convert") {
        const newProjectId = `project-${Date.now()}`;
        setThings((current) => ({
          ...current,
          projects: [
            ...current.projects.map((item) =>
              item.id === project.id
                ? { ...item, headings: item.headings.filter((entry) => entry.id !== heading.id) }
                : item,
            ),
            {
              id: newProjectId,
              name: heading.title,
              areaId: project.areaId,
              note: "Converted from a heading.",
              tags: [...project.tags],
              start: "anytime",
              evening: false,
              status: "open",
              isLogged: false,
              headings: [],
            },
          ],
          tasks: current.tasks.map((task) =>
            task.parent.type === "project" &&
            task.parent.id === project.id &&
            task.headingId === heading.id
              ? {
                  ...task,
                  parent: { type: "project", id: newProjectId },
                  headingId: undefined,
                }
              : task,
          ),
        }));
        setOverlay(null);
        navigate(`project:${newProjectId}`);
        announce(`Converted “${heading.title}” to a project`);
      }
    },
    [announce, navigate, things.projects, updateProject],
  );

  const quickResults = useMemo(
    () => buildQuickFindResults(things, query, { extended: quickExtended }),
    [query, quickExtended, things],
  );

  useEffect(() => {
    setQuickIndex(0);
  }, [query, quickExtended]);

  const chooseQuickResult = useCallback(
    (item) => {
      closeQuickFind();
      if (item.type === "settings") {
        setOverlay({ type: "settings" });
        return;
      }
      if (item.type === "task") {
        const task = things.tasks.find((entry) => entry.id === item.id);
        if (!task) return;
        let destination = item.viewId;
        if (!destination) {
          if (task.isInbox) destination = "inbox";
          else if (task.start === "someday") destination = "someday";
          else if (task.start === "on-date" && task.startDate > TODAY_DATE) destination = "upcoming";
          else if (task.parent.type === "project") destination = `project:${task.parent.id}`;
          else destination = "anytime";
        }
        navigate(destination);
        requestAnimationFrame(() => setSelectedId(task.id));
        return;
      }
      navigate(item.viewId);
    },
    [closeQuickFind, navigate, things.tasks],
  );

  const openWindow = useCallback(
    (event) => {
      const targetView = event.altKey ? view : "today";
      const url = `${window.location.href.split("#")[0]}#view=${encodeURIComponent(targetView)}`;
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      announce(
        opened
          ? `Opened ${event.altKey ? "the current list" : "Today"} in a new window`
          : "Your browser blocked the new window",
      );
    },
    [announce, view],
  );

  const controller = {
    things,
    view,
    selectedId,
    selectedTask,
    overlay,
    filteredTasks,
    availableFilterTags,
    filterTags,
    expandedGroups,
    settings,
    newTaskOpen,
    newTaskTitle,
    movedOutInbox,
    navigate,
    setSelectedId: (id) => {
      setSelectedId((current) => (current === id ? null : id));
      setOverlay(null);
    },
    setOverlay,
    setFilterTags,
    setExpandedGroups,
    setSettings,
    setNewTaskTitle,
    setMovedOutInbox,
    startNewTask,
    addTask,
    cancelNewTask: () => {
      setNewTaskOpen(false);
      setNewTaskTitle("");
      setNewTaskHeadingId(null);
    },
    updateTask,
    completeTask,
    reopenTask,
    scheduleTask,
    moveTask,
    setTaskDeadline,
    setTaskTags,
    toggleChecklist,
    addChecklistItem,
    removeChecklistItem,
    addTag,
    duplicateTask,
    createProjectForTask,
    updateProject,
    reopenProject,
    updateArea,
    projectAction,
    headingAction,
    announce,
  };

  return (
    <main className="stage">
      <div
        className="scaled-window"
        style={{ width: compact ? "100%" : 1188 * scale, height: compact ? "100%" : 1028 * scale }}
      >
        <section
          className={`things-window${compact ? " compact-window" : ""}`}
          style={{ transform: compact ? "none" : `scale(${scale})` }}
          aria-label="Things complete interaction reference prototype"
        >
          <Sidebar
            controller={controller}
            onNewList={() => setOverlay({ type: "new-list" })}
            onSettings={() => setOverlay({ type: "settings" })}
          />

          <section className="content-shell">
            <button
              className="open-new-window"
              aria-label="Open in new window"
              title="Click for Today; Option-click for the current list"
              onClick={openWindow}
            >
              <Icon className="fa-regular fa-clone" />
            </button>

            <ThingsContent controller={controller} />

            <footer className="bottom-toolbar" aria-label="Things actions">
              <button className="tool-button" aria-label="New to-do" onClick={() => startNewTask()}>
                <Icon className="fa-solid fa-plus" />
              </button>
              <button
                className="tool-button"
                aria-label="When"
                aria-expanded={overlay?.type === "when"}
                onClick={() =>
                  selectedTask
                    ? setOverlay({ type: "when", taskId: selectedTask.id })
                    : announce("Open a to-do before choosing When")
                }
              >
                <Icon className="fa-regular fa-calendar-days" />
              </button>
              <button
                className="tool-button"
                aria-label="Move"
                aria-expanded={overlay?.type === "move"}
                onClick={() =>
                  selectedTask
                    ? setOverlay({ type: "move", taskId: selectedTask.id })
                    : announce("Open a to-do before moving it")
                }
              >
                <Icon className="fa-solid fa-arrow-right" />
              </button>
              <button
                className="tool-button"
                aria-label="Quick Find"
                onClick={(event) => openQuickFind("", event.currentTarget)}
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
              activeIndex={quickIndex}
              onActiveIndex={setQuickIndex}
              extended={quickExtended}
              onExtend={() => setQuickExtended(true)}
              onClose={closeQuickFind}
              onChoose={chooseQuickResult}
            />
          )}

          {overlay?.type === "new-list" && (
            <NewListPopover areas={things.areas} onClose={() => setOverlay(null)} onCreate={createList} />
          )}

          {overlay?.type === "settings" && (
            <SettingsPopover
              settings={settings}
              onSettings={setSettings}
              onClose={() => setOverlay(null)}
            />
          )}

          {toast && (
            <div className="toast" role="status" aria-live="polite">
              <span>{toast.message}</span>
              {toast.actionLabel && (
                <button onClick={toast.onAction}>{toast.actionLabel}</button>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
