import assert from "node:assert/strict";
import test from "node:test";
import { failInterruptedLocalRuns } from "../../src/workflows/local-run-recovery.ts";
import { registerWorkflowAgentAbort, abortWorkflowAgents } from "../../src/workflows/execution-registry.ts";

test("only old running executors fail; queued, review and current paused steps survive", async () => {
  const failed = [];
  const old = { status: "running", startedAt: new Date(10), updatedAt: new Date(10) };
  const steps = { old: [old], review: [], queued: [{ ...old, status: "pending" }], current: [{ ...old, startedAt: new Date(100) }], retried: [{ ...old, updatedAt: new Date(100) }] };
  const world = {
    runs: { list: async () => ({ data: Object.keys(steps).map(runId => ({ runId })), hasMore: false }) },
    steps: { list: async ({ runId }) => ({ data: steps[runId], hasMore: false }) },
    events: { create: async (id, event) => { assert.equal(event.eventType, "run_failed"); assert.match(event.eventData.error.message, /未自动重试/); failed.push(id); } },
  };
  await failInterruptedLocalRuns(world, 50);
  assert.deepEqual(failed, ["old"]);
});
test("recovery never overwrites a concurrent terminal result and does not swallow persistence failure", async () => {
  let status = "completed";
  const world = {
    runs: { list: async () => ({ data: [{ runId: "r" }], hasMore: false }), get: async () => ({ status }) },
    steps: { list: async () => ({ data: [{ status: "running", startedAt: new Date(1), updatedAt: new Date(1) }], hasMore: false }) },
    events: { create: async () => { throw Error("write failed"); } },
  };
  await failInterruptedLocalRuns(world, 10);
  status = "running";
  await assert.rejects(failInterruptedLocalRuns(world, 10), /write failed/);
});
test("cancellation reaches only the selected Run's live Pi sessions and unregisters on finish", async () => {
  let count = 0;
  const unregister = registerWorkflowAgentAbort("one", async () => { count++; });
  await abortWorkflowAgents("another"); assert.equal(count, 0);
  await abortWorkflowAgents("one"); assert.equal(count, 1);
  unregister(); await abortWorkflowAgents("one"); assert.equal(count, 1);
});
