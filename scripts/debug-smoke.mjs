import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { debugHome, debugRoot, ports } from "./debug-environment.mjs";

// Exercise the actual Vite proxy + browser HTTP contract. No production URL is accepted.
const base = `http://127.0.0.1:${ports.frontend}`;
const credentials = parseEnv(await readFile(join(debugRoot, "backend.env"), "utf8"));
const login = await fetch(`${base}/api/auth/session`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: credentials.CHAT_WEB_AUTH_USERNAME, password: credentials.CHAT_WEB_AUTH_PASSWORD }),
});
assert.equal(login.status, 200, "Debug login failed");
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "Debug login did not return a cookie");
async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
}
await request("/api/projects/open", { path: join(debugHome, "workspaces/debug-lab") });
for (const [prompt, expected] of [["DEBUG_HELLO", "DEBUG_OK"], ["DEBUG_READ_SKILL", "DEBUG_SKILL_LOADED"]]) {
  const started = await request("/runs", { projectId: "debug-lab", workflow: "minimal-pi-coding-agent", prompt });
  let status;
  for (let attempt = 0; attempt < 120; attempt++) {
    status = await request(`/runs/${encodeURIComponent(started.runId)}`);
    if (status.status === "completed" || status.status === "failed") break;
    await delay(500);
  }
  assert.equal(status.status, "completed", JSON.stringify(status));
  assert.ok(JSON.stringify(status).includes(expected), `Missing ${expected}: ${JSON.stringify(status)}`);
  const session = await request(`/api/sessions/${encodeURIComponent(started.sessionId)}?projectId=debug-lab`);
  assert.ok(JSON.stringify(session).includes(expected), "Result did not survive Session reload");
  console.log(`${prompt}: completed runId=${started.runId} sessionId=${started.sessionId}`);
}
if (process.argv.includes("--long-agent")) {
  // Requires the offline Group/Registry setup from channels.md. This Web path does not send platform messages.
  const started = await request("/api/long-agents/debug-agent/start", { projectId: "debug-lab" });
  const result = await request("/api/long-agents/debug-agent/messages", { projectId: "debug-lab", text: "DEBUG_HELLO" });
  assert.equal(result.completed, true);
  assert.match(result.text, /DEBUG_OK/);
  const session = await request(`/api/sessions/${encodeURIComponent(result.sessionId)}?projectId=debug-lab`);
  assert.ok(JSON.stringify(session).includes("DEBUG_OK"));
  console.log(`Long Agent: completed sessionId=${result.sessionId} turnId=${result.turnId} (Group fetched through real debug Gateway)`);
}
