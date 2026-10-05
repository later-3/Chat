import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, readLongAgentState, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { createProjectSession, listProjectSessions } from "../../src/long-agents/project-sessions.ts";
import { ensureProjectLongAgent } from "../../src/long-agents/project-agent.ts";
import { listRemovedChatSessions, purgeRemovedChatSession, removeChatSession, restoreRemovedChatSession } from "../../src/session-removal.ts";
import { resolveProjectContext } from "../../src/projects/registry.ts";

/** 第二层会话管理：Long Agent 在绑定项目里的会话，必须与普通会话走同一套移除/恢复/永久删除。 */
test("Long Agent 项目会话的移除、恢复与永久删除使用同一套生命周期", async (t) => {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({
    ...registry,
    agents: registry.agents.map((agent) => agent.id === "friend" ? { ...agent, boundProjectIds: ["friend", "a", "b"] } : agent),
  }, f.home);

  const created = await createProjectSession({
    chatHome: f.home, longAgentId: "friend", projectId: "a", requestId: "removal-round-trip", kind: "independent",
  });
  const sessionId = created.binding.sessionId;
  const sessionDir = (await resolveProjectContext("a", f.home, { ownerLongAgentId: "friend" })).sessionDir;
  const fileName = fs.readdirSync(sessionDir).find((name) => name.includes(sessionId));
  const manager = SessionManager.open(path.join(sessionDir, fileName), sessionDir);
  manager.appendMessage({ role: "user", content: "要移除的项目会话", timestamp: Date.now() });
  manager.flush();

  // 移除：文件进入该 Agent 项目树下的移除区（位置即归属）
  const removed = await removeChatSession("a", sessionId, f.home);
  assert.equal(removed.id, sessionId);
  assert.equal(fs.existsSync(path.join(sessionDir, "removed")), true, "移除区位于该会话所属的存储根");
  assert.equal((await listProjectSessions(f.home, "friend", "a")).some((item) => item.sessionId === sessionId), false, "移除后不再出现在活动列表");

  // 移除区列表面向“项目”：合并共享目录与该 Agent 项目树
  const listed = await listRemovedChatSessions("a", f.home);
  assert.equal(listed.sessions.some((item) => item.id === sessionId), true, "项目的移除区能看到该会话");

  // 绑定记录保留，供恢复识别
  const state = await readLongAgentState(f.home);
  assert.equal(state.projectSessions.some((item) => item.sessionId === sessionId), true, "移除不改写项目归属绑定");

  // 恢复：回到活动目录，绑定自然重新生效
  await restoreRemovedChatSession("a", sessionId, f.home);
  assert.equal((await listProjectSessions(f.home, "friend", "a")).some((item) => item.sessionId === sessionId), true, "恢复后重新出现在项目列表");

  // 永久删除：先移除再清除，之后不可恢复
  await removeChatSession("a", sessionId, f.home);
  await purgeRemovedChatSession("a", sessionId, f.home);
  const afterPurge = await listRemovedChatSessions("a", f.home);
  assert.equal(afterPurge.sessions.some((item) => item.id === sessionId), false, "永久删除后不在移除区");
  await assert.rejects(() => restoreRemovedChatSession("a", sessionId, f.home), /永久删除/);
});

test("每日（Agent Home）会话与项目会话走同一套移除与恢复", async (t) => {
  const f = await fixture(t);
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const day = await ensureProjectLongAgent({ chatHome: f.home, agent, projectId: "friend" });
  const sessionId = day.day.sessionId;

  const removed = await removeChatSession("friend", sessionId, f.home);
  assert.equal(removed.id, sessionId);
  const listed = await listRemovedChatSessions("friend", f.home);
  assert.equal(listed.sessions.some((item) => item.id === sessionId), true, "Agent Home 的移除区同样可见");

  await restoreRemovedChatSession("friend", sessionId, f.home);
  const state = await readLongAgentState(f.home);
  assert.equal(state.dailySessions.some((item) => item.sessionId === sessionId), true, "恢复后每日绑定仍然指向该会话");
});
