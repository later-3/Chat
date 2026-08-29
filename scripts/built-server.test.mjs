import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendChatWorkflowStage } from "../src/workflows/workflow-stage.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverEntry = path.join(projectRoot, ".output/server/index.mjs");
let runtimeRoot;
let workspace;
let sessionId;
let server;
let baseUrl;
let serverOutput = "";
let authenticatedCookiePromise;

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function encodeFilePath(filePath) {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function authenticatedCookie() {
  authenticatedCookiePromise ??= (async () => {
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "later", password: "123456", persistent: true }),
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    return setCookie.split(";", 1)[0];
  })();
  return authenticatedCookiePromise;
}

async function authenticatedFetch(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", await authenticatedCookie());
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

before(async () => {
  assert.equal(fs.existsSync(serverEntry), true, "run pnpm build before pnpm test:built");
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-built-server-"));
  workspace = path.join(runtimeRoot, "workspace");
  const sessionDir = path.join(runtimeRoot, ".pi", "sessions");
  const legacyAgentDir = path.join(runtimeRoot, ".pi", "agent");
  const legacySkillDir = path.join(legacyAgentDir, "skills", "built-review");
  const legacyExtensionDir = path.join(legacyAgentDir, "extensions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(legacySkillDir, { recursive: true });
  fs.mkdirSync(legacyExtensionDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "fixture.md"), "# Built server fixture\n");
  fs.writeFileSync(path.join(legacySkillDir, "SKILL.md"), [
    "---", "name: built-review", "description: Built server review", "---", "Review built output.",
  ].join("\n"));
  fs.writeFileSync(path.join(legacyExtensionDir, "built-extension.ts"), "export default function register() {}\n");

  const manager = SessionManager.create(workspace, sessionDir);
  appendChatWorkflowStage(manager, {
    invocationId: "built-history-invocation",
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  manager.appendMessage({ role: "user", content: "fixture prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "fixture response" }],
    timestamp: Date.now(),
  });
  sessionId = manager.getSessionId();

  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [serverEntry], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      WORKFLOW_TARGET_WORLD: "local",
      CHAT_PUBLIC_URL: "https://chat.ai4child.asia",
      CHAT_WEB_AUTH_ENABLED: "1",
      CHAT_WEB_AUTH_USERNAME: "later",
      CHAT_WEB_AUTH_PASSWORD: "123456",
      CHAT_WEB_AUTH_SESSION_SECRET: "built-server-test-session-secret-at-least-32-characters",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chat server did not start:\n${serverOutput}`)), 15_000);
    const collect = (chunk) => {
      serverOutput += chunk.toString();
      if (serverOutput.includes(`http://127.0.0.1:${port}/`)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      if (!serverOutput.includes(`http://127.0.0.1:${port}/`)) {
        clearTimeout(timeout);
        reject(new Error(`Chat server exited with ${code}:\n${serverOutput}`));
      }
    });
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 6_000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test("the production server serves the embedded frontend", async () => {
  const redirectResponse = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(redirectResponse.status, 307);
  assert.equal(redirectResponse.headers.get("location"), "/login?next=%2F");

  const response = await authenticatedFetch("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/);
  const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(assetPath);
  assert.equal((await fetch(`${baseUrl}${assetPath}`)).status, 200);

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.equal((await manifestResponse.json()).name, "Chat");
  assert.equal((await fetch(`${baseUrl}/sw.js`)).status, 200);
});

test("health is public while Chat product APIs require login", async () => {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true, service: "chat" });

  const unauthorized = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("x-chat-auth-required"), "1");
  assert.deepEqual(await unauthorized.json(), { error: "Authentication required" });

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /登录到 Chat/);
});

test("the default Later account creates a signed HttpOnly session", async () => {
  const rejected = await fetch(`${baseUrl}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "later", password: "wrong", persistent: true }),
  });
  assert.equal(rejected.status, 401);

  const cookie = await authenticatedCookie();
  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.username, "later");

  const devicesResponse = await authenticatedFetch("/api/devices");
  assert.equal(devicesResponse.status, 200);
  assert.equal((await devicesResponse.json()).devices[0].url, "https://chat.ai4child.asia");
});

test("session list and detail come from the isolated Chat session directory", async () => {
  const listResponse = await authenticatedFetch("/api/sessions");
  assert.equal(listResponse.status, 200);
  assert.match(listResponse.headers.get("cache-control") ?? "", /no-store/);
  const list = await listResponse.json();
  assert.deepEqual(list.sessions.map((session) => session.id), [sessionId]);

  const detailResponse = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.deepEqual(detail.context.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(detail.context.messages.length, detail.context.entryIds.length);
});

test("Workflow containers and their Agents come from the backend registry", async () => {
  const response = await authenticatedFetch("/api/workflows");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.workflows.map((workflow) => workflow.id), [
    "minimal-pi-coding-agent",
    "planning-execution",
  ]);
  assert.deepEqual(body.workflows.map((workflow) => workflow.agents.map((agent) => agent.id)), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
  ]);
  assert.deepEqual(body.workflows.map((workflow) => workflow.stages.map((stage) => stage.agentId)), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
  ]);
});

test("Pi resources are served by Chat from the managed Agent directory", async () => {
  const skillsResponse = await authenticatedFetch(`/api/skills?cwd=${encodeURIComponent(workspace)}`);
  assert.equal(skillsResponse.status, 200);
  const skills = await skillsResponse.json();
  const skill = skills.skills.find((item) => item.name === "built-review");
  assert.ok(skill);

  const toggleResponse = await authenticatedFetch("/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: workspace, filePath: skill.filePath, disableModelInvocation: true }),
  });
  assert.equal(toggleResponse.status, 200);

  const extensionsResponse = await authenticatedFetch(`/api/extensions?cwd=${encodeURIComponent(workspace)}`);
  assert.equal(extensionsResponse.status, 200);
  assert.ok((await extensionsResponse.json()).extensions.some((extension) => extension.name === "built-extension"));

  const pluginsResponse = await authenticatedFetch(`/api/plugins?cwd=${encodeURIComponent(workspace)}`);
  assert.equal(pluginsResponse.status, 200);
  assert.deepEqual((await pluginsResponse.json()).packages, []);
});

test("full history exports the managed Chat Session as standalone HTML", async () => {
  const inlineResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1`,
  );
  assert.equal(inlineResponse.status, 200);
  assert.match(inlineResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.match(inlineResponse.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(inlineResponse.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(inlineResponse.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(inlineResponse.headers.get("x-content-type-options"), "nosniff");
  const html = await inlineResponse.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /id="chat-workflow-history-styles"/);
  assert.match(html, /createChatWorkflowGroup/);

  const missingResponse = await authenticatedFetch("/api/sessions/not-a-chat-session/export?inline=1");
  assert.equal(missingResponse.status, 404);
});

test("file list, metadata, and text reads use the Pi Web-compatible contract", async () => {
  const encodedWorkspace = encodeFilePath(workspace);
  const listResponse = await authenticatedFetch(`/api/files/${encodedWorkspace}?type=list`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.entries.some((entry) => entry.name === "fixture.md"), true);

  const encodedFile = `${encodedWorkspace}/fixture.md`;
  const metaResponse = await authenticatedFetch(`/api/files/${encodedFile}?type=meta`);
  assert.equal(metaResponse.status, 200);
  assert.equal((await metaResponse.json()).language, "markdown");

  const readResponse = await authenticatedFetch(`/api/files/${encodedFile}?type=read`);
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), {
    content: "# Built server fixture\n",
    language: "markdown",
    size: 23,
  });
});

test("file access outside Chat-authorized roots is rejected", async () => {
  if (process.platform === "win32") return;
  const response = await authenticatedFetch("/api/files/etc/passwd?type=read");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});
