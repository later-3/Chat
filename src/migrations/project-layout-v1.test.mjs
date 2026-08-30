import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryRepository } from "../memory/repository.ts";
import { migrateLegacyProjectLayout } from "./project-layout-v1.ts";

async function json(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("legacy Chat data migrates once into Chat Home and independent Memory stores", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-project-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = resolve(root, "workspace");
  const chatHome = resolve(root, "home");
  await mkdir(resolve(projectRoot, ".chat", "agent"), { recursive: true });
  await mkdir(resolve(projectRoot, ".chat", "sessions"), { recursive: true });
  await json(resolve(projectRoot, ".chat", "project.json"), {
    schemaVersion: 1,
    id: "chat",
    name: "Chat",
    description: "test",
  });
  await json(resolve(projectRoot, ".chat", "config.json"), {
    schemaVersion: 1,
    defaultWorkflowId: "memory",
    workflows: {},
  });
  await writeFile(resolve(projectRoot, ".chat", "agent", "settings.json"), "{}\n");
  await writeFile(resolve(projectRoot, ".chat", "sessions", "session.jsonl"), "{}\n");

  const legacyMemoryDir = resolve(projectRoot, ".chat", "memory");
  await mkdir(legacyMemoryDir, { recursive: true });
  const legacy = new Database(resolve(legacyMemoryDir, "catalog.db"));
  legacy.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
      project_id TEXT, metadata_json TEXT NOT NULL, source_session_id TEXT,
      source_entry_ids_json TEXT NOT NULL, source_workflow_invocation_id TEXT,
      status TEXT NOT NULL, version INTEGER NOT NULL, mem0_id TEXT,
      index_status TEXT NOT NULL, index_error TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  const insert = legacy.prepare(`
    INSERT INTO memories VALUES (?, ?, 'fact', ?, ?, '{}', NULL, '[]', NULL,
      'active', 1, NULL, 'pending', NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
  `);
  insert.run("personal-memory", "personal", "global", null);
  insert.run("project-memory", "project", "project", "chat");
  legacy.close();

  const first = await migrateLegacyProjectLayout({ projectRoot, chatHome });
  assert.equal(first?.copiedSessions, 1);
  assert.equal(first?.importedMemories, 2);
  assert.equal(await readFile(resolve(chatHome, "agent", "settings.json"), "utf8"), "{}\n");
  assert.equal(await readFile(resolve(chatHome, "projects", "chat", "sessions", "session.jsonl"), "utf8"), "{}\n");

  const personal = new MemoryRepository(resolve(chatHome, "memory", "personal", "catalog.db"));
  const project = new MemoryRepository(resolve(chatHome, "projects", "chat", "memory", "catalog.db"));
  assert.equal(personal.require("personal-memory").scope, "personal");
  assert.equal(project.require("project-memory").projectId, "chat");
  personal.close();
  project.close();

  const second = await migrateLegacyProjectLayout({ projectRoot, chatHome });
  assert.deepEqual(second, first);
});
