import assert from "node:assert/strict";
import test from "node:test";
import { SessionRecordsController } from "../src/client/session-records-controller.ts";

const timestamp = "2026-08-19T00:00:00.000Z";
const overview = {
  schemaVersion: "chat-dsh-session-records.v1",
  dsh: {
    header: {
      version: 0,
      id: "dsh-records-1",
      createdAt: Date.parse(timestamp),
      cwd: "/workspace/chat",
    },
    title: "持久化会话",
    live: true,
    persisted: true,
    archived: false,
    eventCount: 2,
    lastEventSeq: 1,
    lastEventAt: Date.parse(timestamp),
  },
  chat: {
    schemaVersion: "chat-product-api.v1",
    sessionId: "psn_records1",
    status: "active",
    title: "正式会话",
    revision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  binding: {
    status: "bound",
    productSessionId: "psn_records1",
    requestCount: 1,
    linkedUserMessageCount: 1,
    linkedAssistantMessageCount: 1,
    currentProductRunId: "run_records1",
  },
  capabilities: {
    continueConversation: true,
    archiveKeepsData: true,
    permanentDelete: false,
  },
} as const;

function chatMessage(sequence: number) {
  return {
    message: {
      schemaVersion: "chat-product-api.v1",
      messageId: `msg_records${String(sequence)}`,
      sessionId: "psn_records1",
      sessionSequence: sequence,
      role: sequence % 2 === 1 ? "user" : "assistant",
      content: { format: "markdown", text: `完整消息 ${String(sequence)}` },
      ...(sequence % 2 === 0 ? { sourceRunId: "run_records1" } : {}),
      sha256: "a".repeat(64),
      createdAt: timestamp,
    },
    link: sequence % 2 === 1 ? { dshMessageId: "dsh-message-1" } : {},
  };
}

function dshEvent(seq: number) {
  return {
    type: seq === 0 ? "turn/start" : "user/message",
    seq,
    time: Date.parse(timestamp) + seq,
    data:
      seq === 0
        ? { turn: 0 }
        : {
            id: "dsh-message-1",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "DSH完整正文" }],
          },
  };
}

test("records controller loads independent sources and advances only server cursors", async () => {
  const requested: string[] = [];
  const controller = new SessionRecordsController("dsh-records-1", async (input) => {
    const url = new URL(String(input), "http://localhost");
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/records")) {
      return new Response(JSON.stringify(overview), { status: 200 });
    }
    if (url.pathname.endsWith("/records/chat")) {
      const cursor = url.searchParams.get("cursor");
      return new Response(
        JSON.stringify({
          schemaVersion: "chat-dsh-session-records.v1",
          dshSessionId: "dsh-records-1",
          productSessionId: "psn_records1",
          messages:
            cursor === null
              ? { items: [chatMessage(1)], nextCursor: "opaque-next" }
              : { items: [chatMessage(2)] },
        }),
        { status: 200 },
      );
    }
    const afterSeq = url.searchParams.get("afterSeq");
    return new Response(
      JSON.stringify({
        schemaVersion: "chat-dsh-session-records.v1",
        dshSessionId: "dsh-records-1",
        header: overview.dsh.header,
        items: [dshEvent(afterSeq === null ? 0 : 1)],
        hasMore: afterSeq === null,
        ...(afterSeq === null ? { nextAfterSeq: 0 } : {}),
      }),
      { status: 200 },
    );
  });

  await controller.refresh();
  assert.equal(controller.getSnapshot().overview?.chat?.sessionId, "psn_records1");
  assert.deepEqual(
    controller.getSnapshot().chat.items.map((item) => item.message.sessionSequence),
    [1],
  );
  assert.deepEqual(
    controller.getSnapshot().dsh.items.map((event) => event.seq),
    [0],
  );

  await Promise.all([controller.loadMoreChat(), controller.loadMoreDsh()]);
  assert.deepEqual(
    controller.getSnapshot().chat.items.map((item) => item.message.sessionSequence),
    [1, 2],
  );
  assert.deepEqual(
    controller.getSnapshot().dsh.items.map((event) => event.seq),
    [0, 1],
  );
  assert.equal(controller.getSnapshot().chat.hasMore, false);
  assert.equal(controller.getSnapshot().dsh.hasMore, false);
  assert.ok(requested.some((path) => path.includes("cursor=opaque-next")));
  assert.ok(requested.some((path) => path.includes("afterSeq=0")));
  controller.dispose();
});

test("one source failure does not erase the other source or the unified overview", async () => {
  const controller = new SessionRecordsController("dsh-records-1", async (input) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/records")) {
      return new Response(JSON.stringify(overview), { status: 200 });
    }
    if (path.endsWith("/records/chat")) {
      return new Response(JSON.stringify({ title: "Chat暂不可用", code: "chat_api_unreachable" }), {
        status: 502,
      });
    }
    return new Response(
      JSON.stringify({
        schemaVersion: "chat-dsh-session-records.v1",
        dshSessionId: "dsh-records-1",
        header: overview.dsh.header,
        items: [dshEvent(0)],
        hasMore: false,
      }),
      { status: 200 },
    );
  });
  await controller.refresh();
  const state = controller.getSnapshot();
  assert.equal(state.overviewStatus, "ready");
  assert.equal(state.chat.status, "error");
  assert.match(state.chat.error ?? "", /chat_api_unreachable/u);
  assert.equal(state.dsh.status, "ready");
  assert.equal(state.dsh.items.length, 1);
  controller.dispose();
});

test("disposing records controller aborts in-flight reads and suppresses late publication", async () => {
  let observedAbort = false;
  const controller = new SessionRecordsController("dsh-records-1", async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  });
  const refresh = controller.refresh();
  controller.dispose();
  await refresh;
  assert.equal(observedAbort, true);
  assert.equal(controller.getSnapshot().overviewStatus, "loading");
});
