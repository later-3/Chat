import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultChatRootConfig,
  readChatRootConfig,
  writeChatRootConfig,
} from "./chat-config.ts";

test(".chat/config.json is created, validated, persisted, and read as one runtime source", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-root-config-"));
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
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
