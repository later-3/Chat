import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import type { SessionQueryEngine, SessionRecord } from "@deepseek-ai/dsh-session-query";
import {
  DshSessionHistoryAccessError,
  DshSessionQueryHistory,
} from "../src/dsh-session-history.ts";

const header = {
  version: 0,
  id: "dsh-history-1",
  createdAt: 1_787_078_400_000,
  cwd: "/workspace/chat",
} as unknown as SessionHeader;

const largeText = "完整正文".repeat(30_000);
const events = [
  { type: "turn/start", seq: 0, time: 1_787_078_400_001, data: { turn: 0 } },
  {
    type: "user/message",
    seq: 1,
    time: 1_787_078_400_002,
    data: {
      id: "dsh-message-1",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: largeText }],
    },
  },
  { type: "turn/end", seq: 2, time: 1_787_078_400_003, data: { turn: 0 } },
] as unknown as SessionEvent[];

function query(options?: {
  readonly records?: readonly SessionRecord[];
  readonly observedHeader?: SessionHeader;
}): SessionQueryEngine {
  const observedHeader = options?.observedHeader ?? header;
  return {
    filterSessions: async () =>
      options?.records ?? [{ header: observedHeader, live: false, persisted: true }],
    readSession: async () => ({ session: observedHeader, events }),
    readTitle: async () => ({
      title: "历史会话",
      messageSeqs: [1],
      source: { kind: "fallback" },
      eventSeq: 3,
      updatedAt: 1_787_078_400_004,
    }),
  } as unknown as SessionQueryEngine;
}

test("SessionQuery adapter reads persisted history and preserves full event payloads", async () => {
  const history = new DshSessionQueryHistory(query(), "/workspace/chat", () => ["dsh-history-1"]);
  await history.assertAccessible("dsh-history-1");
  const description = await history.describe("dsh-history-1");
  assert.equal(description.title, "历史会话");
  assert.equal(description.live, false);
  assert.equal(description.persisted, true);
  assert.equal(description.archived, true);
  assert.equal(description.eventCount, 3);
  assert.equal(description.lastEventSeq, 2);

  const first = await history.readEvents("dsh-history-1", undefined, 2);
  assert.deepEqual(
    first.items.map((event) => event.seq),
    [0, 1],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.nextAfterSeq, 1);
  const user = first.items[1] as (typeof events)[number];
  assert.equal(JSON.stringify(user).includes(largeText), true);

  const second = await history.readEvents("dsh-history-1", first.nextAfterSeq, 2);
  assert.deepEqual(
    second.items.map((event) => event.seq),
    [2],
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextAfterSeq, undefined);
});

test("access checks stay header-only so Chat paging does not replay a long DSH log", async () => {
  let reads = 0;
  const lightweight = {
    filterSessions: async () => [{ header, live: false, persisted: true }],
    readSession: async () => {
      reads += 1;
      return { session: header, events };
    },
    readTitle: async () => undefined,
  } as unknown as SessionQueryEngine;
  const history = new DshSessionQueryHistory(lightweight, "/workspace/chat", () => []);

  await history.assertAccessible("dsh-history-1");
  assert.equal(reads, 0);
  await history.describe("dsh-history-1");
  assert.equal(reads, 1);
});

test("SessionQuery adapter fails closed for missing and cross-workspace sessions", async () => {
  const missing = new DshSessionQueryHistory(query({ records: [] }), "/workspace/chat", () => []);
  await assert.rejects(
    missing.assertAccessible("dsh-history-1"),
    (error) =>
      error instanceof DshSessionHistoryAccessError &&
      error.status === 404 &&
      error.code === "lifeos_dsh_session_not_found",
  );

  const foreignHeader = { ...header, cwd: "/workspace/foreign" } as SessionHeader;
  const foreign = new DshSessionQueryHistory(
    query({ observedHeader: foreignHeader }),
    "/workspace/chat",
    () => [],
  );
  await assert.rejects(
    foreign.readEvents("dsh-history-1", undefined, 50),
    (error) =>
      error instanceof DshSessionHistoryAccessError &&
      error.status === 403 &&
      error.code === "lifeos_dsh_session_forbidden",
  );
});

test("SessionQuery adapter honors caller cancellation even when the provider already settled", async () => {
  const history = new DshSessionQueryHistory(query(), "/workspace/chat", () => []);
  const abort = new AbortController();
  abort.abort(new DOMException("superseded", "AbortError"));
  await assert.rejects(history.describe("dsh-history-1", abort.signal), {
    name: "AbortError",
  });
});
