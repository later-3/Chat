import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addComment,
  addHillUpdate,
  addSubtask,
  addToolItem,
  aggregateViews,
  createFolder,
  createInitialState,
  createProject,
  createTodo,
  filterTodos,
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
} from "../src/basecampModel.js";

test("eight project cards represent eight stable destinations", () => {
  const state = createInitialState();
  assert.equal(state.projects.length, 8);
  assert.equal(new Set(state.projects.map((project) => project.id)).size, 8);
});

test("all six Basecamp project tools are represented", () => {
  assert.deepEqual(toolCatalog.map((tool) => tool.id), ["message", "docs", "todos", "chat", "schedule", "cards"]);
});

test("global and personal navigation expose ten distinct aggregate views", () => {
  assert.equal(aggregateViews.length, 10);
  assert.equal(new Set(aggregateViews.map((view) => view.id)).size, aggregateViews.length);
});

test("project stars update immutably and keep project identity", () => {
  const state = createInitialState();
  const before = state.projects.find((project) => project.id === "enormicom");
  const next = toggleProjectStar(state, "enormicom");
  const after = next.projects.find((project) => project.id === "enormicom");
  assert.equal(before.starred, true);
  assert.equal(after.starred, false);
  assert.equal(after.id, before.id);
  assert.notEqual(next, state);
});

test("new projects and folders receive stable unique ids", () => {
  const state = createInitialState();
  const withProject = createProject(state, { name: "Editorial calendar", note: "Weekly publishing" });
  const withFolder = createFolder(withProject, "Publishing");
  assert.equal(withProject.projects.at(-1).id, "project-100");
  assert.equal(withFolder.folders.at(-1).id, "folder-101");
  assert.equal(new Set(withFolder.projects.map((project) => project.id)).size, withFolder.projects.length);
});

test("to-do creation enters only the requested project and list", () => {
  const state = createInitialState();
  const next = createTodo(state, { projectId: "website", listId: "next", title: "Confirm launch copy", ownerId: "alex" });
  const created = next.todos.at(-1);
  assert.equal(created.projectId, "website");
  assert.equal(created.listId, "next");
  assert.equal(created.ownerId, "alex");
  assert.equal(todosForProject(next, "website").includes(created), true);
  assert.equal(todosForProject(next, "enormicom").includes(created), false);
});

test("list and detail share the same to-do object projection", () => {
  const state = createInitialState();
  const before = todoById(state, "kickoff");
  const next = toggleTodo(state, "kickoff");
  const detail = todoById(next, "kickoff");
  const list = todosForProject(next, "enormicom").find((todo) => todo.id === "kickoff");
  assert.equal(before.done, false);
  assert.equal(detail.done, true);
  assert.equal(list, detail);
  assert.equal(list.dueLabel, "Fri, Jul 31");
  const reopened = todoById(toggleTodo(next, "kickoff"), "kickoff");
  assert.equal(reopened.done, false);
  assert.equal(reopened.dueLabel, "Fri, Jul 31");
});

test("assignment, due date, title, and notes update without replacing the id", () => {
  const state = createInitialState();
  const next = updateTodo(state, "kickoff", { ownerId: "sofia", due: "2026-08-12", dueLabel: "Aug 12", title: "Refine kickoff scope", notes: "Updated notes" });
  const todo = todoById(next, "kickoff");
  assert.equal(todo.id, "kickoff");
  assert.equal(todo.ownerId, "sofia");
  assert.equal(todo.due, "2026-08-12");
  assert.equal(todo.title, "Refine kickoff scope");
  assert.equal(todo.notes, "Updated notes");
});

test("bookmark, subtask, and comment state remain attached to the same to-do", () => {
  let state = createInitialState();
  state = toggleTodoBookmark(state, "kickoff");
  state = addSubtask(state, "kickoff", "Share final agenda", "geoff");
  const subtaskId = todoById(state, "kickoff").subtasks.at(-1).id;
  state = toggleSubtask(state, "kickoff", subtaskId);
  state = addComment(state, "kickoff", "Agenda is ready.");
  const commentId = todoById(state, "kickoff").comments.at(-1).id;
  const withComment = todoById(state, "kickoff");
  assert.equal(withComment.bookmarked, true);
  assert.equal(withComment.subtasks.at(-1).done, true);
  assert.equal(withComment.comments.at(-1).body, "Agenda is ready.");
  state = removeComment(state, "kickoff", commentId);
  assert.equal(todoById(state, "kickoff").comments.some((comment) => comment.id === commentId), false);
});

test("filters preserve source objects and combine status and owner", () => {
  const state = createInitialState();
  const projectTodos = todosForProject(state, "enormicom");
  const filtered = filterTodos(projectTodos, { status: "open", ownerId: "geoff", query: "build" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "pages");
  assert.equal(filtered[0], todoById(state, "pages"));
});

test("quick find returns projects, people, pages, and distinct to-dos", () => {
  const state = createInitialState();
  assert.equal(quickFind(state, "Website Redesign")[0].type, "Project");
  assert.equal(quickFind(state, "Geoff Collier")[0].type, "Person");
  assert.equal(quickFind(state, "My Notes")[0].type, "Page");
  const todoResult = quickFind(state, "Run project kickoff")[0];
  assert.equal(todoResult.type, "To-do");
  assert.equal(todoResult.target.todoId, "kickoff");
});

test("tool items and hill history are real model changes", () => {
  const state = createInitialState();
  const withDocument = addToolItem(state, "docs", "Launch checklist.pdf");
  const withHillUpdate = addHillUpdate(withDocument, "Build moved past the top of the hill.");
  assert.equal(withDocument.toolItems.docs[0], "Launch checklist.pdf");
  assert.equal(withHillUpdate.hillUpdates[0].summary, "Build moved past the top of the hill.");
  assert.equal(withHillUpdate.hillUpdates.length, state.hillUpdates.length + 1);
});

test("JSX has no empty click handlers or legacy single-project routing", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.equal(source.includes("onClick={() => {}}"), false);
  assert.equal(source.includes('navigate(project.id === "enormicom" ? "project" : "project")'), false);
  assert.equal(source.includes("tool.id === \"todos\" ? navigate"), false);
});
