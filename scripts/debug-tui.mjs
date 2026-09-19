import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { debugHome, repositoryRoot } from "./debug-environment.mjs";

/** Prepare a real Backend project; the client uses the normal project/session APIs. */
export async function prepareTuiProject({ url, projectPath, signal, timeoutMs = 60000 }) {
  const pending = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const request = (path, options = {}) => fetch(`${url}${path}`, {
    ...options, redirect: "error", signal: AbortSignal.any([pending, AbortSignal.timeout(3000)]),
  });
  while (true) {
    pending.throwIfAborted();
    try { if ((await request("/api/health")).ok) break; } catch { pending.throwIfAborted(); }
    await delay(250, undefined, { signal: pending });
  }
  const opened = await request("/api/projects/open", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  if (!opened.ok) throw new Error(`Debug TUI could not open Debug Lab (${opened.status})`);
  const project = await opened.json();
  if (project?.projectId !== "debug-lab") throw new Error("Debug TUI project identity differs from debug-lab");
}

export async function prepareDebugTui(env, signal) {
  console.log("[debug] Building TUI with source maps and waiting for Backend…");
  await promisify(execFile)(process.execPath, [join(repositoryRoot, "scripts/build-cli.mjs")], {
    cwd: repositoryRoot, env, signal,
  });
  await prepareTuiProject({ url: env.CHAT_SERVER_URL, projectPath: join(debugHome, "workspaces/debug-lab"), signal });
}
