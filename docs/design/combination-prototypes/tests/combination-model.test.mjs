import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptCandidate,
  acceptDecision,
  completeAction,
  createInitialState,
  editCandidate,
  findById,
  fixtureContract,
  getModeObjectIds,
  moveActionToDayPart,
  reviseDecision,
  stableMockHash,
  startReconciliation,
  undoActionMutation,
  verifyReconciliation,
} from "../src/model.js";

test("fixture exposes exactly three differentiated attention modes", () => {
  assert.deepEqual(fixtureContract.modes, ["project", "today", "workbench"]);
  const state = createInitialState();
  assert.equal(state.projects.length, 3);
  assert.deepEqual(state.projects.map((project) => project.category), ["work", "life", "hobby"]);
});

test("stable object identity crosses Project, Today, and Workbench projections", () => {
  const state = createInitialState();
  const projectIds = getModeObjectIds(state, "project");
  const todayIds = getModeObjectIds(state, "today");
  const workbenchIds = getModeObjectIds(state, "workbench");

  assert.ok(projectIds.includes("project_chat_solution"));
  assert.ok(todayIds.includes("decision_combination_freeze_r4"));
  assert.ok(workbenchIds.includes("decision_combination_freeze_r4"));
  assert.ok(todayIds.includes("run_calendar_publish_attempt_02"));
  assert.ok(workbenchIds.includes("run_calendar_publish_attempt_02"));
});

test("Project structure keeps Stage, Milestone, Iteration, Work, Scope, and Action separate", () => {
  const state = createInitialState();
  const project = findById(state, "projects", "project_chat_solution");
  const work = findById(state, "works", project.workIds[0]);
  const scope = findById(state, "scopes", work.scopeIds[0]);
  const action = findById(state, "actions", scope.actionIds[0]);

  assert.equal(project.stage, "交互收口");
  assert.equal(project.milestone, "组合原型冻结");
  assert.match(project.iteration, /Iteration 02/);
  assert.equal(scope.workId, work.id);
  assert.equal(action.scopeId, scope.id);
});

test("Resource and Evidence remain separate reusable identities", () => {
  const state = createInitialState();
  const resource = findById(state, "resources", "resource_reference_audits");
  const evidence = findById(state, "evidence", resource.evidenceIds[0]);

  assert.equal(resource.kind, "source_bundle");
  assert.equal(evidence.integrity, "verified");
  assert.notEqual(resource.id, evidence.id);
});

test("only a reversible Action can complete and Undo restores its exact Today state", () => {
  const state = createInitialState();
  const actionId = "action_review_evidence_contract";
  const result = completeAction(state, actionId);

  assert.equal(findById(result.state, "actions", actionId).status, "completed");
  assert.equal(result.mutation.undoable, true);
  const restored = undoActionMutation(result.state, result.mutation);
  assert.equal(findById(restored, "actions", actionId).status, "open");
  assert.equal(findById(restored, "actions", actionId).dayPart, "day");
});

test("move to evening is an Action-only reversible projection change", () => {
  const state = createInitialState();
  const actionId = "action_check_route_water";
  const result = moveActionToDayPart(state, actionId, "evening");

  assert.equal(findById(result.state, "actions", actionId).dayPart, "evening");
  assert.equal(findById(state, "actions", actionId).projectId, findById(result.state, "actions", actionId).projectId);
  const restored = undoActionMutation(result.state, result.mutation);
  assert.equal(findById(restored, "actions", actionId).dayPart, "day");
});

test("external reconciliation Action cannot use Today completion or move semantics", () => {
  const state = createInitialState();
  const actionId = "action_query_calendar_receipt";
  assert.throws(() => completeAction(state, actionId), /Only reversible Action/);
  assert.throws(() => moveActionToDayPart(state, actionId, "evening"), /Only reversible Action/);
});

test("Decision revision changes content and hash before version-bound acceptance", () => {
  const state = createInitialState();
  const id = "decision_combination_freeze_r4";
  const current = findById(state, "decisions", id);
  const revised = reviseDecision(state, id, `${current.content} 移动端使用层级返回。`, current.revision);
  const candidate = findById(revised, "decisions", id);

  assert.equal(candidate.revision, current.revision + 1);
  assert.notEqual(candidate.hash, current.hash);
  assert.equal(candidate.hash, stableMockHash(`${id}|${candidate.revision}|${candidate.content}`));
  const accepted = acceptDecision(revised, id, candidate.revision);
  assert.equal(findById(accepted, "decisions", id).status, "accepted");
});

test("stale Decision and Candidate revisions fail closed", () => {
  const state = createInitialState();
  assert.throws(() => acceptDecision(state, "decision_combination_freeze_r4", 3), /Stale revision/);
  assert.throws(() => editCandidate(state, "candidate_evidence_summary_r2", "new", 1), /Stale revision/);
});

test("Candidate edit and accept preserve identity and provenance", () => {
  const state = createInitialState();
  const id = "candidate_evidence_summary_r2";
  const edited = editCandidate(state, id, "Resource 与 Evidence 必须保留独立身份与来源。", 2);
  const revision = findById(edited, "candidates", id).revision;
  const accepted = acceptCandidate(edited, id, revision);
  const candidate = findById(accepted, "candidates", id);

  assert.equal(candidate.id, id);
  assert.equal(candidate.createdById, "agent_mochi");
  assert.equal(candidate.status, "accepted");
});

test("outcome_unknown has a query-only reconciliation path and no Undo", () => {
  const state = createInitialState();
  const id = "run_calendar_publish_attempt_02";
  const run = findById(state, "runs", id);
  assert.equal(run.undoAllowed, false);
  assert.throws(() => undoActionMutation(state, { kind: "run_reconcile", undoable: false }), /cannot be undone/);

  const querying = startReconciliation(state, id);
  assert.equal(findById(querying, "runs", id).status, "outcome_unknown");
  assert.equal(findById(querying, "runs", id).reconciliation, "querying");
  const verified = verifyReconciliation(querying, id);
  assert.equal(findById(verified, "runs", id).status, "succeeded");
  assert.equal(findById(verified, "evidence", "evidence_calendar_provider_query").integrity, "verified");
});

test("visibility, consent, and participants are explicit on supervised objects", () => {
  const state = createInitialState();
  for (const object of [...state.decisions, ...state.runs, ...state.candidates]) {
    assert.ok(object.visibility);
    assert.ok(object.consent);
  }
  assert.deepEqual(findById(state, "runs", "run_calendar_publish_attempt_02").participantIds, ["participant_later", "agent_zhuri"]);
});
