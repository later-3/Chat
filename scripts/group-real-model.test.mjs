import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openProject } from "../src/projects/registry.ts";
import { writeLongAgentRegistry } from "../src/long-agents/storage.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const realAgentDir = path.join(os.homedir(), ".chat", "agent");

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

/**
 * Real-model acceptance through the actual Chat assembly.
 *
 * The isolated Chat Home **symlinks** the existing `~/.chat/agent` model configuration (models.json /
 * settings.json / auth.json) instead of copying it, so no credential is read, printed, duplicated or
 * modified. Sessions, conversations and workflow data stay in the temporary Home. The test is skipped
 * when no real model config exists; a failed/insufficient-credit call surfaces as a real assertion.
 */
test("group round runs through the real configured model", {
  timeout: 180_000,
  skip: fs.existsSync(path.join(realAgentDir, "models.json")) ? false : "没有可用的真实模型配置",
}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la5-realmodel-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la5-realmodel-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_REAL\n");
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  for (const file of ["models.json", "settings.json", "auth.json"]) {
    const source = path.join(realAgentDir, file);
    if (fs.existsSync(source)) fs.symlinkSync(source, path.join(home, "agent", file));
  }
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: ["friend", "friend2"].map((id) => ({
      id, name: id, description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
      nanoclawAgentGroupId: `group-${id}`, defaultProjectId: id,
      definition: {
        schemaVersion: 1, id, name: id, description: "Stable",
        systemPrompt: { mode: "replace", text: "你是群里的研究员。只回答被问到的内容，保持简短。" }, customInstructions: [],
        tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
      },
    })),
  }, home);

  let output = "";
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env, CHAT_HOME: home, CHAT_NITRO_BUILD_DIR: buildDir,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopProcess(server);
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = async () => {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return true; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  assert.equal(await ready(), true, output);
  const api = async (suffix, init) => {
    const response = await fetch(`${baseUrl}/api/long-agents/friend/conversations${suffix}`, {
      ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
  const created = await api("", { method: "POST", body: JSON.stringify({ storageProjectId: "a", title: "真实模型群", requestId: "req-real", memberLongAgentIds: ["friend"] }) });
  assert.equal(created.status, 201, JSON.stringify(created.body) + output);
  const conversationId = created.body.id;
  await api(`/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ clientMessageId: "real-1", text: "请用一句话说明这个群可以做什么。" }) });
  const round = await api(`/${conversationId}/discussions`, { method: "POST", body: JSON.stringify({ policy: "mention", targets: ["friend"] }) });
  assert.equal(round.status, 202, JSON.stringify(round.body));

  const waitForReply = async () => {
    const deadline = Date.now() + 90_000;
    let last = null;
    while (Date.now() < deadline) {
      const detail = await api(`/${conversationId}`);
      const messages = await api(`/${conversationId}/messages`);
      last = { detail: detail.body, messages: messages.body };
      const publication = messages.body.messages?.find((message) => message.publicationId !== null && message.text !== null);
      const discussion = (detail.body.discussions ?? []).find((item) => item.discussionId === round.body.discussionId) ?? detail.body.discussions?.[0];
      // Wait for both the committed publication and the terminal discussion state: the outbound
      // delivery step is awaited before the round is closed.
      if (publication !== undefined && discussion !== undefined && ["completed", "stopped"].includes(discussion.status)) return last;
      if (discussion !== undefined && ["failed", "interrupted"].includes(discussion.status))
        assert.fail(`真实模型轮次失败：${JSON.stringify(detail.body)}\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail(`真实模型没有返回公开回复：${JSON.stringify(last)}\n${output}`);
  };
  const result = await waitForReply();
  const reply = result.messages.messages.find((message) => message.publicationId !== null);
  assert.equal(reply.authorLongAgentId, "friend");
  assert.equal(typeof reply.text, "string");
  assert.ok(reply.text.trim().length > 0, "真实模型返回了非空公开回复");
  assert.equal(reply.unavailableReason, null);
  const discussion = result.detail.discussions[0];
  assert.equal(discussion.status, "completed", JSON.stringify(discussion));
  assert.equal(discussion.modelCalls >= 1, true);
  if (process.env.CHAT_LA5_EXTENDED_ACCEPTANCE === "1") {
    for (const policy of ["round-robin", "parallel", "moderator", "free"]) {
      const group = await api("", {method:"POST", body:JSON.stringify({
        storageProjectId:"a", title:`真实 ${policy}`, requestId:`real-${policy}`,
        memberLongAgentIds:["friend","friend2"],
        policy:{defaultPolicy:policy,moderatorLongAgentId:"friend"},
        budget:{maxRounds:1,maxModelCalls:4,maxConcurrentSpeakers:2},
      })});
      assert.equal(group.status,201);
      const id=group.body.id;
      await api(`/${id}/messages`,{method:"POST",body:JSON.stringify({clientMessageId:"topic",text:"请讨论如何合作学习。每人只说一句话；若担任主持，先按要求输出下一位成员标签。"})});
      const start=await api(`/${id}/discussions`,{method:"POST",body:JSON.stringify({policy})});
      assert.equal(start.status,202);
      let finished;
      for(let i=0;i<160;i++) {
        const detail=await api(`/${id}`);
        const current=detail.body.discussions?.[0];
        if(current && ["completed","failed","interrupted","stopped"].includes(current.status)){finished=current;break;}
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      assert.equal(finished?.status,"completed",JSON.stringify({policy,finished}));
      assert.ok(finished.modelCalls>=1 && finished.modelCalls<=4);
      const messages=await api(`/${id}/messages`);
      assert.ok(messages.body.messages.some(message=>message.publicationId!==null));
      console.log(`真实策略 ${policy}: completed, calls=${finished.modelCalls}`);
    }
  }

});
