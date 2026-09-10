import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveLongAgent,
  createLongAgent,
  deleteLongAgent,
  LongAgentLifecycleError,
  unarchiveLongAgent,
} from "../../src/long-agents/lifecycle.ts";
import { longAgentConfigRoot, readLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureDailyProject, readProjectRegistry } from "../../src/projects/registry.ts";

const INSTANCE = {
  id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
  gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
};

async function setup(t, agents = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-lifecycle-"));
  const chatHome = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  await ensureDailyProject(chatHome);
  const { writeLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  await writeLongAgentRegistry({ schemaVersion: 1, instances: [INSTANCE], agents }, chatHome);
  return { base, chatHome };
}

const verifyOk = async () => {};

test("createLongAgent provisions config root, Daily Project and registry entry atomically", async (t) => {
  const { chatHome } = await setup(t);
  const agent = await createLongAgent({
    id: "luna",
    name: "Luna",
    description: "Reading companion",
    instanceId: "local",
    nanoclawAgentGroupId: "ag-luna",
    chatHome,
    verifyAgentGroup: verifyOk,
  });
  assert.equal(agent.defaultProjectId, "daily-luna");
  assert.equal(agent.status, "active");
  assert.ok(fs.existsSync(path.join(longAgentConfigRoot(chatHome, "luna"), "skills")));
  assert.ok(fs.existsSync(path.join(longAgentConfigRoot(chatHome, "luna"), "definition.json")));
  const projects = await readProjectRegistry(chatHome);
  assert.ok(projects.projects.some((entry) => entry.projectId === "daily-luna"));

  await assert.rejects(
    createLongAgent({
      id: "luna", name: "Dup", instanceId: "local", nanoclawAgentGroupId: "ag-new",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /已存在/,
  );
  await assert.rejects(
    createLongAgent({
      id: "newbie", name: "Dup Group", instanceId: "local", nanoclawAgentGroupId: "ag-luna",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /已被其他Agent绑定/,
  );
  await assert.rejects(
    createLongAgent({
      id: "ghost", name: "Ghost", instanceId: "missing", nanoclawAgentGroupId: "ag-ghost",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /找不到NanoClaw实例/,
  );
});

test("createLongAgent rolls back the registry entry when provisioning fails", async (t) => {
  const { chatHome } = await setup(t);
  await assert.rejects(
    createLongAgent({
      id: "bad agent id!", name: "Bad", instanceId: "local", nanoclawAgentGroupId: "ag-bad",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /格式无效/,
  );
  const registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents.length, 0);
});

test("archive/unarchive/delete follow the two-phase contract", async (t) => {
  const { chatHome } = await setup(t);
  await createLongAgent({
    id: "luna", name: "Luna", instanceId: "local", nanoclawAgentGroupId: "ag-luna",
    chatHome, verifyAgentGroup: verifyOk,
  });

  await assert.rejects(deleteLongAgent("luna", chatHome), /先归档/);

  await archiveLongAgent("luna", chatHome);
  let registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents[0].status, "archived");
  assert.equal(registry.agents[0].enabled, false);

  await unarchiveLongAgent("luna", chatHome);
  registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents[0].status, "active");

  await archiveLongAgent("luna", chatHome);
  await deleteLongAgent("luna", chatHome);
  registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents.length, 0);
  assert.equal(fs.existsSync(longAgentConfigRoot(chatHome, "luna")), false);

  await assert.rejects(deleteLongAgent("luna", chatHome), (error) => {
    assert.ok(error instanceof LongAgentLifecycleError);
    assert.equal(error.statusCode, 404);
    return true;
  });
});
