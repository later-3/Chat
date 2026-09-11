import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLongAgentActivity } from "../../src/long-agents/activity.ts";
import {
  commentOnLongAgentPost,
  listLongAgentFeed,
  publishLongAgentPost,
} from "../../src/long-agents/social.ts";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-activity-social-"));
  const chatHome = path.join(base, ".chat");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { chatHome };
}

function writeSession(chatHome, sessionFile, date, { turns, input, output, tools }) {
  const dir = path.join(chatHome, "long-agents", "nexus", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", id: sessionFile, timestamp: `${date}T00:00:00.000Z` })];
  for (const turnId of turns) {
    lines.push(JSON.stringify({ type: "custom", timestamp: `${date}T01:00:00.000Z`, data: { turnId, status: "completed" } }));
  }
  lines.push(JSON.stringify({
    type: "message",
    timestamp: `${date}T01:05:00.000Z`,
    message: { role: "assistant", provider: "p", model: "m", usage: { input, output, totalTokens: input + output } },
  }));
  for (const name of tools) {
    lines.push(JSON.stringify({ type: "message", timestamp: `${date}T01:06:00.000Z`, message: { role: "toolResult", toolName: name } }));
  }
  fs.writeFileSync(path.join(dir, `${sessionFile}.jsonl`), `${lines.join("\n")}\n`);
}

test("activity is derived from the Agent's own sessions per day", async (t) => {
  const { chatHome } = fixture(t);
  writeSession(chatHome, "s-1", "2026-09-10", { turns: ["t1", "t2"], input: 100, output: 20, tools: ["memory_search", "memory_search", "channel_send"] });
  writeSession(chatHome, "s-2", "2026-09-11", { turns: ["t3"], input: 50, output: 10, tools: ["workflow_call"] });

  const activity = await buildLongAgentActivity({ chatHome, longAgentId: "nexus", from: "2026-09-09", to: "2026-09-12" });
  assert.deepEqual(activity.days.map((day) => day.date), ["2026-09-10", "2026-09-11"]);
  const first = activity.days[0];
  assert.equal(first.turns, 2);
  assert.equal(first.tokens.input, 100);
  assert.equal(first.tokens.output, 20);
  assert.equal(first.tokens.total, 120);
  assert.deepEqual(first.tools, [{ name: "memory_search", count: 2 }, { name: "channel_send", count: 1 }]);
  assert.deepEqual(first.models, ["p/m"]);

  const windowed = await buildLongAgentActivity({ chatHome, longAgentId: "nexus", from: "2026-09-11", to: "2026-09-11" });
  assert.deepEqual(windowed.days.map((day) => day.date), ["2026-09-11"]);
});

test("social feed stores posts and comments with cross-Agent visibility", async (t) => {
  const { chatHome } = fixture(t);
  const post = await publishLongAgentPost({ chatHome, longAgentId: "nexus", text: "今天把任务链路打通了", date: "2026-09-11" });
  const other = await publishLongAgentPost({ chatHome, longAgentId: "architecture-muse", text: "完成架构评审", date: "2026-09-11" });

  const feed = await listLongAgentFeed({ chatHome });
  assert.equal(feed.length, 2, "默认可见全部长期同事的动态");
  assert.deepEqual(feed.map((item) => item.longAgentId).sort(), ["architecture-muse", "nexus"]);

  const commented = await commentOnLongAgentPost({ chatHome, longAgentId: "architecture-muse", postId: post.id, text: "建议补一个回归测试" });
  assert.equal(commented.comments.length, 1);
  assert.equal(commented.comments[0].longAgentId, "architecture-muse");

  const refetched = await listLongAgentFeed({ chatHome, longAgentId: "nexus" });
  assert.equal(refetched[0].comments[0].text, "建议补一个回归测试");
  assert.equal((await listLongAgentFeed({ chatHome, from: "2026-09-12" })).length, 0);
  assert.equal(other.comments.length, 0);

  await assert.rejects(commentOnLongAgentPost({ chatHome, longAgentId: "nexus", postId: "post-missing", text: "hi" }), /找不到动态/);
  await assert.rejects(publishLongAgentPost({ chatHome, longAgentId: "nexus", text: "   " }), /不能为空/);
});
