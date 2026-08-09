import { forwardRef, useState } from "react";
import {
  builtInLists,
  getArea,
  getParentLabel,
  getProject,
  getTasksForView,
  TODAY_DATE,
  TOMORROW_DATE,
} from "./thingsModel.js";

export function Icon({ className, label }) {
  return <i className={className} aria-hidden={label ? undefined : "true"} aria-label={label} />;
}

function TrafficLights() {
  return (
    <div className="traffic-lights" aria-label="Decorative macOS window controls">
      <Icon className="fa-solid fa-circle traffic red" />
      <Icon className="fa-solid fa-circle traffic amber" />
      <Icon className="fa-solid fa-circle traffic green" />
    </div>
  );
}

export function Sidebar({ controller, onNewList, onSettings }) {
  const { things, view, navigate } = controller;
  const inboxCount = getTasksForView(things, "inbox").length;
  const todayTasks = getTasksForView(things, "today");
  const todayDeadlineCount = todayTasks.filter((task) => task.deadline === TODAY_DATE).length;
  const visibleProjects = (areaId) =>
    things.projects.filter(
      (project) =>
        project.areaId === areaId &&
        project.status === "open" &&
        project.start !== "someday" &&
        !(project.start === "on-date" && project.startDate > TODAY_DATE),
    );

  return (
    <aside className="sidebar">
      <TrafficLights />
      <nav className="primary-nav" aria-label="Things lists">
        {builtInLists.map((item) => {
          const isInbox = item.id === "inbox";
          const isToday = item.id === "today";
          return (
            <button
              key={item.id}
              className={`nav-row${view === item.id ? " active" : ""}${item.separated ? " separated" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <span className={`nav-icon ${item.tone}`}>
                <Icon className={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              <span className="nav-numbers">
                {isToday && todayDeadlineCount > 0 && (
                  <span className="badge">{todayDeadlineCount}</span>
                )}
                {isToday && (
                  <span className="count">{Math.max(0, todayTasks.length - todayDeadlineCount)}</span>
                )}
                {isInbox && inboxCount > 0 && <span className="count">{inboxCount}</span>}
              </span>
            </button>
          );
        })}
      </nav>

      <nav className="area-nav" aria-label="Areas and projects">
        {things.areas.map((area) => (
          <section className="area-group" key={area.id}>
            <button
              className={`area-title${view === `area:${area.id}` ? " current" : ""}`}
              onClick={() => navigate(`area:${area.id}`)}
            >
              <Icon className="fa-solid fa-cube" />
              <span>{area.name}</span>
            </button>
            {visibleProjects(area.id).map((project) => (
              <button
                key={project.id}
                className={`project-row${view === `project:${project.id}` ? " current" : ""}`}
                onClick={() => navigate(`project:${project.id}`)}
              >
                <Icon className="fa-solid fa-circle-half-stroke" />
                <span>{project.name}</span>
              </button>
            ))}
          </section>
        ))}
        {things.projects.filter((project) => !project.areaId && project.status === "open").length > 0 && (
          <section className="area-group">
            <div className="area-title static-area-title">
              <Icon className="fa-solid fa-list" />
              <span>Projects</span>
            </div>
            {things.projects
              .filter((project) => !project.areaId && project.status === "open")
              .map((project) => (
                <button
                  key={project.id}
                  className={`project-row${view === `project:${project.id}` ? " current" : ""}`}
                  onClick={() => navigate(`project:${project.id}`)}
                >
                  <Icon className="fa-solid fa-circle-half-stroke" />
                  <span>{project.name}</span>
                </button>
              ))}
          </section>
        )}
      </nav>

      <button className="new-list-button" onClick={onNewList} aria-expanded={controller.overlay?.type === "new-list"}>
        <Icon className="fa-solid fa-plus" />
        <span>New List</span>
      </button>
      <button
        className="sidebar-settings"
        aria-label="List settings"
        onClick={onSettings}
        aria-expanded={controller.overlay?.type === "settings"}
      >
        <Icon className="fa-solid fa-sliders" />
      </button>
    </aside>
  );
}

function Checkbox({ checked, onChange, label, archived = false }) {
  return (
    <button
      className={`task-checkbox${checked ? " checked" : ""}${archived ? " archived" : ""}`}
      onClick={onChange}
      aria-label={label}
      aria-pressed={checked}
    >
      <Icon className={checked ? "fa-solid fa-circle-check" : "fa-regular fa-square"} />
    </button>
  );
}

function NewTaskRow({ controller }) {
  if (!controller.newTaskOpen) return null;
  return (
    <div className="new-task-row">
      <Icon className="fa-regular fa-square" />
      <input
        data-new-task-input
        autoFocus
        value={controller.newTaskTitle}
        onChange={(event) => controller.setNewTaskTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && controller.newTaskTitle.trim()) {
            event.stopPropagation();
            controller.addTask();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            controller.cancelNewTask();
          }
        }}
        placeholder="New To-Do"
        aria-label="New to-do title"
      />
      <button onClick={controller.addTask} disabled={!controller.newTaskTitle.trim()}>
        Add
      </button>
      <button className="new-task-cancel" onClick={controller.cancelNewTask} aria-label="Cancel new to-do">
        <Icon className="fa-solid fa-xmark" />
      </button>
    </div>
  );
}

function TagFilters({ tags, selected, onChange }) {
  if (!tags.length) return null;
  const choose = (tag, preserve) => {
    if (tag === "All") {
      onChange([]);
      return;
    }
    if (preserve) {
      onChange(selected.includes(tag) ? selected.filter((item) => item !== tag) : [...selected, tag]);
      return;
    }
    onChange(selected.length === 1 && selected[0] === tag ? [] : [tag]);
  };
  return (
    <div className="project-filters" aria-label="Filter by tag">
      <button className={selected.length === 0 ? "selected" : ""} onClick={() => choose("All", false)}>
        All
      </button>
      {tags.slice(0, 4).map((tag) => (
        <button
          key={tag}
          className={selected.includes(tag) ? "selected" : ""}
          aria-pressed={selected.includes(tag)}
          onClick={(event) => choose(tag, event.metaKey || event.ctrlKey)}
          title="Command-click to combine tags"
        >
          {tag}
        </button>
      ))}
    </div>
  );
}

function ViewTitle({ icon, tone, title, menuLabel, onMenu }) {
  return (
    <header className="list-heading">
      <span className={`list-heading-icon ${tone}`}>
        <Icon className={icon} />
      </span>
      <h1>{title}</h1>
      {onMenu && (
        <button className="project-more" aria-label={menuLabel} onClick={onMenu}>
          <Icon className="fa-solid fa-ellipsis" />
        </button>
      )}
    </header>
  );
}

function SourceButton({ controller, task }) {
  const label = getParentLabel(controller.things, task);
  if (!label) return null;
  const target =
    task.parent.type === "project"
      ? `project:${task.parent.id}`
      : task.parent.type === "area"
        ? `area:${task.parent.id}`
        : "inbox";
  return (
    <button
      className="task-project"
      onClick={(event) => {
        event.stopPropagation();
        controller.navigate(target);
      }}
      aria-label={`Show in ${label}`}
    >
      {label}
    </button>
  );
}

function TaskItem({ controller, task, showSource = true, archived = false, someday = false }) {
  const selected = controller.selectedId === task.id;
  if (selected) return <TaskDetail controller={controller} task={task} archived={archived} />;
  const isToday =
    task.start === "on-date" && task.startDate === TODAY_DATE && task.status === "open";
  return (
    <div className={`task-row${archived ? " logged-task" : ""}${someday ? " someday-task" : ""}`}>
      <Checkbox
        checked={archived && task.status === "completed"}
        archived={archived}
        onChange={() =>
          archived ? controller.reopenTask(task) : controller.completeTask(task)
        }
        label={archived ? `Reopen ${task.title}` : `Complete ${task.title}`}
      />
      <button className="task-copy" onClick={() => controller.setSelectedId(task.id)}>
        <span className="task-title">
          {isToday && controller.view === "anytime" && (
            <Icon className="fa-solid fa-star row-today-star" />
          )}
          {task.repeat && <Icon className="fa-solid fa-rotate row-repeat-icon" />}
          {task.title}
          {task.checklistMark && <Icon className="fa-solid fa-list-ul row-meta-icon" />}
          {task.attachment && <Icon className="fa-regular fa-file row-meta-icon" />}
        </span>
      </button>
      {showSource && <SourceButton controller={controller} task={task} />}
      {controller.view !== "today" && task.tags.slice(0, 1).map((tag) => (
        <span className="task-tag" key={tag}>{tag}</span>
      ))}
      {task.deadline && (
        <button
          className="deadline-chip"
          onClick={() => {
            controller.setSelectedId(task.id);
            requestAnimationFrame(() => controller.setOverlay({ type: "deadline", taskId: task.id }));
          }}
          aria-label={`Deadline ${task.deadline}`}
        >
          <Icon className="fa-solid fa-flag" />
          <span>{task.deadline === TODAY_DATE ? "today" : task.deadline.slice(5)}</span>
        </button>
      )}
      {archived && <span className="logged-status">{task.status === "canceled" ? "Canceled" : "Completed"}</span>}
    </div>
  );
}

function TaskDetail({ controller, task, archived }) {
  const [checklistTitle, setChecklistTitle] = useState("");
  const isOverlay = (type) => controller.overlay?.type === type && controller.overlay.taskId === task.id;
  return (
    <article className={`task-detail${archived ? " archived-detail" : ""}`}>
      <div className="detail-main-row">
        <Checkbox
          checked={archived && task.status === "completed"}
          archived={archived}
          onChange={() => (archived ? controller.reopenTask(task) : controller.completeTask(task))}
          label={archived ? `Reopen ${task.title}` : `Complete ${task.title}`}
        />
        <div className="detail-copy">
          <input
            className="detail-title"
            value={task.title}
            readOnly={archived}
            onChange={(event) => controller.updateTask(task.id, { title: event.target.value })}
            aria-label="To-do title"
          />
          <textarea
            className="detail-note"
            value={task.note}
            readOnly={archived}
            onChange={(event) => controller.updateTask(task.id, { note: event.target.value })}
            aria-label="Notes"
            placeholder="Notes"
          />
        </div>
        <button className="detail-close" aria-label="Close to-do" onClick={() => controller.setSelectedId(task.id)}>
          <Icon className="fa-solid fa-xmark" />
        </button>
      </div>

      {!archived && (
        <div className="checklist">
          {task.checklist.map((item) => (
            <div className="checklist-row" key={item.id}>
              <button
                className={item.completed ? "checklist-toggle completed" : "checklist-toggle"}
                onClick={() => controller.toggleChecklist(task, item.id)}
                aria-label={`${item.completed ? "Reopen" : "Complete"} checklist item ${item.title}`}
              >
                <Icon className={item.completed ? "fa-solid fa-circle-check" : "fa-regular fa-circle"} />
              </button>
              <span>{item.title}</span>
              <button
                className="checklist-remove"
                aria-label={`Delete checklist item ${item.title}`}
                onClick={() => controller.removeChecklistItem(task, item.id)}
              >
                <Icon className="fa-solid fa-xmark" />
              </button>
            </div>
          ))}
          <div className="checklist-add-row">
            <Icon className="fa-regular fa-circle" />
            <input
              value={checklistTitle}
              onChange={(event) => setChecklistTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && checklistTitle.trim()) {
                  controller.addChecklistItem(task, checklistTitle);
                  setChecklistTitle("");
                }
              }}
              placeholder="New Checklist Item"
              aria-label="New checklist item"
            />
            <button
              disabled={!checklistTitle.trim()}
              onClick={() => {
                controller.addChecklistItem(task, checklistTitle);
                setChecklistTitle("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="detail-footer">
        {archived ? (
          <button className="when-button active" onClick={() => controller.reopenTask(task)}>
            <Icon className="fa-solid fa-arrow-rotate-left" />
            <span>Reopen</span>
          </button>
        ) : (
          <button
            className="when-button active"
            onClick={() => controller.setOverlay({ type: "when", taskId: task.id })}
            aria-expanded={isOverlay("when")}
          >
            <Icon
              className={
                task.evening
                  ? "fa-solid fa-moon"
                  : task.start === "on-date" && task.startDate === TODAY_DATE
                    ? "fa-solid fa-star"
                    : task.start === "someday"
                      ? "fa-solid fa-box-archive"
                      : "fa-regular fa-calendar-days"
              }
            />
            <span>{formatStart(task)}</span>
          </button>
        )}
        <div className="detail-actions">
          <button
            aria-label="Move"
            onClick={() => controller.setOverlay({ type: "move", taskId: task.id })}
            aria-expanded={isOverlay("move")}
            disabled={archived}
            title={archived ? "Reopen the to-do before moving it" : undefined}
          >
            <Icon className="fa-solid fa-arrow-right" />
          </button>
          <button
            aria-label="Tags"
            onClick={() => controller.setOverlay({ type: "tags", taskId: task.id })}
            aria-expanded={isOverlay("tags")}
            disabled={archived}
            title={archived ? "Reopen the to-do before editing tags" : undefined}
          >
            <Icon className="fa-solid fa-tag" />
          </button>
          <button
            aria-label="Deadline"
            onClick={() => controller.setOverlay({ type: "deadline", taskId: task.id })}
            aria-expanded={isOverlay("deadline")}
            disabled={archived}
            title={archived ? "Reopen the to-do before editing its deadline" : undefined}
          >
            <Icon className="fa-regular fa-flag" />
          </button>
          <button
            aria-label="To-do menu"
            onClick={() => controller.setOverlay({ type: "task-menu", taskId: task.id })}
            aria-expanded={isOverlay("task-menu")}
          >
            <Icon className="fa-solid fa-ellipsis" />
          </button>
        </div>
      </div>
      {task.tags.length > 0 && (
        <div className="detail-tags" aria-label="Direct tags">
          {task.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      )}

      {isOverlay("when") && (
        <WhenPopover onChoose={(value) => controller.scheduleTask(task, value)} onClose={() => controller.setOverlay(null)} />
      )}
      {isOverlay("move") && (
        <MovePopover controller={controller} task={task} onClose={() => controller.setOverlay(null)} />
      )}
      {isOverlay("tags") && (
        <TagPicker
          title="Tags"
          tags={task.tags}
          allTags={controller.things.tags}
          onChange={(tags) => controller.setTaskTags(task, tags)}
          onNewTag={controller.addTag}
          onClose={() => controller.setOverlay(null)}
        />
      )}
      {isOverlay("deadline") && (
        <DeadlinePopover
          current={task.deadline}
          onChoose={(value) => controller.setTaskDeadline(task, value)}
          onClose={() => controller.setOverlay(null)}
        />
      )}
      {isOverlay("task-menu") && (
        <TaskMenu controller={controller} task={task} archived={archived} />
      )}
    </article>
  );
}

function formatStart(task) {
  if (task.evening) return "This Evening";
  if (task.start === "someday") return "Someday";
  if (task.start === "anytime") return "Anytime";
  if (task.startDate === TODAY_DATE) return "Today";
  if (task.startDate === TOMORROW_DATE) return "Tomorrow";
  return task.startDate || "When";
}

const whenOptions = [
  { value: "today", label: "Today", hint: "Today", icon: "fa-solid fa-star", tone: "yellow" },
  { value: "evening", label: "This Evening", hint: "Tonight", icon: "fa-solid fa-moon", tone: "blue" },
  { value: "tomorrow", label: "Tomorrow", hint: "Mon, Aug 10", icon: "fa-solid fa-calendar-day", tone: "pink" },
  { value: "someday", label: "Someday", hint: "No start date", icon: "fa-solid fa-box-archive", tone: "olive" },
  { value: "clear", label: "Clear", hint: "Move to Anytime", icon: "fa-solid fa-xmark", tone: "gray" },
];

function WhenPopover({ onChoose, onClose }) {
  const [dateQuery, setDateQuery] = useState("");
  const naturalSuggestions = [
    { label: "in 3 days", hint: "Wed, Aug 12", value: "2026-08-12" },
    { label: "in 3 weeks", hint: "Sun, Aug 30", value: "2026-08-30" },
    { label: "in 3 months", hint: "Mon, Nov 9", value: "2026-11-09" },
  ];
  return (
    <div className={`when-popover${dateQuery ? " natural" : ""}`} role="dialog" aria-modal="true" aria-label="Choose when">
      <div className="popover-title-row">
        <strong>When</strong>
        <button onClick={onClose} aria-label="Close When"><Icon className="fa-solid fa-xmark" /></button>
      </div>
      <label className="when-search">
        <Icon className="fa-solid fa-magnifying-glass" />
        <input autoFocus value={dateQuery} onChange={(event) => setDateQuery(event.target.value)} placeholder="Type a date" aria-label="Type a natural language date" />
      </label>
      <div className="when-options">
        {(dateQuery ? naturalSuggestions : whenOptions).map((option, index) => (
          <button key={option.value} className={dateQuery && index === 0 ? "suggestion-selected" : ""} onClick={() => onChoose(option.value)}>
            <span className={`when-icon ${option.tone || "pink"}`}><Icon className={option.icon || "fa-solid fa-calendar-days"} /></span>
            <span className="when-label">{option.label}</span>
            <span className="when-hint">{option.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DeadlinePopover({ current, onChoose, onClose }) {
  const [dateQuery, setDateQuery] = useState("");
  const options = dateQuery
    ? [
        { value: "2026-08-12", label: "in 3 days", hint: "Wed, Aug 12" },
        { value: "2026-08-16", label: "next week", hint: "Sun, Aug 16" },
      ]
    : [
        { value: TODAY_DATE, label: "Today", hint: "Aug 9" },
        { value: TOMORROW_DATE, label: "Tomorrow", hint: "Aug 10" },
        { value: "2026-08-16", label: "Next Week", hint: "Aug 16" },
        { value: "", label: "Clear", hint: current ? "Remove deadline" : "No deadline" },
      ];
  return (
    <div className="deadline-popover" role="dialog" aria-modal="true" aria-label="Choose deadline">
      <div className="popover-title-row"><strong>Deadline</strong><button onClick={onClose} aria-label="Close Deadline"><Icon className="fa-solid fa-xmark" /></button></div>
      <label className="when-search"><Icon className="fa-solid fa-magnifying-glass" /><input autoFocus value={dateQuery} onChange={(event) => setDateQuery(event.target.value)} placeholder="Type a deadline" aria-label="Type a deadline" /></label>
      <div className="when-options">
        {options.map((option) => (
          <button key={`${option.value}-${option.label}`} onClick={() => onChoose(option.value)}>
            <span className="when-icon pink"><Icon className={option.value ? "fa-regular fa-flag" : "fa-solid fa-xmark"} /></span>
            <span className="when-label">{option.label}</span><span className="when-hint">{option.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TagPicker({ title, tags, allTags, onChange, onNewTag, onClose }) {
  const [newTag, setNewTag] = useState("");
  return (
    <div className="tag-popover" role="dialog" aria-modal="true" aria-label={title}>
      <div className="popover-title-row"><strong>{title}</strong><button onClick={onClose} aria-label={`Close ${title}`}><Icon className="fa-solid fa-xmark" /></button></div>
      <div className="tag-options">
        {allTags.map((tag) => (
          <button key={tag} className={tags.includes(tag) ? "selected" : ""} aria-pressed={tags.includes(tag)} onClick={() => onChange(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag])}>
            <Icon className={tags.includes(tag) ? "fa-solid fa-check" : "fa-solid fa-tag"} /><span>{tag}</span>
          </button>
        ))}
      </div>
      <div className="tag-create-row">
        <input autoFocus value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="New Tag" aria-label="New tag name" />
        <button disabled={!newTag.trim()} onClick={() => { const tag = newTag.trim(); onNewTag(tag); onChange([...new Set([...tags, tag])]); setNewTag(""); }}>Add</button>
      </div>
      <button className="popover-done" onClick={onClose}>Done</button>
    </div>
  );
}

function MovePopover({ controller, task, onClose }) {
  const [moveQuery, setMoveQuery] = useState("");
  const normalized = moveQuery.trim().toLowerCase();
  const destinations = [
    { type: "inbox", id: "inbox", label: "Inbox", meta: "Capture" },
    { type: "none", id: "none", label: "No Project/Area", meta: "Loose to-do" },
    ...controller.things.areas.map((area) => ({ type: "area", id: area.id, label: area.name, meta: "Area" })),
    ...controller.things.projects.filter((project) => project.status === "open").map((project) => ({ type: "project", id: project.id, label: project.name, meta: getArea(controller.things, project.areaId)?.name || "Project" })),
    ...(normalized
      ? controller.things.projects.flatMap((project) => project.headings.filter((heading) => !heading.archived).map((heading) => ({ type: "heading", id: heading.id, projectId: project.id, label: heading.title, meta: project.name })))
      : []),
  ].filter((item) => !normalized || `${item.label} ${item.meta}`.toLowerCase().includes(normalized));
  return (
    <div className="move-popover" role="dialog" aria-modal="true" aria-label="Move to-do">
      <div className="popover-title-row"><strong>Move</strong><button onClick={onClose} aria-label="Close Move"><Icon className="fa-solid fa-xmark" /></button></div>
      <label className="when-search"><Icon className="fa-solid fa-magnifying-glass" /><input autoFocus value={moveQuery} onChange={(event) => setMoveQuery(event.target.value)} placeholder="Type a destination" aria-label="Move destination" /></label>
      <div className="move-options">
        {destinations.map((destination) => (
          <button key={`${destination.type}-${destination.id}-${destination.projectId || ""}`} onClick={() => controller.moveTask(task, destination)}>
            <span className="move-icon"><Icon className={destination.type === "inbox" ? "fa-solid fa-inbox" : destination.type === "area" ? "fa-solid fa-cube" : destination.type === "heading" ? "fa-solid fa-heading" : destination.type === "none" ? "fa-solid fa-xmark" : "fa-solid fa-circle-half-stroke"} /></span>
            <span>{destination.label}</span><small>{destination.meta}</small>
          </button>
        ))}
        {normalized && !destinations.some((item) => item.label.toLowerCase() === normalized) && (
          <button onClick={() => controller.createProjectForTask(task, moveQuery.trim())}>
            <span className="move-icon"><Icon className="fa-solid fa-plus" /></span><span>New Project “{moveQuery.trim()}”</span><small>Create and move</small>
          </button>
        )}
      </div>
    </div>
  );
}

function TaskMenu({ controller, task, archived }) {
  return (
    <div className="context-popover task-menu-popover" role="menu" aria-label="To-do menu">
      {archived ? (
        <button role="menuitem" onClick={() => controller.reopenTask(task)}><Icon className="fa-solid fa-arrow-rotate-left" />Reopen</button>
      ) : (
        <>
          <button role="menuitem" onClick={() => controller.completeTask(task, "canceled")}><Icon className="fa-solid fa-ban" />Cancel To-Do</button>
          <button role="menuitem" onClick={() => controller.duplicateTask(task)}><Icon className="fa-regular fa-copy" />Duplicate</button>
        </>
      )}
      <button role="menuitem" onClick={() => controller.setOverlay(null)}><Icon className="fa-solid fa-xmark" />Close Menu</button>
    </div>
  );
}

function EmptyState({ children = "No to-dos here." }) {
  return <p className="empty-project">{children}</p>;
}

function TodayView({ controller }) {
  const daytime = controller.filteredTasks.filter((task) => !task.evening);
  const evening = controller.filteredTasks.filter((task) => task.evening);
  const groups = controller.settings.groupToday
    ? groupTasksByParent(controller, daytime)
    : [{ id: "daytime", title: null, tasks: daytime }];
  return (
    <div className="today-view">
      <header className="today-heading"><Icon className="fa-solid fa-star heading-star" /><h1>Today</h1></header>
      {controller.settings.showCalendar && <CalendarEvents />}
      <NewTaskRow controller={controller} />
      {groups.map((group) => (
        <section className="task-section daytime-section" key={group.id} aria-label={group.title || "Daytime to-dos"}>
          {group.title && <GroupHeading controller={controller} group={group} />}
          {group.tasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} />)}
        </section>
      ))}
      <section className="evening-section" aria-label="This Evening">
        <div className="evening-heading"><Icon className="fa-solid fa-moon" /><h2>This Evening</h2><span className="rule" /></div>
        {evening.map((task) => <TaskItem key={task.id} controller={controller} task={task} />)}
        {!evening.length && <EmptyState>Nothing planned for this evening.</EmptyState>}
      </section>
    </div>
  );
}

function CalendarEvents() {
  return (
    <section className="calendar-events" aria-label="Calendar events">
      <div className="event birthday"><span className="event-mark">I</span><span>Ben’s birthday</span></div>
      <div className="event blue"><span>07:00</span><span>Hit the gym with Lucas</span></div>
      <div className="event blue"><span>08:30</span><span>Coffee with Emma</span></div>
      <div className="event green"><span>11:00</span><span>Team meeting</span></div>
      <div className="event green"><span>15:30</span><span>Budget review</span></div>
    </section>
  );
}

function InboxView({ controller }) {
  return (
    <div className="project-view list-view inbox-view">
      <ViewTitle icon="fa-solid fa-inbox" tone="blue" title="Inbox" />
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      <NewTaskRow controller={controller} />
      <section className="plain-task-list">
        {controller.filteredTasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} showSource={false} />)}
        {!controller.filteredTasks.length && <EmptyState>Inbox is clear.</EmptyState>}
      </section>
      {controller.movedOutInbox > 0 && (
        <div className="moved-out-panel" role="status">
          <span>{controller.movedOutInbox} to-do{controller.movedOutInbox === 1 ? "" : "s"} moved out of the Inbox</span>
          <button onClick={() => controller.setMovedOutInbox(0)}>OK</button>
        </div>
      )}
    </div>
  );
}

const dateInfo = {
  "2026-08-10": { day: "10", label: "Tomorrow" },
  "2026-08-11": { day: "11", label: "Tuesday" },
  "2026-08-12": { day: "12", label: "Wednesday" },
  "2026-08-13": { day: "13", label: "Thursday" },
  "2026-08-14": { day: "14", label: "Friday" },
  "2026-08-16": { day: "16", label: "Sunday" },
};

function upcomingDate(task) {
  if (task.start === "on-date" && task.startDate > TODAY_DATE) return task.startDate;
  return task.deadline;
}

function UpcomingView({ controller }) {
  const groups = Object.entries(
    controller.filteredTasks.reduce((all, task) => {
      const date = upcomingDate(task);
      if (!date) return all;
      all[date] = [...(all[date] || []), task];
      return all;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));
  const futureProjects = controller.things.projects
    .filter(
      (project) =>
        project.status === "open" && project.start === "on-date" && project.startDate > TODAY_DATE,
    )
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  return (
    <div className="project-view list-view upcoming-view">
      <ViewTitle icon="fa-solid fa-calendar-days" tone="pink" title="Upcoming" />
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      <NewTaskRow controller={controller} />
      {groups.map(([date, tasks], index) => {
        const info = dateInfo[date] || { day: date.slice(-2), label: date };
        return (
          <section className="upcoming-day" key={date}>
            <div className="upcoming-day-heading"><strong>{info.day}</strong><span>{info.label}</span><span className="rule" /></div>
            {index === 0 && <div className="mini-calendar-events"><span>10:00</span> Interview Michael<br /><span>13:00</span> Benefits presentation</div>}
            {tasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} />)}
          </section>
        );
      })}
      {futureProjects.map((project) => (
        <section className="upcoming-day upcoming-project-day" key={project.id}>
          <div className="upcoming-day-heading"><strong>{project.startDate.slice(-2)}</strong><span>{dateInfo[project.startDate]?.label || project.startDate}</span><span className="rule" /></div>
          <button className="area-project-card" onClick={() => controller.navigate(`project:${project.id}`)}><Icon className="fa-solid fa-circle-half-stroke" /><span>{project.name}</span><small>Project</small></button>
        </section>
      ))}
      {!groups.length && !futureProjects.length && <EmptyState>No upcoming plans match this filter.</EmptyState>}
    </div>
  );
}

function groupTasksByParent(controller, tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const id = task.parent.type === "none" ? "loose" : `${task.parent.type}:${task.parent.id}`;
    const title = task.parent.type === "none" ? "To-Dos" : getParentLabel(controller.things, task);
    const current = groups.get(id) || { id, title, tasks: [] };
    current.tasks.push(task);
    groups.set(id, current);
  }
  return [...groups.values()];
}

function GroupHeading({ controller, group }) {
  const target = group.id === "loose" ? null : group.id;
  return (
    <div className="project-section-heading grouped-list-heading">
      {target ? (
        <button className="group-title-button" onClick={() => controller.navigate(target)}>
          <Icon className={target.startsWith("area:") ? "fa-solid fa-cube" : "fa-solid fa-circle-half-stroke"} />
          <h2>{group.title}</h2>
        </button>
      ) : <h2>{group.title}</h2>}
      <span className="rule" />
    </div>
  );
}

function GroupedListView({ controller, title, icon, tone, someday = false, tagView = false }) {
  const groups = groupTasksByParent(controller, controller.filteredTasks);
  const somedayProjects = someday
    ? controller.things.projects.filter(
        (project) => project.status === "open" && project.start === "someday",
      )
    : [];
  return (
    <div className={`project-view list-view grouped-list-view${someday ? " someday-list" : ""}`}>
      <ViewTitle icon={icon} tone={tone} title={title} />
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      <NewTaskRow controller={controller} />
      {groups.map((group) => {
        const expanded = controller.expandedGroups.includes(group.id);
        const visible = expanded || group.tasks.length <= 4 ? group.tasks : group.tasks.slice(0, 3);
        return (
          <section className="grouped-task-section" key={group.id}>
            <GroupHeading controller={controller} group={group} />
            {visible.map((task) => <TaskItem key={task.id} controller={controller} task={task} someday={someday} showSource={tagView} />)}
            {!expanded && group.tasks.length > 4 && (
              <button className="show-more" onClick={() => controller.setExpandedGroups([...controller.expandedGroups, group.id])}>Show {group.tasks.length - 3} more</button>
            )}
          </section>
        );
      })}
      {somedayProjects.map((project) => (
        <button className="area-project-card someday-project-card" key={project.id} onClick={() => controller.navigate(`project:${project.id}`)}>
          <Icon className="fa-regular fa-circle" /><span>{project.name}</span><small>{getArea(controller.things, project.areaId)?.name || "Project"}</small>
        </button>
      ))}
      {!groups.length && !somedayProjects.length && <EmptyState>No to-dos match this view.</EmptyState>}
    </div>
  );
}

function LogbookView({ controller }) {
  const groups = Object.entries(
    controller.filteredTasks.reduce((all, task) => {
      const date = task.completedAt || "Earlier";
      all[date] = [...(all[date] || []), task];
      return all;
    }, {}),
  ).sort(([left], [right]) => right.localeCompare(left));
  return (
    <div className="project-view list-view logbook-view">
      <ViewTitle icon="fa-solid fa-square-check" tone="green" title="Logbook" />
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      {groups.map(([date, tasks]) => (
        <section className="logbook-day" key={date}>
          <div className="project-section-heading"><h2>{date === TODAY_DATE ? "Today" : date === "2026-08-08" ? "Yesterday" : date}</h2><span className="rule" /></div>
          {tasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} archived />)}
        </section>
      ))}
      {!groups.length && <EmptyState>Completed and canceled items will appear here.</EmptyState>}
    </div>
  );
}

function AreaView({ controller, area }) {
  const projects = controller.things.projects.filter((project) => project.areaId === area.id && project.status === "open");
  const directTasks = controller.filteredTasks.filter((task) => task.parent.type === "area" && task.parent.id === area.id);
  return (
    <div className="project-view area-view">
      <button className="project-back" onClick={() => controller.navigate("today")}><Icon className="fa-solid fa-chevron-left" /><span>Today</span></button>
      <ViewTitle icon="fa-solid fa-cube" tone="teal" title={area.name} menuLabel="Area menu" onMenu={() => controller.setOverlay({ type: "area-menu", areaId: area.id })} />
      {area.tags.length > 0 && <div className="detail-tags">{area.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      <NewTaskRow controller={controller} />
      <section className="area-projects">
        {projects.map((project) => (
          <button key={project.id} className="area-project-card" onClick={() => controller.navigate(`project:${project.id}`)}>
            <Icon className="fa-solid fa-circle-half-stroke" /><span>{project.name}</span><small>{getTasksForView(controller.things, `project:${project.id}`).length} to-dos</small>
          </button>
        ))}
      </section>
      {directTasks.length > 0 && <section className="project-list"><div className="project-section-heading"><h2>To-Dos</h2><span className="rule" /></div>{directTasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} showSource={false} />)}</section>}
      {controller.overlay?.type === "area-menu" && controller.overlay.areaId === area.id && <AreaMenu controller={controller} area={area} />}
      {controller.overlay?.type === "area-tags" && controller.overlay.areaId === area.id && (
        <TagPicker title="Area Tags" tags={area.tags} allTags={controller.things.tags} onChange={(tags) => controller.updateArea(area.id, { tags })} onNewTag={controller.addTag} onClose={() => controller.setOverlay(null)} />
      )}
      {controller.overlay?.type === "area-rename" && controller.overlay.areaId === area.id && (
        <NameDialog title="Rename Area" initial={area.name} actionLabel="Rename" onClose={() => controller.setOverlay(null)} onSubmit={(title) => { controller.updateArea(area.id, { name: title }); controller.setOverlay(null); controller.announce(`Renamed area to “${title}”`); }} />
      )}
    </div>
  );
}

function AreaMenu({ controller, area }) {
  return (
    <div className="context-popover header-menu-popover" role="menu" aria-label="Area menu">
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "area-tags", areaId: area.id })}><Icon className="fa-solid fa-tag" />Add Tags</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "area-rename", areaId: area.id })}><Icon className="fa-solid fa-pen" />Rename</button>
      <button role="menuitem" onClick={() => controller.setOverlay(null)}><Icon className="fa-solid fa-xmark" />Close Menu</button>
    </div>
  );
}

function ProjectView({ controller, project }) {
  const allTasks = controller.filteredTasks;
  const loose = allTasks.filter((task) => !task.headingId && task.start !== "someday" && !(task.start === "on-date" && task.startDate > TODAY_DATE));
  const later = allTasks.filter((task) => task.start === "someday" || (task.start === "on-date" && task.startDate > TODAY_DATE));
  return (
    <div className="project-view">
      <button className="project-back" onClick={() => controller.navigate("today")}><Icon className="fa-solid fa-chevron-left" /><span>Today</span></button>
      <ViewTitle icon="fa-solid fa-circle-notch" tone="blue" title={project.name} menuLabel="Project menu" onMenu={() => controller.setOverlay({ type: "project-menu", projectId: project.id })} />
      <textarea className="project-intro project-note-editor" value={project.note} onChange={(event) => controller.updateProject(project.id, { note: event.target.value })} aria-label="Project notes" placeholder="Project notes" />
      {project.tags.length > 0 && <div className="detail-tags project-direct-tags">{project.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      <NewTaskRow controller={controller} />
      <div className="project-sections">
        {loose.length > 0 && <ProjectSection controller={controller} project={project} title="To-Dos" tasks={loose} />}
        {project.headings.filter((heading) => !heading.archived).map((heading) => (
          <ProjectSection key={heading.id} controller={controller} project={project} heading={heading} title={heading.title} tasks={allTasks.filter((task) => task.headingId === heading.id && !later.includes(task))} />
        ))}
        {later.length > 0 && <ProjectSection controller={controller} project={project} title="Later Items" tasks={later} later />}
        {project.headings.some((heading) => heading.archived) && (
          <section className="project-list logged-headings"><div className="project-section-heading"><h2>Logged Headings</h2><span className="rule" /></div>{project.headings.filter((heading) => heading.archived).map((heading) => <button key={heading.id} onClick={() => controller.announce(`“${heading.title}” is archived in this project`)}><Icon className="fa-solid fa-box-archive" /><span className="project-task-title">{heading.title}</span></button>)}</section>
        )}
      </div>
      {controller.overlay?.projectId === project.id && <ProjectOverlay controller={controller} project={project} />}
    </div>
  );
}

function ProjectSection({ controller, project, heading, title, tasks, later }) {
  return (
    <section className={`project-list${later ? " later-project-list" : ""}`}>
      <div className="project-section-heading">
        <h2>{title}</h2>
        {heading && <button aria-label={`${title} menu`} onClick={() => controller.setOverlay({ type: "heading-menu", projectId: project.id, headingId: heading.id })}><Icon className="fa-solid fa-ellipsis" /></button>}
      </div>
      {tasks.length ? tasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} showSource={false} someday={task.start === "someday"} />) : <EmptyState>No to-dos in this section yet.</EmptyState>}
    </section>
  );
}

function ProjectOverlay({ controller, project }) {
  const overlay = controller.overlay;
  const heading = project.headings.find((item) => item.id === overlay.headingId);
  if (overlay.type === "project-menu") return <ProjectMenu controller={controller} project={project} />;
  if (overlay.type === "project-tags") return <TagPicker title="Project Tags" tags={project.tags} allTags={controller.things.tags} onChange={(tags) => controller.updateProject(project.id, { tags })} onNewTag={controller.addTag} onClose={() => controller.setOverlay(null)} />;
  if (overlay.type === "project-when") return <WhenPopover onChoose={(value) => controller.projectAction(project, "schedule", value)} onClose={() => controller.setOverlay(null)} />;
  if (overlay.type === "project-deadline") return <DeadlinePopover current={project.deadline} onChoose={(value) => controller.projectAction(project, "deadline", value)} onClose={() => controller.setOverlay(null)} />;
  if (overlay.type === "project-move") return <ProjectMovePopover controller={controller} project={project} />;
  if (overlay.type === "new-heading") return <NameDialog title="New Heading" initial="" actionLabel="Create" onClose={() => controller.setOverlay(null)} onSubmit={(title) => { controller.updateProject(project.id, (current) => ({ ...current, headings: [...current.headings, { id: `heading-${Date.now()}`, title, archived: false }] })); controller.setOverlay(null); controller.announce(`Created heading “${title}”`); }} />;
  if (overlay.type === "heading-menu" && heading) return <HeadingMenu controller={controller} project={project} heading={heading} />;
  if (overlay.type === "heading-rename" && heading) return <NameDialog title="Rename Heading" initial={heading.title} actionLabel="Rename" onClose={() => controller.setOverlay(null)} onSubmit={(title) => controller.headingAction(project, heading, "rename", title)} />;
  if (overlay.type === "heading-move" && heading) return <HeadingMovePopover controller={controller} project={project} heading={heading} />;
  return null;
}

function ProjectMenu({ controller, project }) {
  return (
    <div className="context-popover header-menu-popover" role="menu" aria-label="Project menu">
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "project-tags", projectId: project.id })}><Icon className="fa-solid fa-tag" />Add Tags</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "project-when", projectId: project.id })}><Icon className="fa-regular fa-calendar-days" />When</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "project-deadline", projectId: project.id })}><Icon className="fa-regular fa-flag" />Deadline</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "project-move", projectId: project.id })}><Icon className="fa-solid fa-arrow-right" />Move</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "new-heading", projectId: project.id })}><Icon className="fa-solid fa-heading" />New Heading</button>
      <button role="menuitem" onClick={() => controller.projectAction(project, "duplicate")}><Icon className="fa-regular fa-copy" />Duplicate Project</button>
      <button role="menuitem" onClick={() => controller.projectAction(project, "complete")}><Icon className="fa-solid fa-circle-check" />Complete Project</button>
      <button role="menuitem" onClick={() => controller.projectAction(project, "cancel")}><Icon className="fa-solid fa-ban" />Cancel Project</button>
    </div>
  );
}

function ProjectMovePopover({ controller, project }) {
  return (
    <div className="context-popover header-menu-popover" role="dialog" aria-modal="true" aria-label="Move project">
      <div className="popover-title-row"><strong>Move Project</strong><button onClick={() => controller.setOverlay(null)} aria-label="Close Move Project"><Icon className="fa-solid fa-xmark" /></button></div>
      <button onClick={() => controller.projectAction(project, "move", null)}><Icon className="fa-solid fa-xmark" />No Area</button>
      {controller.things.areas.map((area) => <button key={area.id} onClick={() => controller.projectAction(project, "move", area.id)}><Icon className="fa-solid fa-cube" />{area.name}</button>)}
    </div>
  );
}

function HeadingMenu({ controller, project, heading }) {
  return (
    <div className="context-popover heading-menu-popover" role="menu" aria-label={`${heading.title} menu`}>
      <button role="menuitem" onClick={() => controller.startNewTask(heading.id)}><Icon className="fa-solid fa-plus" />New To-Do</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "heading-rename", projectId: project.id, headingId: heading.id })}><Icon className="fa-solid fa-pen" />Rename</button>
      <button role="menuitem" onClick={() => controller.headingAction(project, heading, "duplicate")}><Icon className="fa-regular fa-copy" />Duplicate</button>
      <button role="menuitem" onClick={() => controller.setOverlay({ type: "heading-move", projectId: project.id, headingId: heading.id })}><Icon className="fa-solid fa-arrow-right" />Move</button>
      <button role="menuitem" onClick={() => controller.headingAction(project, heading, "convert")}><Icon className="fa-solid fa-circle-half-stroke" />Convert to Project</button>
      <button role="menuitem" onClick={() => controller.headingAction(project, heading, "archive")}><Icon className="fa-solid fa-box-archive" />Archive</button>
    </div>
  );
}

function HeadingMovePopover({ controller, project, heading }) {
  return (
    <div className="context-popover heading-menu-popover" role="dialog" aria-modal="true" aria-label="Move heading">
      <div className="popover-title-row"><strong>Move Heading</strong><button onClick={() => controller.setOverlay(null)} aria-label="Close Move Heading"><Icon className="fa-solid fa-xmark" /></button></div>
      {controller.things.projects.filter((item) => item.id !== project.id && item.status === "open").map((item) => <button key={item.id} onClick={() => controller.headingAction(project, heading, "move", item.id)}><Icon className="fa-solid fa-circle-half-stroke" />{item.name}</button>)}
    </div>
  );
}

function NameDialog({ title, initial, actionLabel, onClose, onSubmit }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="name-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="popover-title-row"><strong>{title}</strong><button onClick={onClose} aria-label={`Close ${title}`}><Icon className="fa-solid fa-xmark" /></button></div>
      <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value.trim()) onSubmit(value.trim()); }} aria-label={title} />
      <button className="popover-done" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>{actionLabel}</button>
    </div>
  );
}

function SpecialListView({ controller, id }) {
  const metadata = {
    tomorrow: ["Tomorrow", "fa-solid fa-calendar-day", "pink"],
    deadlines: ["Deadlines", "fa-solid fa-flag", "pink"],
    repeating: ["Repeating", "fa-solid fa-rotate", "gray"],
  }[id];
  return (
    <div className="project-view list-view special-list-view">
      <button className="project-back" onClick={() => controller.navigate("today")}><Icon className="fa-solid fa-chevron-left" /><span>Today</span></button>
      <ViewTitle icon={metadata[1]} tone={metadata[2]} title={metadata[0]} />
      <TagFilters tags={controller.availableFilterTags} selected={controller.filterTags} onChange={controller.setFilterTags} />
      <NewTaskRow controller={controller} />
      <section className="plain-task-list">{controller.filteredTasks.map((task) => <TaskItem key={task.id} controller={controller} task={task} />)}{!controller.filteredTasks.length && <EmptyState>No matching to-dos.</EmptyState>}</section>
    </div>
  );
}

function AllProjectsView({ controller, logged = false }) {
  const projects = controller.things.projects.filter((project) => logged ? project.isLogged : project.status === "open");
  return (
    <div className="project-view list-view all-projects-view">
      <button className="project-back" onClick={() => controller.navigate("today")}><Icon className="fa-solid fa-chevron-left" /><span>Today</span></button>
      <ViewTitle icon={logged ? "fa-solid fa-square-check" : "fa-solid fa-list"} tone={logged ? "green" : "gray"} title={logged ? "Logged Projects" : "All Projects"} />
      {controller.things.areas.map((area) => {
        const areaProjects = projects.filter((project) => project.areaId === area.id);
        if (!areaProjects.length) return null;
        return <section className="all-projects-group" key={area.id}><div className="project-section-heading"><h2>{area.name}</h2><span className="rule" /></div>{areaProjects.map((project) => <button className="area-project-card" key={project.id} onClick={() => logged ? controller.reopenProject(project) : controller.navigate(`project:${project.id}`)}><Icon className={logged ? "fa-solid fa-square-check" : "fa-solid fa-circle-half-stroke"} /><span>{project.name}</span><small>{logged ? "Reopen" : `${getTasksForView(controller.things, `project:${project.id}`).length} to-dos`}</small></button>)}</section>;
      })}
      {!projects.length && <EmptyState>No projects here.</EmptyState>}
    </div>
  );
}

function TagListView({ controller, tag }) {
  return <GroupedListView controller={controller} title={tag} icon="fa-solid fa-tag" tone="gray" tagView />;
}

export function ThingsContent({ controller }) {
  const { view, things } = controller;
  if (view === "today") return <TodayView controller={controller} />;
  if (view === "inbox") return <InboxView controller={controller} />;
  if (view === "upcoming") return <UpcomingView controller={controller} />;
  if (view === "anytime") return <GroupedListView controller={controller} title="Anytime" icon="fa-solid fa-layer-group" tone="teal" />;
  if (view === "someday") return <GroupedListView controller={controller} title="Someday" icon="fa-solid fa-box-archive" tone="olive" someday />;
  if (view === "logbook") return <LogbookView controller={controller} />;
  if (["tomorrow", "deadlines", "repeating"].includes(view)) return <SpecialListView controller={controller} id={view} />;
  if (view === "all-projects") return <AllProjectsView controller={controller} />;
  if (view === "logged-projects") return <AllProjectsView controller={controller} logged />;
  if (view.startsWith("area:")) {
    const area = getArea(things, view.slice(5));
    return area ? <AreaView controller={controller} area={area} /> : <MissingView controller={controller} />;
  }
  if (view.startsWith("project:")) {
    const project = getProject(things, view.slice(8));
    return project ? <ProjectView controller={controller} project={project} /> : <MissingView controller={controller} />;
  }
  if (view.startsWith("tag:")) return <TagListView controller={controller} tag={view.slice(4)} />;
  return <MissingView controller={controller} />;
}

function MissingView({ controller }) {
  return <div className="project-view list-view"><ViewTitle icon="fa-solid fa-circle-exclamation" tone="gray" title="List unavailable" /><EmptyState>This list no longer exists.</EmptyState><button className="return-today" onClick={() => controller.navigate("today")}>Return to Today</button></div>;
}

export const QuickFind = forwardRef(function QuickFind({ query, onQuery, results, activeIndex, onActiveIndex, extended, onExtend, onClose, onChoose }, ref) {
  return (
    <div className="quick-find" role="dialog" aria-modal="true" aria-label="Quick Find">
      <label className="quick-input"><Icon className="fa-solid fa-magnifying-glass" /><input ref={ref} value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); onActiveIndex(Math.min(results.length - 1, activeIndex + 1)); } if (event.key === "ArrowUp") { event.preventDefault(); onActiveIndex(Math.max(0, activeIndex - 1)); } if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); onChoose(results[activeIndex]); } }} placeholder={extended ? "Search Notes, Checklists & Logbook" : "Quick Find"} aria-label="Quick Find" /><button onClick={onClose} aria-label="Close Quick Find"><Icon className="fa-solid fa-xmark" /></button></label>
      <div className="quick-results" role="listbox" aria-label="Quick Find results">
        {results.map((item, index) => <button key={`${item.type}-${item.id}`} className={index === activeIndex ? "highlighted" : ""} onMouseEnter={() => onActiveIndex(index)} onClick={() => onChoose(item)} role="option" aria-selected={index === activeIndex}><span className={`quick-icon ${item.tone}`}><Icon className={item.icon} /></span><span className="quick-title">{item.title}</span>{item.meta && <span className="quick-meta">{item.meta}</span>}</button>)}
        {!results.length && <p className="quick-empty">No results</p>}
        <button className="continue-search" onClick={onExtend} disabled={extended} title={extended ? "Notes, checklists, and Logbook are included" : undefined}><Icon className={extended ? "fa-solid fa-check" : "fa-solid fa-magnifying-glass"} /><span>{extended ? "Searching everywhere" : "Continue Search"}</span></button>
      </div>
    </div>
  );
});

export function NewListPopover({ areas, onClose, onCreate }) {
  const [kind, setKind] = useState("project");
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState(areas[0]?.id || "");
  return (
    <div className="new-list-popover" role="dialog" aria-modal="true" aria-label="New list">
      <div className="popover-title-row"><strong>New List</strong><button onClick={onClose} aria-label="Close New List"><Icon className="fa-solid fa-xmark" /></button></div>
      <div className="segmented-control"><button className={kind === "project" ? "selected" : ""} onClick={() => setKind("project")}>Project</button><button className={kind === "area" ? "selected" : ""} onClick={() => setKind("area")}>Area</button></div>
      <label><span>Name</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && title.trim()) onCreate({ type: kind, title, areaId }); }} /></label>
      {kind === "project" && <label><span>Area</span><select value={areaId} onChange={(event) => setAreaId(event.target.value)}><option value="">No Area</option>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>}
      <button className="popover-done" disabled={!title.trim()} onClick={() => onCreate({ type: kind, title, areaId })}>Create {kind === "project" ? "Project" : "Area"}</button>
    </div>
  );
}

export function SettingsPopover({ settings, onSettings, onClose }) {
  return (
    <div className="settings-popover" role="dialog" aria-modal="true" aria-label="List settings">
      <div className="popover-title-row"><strong>List Settings</strong><button onClick={onClose} aria-label="Close Settings"><Icon className="fa-solid fa-xmark" /></button></div>
      <label className="setting-row"><span><strong>Show Calendar Events</strong><small>Display read-only calendar events in Today.</small></span><input type="checkbox" checked={settings.showCalendar} onChange={(event) => onSettings({ ...settings, showCalendar: event.target.checked })} /></label>
      <label className="setting-row"><span><strong>Group Today by Project or Area</strong><small>Use parent context instead of one manual sequence.</small></span><input type="checkbox" checked={settings.groupToday} onChange={(event) => onSettings({ ...settings, groupToday: event.target.checked })} /></label>
      <button className="popover-done" onClick={onClose}>Done</button>
    </div>
  );
}
