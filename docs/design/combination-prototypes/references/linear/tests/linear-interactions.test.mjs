import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addUpdateComment,
  createAgentDraft,
  createInitialState,
  editDraft,
  issueById,
  projectById,
  publishDraft,
  pulseUpdates,
  reactToUpdate,
  setUpdateSchedule,
  startManualDraft,
  updateIssue,
  updatesForProject,
} from "../src/linearModel.js";

test("issue list exposes stable distinct objects", () => {
  const state = createInitialState();
  assert.equal(state.issues.length, 6);
  assert.equal(new Set(state.issues.map((issue) => issue.id)).size, state.issues.length);
  assert.equal(new Set(state.issues.map((issue) => issue.key)).size, state.issues.length);
});

test("list, Peek, and detail project the same issue state", () => {
  const state = createInitialState();
  const before = issueById(state, "issue-342");
  const next = updateIssue(state, "issue-342", { status: "In review", assigneeId: "roman" });
  const after = issueById(next, "issue-342");
  assert.equal(after.id, before.id);
  assert.equal(after.status, "In review");
  assert.equal(after.assigneeId, "roman");
  assert.equal(next.issues.find((issue) => issue.id === "issue-342"), after);
});

test("agent-assisted update stays a candidate until a human publishes", () => {
  const state = createInitialState();
  const candidate = createAgentDraft(state, "atlas");
  assert.equal(candidate.draft.source, "agent");
  assert.equal(candidate.draft.status, "candidate");
  assert.equal(candidate.draft.sources.length, 3);
  assert.equal(candidate.updates.length, state.updates.length);
  assert.equal(pulseUpdates(candidate).length, pulseUpdates(state).length);
});

test("editing and publishing creates one authored revision with provenance", () => {
  let state = createAgentDraft(createInitialState(), "atlas");
  state = editDraft(state, { body: `${state.draft.body}\n\nLead note: we will not automate the health judgment.` });
  state = publishDraft(state, "maya");
  const published = state.updates[0];
  assert.equal(published.projectId, "atlas");
  assert.equal(published.assistedByAgent, true);
  assert.equal(published.body.includes("Lead note"), true);
  assert.equal(state.draft, null);
  assert.equal(updatesForProject(state, "atlas")[0], published);
  assert.equal(pulseUpdates(state, "recent")[0], published);
});

test("empty manual draft cannot create a false update", () => {
  const state = startManualDraft(createInitialState(), "atlas");
  const next = publishDraft(state);
  assert.equal(next, state);
  assert.equal(next.updates.length, 4);
});

test("project health does not derive itself from issue completion", () => {
  let state = createInitialState();
  state = { ...state, issues: state.issues.map((issue) => issue.projectId === "atlas" ? { ...issue, status: "Done" } : issue) };
  assert.equal(updatesForProject(state, "atlas")[0].health, "at-risk");
  assert.equal(projectById(state, "atlas").status, "In progress");
});

test("comments and reactions remain attached to the update", () => {
  let state = createInitialState();
  state = addUpdateComment(state, "update-atlas-3", "The reminder copy is ready.", "roman");
  state = reactToUpdate(state, "update-atlas-3", "eyes");
  const update = state.updates.find((item) => item.id === "update-atlas-3");
  assert.equal(update.comments.at(-1).body, "The reminder copy is ready.");
  assert.equal(update.reactions.eyes, 4);
});

test("update schedule changes project expectation, not project health", () => {
  const state = createInitialState();
  const health = updatesForProject(state, "relay")[0].health;
  const next = setUpdateSchedule(state, "relay", { mode: "never", frequency: "Every week", day: "Monday", time: "11:00–12:00" });
  assert.equal(projectById(next, "relay").updateSchedule.mode, "never");
  assert.equal(updatesForProject(next, "relay")[0].health, health);
});

test("Pulse feeds are projections over published updates", () => {
  const state = createInitialState();
  assert.equal(pulseUpdates(state, "for-me").every((update) => ["atlas", "relay"].includes(update.projectId)), true);
  assert.equal(pulseUpdates(state, "custom:feed-risk").every((update) => update.health === "at-risk"), true);
  assert.equal(pulseUpdates(state, "recent").every((update) => update.published), true);
  const popularTotals = pulseUpdates(state, "popular").map((update) => Object.values(update.reactions).reduce((total, count) => total + count, 0));
  assert.deepEqual(popularTotals, [...popularTotals].sort((left, right) => right - left));
});

test("JSX declares the complete interaction contract without silent no-op handlers", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const modelSource = await readFile(new URL("../src/linearModel.js", import.meta.url), "utf8");
  assert.equal(source.includes("onClick={() => {}}"), false);
  assert.equal(source.includes('new Set(["issues", "issue", "project", "pulse"])'), true);
  assert.equal(source.includes("Peek · Space"), true);
  assert.equal(source.includes("Agent candidate — not published"), true);
  assert.equal(source.includes("Project update history"), true);
  assert.equal(source.includes("custom:feed-risk"), true);
  assert.equal(modelSource.includes('name: "At risk projects"'), true);
  assert.equal(source.includes("Update schedule"), true);
});
