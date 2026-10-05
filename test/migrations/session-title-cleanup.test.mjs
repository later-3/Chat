import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { migrateSessionTitleCleanup } from "../../src/migrations/session-title-cleanup.ts";

async function json(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("历史系统占位名被清空，用户命名的标题保留", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-title-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = resolve(root, "workspace");
  await mkdir(cwd, { recursive: true });

  const agentId = "friend";
  const projectId = "lab";
  const sessionDir = resolve(root, "long-agents", agentId, "projects", projectId, "sessions");
  const workspaceSessions = resolve(root, "long-agents", agentId, "projects", agentId, "sessions");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceSessions, { recursive: true });

  const makeSession = (dir, id, firstUser, title) => {
    const created = SessionManager.create(cwd, dir, { id });
    created.appendMessage({ role: "user", content: firstUser, timestamp: Date.now() });
    if (title !== undefined) created.appendSessionInfo(title);
    created.flush();
    return created.getSessionFile();
  };

  // 系统占位名（项目会话）→ 应清空
  const placeholderId = "01a10000-0000-7000-8000-000000000001";
  const placeholderFile = makeSession(sessionDir, placeholderId, "帮我看看这个仓库", "Friend · Lab · 新会话");
  // 用户自己命名的会话 → 保留
  const userNamedId = "01a10000-0000-7000-8000-000000000002";
  const userNamedFile = makeSession(sessionDir, userNamedId, "另一个问题", "用户自己定的主题");
  // 每日会话的日期名（workspace 项目）→ 应清空
  const dailyId = "01a10000-0000-7000-8000-000000000003";
  const dailyFile = makeSession(workspaceSessions, dailyId, "今天聊了会话标题", "Friend · 2026-10-04");

  await json(resolve(root, "long-agents.json"), {
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{ id: agentId, name: "Friend", defaultProjectId: agentId, enabled: true, instanceId: "local" }],
  });
  await json(resolve(root, "projects", "registry.json"), {
    schemaVersion: 1,
    projects: [{ projectId, path: cwd, kind: "project", cachedName: "Lab" }],
  });
  await json(resolve(root, "runtime", "long-agent-state.json"), {
    schemaVersion: 1,
    dailySessions: [{ longAgentId: agentId, date: "2026-10-04", timeZone: "UTC", sessionId: dailyId, createdAt: "2026-10-04T00:00:00.000Z", summary: { status: "pending" } }],
    additionalSessions: [],
    projectSessions: [{ longAgentId: agentId, projectId, sessionId: placeholderId, kind: "independent", requestId: "r1", createdAt: "2026-10-04T00:00:00.000Z" }],
    works: [],
    turns: [], nodeSessions: [], projectAgents: [],
  });

  const first = await migrateSessionTitleCleanup(root);
  assert.equal(first.cleared, 2, "两个系统占位名被清空");
  assert.equal(first.kept, 1, "用户命名的标题不动");
  assert.equal(SessionManager.open(placeholderFile, sessionDir).getSessionName(), undefined);
  assert.equal(SessionManager.open(dailyFile, workspaceSessions).getSessionName(), undefined);
  assert.equal(SessionManager.open(userNamedFile, sessionDir).getSessionName(), "用户自己定的主题");

  // 幂等：第二次运行不再改动任何会话。
  const second = await migrateSessionTitleCleanup(root);
  assert.equal(second.completedAt, first.completedAt, "marker 使第二轮成为 no-op");
  assert.equal(JSON.parse(await readFile(resolve(root, "migrations", "session-title-cleanup-v1.json"), "utf8")).cleared, 2);
});
