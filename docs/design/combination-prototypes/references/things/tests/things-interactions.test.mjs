import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildQuickFindResults,
  completeTask,
  getNewTaskDefaults,
  getTasksForView,
  initialThingsState,
  moveTask,
  restoreTask,
  scheduleTask,
  TODAY_DATE,
} from "../src/thingsModel.js";

const sourceDirectory = new URL("../src/", import.meta.url);
const jsxFiles = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".jsx"));
const jsxSource = (
  await Promise.all(
    jsxFiles.map(async (name) => `/* ${name} */\n${await readFile(new URL(name, sourceDirectory), "utf8")}`),
  )
).join("\n");

const clone = (value) => structuredClone(value);

const taskParent = (task) => task.parent;

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function changedTask(result, taskId) {
  const tasks = Array.isArray(result) ? result : result.tasks;
  assert.ok(Array.isArray(tasks), "mutation helper must return tasks or { tasks, snapshot }");
  const task = tasks.find((item) => item.id === taskId);
  assert.ok(task, `expected task ${taskId} to remain in the collection`);
  return { task, tasks, snapshot: Array.isArray(result) ? undefined : result.snapshot };
}

function allInitialTasks() {
  assert.ok(Array.isArray(initialThingsState.tasks), "initialThingsState.tasks must be an array");
  return initialThingsState.tasks;
}

test("the fixture has stable, unique identities for every to-do", () => {
  const tasks = allInitialTasks();
  const ids = tasks.map((task) => task.id);

  assert.ok(ids.length > 0, "the reference needs at least one to-do");
  assert.ok(ids.every(Boolean), "every to-do needs a stable id");
  assert.equal(new Set(ids).size, ids.length, "to-do ids must be unique");
});

test("the six built-in lists project tasks by responsibility", () => {
  const inbox = getTasksForView(initialThingsState, "inbox");
  const today = getTasksForView(initialThingsState, "today");
  const upcoming = getTasksForView(initialThingsState, "upcoming");
  const anytime = getTasksForView(initialThingsState, "anytime");
  const someday = getTasksForView(initialThingsState, "someday");
  const logbook = getTasksForView(initialThingsState, "logbook");

  for (const [view, tasks] of Object.entries({ inbox, today, upcoming, anytime, someday, logbook })) {
    assert.ok(Array.isArray(tasks), `${view} must return a task projection`);
    assert.ok(tasks.length > 0, `${view} needs a non-empty interaction fixture`);
  }

  assert.ok(inbox.every((task) => task.isInbox && task.status === "open"));
  assert.ok(
    today.every(
      (task) =>
        task.status === "open" && !task.isInbox && task.start !== "someday" && !task.isLogged,
    ),
  );
  assert.ok(
    upcoming.every(
      (task) =>
        !task.isInbox &&
        task.status === "open" &&
        ((task.start === "on-date" && task.startDate > TODAY_DATE) || task.deadline > TODAY_DATE),
    ),
  );
  assert.ok(
    anytime.every(
      (task) =>
        task.status === "open" && !task.isInbox && task.start !== "someday" && !task.isLogged,
    ),
  );
  assert.ok(
    someday.every((task) => task.start === "someday" && task.status === "open" && !task.isInbox),
  );
  assert.ok(
    logbook.every(
      (task) => task.isLogged && ["completed", "canceled"].includes(task.status),
    ),
  );
});

test("one to-do keeps the same object identity across attention and parent projections", () => {
  const todayTasks = getTasksForView(initialThingsState, "today");
  const task = todayTasks.find((item) => taskParent(item)?.id);
  assert.ok(task, "fixture needs a Today task owned by an Area, Project, or Heading");

  const parentId = taskParent(task).id;
  const parentTasks = getTasksForView(initialThingsState, `${taskParent(task).type}:${parentId}`);
  const projectedAgain = parentTasks.find((item) => item.id === task.id);

  assert.equal(projectedAgain, task, "projections must reuse the authoritative to-do object");
});

test("Today and deadline-only to-dos remain visible in every applicable projection", () => {
  const today = getTasksForView(initialThingsState, "today");
  const anytime = getTasksForView(initialThingsState, "anytime");
  const upcoming = getTasksForView(initialThingsState, "upcoming");

  const todayInAnytime = today.find((task) => anytime.includes(task));
  assert.ok(todayInAnytime, "a Today to-do must remain actionable in Anytime");

  const deadlineOnly = anytime.find(
    (task) => task.start === "anytime" && task.deadline && task.deadline > TODAY_DATE,
  );
  assert.ok(deadlineOnly, "fixture needs an Anytime to-do with a future deadline");
  assert.ok(upcoming.includes(deadlineOnly), "a future deadline must also project into Upcoming");
});

test("project fixtures cover active, future, Someday, and logged states", () => {
  const projects = initialThingsState.projects;
  assert.ok(projects.some((project) => project.status === "open" && project.start === "anytime"));
  assert.ok(
    projects.some(
      (project) =>
        project.status === "open" &&
        project.start === "on-date" &&
        project.startDate > TODAY_DATE,
    ),
    "Upcoming needs a future Project fixture",
  );
  assert.ok(
    projects.some((project) => project.status === "open" && project.start === "someday"),
    "Someday needs a dormant Project fixture",
  );
  assert.ok(
    projects.some((project) => project.status !== "open" && project.isLogged),
    "Logged Projects needs an archived Project fixture",
  );
});

test("When changes schedule fields only and never duplicates or completes a to-do", () => {
  const tasks = clone(allInitialTasks());
  const original = tasks.find((task) => task.status === "open" && taskParent(task));
  assert.ok(original);
  const before = clone(original);

  const result = scheduleTask(tasks, original.id, "someday");
  const { task, tasks: updatedTasks } = changedTask(result, original.id);

  assert.equal(updatedTasks.length, tasks.length);
  assert.equal(new Set(updatedTasks.map((item) => item.id)).size, updatedTasks.length);
  assert.deepEqual(
    withoutKeys(task, ["start", "startDate", "evening", "isInbox"]),
    withoutKeys(before, ["start", "startDate", "evening", "isInbox"]),
    "When must not change parent, heading, deadline, tags, or content",
  );
  assert.equal(task.status, before.status, "When must not masquerade as completion");
  assert.equal(task.start, "someday");
  assert.equal(task.evening, false);
  assert.equal(task.isInbox, false, "scheduling an Inbox item files it out of Inbox");
  assert.deepEqual(tasks.find((item) => item.id === original.id), before, "updates must be immutable");
});

test("When maps Today, This Evening, Tomorrow, and Clear to distinct schedule states", () => {
  const original = clone(allInitialTasks().find((task) => task.status === "open"));
  assert.ok(original);
  const tasks = [original];
  const cases = [
    ["today", "on-date", TODAY_DATE, false],
    ["evening", "on-date", TODAY_DATE, true],
    ["tomorrow", "on-date", "2026-08-10", false],
    ["clear", "anytime", undefined, false],
  ];

  for (const [value, start, startDate, evening] of cases) {
    const { task } = changedTask(scheduleTask(tasks, original.id, value), original.id);
    assert.equal(task.start, start, `${value} chose the wrong start state`);
    assert.equal(task.startDate, startDate, `${value} chose the wrong start date`);
    assert.equal(task.evening, evening, `${value} chose the wrong evening state`);
    assert.equal(task.isInbox, false);
    assert.equal(task.status, original.status);
  }
});

test("Move changes filing fields only and preserves schedule, status, and identity", () => {
  const tasks = clone(allInitialTasks());
  const original = tasks.find((task) => task.status === "open" && taskParent(task)?.id);
  assert.ok(original);
  const before = clone(original);
  const project = initialThingsState.projects[0];
  assert.ok(project?.id);
  const destination = { type: "project", id: project.id };

  const result = moveTask(tasks, original.id, destination);
  const { task, tasks: updatedTasks } = changedTask(result, original.id);

  assert.equal(updatedTasks.length, tasks.length);
  assert.equal(task.id, before.id);
  assert.deepEqual(taskParent(task), destination);
  assert.deepEqual(
    withoutKeys(task, ["parent", "headingId", "isInbox"]),
    withoutKeys(before, ["parent", "headingId", "isInbox"]),
    "Move must not change start, deadline, completion, tags, or content",
  );
  assert.deepEqual(tasks.find((item) => item.id === original.id), before, "updates must be immutable");
});

test("Move distinguishes Area, Project, Heading, and Inbox destinations", () => {
  const original = clone(allInitialTasks().find((task) => task.status === "open"));
  assert.ok(original);
  const project = initialThingsState.projects.find((item) => item.headings.length);
  const area = initialThingsState.areas[0];
  assert.ok(project && area);
  const heading = project.headings[0];
  const cases = [
    [{ type: "area", id: area.id }, { type: "area", id: area.id }, undefined, false],
    [{ type: "project", id: project.id }, { type: "project", id: project.id }, undefined, false],
    [
      { type: "heading", id: heading.id, projectId: project.id },
      { type: "project", id: project.id },
      heading.id,
      false,
    ],
    [{ type: "inbox" }, { type: "none" }, undefined, true],
  ];

  for (const [destination, parent, headingId, isInbox] of cases) {
    const { task } = changedTask(moveTask([original], original.id, destination), original.id);
    assert.deepEqual(task.parent, parent);
    assert.equal(task.headingId, headingId);
    assert.equal(task.isInbox, isInbox);
  }
});

test("complete and restore form a lossless round trip", () => {
  const tasks = clone(allInitialTasks());
  const original = tasks.find((task) => task.status === "open");
  assert.ok(original);
  const before = clone(original);

  const completedResult = completeTask(tasks, original.id, "2026-08-09");
  const completed = changedTask(completedResult, original.id);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.isLogged, true);
  assert.deepEqual(taskParent(completed.task), taskParent(before));
  assert.equal(completed.task.headingId, before.headingId);
  assert.equal(completed.task.start, before.start);
  assert.equal(completed.task.startDate, before.startDate);
  assert.equal(completed.task.evening, before.evening);

  const snapshot = completed.snapshot ?? before;
  const restoredResult = restoreTask(completed.tasks, snapshot);
  const restored = changedTask(restoredResult, original.id);
  assert.deepEqual(restored.task, before);
});

test("cancel uses the same Logbook transition without becoming completed", () => {
  const original = clone(allInitialTasks().find((task) => task.status === "open"));
  assert.ok(original);
  const canceled = changedTask(
    completeTask([original], original.id, "2026-08-09", "canceled"),
    original.id,
  );
  assert.equal(canceled.task.status, "canceled");
  assert.equal(canceled.task.isLogged, true);
});

test("hidden task lists derive from authoritative fields", () => {
  const tomorrow = getTasksForView(initialThingsState, "tomorrow");
  const deadlines = getTasksForView(initialThingsState, "deadlines");
  const repeating = getTasksForView(initialThingsState, "repeating");

  assert.ok(tomorrow.length > 0 && tomorrow.every((task) => task.startDate === "2026-08-10"));
  assert.ok(deadlines.length > 0 && deadlines.every((task) => Boolean(task.deadline)));
  assert.ok(repeating.length > 0 && repeating.every((task) => task.repeat));
});

test("Quick Find covers navigation and expands into deep content", () => {
  const examples = [
    ["list", "Today"],
    ["area", initialThingsState.areas[0].name],
    ["project", initialThingsState.projects[0].name],
    ["heading", initialThingsState.projects.find((project) => project.headings.length).headings[0].title],
    ["tag", initialThingsState.tags[0]],
    ["task", initialThingsState.tasks.find((task) => task.status === "open").title],
  ];
  for (const [expectedType, query] of examples) {
    const results = buildQuickFindResults(initialThingsState, query, { extended: false });
    assert.ok(
      results.some((result) => result.type === expectedType),
      `basic Quick Find must find ${expectedType}`,
    );
  }

  const taskWithNote = initialThingsState.tasks.find(
    (task) => task.status === "open" && task.note && !task.title.toLowerCase().includes("neighborhood"),
  );
  assert.ok(taskWithNote);
  const distinctiveNoteWord = taskWithNote.note
    .toLowerCase()
    .match(/[a-z]{7,}/)?.[0];
  assert.ok(distinctiveNoteWord, "fixture needs a distinctive note word");
  const basic = buildQuickFindResults(initialThingsState, distinctiveNoteWord, { extended: false });
  const extended = buildQuickFindResults(initialThingsState, distinctiveNoteWord, { extended: true });
  assert.ok(
    !basic.some((result) => result.id === taskWithNote.id),
    "basic search must stay out of Notes",
  );
  assert.ok(
    extended.some((result) => result.id === taskWithNote.id),
    "Continue Search must include Notes and Checklist content",
  );

  const logged = initialThingsState.tasks.find((task) => task.isLogged);
  assert.ok(logged);
  assert.ok(
    !buildQuickFindResults(initialThingsState, logged.title, { extended: false }).some(
      (result) => result.id === logged.id,
    ),
  );
  assert.ok(
    buildQuickFindResults(initialThingsState, logged.title, { extended: true }).some(
      (result) => result.id === logged.id,
    ),
    "Continue Search must include Logbook items",
  );
});

test("Quick Find exposes all five hidden lists", () => {
  const hiddenLists = [
    ["tomorrow", "Tomorrow"],
    ["deadlines", "Deadlines"],
    ["repeating", "Repeating"],
    ["all-projects", "All Projects"],
    ["logged-projects", "Logged Projects"],
  ];
  for (const [id, query] of hiddenLists) {
    const results = buildQuickFindResults(initialThingsState, query, { extended: true });
    assert.ok(results.some((result) => result.id === id), `Quick Find is missing hidden list ${id}`);
  }
});

test("new to-do defaults follow the current list instead of always using Today", () => {
  const cases = [
    ["inbox", true, "anytime"],
    ["today", false, "on-date"],
    ["upcoming", false, "on-date"],
    ["anytime", false, "anytime"],
    ["someday", false, "someday"],
    ["logbook", true, "anytime"],
  ];

  for (const [viewId, isInbox, start] of cases) {
    const defaults = getNewTaskDefaults(viewId, initialThingsState);
    assert.equal(defaults.isInbox, isInbox, `${viewId} chose the wrong Inbox state`);
    assert.equal(defaults.start, start, `${viewId} chose the wrong start state`);
  }

  const project = initialThingsState.projects[0];
  assert.ok(project?.id, "fixture needs a project for contextual creation");
  assert.deepEqual(getNewTaskDefaults(`project:${project.id}`, initialThingsState).parent, {
    type: "project",
    id: project.id,
  });

  const area = initialThingsState.areas[0];
  assert.deepEqual(getNewTaskDefaults(`area:${area.id}`, initialThingsState).parent, {
    type: "area",
    id: area.id,
  });

  const tag = initialThingsState.tags[0];
  assert.deepEqual(getNewTaskDefaults(`tag:${tag}`, initialThingsState).tags, [tag]);
});

test("every native button declares behavior or is explicitly disabled", () => {
  const sourceWithoutArrowTokens = jsxSource.replaceAll("=>", "__ARROW__");
  const openings = [...sourceWithoutArrowTokens.matchAll(/<button\b([\s\S]*?)>/g)];
  assert.ok(openings.length > 0);

  const noOps = openings
    .map((match) => match[0])
    .filter(
      (opening) =>
        !/\bonClick\s*=/.test(opening) &&
        !/\bdisabled(?:\s*=|\s|>)/.test(opening) &&
        !/\btype\s*=\s*["']submit["']/.test(opening),
    );

  assert.deepEqual(noOps, [], `silent no-op buttons found:\n${noOps.join("\n")}`);
});

test("interactive overlays expose distinct accessible dialogs", () => {
  const namedDialogs = [
    ["Choose when", /role=["']dialog["'][^>]*aria-label=["']Choose when["']/],
    ["Move to-do", /role=["']dialog["'][^>]*aria-label=["']Move to-do["']/],
    ["Choose deadline", /role=["']dialog["'][^>]*aria-label=["']Choose deadline["']/],
    ["Quick Find", /role=["']dialog["'][^>]*aria-label=["']Quick Find["']/],
    ["New list", /role=["']dialog["'][^>]*aria-label=["']New list["']/],
    ["List settings", /role=["']dialog["'][^>]*aria-label=["']List settings["']/],
  ];
  for (const [label, pattern] of namedDialogs) {
    assert.match(
      jsxSource,
      pattern,
      `${label} must be a named dialog`,
    );
  }
  assert.match(jsxSource, /<TagPicker\b[\s\S]{0,120}title=["']Tags["']/);
  assert.match(jsxSource, /role=["']dialog["'][^>]*aria-label=\{title\}/);
});
