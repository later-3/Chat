import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  activeStatuses,
  agents,
  applyTransition,
  attentionStatuses,
  cloneInitialFeedItems,
  evidenceCatalog,
  getHumanActionSet,
  getRecordProjection,
  getSummary,
  getSystemActionSet,
  groupForStatus,
  projects,
  selectFeedItems,
  terminalStatuses,
} from "../src/agentFeedModel.js";

function fresh() {
  return cloneInitialFeedItems();
}

function find(items, id) {
  return items.find((item) => item.id === id);
}

function validFeedback(item, overrides = {}) {
  return {
    note: "Bind provider Evidence and show the Product Commit before resume.",
    requirementIds: ["no-blind-retry", "bind-provider-evidence", "show-resume-gate"],
    evidenceIds: ["ev-run-14", "ev-provider-contract"],
    scope: "One waiting deployment Run",
    attachmentName: "retry-boundary-note.md",
    expectedRevision: item.revision,
    expectedHash: item.hash,
    ...overrides,
  };
}

function toRevision8(items) {
  const source = find(items, "task-decision-retry");
  const submitted = applyTransition(items, source.id, "submit_feedback", validFeedback(source));
  assert.equal(submitted.ok, true);
  const returned = applyTransition(submitted.items, source.id, "agent_return_revision");
  assert.equal(returned.ok, true);
  return returned;
}

test("fixtures cover four role agents, four projects, and every required live path", () => {
  const items = fresh();
  assert.equal(agents.length, 4);
  assert.ok(projects.length >= 3);
  assert.equal(new Set(agents.map((agent) => agent.id)).size, agents.length);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.ok(items.some((item) => item.type === "decision" && item.revision === 7 && item.status === "waiting_human"));
  assert.ok(items.some((item) => item.type === "assistance" && item.status === "waiting_human"));
  assert.ok(items.some((item) => item.type === "candidate" && item.status === "candidate_editable"));
  assert.ok(items.some((item) => item.status === "outcome_unknown"));
  assert.ok(items.some((item) => item.type === "delegation"));
  assert.ok(evidenceCatalog.length >= 7);
});

test("attention, active, and terminal statuses stay in separate projections", () => {
  for (const status of attentionStatuses) assert.equal(groupForStatus(status), "attention");
  for (const status of activeStatuses) assert.equal(groupForStatus(status), "active");
  for (const status of terminalStatuses) assert.equal(groupForStatus(status), "history");
  const items = fresh();
  const groups = ["attention", "active", "history"].map((tab) => selectFeedItems(items, { tab }));
  assert.equal(groups.flat().length, items.length);
  assert.equal(new Set(groups.flat().map((item) => item.id)).size, items.length);
});

test("agent and project filters compose without copying authoritative objects", () => {
  const items = fresh();
  const result = selectFeedItems(items, { tab: "attention", agentId: "project-pilot", projectId: "project-solution" });
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.projectId === "project-solution"));
  assert.strictEqual(result[0], find(items, result[0].id));
});

test("typed human actions never collapse into a universal approve, complete, retry, or undo", () => {
  const items = fresh();
  assert.deepEqual(getHumanActionSet(find(items, "task-decision-retry")), ["approve_decision", "submit_feedback"]);
  assert.deepEqual(getHumanActionSet(find(items, "task-assistance-source")), ["submit_assistance"]);
  assert.deepEqual(getHumanActionSet(find(items, "task-data-project-update")), ["accept_candidate", "dismiss_candidate"]);
  assert.deepEqual(getHumanActionSet(find(items, "task-outcome-unknown")), ["start_reconciliation"]);
  assert.deepEqual(getHumanActionSet(find(items, "task-delegation-evidence")), ["delegate"]);
  for (const item of items) {
    const actions = getHumanActionSet(item);
    assert.ok(!actions.includes("retry"));
    assert.ok(!actions.includes("undo"));
    assert.ok(!actions.includes("complete"));
  }
});

test("decision feedback requires text, typed changes, Evidence, and a current revision/hash", () => {
  const items = fresh();
  const item = find(items, "task-decision-retry");
  assert.equal(applyTransition(items, item.id, "submit_feedback", validFeedback(item, { note: "" })).code, "feedback_note_required");
  assert.equal(applyTransition(items, item.id, "submit_feedback", validFeedback(item, { requirementIds: [] })).code, "feedback_requirement_required");
  assert.equal(applyTransition(items, item.id, "submit_feedback", validFeedback(item, { evidenceIds: [] })).code, "feedback_evidence_required");
  assert.equal(applyTransition(items, item.id, "submit_feedback", validFeedback(item, { expectedRevision: 6 })).code, "stale_decision");
  assert.strictEqual(find(items, item.id), item);
});

test("submitting feedback hands ownership to the Agent without creating a Decision fact", () => {
  const items = fresh();
  const item = find(items, "task-decision-retry");
  const result = applyTransition(items, item.id, "submit_feedback", validFeedback(item));
  const changed = find(result.items, item.id);
  assert.equal(result.ok, true);
  assert.equal(changed.status, "waiting_agent");
  assert.equal(changed.run.nextOwner, "Project Pilot");
  assert.equal(changed.decisionFacts.length, 0);
  assert.equal(changed.latestFeedback.attachmentName, "retry-boundary-note.md");
  assert.deepEqual(getHumanActionSet(changed), []);
  assert.deepEqual(getSystemActionSet(changed), ["agent_return_revision"]);
});

test("Agent return creates revision 8 with a new hash, diff, Evidence, and itemized responses", () => {
  const returned = toRevision8(fresh());
  const changed = returned.item;
  assert.equal(changed.revision, 8);
  assert.equal(changed.hash, "b47c…e910");
  assert.equal(changed.status, "waiting_human");
  assert.equal(changed.previousRevision.revision, 7);
  assert.notEqual(changed.diff.from, changed.diff.to);
  assert.ok(changed.evidenceIds.includes("ev-provider-ledger"));
  assert.equal(changed.agentResponses.length, changed.latestFeedback.requirementIds.length + 1);
  assert.ok(changed.agentResponses.every((response) => response.state === "addressed"));
});

test("revision 8 can be requested again and produces a distinct later revision", () => {
  const revision8 = toRevision8(fresh());
  const item = revision8.item;
  const submitted = applyTransition(revision8.items, item.id, "submit_feedback", validFeedback(item, { note: "Narrow the scope one more time." }));
  const returned = applyTransition(submitted.items, item.id, "agent_return_revision");
  assert.equal(returned.item.revision, 9);
  assert.notEqual(returned.item.hash, item.hash);
  assert.equal(returned.item.feedbackHistory.length, 2);
});

test("approval first commits an authoritative Decision fact while the Run is still not resumed", () => {
  const revision8 = toRevision8(fresh());
  const item = revision8.item;
  const approved = applyTransition(revision8.items, item.id, "approve_decision", { expectedRevision: 8, expectedHash: item.hash });
  assert.equal(approved.item.status, "decision_committed");
  assert.equal(approved.item.run.state, "decision_committed");
  assert.equal(approved.item.decisionFacts.length, 1);
  assert.equal(approved.item.decisionFacts[0].revision, 8);
  assert.equal(approved.item.finalRecord, undefined);
  assert.deepEqual(getSystemActionSet(approved.item), ["resume_decision_run"]);
});

test("a stale page cannot approve a newer Decision revision", () => {
  const revision8 = toRevision8(fresh());
  const result = applyTransition(revision8.items, revision8.item.id, "approve_decision", { expectedRevision: 7, expectedHash: "8fe1…5c2a" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_decision");
  assert.equal(find(result.items, revision8.item.id).decisionFacts.length, 0);
});

test("Decision run resumes, executes, and succeeds only after the Decision fact", () => {
  const revision8 = toRevision8(fresh());
  const item = revision8.item;
  const approved = applyTransition(revision8.items, item.id, "approve_decision", { expectedRevision: 8, expectedHash: item.hash });
  const resumed = applyTransition(approved.items, item.id, "resume_decision_run");
  const executing = applyTransition(resumed.items, item.id, "execute_decision_run");
  const completed = applyTransition(executing.items, item.id, "complete_decision_run");
  assert.equal(resumed.item.status, "resuming");
  assert.equal(executing.item.status, "running");
  assert.equal(completed.item.status, "succeeded");
  assert.equal(completed.item.finalRecord.state, "committed");
  assert.equal(completed.item.run.timeline.at(-1).label, "Authoritative policy record written");
  assert.deepEqual(getHumanActionSet(completed.item), []);
});

test("Decision execution failure cannot create a false success record", () => {
  const revision8 = toRevision8(fresh());
  const item = revision8.item;
  const approved = applyTransition(revision8.items, item.id, "approve_decision", { expectedRevision: 8, expectedHash: item.hash });
  const resumed = applyTransition(approved.items, item.id, "resume_decision_run");
  const executing = applyTransition(resumed.items, item.id, "execute_decision_run");
  const failed = applyTransition(executing.items, item.id, "fail_decision_run");
  assert.equal(failed.item.status, "failed");
  assert.equal(failed.item.finalRecord, undefined);
});

test("assistance requires context, a resource, and a recorded manual result", () => {
  const items = fresh();
  const item = find(items, "task-assistance-source");
  assert.equal(applyTransition(items, item.id, "submit_assistance", { context: "", resourceIds: ["resource-source-record"], manualResult: "access_confirmed" }).code, "assistance_context_required");
  assert.equal(applyTransition(items, item.id, "submit_assistance", { context: "Safe", resourceIds: [], manualResult: "access_confirmed" }).code, "assistance_resource_required");
  assert.equal(applyTransition(items, item.id, "submit_assistance", { context: "Safe", resourceIds: ["resource-source-record"], manualResult: "unknown" }).code, "assistance_result_required");
});

test("successful assistance records an Agent receipt, resumes the Run, and writes related Evidence", () => {
  const items = fresh();
  const item = find(items, "task-assistance-source");
  const submitted = applyTransition(items, item.id, "submit_assistance", { context: "The record is participant-safe.", resourceIds: ["resource-source-record", "resource-permission-log"], manualResult: "access_confirmed", attachmentName: "permission-note.txt" });
  assert.equal(submitted.item.status, "waiting_agent");
  assert.equal(submitted.item.agentReceipt.receivedResources.length, 2);
  const resumed = applyTransition(submitted.items, item.id, "resume_assistance_run");
  const completed = applyTransition(resumed.items, item.id, "complete_assistance_run");
  assert.equal(completed.item.status, "succeeded");
  assert.equal(completed.item.finalRecord.state, "verified");
  assert.deepEqual(completed.item.finalRecord.resourceIds, ["resource-source-record", "resource-permission-log"]);
});

test("assistance can return to human intervention without claiming failure or success", () => {
  const items = fresh();
  const item = find(items, "task-assistance-source");
  const submitted = applyTransition(items, item.id, "submit_assistance", { context: "The source is still restricted.", resourceIds: ["resource-permission-log"], manualResult: "source_still_restricted" });
  const resumed = applyTransition(submitted.items, item.id, "resume_assistance_run");
  const reblocked = applyTransition(resumed.items, item.id, "complete_assistance_run");
  assert.equal(reblocked.item.status, "waiting_human");
  assert.equal(reblocked.item.run.nextOwner, "Human");
  assert.equal(reblocked.item.reinterventionCount, 1);
  assert.equal(reblocked.item.finalRecord, undefined);
});

test("assistance run failure remains a distinct failed terminal state", () => {
  const items = fresh();
  const item = find(items, "task-assistance-source");
  const submitted = applyTransition(items, item.id, "submit_assistance", { context: "Use safe record.", resourceIds: ["resource-source-record"], manualResult: "access_confirmed" });
  const resumed = applyTransition(submitted.items, item.id, "resume_assistance_run");
  const failed = applyTransition(resumed.items, item.id, "fail_assistance_run");
  assert.equal(failed.item.status, "failed");
  assert.equal(failed.item.finalRecord, undefined);
});

test("accepting a Project Update preserves the candidate and creates a read-only record", () => {
  const items = fresh();
  const item = find(items, "task-data-project-update");
  const acceptedPayload = { ...item.candidate, health: "On track", summary: "Edited summary" };
  const accepted = applyTransition(items, item.id, "accept_candidate", acceptedPayload);
  assert.equal(accepted.item.status, "succeeded");
  assert.equal(accepted.item.outcome, "accepted");
  assert.equal(accepted.item.finalRecord.state, "published");
  assert.equal(item.candidate.health, "At risk");
  assert.deepEqual(getHumanActionSet(accepted.item), []);
});

test("dismissing a candidate is read-only and cannot later be accepted", () => {
  const items = fresh();
  const item = find(items, "task-data-project-update");
  const dismissed = applyTransition(items, item.id, "dismiss_candidate");
  assert.equal(dismissed.item.status, "dismissed");
  assert.equal(dismissed.item.finalRecord, undefined);
  const invalid = applyTransition(dismissed.items, item.id, "accept_candidate", item.candidate);
  assert.equal(invalid.code, "invalid_transition");
});

test("restarting a dismissed candidate creates a new identity and preserves the dismissed object", () => {
  const items = fresh();
  const dismissed = find(items, "task-dismissed-personal");
  const created = applyTransition(items, dismissed.id, "create_new_candidate");
  assert.equal(created.ok, true);
  assert.notEqual(created.createdItemId, dismissed.id);
  assert.equal(find(created.items, dismissed.id).status, "dismissed");
  assert.equal(find(created.items, created.createdItemId).status, "candidate_editable");
  assert.equal(created.items.length, items.length + 1);
});

test("outcome_unknown rejects ordinary retry and enters reconciliation only", () => {
  const items = fresh();
  const item = find(items, "task-outcome-unknown");
  const retry = applyTransition(items, item.id, "retry");
  assert.equal(retry.code, "invalid_transition");
  assert.strictEqual(retry.items, items);
  const started = applyTransition(items, item.id, "start_reconciliation");
  assert.equal(started.item.status, "reconciling");
  assert.match(started.item.run.timeline.at(-1).detail, /no new command sent/i);
});

test("reconciliation shows provider Evidence before a separate Product Commit", () => {
  const items = fresh();
  const item = find(items, "task-outcome-unknown");
  const started = applyTransition(items, item.id, "start_reconciliation");
  const found = applyTransition(started.items, item.id, "reconciliation_found");
  assert.equal(found.item.status, "reconciliation_found");
  assert.ok(found.item.queryEvidence);
  assert.equal(found.item.productState, "No deployment fact committed");
  assert.deepEqual(getHumanActionSet(found.item), ["commit_reconciliation", "manual_disposition"]);
  const committed = applyTransition(found.items, item.id, "commit_reconciliation");
  assert.equal(committed.item.status, "reconciled");
  assert.equal(committed.item.finalRecord.commandId, item.commandId);
  assert.deepEqual(getHumanActionSet(committed.item), []);
});

test("manual reconciliation disposition closes without a Product success fact", () => {
  const items = fresh();
  const item = find(items, "task-outcome-unknown");
  const started = applyTransition(items, item.id, "start_reconciliation");
  const found = applyTransition(started.items, item.id, "reconciliation_found");
  assert.equal(applyTransition(found.items, item.id, "manual_disposition", { note: "" }).code, "manual_note_required");
  const manual = applyTransition(found.items, item.id, "manual_disposition", { note: "Escalated to the release owner." });
  assert.equal(manual.item.status, "canceled");
  assert.equal(manual.item.outcome, "manual_disposition");
  assert.equal(manual.item.finalRecord, undefined);
});

test("delegation creates parent-child identity, dependency, participants, and current ownership", () => {
  const items = fresh();
  const item = find(items, "task-delegation-evidence");
  const delegated = applyTransition(items, item.id, "delegate");
  assert.equal(delegated.item.status, "delegated");
  assert.equal(delegated.item.delegatedTask.parentTaskId, item.parentTask.id);
  assert.equal(delegated.item.currentOwnerAgentId, "evidence-scout");
  assert.equal(delegated.item.dependency.state, "in_progress");
  assert.ok(delegated.item.participants.includes("project-pilot"));
  assert.ok(delegated.item.participants.includes("evidence-scout"));
});

test("Agent-to-Agent coordination messages never become authoritative facts", () => {
  const items = fresh();
  const item = find(items, "task-delegation-evidence");
  const delegated = applyTransition(items, item.id, "delegate");
  assert.ok(delegated.item.coordinationMessages.length > 0);
  assert.ok(delegated.item.coordinationMessages.every((message) => message.authoritativeFact === false));
  assert.ok(delegated.item.coordinationMessages.every((message) => message.visibility === "Project participants"));
  const directed = applyTransition(delegated.items, item.id, "add_direction", { note: "Prefer the official preview documentation." });
  assert.equal(directed.item.coordinationMessages.at(-1).authoritativeFact, false);
  assert.equal(directed.item.finalRecord, undefined);
});

test("delegated Evidence returns to Project Pilot and unblocks the parent only after consumption", () => {
  const items = fresh();
  const item = find(items, "task-delegation-evidence");
  const delegated = applyTransition(items, item.id, "delegate");
  const returned = applyTransition(delegated.items, item.id, "scout_return");
  assert.equal(returned.item.status, "evidence_returned");
  assert.equal(returned.item.currentOwnerAgentId, "project-pilot");
  assert.equal(returned.item.dependency.state, "satisfied");
  assert.ok(returned.item.evidenceIds.includes("ev-delegated-source"));
  assert.equal(returned.item.finalRecord, undefined);
  const consumed = applyTransition(returned.items, item.id, "pilot_consume");
  assert.equal(consumed.item.status, "succeeded");
  assert.equal(consumed.item.finalRecord.state, "unblocked");
});

test("human can reassign or stop a live delegation", () => {
  const items = fresh();
  const item = find(items, "task-delegation-evidence");
  const delegated = applyTransition(items, item.id, "delegate");
  assert.equal(applyTransition(delegated.items, item.id, "reassign", { agentId: "missing" }).code, "agent_required");
  const reassigned = applyTransition(delegated.items, item.id, "reassign", { agentId: "research-navigator" });
  assert.equal(reassigned.item.currentOwnerAgentId, "research-navigator");
  assert.ok(reassigned.item.participants.includes("research-navigator"));
  const stopped = applyTransition(reassigned.items, item.id, "stop_delegation");
  assert.equal(stopped.item.status, "canceled");
  assert.equal(stopped.item.dependency.state, "unresolved");
  assert.deepEqual(getHumanActionSet(stopped.item), []);
});

test("terminal statuses and summary numbers remain exact after transitions", () => {
  let items = fresh();
  const summary = getSummary(items);
  assert.equal(summary.attention, 5);
  assert.equal(summary.active, 0);
  assert.equal(summary.history, 4);
  const candidate = find(items, "task-data-project-update");
  items = applyTransition(items, candidate.id, "dismiss_candidate").items;
  const next = getSummary(items);
  assert.equal(next.attention, 4);
  assert.equal(next.history, 5);
  assert.ok(selectFeedItems(items, { tab: "history" }).some((item) => item.status === "failed"));
  assert.ok(selectFeedItems(items, { tab: "history" }).some((item) => item.status === "dismissed"));
  assert.ok(selectFeedItems(items, { tab: "history" }).some((item) => item.status === "reconciled"));
});

test("related record projection preserves authority, identity, Decision, Run, and Evidence links", () => {
  const revision8 = toRevision8(fresh());
  const item = revision8.item;
  const approved = applyTransition(revision8.items, item.id, "approve_decision", { expectedRevision: 8, expectedHash: item.hash });
  const record = getRecordProjection(approved.item);
  assert.equal(record.owner, "Chat Product Store fixture");
  assert.equal(record.revision, 8);
  assert.equal(record.hash, "b47c…e910");
  assert.equal(record.runId, "run-policy-14");
  assert.equal(record.decisionFacts.length, 1);
  assert.ok(record.evidenceIds.includes("ev-provider-ledger"));
});

test("core JSX exposes all required interaction surfaces without generic Undo or Retry", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const label of [
    "Needs attention",
    "Active",
    "Recent results",
    "Request changes",
    "Submit feedback",
    "Response to feedback",
    "Run timeline",
    "Provide assistance",
    "Accept Project Update",
    "Reconcile provider state",
    "Commit Product fact",
    "Delegate to Evidence Scout",
    "Coordination events",
    "Open record",
  ]) assert.match(source, new RegExp(label));
  assert.doesNotMatch(source, />\s*Undo\s*</);
  assert.doesNotMatch(source, />\s*Retry\s*</);
  assert.doesNotMatch(source, />\s*Complete\s*</);
});

test("opening a human composer pauses the simulated Agent clock", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(composer\) return undefined/);
  assert.match(source, /\[items, selectedId, composer\]/);
});

test("CSS contains mobile reflow, 44px targets, focus, modal, and reduced-motion contracts", async () => {
  const source = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /@media \(max-width: 850px\)/);
  assert.match(source, /min-height: 44px/);
  assert.match(source, /:focus-visible/);
  assert.match(source, /\.modal-backdrop/);
  assert.match(source, /\.toast\s*\{[^}]*bottom:\s*82px/s);
  assert.match(source, /\.toast\s*\{[^}]*bottom:\s*84px/s);
  assert.match(source, /prefers-reduced-motion/);
  assert.doesNotMatch(source, /animation-iteration-count:\s*infinite/);
});
