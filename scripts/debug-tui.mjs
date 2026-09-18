import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { debugHome, repositoryRoot } from "./debug-environment.mjs";

/** Prepare a real Backend project; the client still uses the normal login/session APIs. */
export async function prepareTuiProject({ url, username, password, projectPath, signal, timeoutMs = 60000 }) {
  const pending = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const request = (path, options = {}) => fetch(`${url}${path}`, {
    ...options, redirect: "error", signal: AbortSignal.any([pending, AbortSignal.timeout(3000)]),
  });
  while (true) {
    pending.throwIfAborted();
    try { if ((await request("/api/health")).ok) break; } catch { pending.throwIfAborted(); }
    await delay(250, undefined, { signal: pending });
  }
  const response = await request("/api/auth/session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`Debug TUI login failed (${response.status}); check .data/debug/backend.env`);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("chat-session="))?.split(";", 1)[0];
  if (!cookie) throw new Error("Debug TUI login returned no session cookie");
  const opened = await request("/api/projects/open", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ path: projectPath }),
  });
  if (!opened.ok) throw new Error(`Debug TUI could not open Debug Lab (${opened.status})`);
  const project = await opened.json();
  if (project?.projectId !== "debug-lab") throw new Error("Debug TUI project identity differs from debug-lab");
}

export async function prepareDebugTui(env, signal) {
  console.log("[debug] Building TUI with source maps and waiting for Backend…");
  await promisify(execFile)(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "cli/tsconfig.json"], {
    cwd: repositoryRoot, env, signal,
  });
  await prepareTuiProject({ url: env.CHAT_SERVER_URL, username: env.CHAT_CLI_USERNAME,
    password: env.CHAT_CLI_PASSWORD, projectPath: join(debugHome, "workspaces/debug-lab"), signal });
}
