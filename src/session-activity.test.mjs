import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "./projects/registry.ts";
import {
  assertChatSessionIsIdle,
  reconcileStaleChatSessionRuns,
} from "./session-activity.ts";
import { SessionLifecycleError } from "./session-errors.ts";
import { removeChatSession } from "./session-removal.ts";
import {
  beginSessionExecution,
  endSessionExecution,
  getSessionExecution,
} from "./workflows/execution-registry.ts";
import {
  bindPlanningExecutionRun,
  findActivePlanningExecutionRun,
  getPlanningExecutionRun,
  planSha256,
  publishPlanReviewState,
} from "./workflows/planning-execution/review-state.ts";
import { recordChatSessionRunBinding } from "./workflows/session-run-registry.ts";

async function fixture(t, id = "session-activity") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-activity-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(base, "chat-home");
  const project = await openProject({ path: workspace, chatHome, id, name: "Session Activity" });
  const manager = SessionManager.create(workspace, project.sessionDir);
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  manager.flush();
  return { base, workspace, chatHome, project, manager };
}

function review(overrides = {}) {
  const plan = overrides.plan ?? "stale plan";
  return {
    schemaVersion: 1,
    workflowId: "planning-execution",
    stageId: "review",
    reviewId: `${overrides.workflowInvocationId ?? "stale-invocation"}:1:review`,
    workflowInvocationId: overrides.workflowInvocationId ?? "stale-invocation",
    sessionId: overrides.sessionId ?? "session-1",
    planRevision: 1,
    planSha256: planSha256(plan),
    planEntryId: "plan-entry-1",
    plan,
    readiness: "ready_for_review",
    blockingQuestions: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Rewinds a run record's updatedAt into the past to simulate a crash-era zombie. */
function ageRunRecord(projectDataDir, workflowInvocationId, ageMs) {
  const recordPath = path.join(
    projectDataDir,
    "workflow-runs",
    "planning-execution",
    `${workflowInvocationId}.json`,
  );
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.updatedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function ageRunBinding(projectDataDir, workflowInvocationId, ageMs) {
  const binding = await recordChatSessionRunBinding(projectDataDir, {
    runId: "wrun_stale",
    workflowInvocationId,
    workflowId: "planning-execution",
    projectId: "project-1",
    sessionId: "session-1",
  });
  const bindingPath = path.join(projectDataDir, "workflows", "runs", `${workflowInvocationId}.json`);
  const value = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
  value.startedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(bindingPath, `${JSON.stringify(value, null, 2)}\n`);
  return binding;
}

test("execution registry registers, reports, and clears one execution per session", () => {
  assert.equal(getSessionExecution("session-registry"), undefined);
  beginSessionExecution("session-registry", "memory", "invocation-1");
  assert.deepEqual(getSessionExecution("session-registry"), {
    workflowId: "memory",
    workflowInvocationId: "invocation-1",
    startedAt: getSessionExecution("session-registry")?.startedAt,
  });
  // 只清除自己那次执行，防止迟到的 finally 误清新登记
  endSessionExecution("session-registry", "invocation-other");
  assert.notEqual(getSessionExecution("session-registry"), undefined);
  endSessionExecution("session-registry", "invocation-1");
  assert.equal(getSessionExecution("session-registry"), undefined);
});

test("a live in-process execution blocks Session removal", async (t) => {
  const { project, manager } = await fixture(t, "session-activity-live");
  const sessionId = manager.getSessionId();
  beginSessionExecution(sessionId, "planning-execution", "live-invocation");
  t.after(() => endSessionExecution(sessionId, "live-invocation"));
  await assert.rejects(
    assertChatSessionIsIdle(project, sessionId),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_BUSY",
  );
  endSessionExecution(sessionId, "live-invocation");
  await assertChatSessionIsIdle(project, sessionId);
});

test("a fresh non-terminal record stays conservative within the grace window", async (t) => {
  const { project, manager } = await fixture(t, "session-activity-fresh");
  const sessionId = manager.getSessionId();
  await bindPlanningExecutionRun({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowInvocationId: "fresh-invocation",
    runId: "wrun_fresh",
    sessionId,
  });
  await assert.rejects(
    assertChatSessionIsIdle(project, sessionId),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_BUSY",
  );
  assert.equal(fs.existsSync(manager.getSessionFile()), true);
});

test("a stale zombie record reconciles to failed and unblocks Session removal", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-activity-zombie");
  const sessionId = manager.getSessionId();
  await bindPlanningExecutionRun({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowInvocationId: "zombie-invocation",
    runId: "wrun_zombie",
    sessionId,
  });
  ageRunRecord(project.projectDataDir, "zombie-invocation", 60_000);
  await ageRunBinding(project.projectDataDir, "zombie-invocation", 60_000);

  // Runtime 不认识僵尸 runId：cancel 静默容错，但账本必须收敛到终态
  await reconcileStaleChatSessionRuns(project, sessionId);
  const record = await getPlanningExecutionRun(project.projectDataDir, "zombie-invocation");
  assert.equal(record?.phase, "failed");
  assert.equal(await findActivePlanningExecutionRun(project.projectDataDir, sessionId), undefined);

  // 对账后删除放行
  await removeChatSession(project.projectId, sessionId, chatHome);
  assert.equal(fs.existsSync(manager.getSessionFile()), false);
});

test("a stale waiting_review record is resumable and must not be reconciled away", async (t) => {
  const { project, manager } = await fixture(t, "session-activity-review");
  const sessionId = manager.getSessionId();
  await bindPlanningExecutionRun({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowInvocationId: "review-invocation",
    runId: "wrun_review",
    sessionId,
  });
  await publishPlanReviewState({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    review: review({ workflowInvocationId: "review-invocation", sessionId }),
  });
  ageRunRecord(project.projectDataDir, "review-invocation", 60_000);

  await assert.rejects(
    assertChatSessionIsIdle(project, sessionId),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_BUSY",
  );
  const record = await getPlanningExecutionRun(project.projectDataDir, "review-invocation");
  assert.equal(record?.phase, "waiting_review");
  assert.equal(fs.existsSync(manager.getSessionFile()), true);
});
