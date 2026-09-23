import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inheritSessionMemoryTarget,
  sessionMemoryTargetForToolContext,
} from "../../src/workflows/session-memory-target.ts";
import { readChatSessionRunBinding, recordChatSessionRunBinding } from "../../src/workflows/session-run-registry.ts";

test("P2 pre-req: the workflow session-memory target is derived from the trusted context only", () => {
  // An agent-home session (storage project == long agent id) qualifies.
  assert.deepEqual(
    sessionMemoryTargetForToolContext({ projectId: "friend", longAgentId: "friend", sessionId: "s1" }),
    { storageProjectId: "friend", sessionId: "s1" },
  );
  // An ordinary project session never gains agent-home memory access.
  assert.equal(sessionMemoryTargetForToolContext({ projectId: "a", sessionId: "s1" }), undefined);
  assert.equal(sessionMemoryTargetForToolContext({ projectId: "a", longAgentId: "friend", sessionId: "s1" }), undefined);
  // A nested call keeps the original target instead of re-stamping the intermediate session.
  const inherited = { storageProjectId: "friend", sessionId: "origin" };
  assert.deepEqual(
    sessionMemoryTargetForToolContext({ sessionMemoryTarget: inherited, projectId: "proj", longAgentId: "other", sessionId: "child" }),
    inherited,
  );
});

test("P2 pre-req: a workflow agent inherits the target from the durable run binding", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-smem-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { storageProjectId: "friend", sessionId: "origin-session" };
  await recordChatSessionRunBinding(dir, {
    runId: "run-1", workflowInvocationId: "inv-1", workflowId: "session-memory",
    projectId: "friend", sessionId: "origin-session", sessionMemoryTarget: target,
  });
  assert.deepEqual(await readChatSessionRunBinding(dir, "inv-1").then((binding) => binding?.sessionMemoryTarget), target);
  // The agent inherits it when its own context has none; an explicit target always wins.
  assert.deepEqual(await inheritSessionMemoryTarget({ projectDataDir: dir, workflowInvocationId: "inv-1" }), target);
  assert.deepEqual(
    await inheritSessionMemoryTarget({ toolContextTarget: { storageProjectId: "x", sessionId: "y" }, projectDataDir: dir, workflowInvocationId: "inv-1" }),
    { storageProjectId: "x", sessionId: "y" },
  );
  // No binding / no context resolves to nothing (fail closed, never a guessed session).
  assert.equal(await inheritSessionMemoryTarget({ projectDataDir: dir, workflowInvocationId: "missing" }), undefined);
  assert.equal(await inheritSessionMemoryTarget({ projectDataDir: undefined, workflowInvocationId: "inv-1" }), undefined);
  assert.equal(await inheritSessionMemoryTarget({ projectDataDir: dir, workflowInvocationId: undefined }), undefined);
});

test("P2 pre-req: a malformed binding target is rejected instead of being trusted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-smem-bad-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "workflows", "runs", "inv-bad.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, runId: "r", workflowInvocationId: "inv-bad", workflowId: "w",
    projectId: "friend", sessionId: "s", startedAt: new Date().toISOString(),
    sessionMemoryTarget: { storageProjectId: "friend" },
  }));
  await assert.rejects(readChatSessionRunBinding(dir, "inv-bad"), /sessionMemoryTarget无效/);
});
