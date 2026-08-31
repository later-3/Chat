import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadChatAgentContextFiles } from "./agent-context-files.ts";

test("Chat loads only global and the exact opened Project context", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "chat-home", "agent");
  const projectRoot = path.join(root, "workspace", "project");
  const cwd = path.join(projectRoot, "packages", "app");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "global Chat instructions");
  fs.writeFileSync(path.join(root, "workspace", "AGENTS.md"), "outside Project instructions");
  fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Project instructions");
  fs.writeFileSync(path.join(cwd, "AGENTS.override.md"), "nested override instructions");

  assert.deepEqual(await loadChatAgentContextFiles({ agentDir, projectRoot }), [
    { path: path.join(fs.realpathSync(agentDir), "AGENTS.md"), content: "global Chat instructions" },
    { path: path.join(fs.realpathSync(projectRoot), "AGENTS.md"), content: "Project instructions" },
  ]);
});

test("Chat rejects a Project context symlink that escapes the Project", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-context-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "chat-home", "agent");
  const projectRoot = path.join(root, "project");
  const outside = path.join(root, "outside.md");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(outside, "outside instructions");
  fs.symlinkSync(outside, path.join(projectRoot, "AGENTS.md"));

  await assert.rejects(
    loadChatAgentContextFiles({ agentDir, projectRoot }),
    /不能越过允许目录/,
  );
});
