import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { createProjectSession } from "../../src/long-agents/project-sessions.ts";
import { ensureProjectLongAgent } from "../../src/long-agents/project-agent.ts";
import { resolveProjectContext } from "../../src/projects/registry.ts";
import { removeChatSession } from "../../src/session-removal.ts";
import { searchChatSessions } from "../../src/session-search.ts";

/** 把一条 user 消息写进指定会话，供全文搜索命中。 */
function appendUserMessage(sessionDir, sessionId, text) {
  const fileName = fs.readdirSync(sessionDir).find((name) => name.includes(sessionId));
  const manager = SessionManager.open(path.join(sessionDir, fileName), sessionDir);
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  manager.flush();
}

async function setup(t) {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({
    ...registry,
    agents: registry.agents.map((agent) => agent.id === "friend" ? { ...agent, boundProjectIds: ["friend", "a"] } : agent),
  }, f.home);
  return f;
}

test("会话搜索覆盖范围、创建日期与全文关键词", async (t) => {
  const f = await setup(t);
  const projectSession = await createProjectSession({
    chatHome: f.home, longAgentId: "friend", projectId: "a", requestId: "search-project", kind: "independent",
  });
  const projectDir = (await resolveProjectContext("a", f.home, { ownerLongAgentId: "friend" })).sessionDir;
  appendUserMessage(projectDir, projectSession.binding.sessionId, "部署流水线里的回滚策略");

  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const daily = await ensureProjectLongAgent({ chatHome: f.home, agent, projectId: "friend" });
  const homeDir = (await resolveProjectContext("friend", f.home)).sessionDir;
  appendUserMessage(homeDir, daily.day.sessionId, "每日复盘里的熔断阈值");

  // 范围＝当前项目：只命中该项目下的会话
  const inProject = await searchChatSessions({ chatHome: f.home, scope: "project", projectId: "a", query: "回滚策略" });
  assert.deepEqual(inProject.map((item) => item.sessionId), [projectSession.binding.sessionId]);
  assert.equal(inProject[0]?.projectId, "a");
  assert.equal(inProject[0]?.ownerLongAgentId, "friend");
  assert.equal(inProject[0]?.state, "active");
  assert.match(inProject[0]?.snippet ?? "", /回滚策略/);
  assert.equal((await searchChatSessions({ chatHome: f.home, scope: "project", projectId: "a", query: "熔断阈值" })).length, 0, "范围外的会话不命中");

  // 范围＝该 Long Agent 的全部项目：Agent Home 会话也命中
  const inAgent = await searchChatSessions({ chatHome: f.home, scope: "agent", ownerLongAgentId: "friend", query: "熔断阈值" });
  assert.deepEqual(inAgent.map((item) => item.sessionId), [daily.day.sessionId]);

  // 范围＝全部会话：两种归属都能被检索到
  assert.equal((await searchChatSessions({ chatHome: f.home, scope: "all", query: "回滚策略" })).length, 1);
  assert.equal((await searchChatSessions({ chatHome: f.home, scope: "all", query: "熔断阈值" })).length, 1);

  // 创建日期：区间之外为空
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  assert.equal((await searchChatSessions({ chatHome: f.home, scope: "all", query: "回滚策略", createdFrom: tomorrow })).length, 0);
  assert.equal((await searchChatSessions({ chatHome: f.home, scope: "all", query: "回滚策略", createdTo: tomorrow })).length, 1);

  // 标题也可作为关键词
  assert.equal((await searchChatSessions({ chatHome: f.home, scope: "project", projectId: "a", query: "回滚" })).length, 1);
});

test("已移除的会话按 includeRemoved 进入搜索结果", async (t) => {
  const f = await setup(t);
  const created = await createProjectSession({
    chatHome: f.home, longAgentId: "friend", projectId: "a", requestId: "search-removed", kind: "independent",
  });
  const dir = (await resolveProjectContext("a", f.home, { ownerLongAgentId: "friend" })).sessionDir;
  appendUserMessage(dir, created.binding.sessionId, "这条会被移除但可搜索");
  await removeChatSession("a", created.binding.sessionId, f.home);

  const activeOnly = await searchChatSessions({ chatHome: f.home, scope: "project", projectId: "a", query: "会被移除" });
  assert.equal(activeOnly.length, 0, "默认不包含移除区的会话");
  const withRemoved = await searchChatSessions({ chatHome: f.home, scope: "project", projectId: "a", query: "会被移除", includeRemoved: true });
  assert.equal(withRemoved.length, 1);
  assert.equal(withRemoved[0]?.state, "removed");
  assert.equal(withRemoved[0]?.sessionId, created.binding.sessionId);
});
