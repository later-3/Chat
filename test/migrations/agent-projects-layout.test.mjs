import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { migrateAgentProjectsLayout } from "../../src/migrations/agent-projects-layout.ts";

async function json(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("agent-project layout migration moves agent workspace data and project-session files once", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-agent-projects-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Agent root (old layout): workspace data at top level.
  const agentId = "friend";
  const base = resolve(root, "long-agents", agentId);
  await mkdir(resolve(base, "sessions"), { recursive: true });
  await writeFile(resolve(base, "sessions", "2026-10-03T15-30-51-633Z_01a10263-b671-7f1c-925e-d71b32ce3787.jsonl"), "session\n");
  await mkdir(resolve(base, "sessions", "session-memory"), { recursive: true });
  await writeFile(resolve(base, "sessions", "session-memory", "01a10263-b671-7f1c-925e-d71b32ce3787.json"), "{}\n");
  await mkdir(resolve(base, "days"), { recursive: true });
  await mkdir(resolve(base, "days", "2026-10-03"), { recursive: true });
  await writeFile(resolve(base, "days", "2026-10-03", "summary.md"), "day\n");
  await mkdir(resolve(base, "summaries"), { recursive: true });
  await writeFile(resolve(base, "summaries", "2026-10-03.json"), "{}\n");
  // Agent config files stay at the root (durable workflow config / memory / prompt-resources
  // are the identity layer and do NOT move into the per-agent project tree).
  await writeFile(resolve(base, "definition.json"), "{}\n");
  await mkdir(resolve(base, "memory"), { recursive: true });
  await writeFile(resolve(base, "memory", "catalog.db"), "db\n");

  // User project with a bound agent session (old shared storage).
  await json(resolve(root, "runtime", "long-agent-state.json"), {
    projectSessions: [{ longAgentId: "nexus", projectId: "lab", sessionId: "aabbccdd-1111-2222-3333-444455556666" }],
  });
  await mkdir(resolve(root, "projects", "lab", "sessions", "session-memory"), { recursive: true });
  await writeFile(resolve(root, "projects", "lab", "sessions", "2026-10-02T00-38-12-763Z_aabbccdd-1111-2222-3333-444455556666.jsonl"), "bound\n");
  await writeFile(resolve(root, "projects", "lab", "sessions", "session-memory", "aabbccdd-1111-2222-3333-444455556666.json"), "{}\n");
  // Ordinary project files never move.
  await writeFile(resolve(root, "projects", "lab", "sessions", "2026-09-22T13-50-00-000Z_eeee0000-1111-2222-3333-444455556666.jsonl"), "ordinary\n");
  // A second agent belongs under the project too, stored at the shared dir: its own binding is unknown → untouched.
  await writeFile(resolve(root, "projects", "lab", "meta.json"), "{}\n");

  const first = await migrateAgentProjectsLayout(root);
  assert.ok(first.movedDirs >= 1 || first.movedFiles >= 1);
  assert.equal(first.version, 1);

  const workspaceData = resolve(base, "projects", agentId);
  await assert.rejects(readdir(resolve(base, "sessions")), { code: "ENOENT" });
  await assert.rejects(readdir(resolve(base, "sessions", "session-memory")), { code: "ENOENT" });
  assert.equal(await readFile(resolve(workspaceData, "sessions", "2026-10-03T15-30-51-633Z_01a10263-b671-7f1c-925e-d71b32ce3787.jsonl"), "utf8"), "session\n");
  assert.equal(await readFile(resolve(workspaceData, "sessions", "session-memory", "01a10263-b671-7f1c-925e-d71b32ce3787.json"), "utf8"), "{}\n");
  assert.equal(await readFile(resolve(workspaceData, "days", "2026-10-03", "summary.md"), "utf8"), "day\n");
  assert.equal(await readFile(resolve(workspaceData, "summaries", "2026-10-03.json"), "utf8"), "{}\n");
  // identity layer stays at the agent root
  assert.equal(await readFile(resolve(base, "memory", "catalog.db"), "utf8"), "db\n");
  assert.equal(true, (await stat(resolve(base, "definition.json"))).isFile());

  // Bound project session relocated under the agent's project tree.
  assert.equal(await readFile(resolve(root, "long-agents", "nexus", "projects", "lab", "sessions", "2026-10-02T00-38-12-763Z_aabbccdd-1111-2222-3333-444455556666.jsonl"), "utf8"), "bound\n");
  assert.equal(await readFile(resolve(root, "long-agents", "nexus", "projects", "lab", "sessions", "session-memory", "aabbccdd-1111-2222-3333-444455556666.json"), "utf8"), "{}\n");
  const projectSessionFiles = await readdir(resolve(root, "projects", "lab", "sessions")).catch(() => []);
  assert.ok(projectSessionFiles.some((name) => name.startsWith("2026-09-22")), "ordinary project files stay in the shared dir");

  // Idempotent: a second pass keeps every location.
  const second = await migrateAgentProjectsLayout(root);
  assert.equal(second.version, 1);
  assert.equal((await readdir(resolve(workspaceData, "sessions"))).some((name) => name.endsWith("01a10263-b671-7f1c-925e-d71b32ce3787.jsonl")), true);
});
