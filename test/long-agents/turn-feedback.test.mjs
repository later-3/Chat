import assert from "node:assert/strict";
import test from "node:test";
import { createRouter } from "nitro/h3";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { drainLongAgentTurns, acceptLongAgentTurn } from "../../src/long-agents/turn-queue.ts";
import { readFriendFeedback } from "../../src/long-agents/turn-feedback.ts";
import { getLiveTurn } from "../../src/long-agents/live-turn.ts";
import { steerFriendTurn } from "../../src/long-agents/turn-controls.ts";
import { openChatSession } from "../../src/chat-session.ts";
import accept from "../../src/routes/api/long-agents/[longAgentId]/turns.post.ts";
import status from "../../src/routes/api/long-agents/[longAgentId]/turns/[turnId].get.ts";
import events from "../../src/routes/api/long-agents/[longAgentId]/turns/[turnId]/events.get.ts";
import cancel from "../../src/routes/api/long-agents/[longAgentId]/turns/[turnId].delete.ts";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) {
    const v = await check();
    if (v) return v;
    await delay(10);
  }
  throw Error("condition timed out");
}
async function setup(t) {
  const f = await fixture(t);
  const previous = process.env.CHAT_HOME;
  process.env.CHAT_HOME = f.home;
  t.after(() => {
    if (previous === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previous;
  });
  const router = createRouter();
  const base = "/api/long-agents/:longAgentId/turns";
  router.post(base, accept);
  router.get(base + "/:turnId", status);
  router.get(base + "/:turnId/events", events);
  router.delete(base + "/:turnId", cancel);
  const post = (body) =>
    router.fetch(
      new Request("http://chat.test/api/long-agents/friend/turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, contextProjectId: "a", ...body }),
      }),
    );
  const url = (id) => "http://chat.test/api/long-agents/friend/turns/" + encodeURIComponent(id);
  return { ...f, router, post, url };
}
function stream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  return (text, end = false) => {
    res.write(
      `data: ${JSON.stringify({ id: "live", object: "chat.completion.chunk", model: "daily-model", choices: [{ index: 0, delta: { content: text }, finish_reason: end ? "stop" : null }] })}\n\n`,
    );
    if (end) res.end("data: [DONE]\n\n");
  };
}

test("P4 accepted HTTP returns before model; native deltas, bounded reset, reconnect and completion", async (t) => {
  const f = await setup(t);
  let send;
  f.setHandler((_body, res) => {
    send = stream(res);
    return undefined;
  });
  const response = await f.post({ requestId: "stream", text: "stream" });
  assert.equal(response.status, 202);
  const ref = await response.json();
  await until(() => send);
  send("First");
  await until(() => getLiveTurn(f.home, ref.id)?.partial);
  let feedback = await readFriendFeedback(f.home, "friend", ref.id);
  assert.equal(feedback.execution.status, "running");
  assert.match(JSON.stringify(feedback.snapshot.partial), /First/);
  const r = await f.router.fetch(new Request(f.url(ref.id) + "/events?after=0"));
  const reader = r.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /agent_event/);
  await reader.cancel();
  assert.equal((await readLongAgentState(f.home)).turns[0].status, "running", "browser detachment does not cancel");
  for (let i = 0; i < 280; i++) {
    send("x");
    await delay(2);
  }
  await until(() => getLiveTurn(f.home, ref.id).seq > 256);
  const replay = await f.router.fetch(new Request(f.url(ref.id) + "/events?after=0"));
  const rr = replay.body.getReader();
  assert.match(new TextDecoder().decode((await rr.read()).value), /"type":"reset"/);
  await rr.cancel();
  send("Final", true);
  await drainLongAgentTurns(f.home, "friend");
  feedback = await readFriendFeedback(f.home, "friend", ref.id);
  assert.equal(feedback.execution.status, "completed");
  assert.match(JSON.stringify(feedback.snapshot.messages), /Firstx+Final/);
  const duplicate = await (await f.post({ requestId: "stream", text: "stream" })).json();
  assert.equal(duplicate.id, ref.id);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.post({ requestId: "stream", text: "different" })).status, 409);
  assert.equal((await f.router.fetch(new Request(f.url(ref.id).replace("/friend/", "/other/")))).status, 404);
});

test("P4 cancellation persists separately from failure; accepted follow-up continues in same daily Session", async (t) => {
  const f = await setup(t);
  let send;
  f.setHandler((body, res) => {
    if (f.requests.length === 1) {
      send = stream(res);
      send("working");
      return undefined;
    }
    return { content: "FOLLOW_UP_DONE" };
  });
  const first = await (await f.post({ requestId: "first", text: "first" })).json();
  await until(() => send);
  const second = await (await f.post({ requestId: "second", text: "follow up", contextProjectId: "b" })).json();
  assert.equal(second.sessionId, first.sessionId);
  const response = await f.router.fetch(new Request(f.url(first.id), { method: "DELETE" }));
  assert.equal(response.status, 200);
  await drainLongAgentTurns(f.home, "friend");
  const turns = (await readLongAgentState(f.home)).turns;
  assert.equal(turns[0].status, "cancelled");
  assert.equal(turns[1].status, "completed");
  assert.equal((await f.router.fetch(new Request(f.url(first.id), { method: "DELETE" }))).status, 200);
  const snapshot = await readFriendFeedback(f.home, "friend", second.id);
  assert.match(JSON.stringify(snapshot.snapshot.messages), /FOLLOW_UP_DONE/);
});

test("P4 native steering is durable and delivered once; cross-project steering rejected; late guidance becomes follow-up", async (t) => {
  const f = await setup(t);
  let send;
  f.setHandler((body, res) => {
    if (f.requests.length === 1) {
      send = stream(res);
      send("working");
      return undefined;
    }
    return { content: "GUIDANCE_DONE" };
  });
  const first = await (await f.post({ requestId: "first", text: "first" })).json();
  await until(() => send);
  await assert.rejects(
    steerFriendTurn(f.home, "friend", first.id, { requestId: "bad", text: "bad", contextProjectId: "b" }),
    /同一项目/,
  );
  const guidance = { requestId: "guide", text: "Please add GUIDANCE", contextProjectId: "a" };
  assert.equal((await steerFriendTurn(f.home, "friend", first.id, guidance)).delivery, "steer");
  await steerFriendTurn(f.home, "friend", first.id, guidance);
  send("end", true);
  await drainLongAgentTurns(f.home, "friend");
  const turns = (await readLongAgentState(f.home)).turns;
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t) => t.status === "completed"));
  assert.equal(f.requests.length, 2);
  const session = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: first.sessionId });
  assert.equal(
    session.manager
      .getEntries()
      .filter((e) => e.type === "custom_message" && e.customType === "chat.friend-steering.v1").length,
    1,
  );
  assert.match(JSON.stringify(f.requests[1].messages), /GUIDANCE/);
  const late = await steerFriendTurn(f.home, "friend", first.id, {
    requestId: "late",
    text: "late",
    contextProjectId: "a",
  });
  assert.equal(late.delivery, "followUp");
  await drainLongAgentTurns(f.home, "friend");
  assert.equal(f.requests.length, 3);
});

test("P4 provider failure retains terminal error and original messages; images rejected before Web acceptance", async (t) => {
  const f = await setup(t);
  f.setHandler(() => ({ error: "provider test rejection" }));
  const ref = await (await f.post({ requestId: "failed", text: "fail" })).json();
  await drainLongAgentTurns(f.home, "friend");
  const feedback = await readFriendFeedback(f.home, "friend", ref.id);
  assert.equal(feedback.execution.status, "failed");
  assert.match(feedback.execution.error, /provider test rejection/);
  const invalid = await f.post({
    requestId: "image",
    text: "image",
    images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
  });
  assert.equal(invalid.status, 400);
  assert.equal((await readLongAgentState(f.home)).turns.length, 1);
});
