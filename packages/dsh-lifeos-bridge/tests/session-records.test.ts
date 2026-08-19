import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionHeader } from "@deepseek-ai/dsh-session";
import type { ChatProductClient } from "../src/chat-client.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import type { DshSessionHistoryPort } from "../src/dsh-session-history.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const timestamp = "2026-08-19T00:00:00.000Z";
const dshHeader = {
  version: 0,
  id: "dsh-records-1",
  createdAt: Date.parse(timestamp),
  cwd: "/workspace/chat",
} as unknown as SessionHeader;
const session = {
  schemaVersion: "chat-product-api.v1",
  sessionId: "psn_records1",
  status: "active",
  title: "完整会话记录",
  revision: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const userMessage = {
  schemaVersion: "chat-product-api.v1",
  messageId: "msg_recordsuser1",
  sessionId: session.sessionId,
  sessionSequence: 1,
  role: "user",
  content: { format: "markdown", text: "完整用户正文" },
  sha256: "a".repeat(64),
  createdAt: timestamp,
} as const;
const assistantMessage = {
  schemaVersion: "chat-product-api.v1",
  messageId: "msg_recordsassistant1",
  sessionId: session.sessionId,
  sessionSequence: 2,
  role: "assistant",
  content: { format: "markdown", text: "完整正式回复" },
  sourceRunId: "run_records1",
  sha256: "b".repeat(64),
  createdAt: timestamp,
} as const;

function history(): DshSessionHistoryPort {
  return {
    assertAccessible: async () => {},
    describe: async () => ({
      header: dshHeader,
      title: "DSH 历史标题",
      live: false,
      persisted: true,
      archived: false,
      eventCount: 2,
      lastEventSeq: 1,
      lastEventAt: Date.parse(timestamp),
    }),
    readEvents: async () => ({
      header: dshHeader,
      items: [
        {
          type: "user/message",
          seq: 1,
          time: Date.parse(timestamp),
          data: {
            id: "dsh-message-1",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "DSH完整原文" }],
          },
        } as never,
      ],
      hasMore: false,
    }),
  };
}

test("unified records compose identities without turning DSH into a Product Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-records-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    await state.mutateSession("dsh-records-1", `cmd_${"c".repeat(48)}`, (binding) => {
      binding.chatSessionId = session.sessionId;
      binding.currentRequestKey = "request-1";
      binding.requests["request-1"] = {
        dshMessageId: "dsh-message-1",
        userTextSha256: "d".repeat(64),
        messageCommandId: `cmd_${"e".repeat(48)}`,
        productUserMessageId: userMessage.messageId,
        productRunId: "run_records1",
        productAssistantMessageId: assistantMessage.messageId,
      };
    });
    const chat = {
      getSession: async () => session,
      getMessages: async () => ({ items: [userMessage, assistantMessage] }),
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state, history());

    const overview = await service.sessionRecordsOverview("dsh-records-1");
    assert.equal(overview.dsh.header.id, "dsh-records-1");
    assert.equal(overview.dsh.persisted, true);
    assert.equal(overview.chat?.sessionId, session.sessionId);
    assert.deepEqual(overview.binding, {
      status: "bound",
      productSessionId: session.sessionId,
      requestCount: 1,
      linkedUserMessageCount: 1,
      linkedAssistantMessageCount: 1,
      currentProductRunId: "run_records1",
    });
    assert.deepEqual(overview.capabilities, {
      continueConversation: true,
      archiveKeepsData: true,
      permanentDelete: false,
    });

    const chatPage = await service.sessionRecordsChatPage("dsh-records-1", undefined, 50);
    assert.equal(chatPage.productSessionId, session.sessionId);
    assert.deepEqual(chatPage.messages.items[0]?.link, {
      dshMessageId: "dsh-message-1",
      productRunId: "run_records1",
    });
    assert.deepEqual(chatPage.messages.items[1]?.link, { productRunId: "run_records1" });
    assert.equal(chatPage.messages.items[1]?.message.content.text, "完整正式回复");

    const dshPage = await service.sessionRecordsDshPage("dsh-records-1", undefined, 50);
    assert.equal(dshPage.items[0]?.type, "user/message");
    assert.match(JSON.stringify(dshPage.items[0]), /DSH完整原文/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a blank DSH draft has no phantom Product Session and returns an empty Chat page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-records-draft-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const inaccessibleChat = new Proxy(
      {},
      {
        get() {
          throw new Error("draft records must not access Chat API");
        },
      },
    ) as ChatProductClient;
    const service = new LifeosBridgeService(inaccessibleChat, state, history());
    const overview = await service.sessionRecordsOverview("dsh-records-1");
    assert.equal(overview.chat, null);
    assert.equal(overview.binding.status, "draft");
    assert.equal(overview.capabilities.continueConversation, true);

    const page = await service.sessionRecordsChatPage("dsh-records-1", undefined, 50);
    assert.deepEqual(page.messages, { items: [] });
    assert.equal(page.productSessionId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an archived DSH attachment remains readable but is not advertised as continuable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-records-archived-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const archivedHistory: DshSessionHistoryPort = {
      ...history(),
      describe: async () => ({ ...(await history().describe("dsh-records-1")), archived: true }),
    };
    const service = new LifeosBridgeService({} as ChatProductClient, state, archivedHistory);
    const overview = await service.sessionRecordsOverview("dsh-records-1");
    assert.equal(overview.dsh.archived, true);
    assert.equal(overview.capabilities.continueConversation, false);
    assert.equal(
      (await service.sessionRecordsDshPage("dsh-records-1", undefined, 50)).items.length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
