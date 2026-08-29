import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatDataLayout, getChatDataPaths } from "./chat-data.ts";

test("Chat uses one .chat root for managed runtime data", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-data-layout-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const paths = await ensureChatDataLayout(projectRoot);
  assert.deepEqual(paths, {
    root: path.join(projectRoot, ".chat"),
    agentDir: path.join(projectRoot, ".chat", "agent"),
    sessionDir: path.join(projectRoot, ".chat", "sessions"),
    workflowDataDir: path.join(projectRoot, ".chat", "workflow-data"),
  });
  assert.equal(fs.statSync(paths.agentDir).isDirectory(), true);
  assert.equal(fs.statSync(paths.sessionDir).isDirectory(), true);
  assert.equal(fs.statSync(paths.workflowDataDir).isDirectory(), true);
  assert.deepEqual(getChatDataPaths(projectRoot), paths);
});

test("legacy .pi Agent settings and Sessions are copied without deleting the source", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-data-migration-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const legacyAgentDir = path.join(projectRoot, ".pi", "agent");
  const legacySessionDir = path.join(projectRoot, ".pi", "sessions");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  fs.mkdirSync(legacySessionDir, { recursive: true });
  fs.writeFileSync(path.join(legacyAgentDir, "settings.json"), '{"defaultModel":"test"}');
  fs.writeFileSync(path.join(legacySessionDir, "session.jsonl"), "legacy session");

  const paths = await ensureChatDataLayout(projectRoot);
  assert.equal(fs.readFileSync(path.join(paths.agentDir, "settings.json"), "utf8"), '{"defaultModel":"test"}');
  assert.equal(fs.readFileSync(path.join(paths.sessionDir, "session.jsonl"), "utf8"), "legacy session");
  assert.equal(fs.existsSync(path.join(legacyAgentDir, "settings.json")), true);
  assert.equal(fs.existsSync(path.join(legacySessionDir, "session.jsonl")), true);
});

test("legacy files fill gaps without overwriting existing .chat files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-data-merge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".chat", "agent"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".chat", "agent", "settings.json"), "chat settings");
  fs.writeFileSync(path.join(root, ".pi", "agent", "settings.json"), "legacy settings");
  fs.writeFileSync(path.join(root, ".pi", "agent", "models.json"), "legacy models");

  await ensureChatDataLayout(root);

  assert.equal(fs.readFileSync(path.join(root, ".chat", "agent", "settings.json"), "utf8"), "chat settings");
  assert.equal(fs.readFileSync(path.join(root, ".chat", "agent", "models.json"), "utf8"), "legacy models");
});
