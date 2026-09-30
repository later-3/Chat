import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { ensureProjectLongAgent } from "../src/long-agents/project-agent.ts";
import { agentDate } from "../src/long-agents/calendar.ts";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../src/long-agents/storage.ts";

/** Isolated product fixture: real HTTP/config/Pi assembly; local models and Nano resources only. */
export async function configurationFixture(t) {
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const f = await fixture({ after: callback => cleanups.push(callback) });
  const revision = `sha256:${"a".repeat(64)}`;
  const file = { path: "index.md", content: "# Private memory\n\nUse clear updates.", size: 35,
    revision, updatedAt: "2026-09-30T00:00:00.000Z" };
  file.size = Buffer.byteLength(file.content);
  const gateway = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    let output;
    if (request.url.endsWith("/agent-groups/get")) output = { agentGroup: {
      id: "group", name: "Friend", standingInstructions: "Maintain your own working memory.", revision,
      workspace: { folder: "friend", memoryFileCount: 1 }, coreMemory: { index: file, definition: { ...file, path: "system/definition.md" } },
    } };
    else if (request.url.endsWith("/memory/list")) output = { agentGroupId: "group", files: [{ ...file, content: undefined }] };
    else if (request.url.endsWith("/memory/read")) output = { agentGroupId: "group", file };
    else if (request.url.endsWith("/memory/write")) {
      if (body.expectedRevision !== file.revision) {
        response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ schemaVersion: 1, error: "memory conflict" })); return;
      }
      file.content = body.content; file.size = Buffer.byteLength(body.content); file.revision = `sha256:${"b".repeat(64)}`;
      output = { agentGroupId: "group", file };
    } else { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ schemaVersion: 1, ...output }));
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const registry = await readLongAgentRegistry(f.home);
  const agent = registry.agents[0];
  await writeLongAgentRegistry({ ...registry,
    instances: [{ ...registry.instances[0], gatewayBaseUrl: `http://127.0.0.1:${gateway.address().port}/webhook/chat-backend` }],
    agents: [{ ...agent, definition: { ...agent.definition, tools: { mode: "explicit", names: ["read"], exclude: [],
      addresses: ["system:tool/agent_memory_read", "system:tool/agent_memory_write", "system:tool/agent_memory_search"] } } }],
  }, f.home);
  const modelPath = path.join(f.home, "agent/models.json");
  const config = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  config.providers["p3-local"].models[0].name = "A deliberately long model name for capability and responsive configuration regression";
  fs.writeFileSync(modelPath, JSON.stringify(config));
  const port = await new Promise(resolve => {
    const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(process.execPath, [path.join(projectRoot, ".output/server/index.mjs")], {
    cwd: projectRoot, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CHAT_HOME: f.home,
      CHAT_CHANNEL_GATEWAY_TOKEN: "isolated-configuration-browser-token-12345", CHAT_PUBLIC_URL: base,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(f.home, "runtime/workflow-data"), MEM0_TELEMETRY: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  cleanups.push(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
  });
  const deadline = Date.now() + 30_000;
  while (true) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Configuration fixture failed: ${output.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const date = agentDate(agent.timeZone);
  const day = await ensureProjectLongAgent({ chatHome: f.home, agent, projectId: agent.id, date });
  return { ...f, base, modelPath, diagnostics: () => output, friendUrl: `${base}/?projectId=friend&session=${day.day.sessionId}&friendDate=${date}` };
}
