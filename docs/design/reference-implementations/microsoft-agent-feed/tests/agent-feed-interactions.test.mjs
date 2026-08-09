import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  agents,
  finishReconciliation,
  getActionSet,
  getSummary,
  initialFeedItems,
  projects,
  restoreFeedItem,
  selectFeedItems,
  transitionFeedItem,
} from "../src/agentFeedModel.js";

test("fixtures cover four agents and multiple projects", () => {
  assert.equal(agents.length, 4);
  assert.ok(projects.length >= 4);
  assert.equal(new Set(agents.map((agent) => agent.id)).size, agents.length);
  assert.equal(new Set(initialFeedItems.map((item) => item.id)).size, initialFeedItems.length);
});

test("feed keeps action work separate from completed information", () => {
  const needs = selectFeedItems(initialFeedItems, { tab: "needs" });
  const completed = selectFeedItems(initialFeedItems, { tab: "completed" });
  assert.ok(needs.every((item) => item.status !== "completed"));
  assert.ok(completed.every((item) => item.status === "completed"));
  assert.equal(needs.length + completed.length, initialFeedItems.length);
});

test("agent and project filters compose without copying objects", () => {
  const result = selectFeedItems(initialFeedItems, { tab: "needs", agentId: "project-pilot", projectId: "project-solution" });
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.agentId === "project-pilot" && item.projectId === "project-solution"));
  assert.strictEqual(result[0], initialFeedItems.find((item) => item.id === result[0].id));
});

test("risk outranks recency in the needs-attention projection", () => {
  const result = selectFeedItems(initialFeedItems, { tab: "needs" });
  assert.equal(result[0].priority, "critical");
  assert.equal(result[1].priority, "high");
});

test("task type determines its exact action set", () => {
  const needs = selectFeedItems(initialFeedItems, { tab: "needs" });
  assert.deepEqual(getActionSet(needs.find((item) => item.type === "decision")), ["approve", "request_changes"]);
  assert.deepEqual(getActionSet(needs.find((item) => item.type === "assistance")), ["complete"]);
  assert.deepEqual(getActionSet(needs.find((item) => item.type === "data_entry")), ["accept", "dismiss"]);
  assert.deepEqual(getActionSet(needs.find((item) => item.type === "outcome_unknown")), ["reconcile"]);
});

test("informational review tasks never expose a fake approval", () => {
  const review = initialFeedItems.find((item) => item.type === "review");
  assert.equal(review.status, "completed");
  assert.deepEqual(getActionSet(review), []);
});

test("decision approval preserves identity and records typed outcome", () => {
  const source = initialFeedItems.find((item) => item.type === "decision" && item.status === "needs_attention");
  const result = transitionFeedItem(initialFeedItems, source.id, "approve");
  const changed = result.items.find((item) => item.id === source.id);
  assert.equal(changed.id, source.id);
  assert.equal(changed.status, "completed");
  assert.equal(changed.outcome, "approved");
  assert.equal(changed.revision, source.revision);
  assert.strictEqual(result.snapshot, source);
});

test("request changes hands work back to the agent instead of completing it", () => {
  const source = initialFeedItems.find((item) => item.type === "decision" && item.status === "needs_attention");
  const result = transitionFeedItem(initialFeedItems, source.id, "request_changes", { note: "Show the provider evidence." });
  const changed = result.items.find((item) => item.id === source.id);
  assert.equal(changed.status, "in_progress");
  assert.equal(changed.userNote, "Show the provider evidence.");
  assert.deepEqual(getActionSet(changed), []);
});

test("assistance completion moves one task and leaves the source immutable", () => {
  const source = initialFeedItems.find((item) => item.type === "assistance" && item.status === "needs_attention");
  const result = transitionFeedItem(initialFeedItems, source.id, "complete");
  assert.equal(source.status, "needs_attention");
  assert.equal(result.items.find((item) => item.id === source.id).status, "completed");
  assert.equal(result.items.length, initialFeedItems.length);
});

test("accepted structured data is retained separately from the candidate", () => {
  const source = initialFeedItems.find((item) => item.type === "data_entry" && item.status === "needs_attention");
  const accepted = { ...source.candidate, health: "On track" };
  const result = transitionFeedItem(initialFeedItems, source.id, "accept", accepted);
  const changed = result.items.find((item) => item.id === source.id);
  assert.deepEqual(changed.accepted, accepted);
  assert.deepEqual(source.candidate.health, "At risk");
  assert.equal(changed.outcome, "accepted");
});

test("dismiss records a negative outcome without creating an accepted fact", () => {
  const source = initialFeedItems.find((item) => item.type === "data_entry" && item.status === "needs_attention");
  const result = transitionFeedItem(initialFeedItems, source.id, "dismiss");
  const changed = result.items.find((item) => item.id === source.id);
  assert.equal(changed.outcome, "dismissed");
  assert.equal(changed.accepted, undefined);
});

test("outcome unknown can only reconcile and never exposes retry", () => {
  const source = initialFeedItems.find((item) => item.type === "outcome_unknown");
  assert.deepEqual(getActionSet(source), ["reconcile"]);
  const invalid = transitionFeedItem(initialFeedItems, source.id, "retry");
  assert.strictEqual(invalid.items, initialFeedItems);
  const started = transitionFeedItem(initialFeedItems, source.id, "reconcile");
  assert.equal(started.items.find((item) => item.id === source.id).status, "reconciling");
  const finished = finishReconciliation(started.items, source.id);
  const changed = finished.find((item) => item.id === source.id);
  assert.equal(changed.status, "completed");
  assert.equal(changed.outcome, "succeeded");
});

test("undo restores the exact task snapshot without duplication", () => {
  const source = initialFeedItems.find((item) => item.type === "assistance" && item.status === "needs_attention");
  const result = transitionFeedItem(initialFeedItems, source.id, "complete");
  const restored = restoreFeedItem(result.items, result.snapshot);
  assert.strictEqual(restored.find((item) => item.id === source.id), source);
  assert.equal(new Set(restored.map((item) => item.id)).size, restored.length);
});

test("summary distinguishes outstanding, completed and running agent counts", () => {
  const summary = getSummary(initialFeedItems);
  assert.equal(summary.needs, 4);
  assert.equal(summary.completed, 5);
  assert.equal(summary.running, 2);
});

test("core JSX names all seven interaction surfaces", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const label of ["Needs attention", "Completed", "Filter tasks", "Insights", "Accept and complete", "Reconcile provider state", "Open record"]) {
    assert.match(source, new RegExp(label));
  }
  assert.doesNotMatch(source, />\s*Retry\s*</);
});
