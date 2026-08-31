import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultChatRootConfig,
  readChatRootConfig,
  resolveChatConfig,
  writeChatRootConfig,
  writeProjectChatConfig,
} from "./chat-config.ts";
import { openProject } from "./projects/registry.ts";

test(".chat/config.json is created, validated, persisted, and read as one runtime source", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-root-config-"));
  process.chdir(root);
  process.env.CHAT_HOME = path.join(root, ".chat");
  t.after(() => {
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousChatHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(await readChatRootConfig(), defaultChatRootConfig());
  const configPath = path.join(root, ".chat", "config.json");
  assert.equal(fs.existsSync(configPath), true);

  const saved = await writeChatRootConfig({
    schemaVersion: 1,
    defaultWorkflowId: "memory",
    workflows: {
      memory: {
        agents: {
          "memory-agent": { promptFiles: ["/rules/memory.md"] },
        },
      },
    },
  });
  assert.equal(saved.defaultWorkflowId, "memory");
  assert.deepEqual((await readChatRootConfig()).workflows.memory.agents["memory-agent"], {
    promptFiles: ["/rules/memory.md"],
  });

  await assert.rejects(
    writeChatRootConfig({
      schemaVersion: 1,
      defaultWorkflowId: "memory",
      workflows: { memory: { agents: { planner: {} } } },
    }),
    /不存在Agent: planner/,
  );
});

test("Project config is isolated and applied directly for the explicitly opened Project", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  await openProject({
    path: projectRoot,
    chatHome,
    id: "project-config",
    name: "Project Config",
  });
  await writeChatRootConfig({
    schemaVersion: 1,
    defaultWorkflowId: "minimal-pi-coding-agent",
    workflows: {},
  }, chatHome);

  await writeProjectChatConfig("project-config", { schemaVersion: 1, defaultWorkflowId: "memory" }, chatHome);
  const resolved = await resolveChatConfig("project-config", chatHome);
  assert.equal(resolved.effective.defaultWorkflowId, "memory");
});
