import assert from "node:assert/strict";
import test from "node:test";
import { busyLongAgentIds, withChatSessionOperationLock } from "../../src/session-operation-lock.ts";

test("coworker presence follows all owned operations, including queues and an old daily Session", async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const firstEntered = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  const oldSession = withChatSessionOperationLock("old-day", async () => { firstEntered.resolve(); await first.promise; }, { longAgentId: "nexus" });
  await firstEntered.promise;
  const nextSession = withChatSessionOperationLock("new-day", async () => { secondEntered.resolve(); await second.promise; }, { longAgentId: "nexus" });
  await secondEntered.promise;
  const queued = withChatSessionOperationLock("old-day", async () => { throw new Error("model failed"); }, { longAgentId: "mira" });
  const rejection = assert.rejects(queued, /model failed/);
  assert.deepEqual([...busyLongAgentIds()].sort(), ["mira", "nexus"]);
  first.resolve();
  await oldSession;
  await rejection;
  assert.deepEqual([...busyLongAgentIds()], ["nexus"]);
  second.resolve();
  await nextSession;
  assert.equal(busyLongAgentIds().size, 0);
});
