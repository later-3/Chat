import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prepareDebug, ports, debugRoot, repositoryRoot } from "./debug-environment.mjs";
import { claimRole, controlRole } from "./debug-processes.mjs";

await prepareDebug();
const includeNano = process.argv.includes("--nanoclaw");
const children = [];
const cancellation = new AbortController();
let lease, failed;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => cancellation.abort());
async function launch(role) {
  const child = spawn(process.execPath, [join(repositoryRoot, "scripts/debug-launch.mjs"), role], { stdio: ["inherit", "pipe", "pipe"] });
  const item = { child, role, labReady: false };
  children.push(item);
  item.exit = new Promise(resolve => {
    child.once("error", error => { failed = error; cancellation.abort(); resolve(); });
    child.once("exit", code => { if (!cancellation.signal.aborted) failed = new Error(`${role} exited (${code})`); cancellation.abort(); resolve(); });
  });
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on("data", chunk => {
    output.write(chunk);
    if (chunk.toString().includes("[debug] lab ready:")) item.labReady = true;
  });
  for (let i = 0; i < 180; i++) {
    cancellation.signal.throwIfAborted();
    try {
      const owner = JSON.parse(await readFile(join(debugRoot, `${role}.lock`), "utf8"));
      if (owner.owner?.pid !== child.pid || !owner.child) { await delay(100); continue; }
      if (role === "nanoclaw") { if (item.labReady) return; }
      else {
        const path = role === "backend" ? "/api/health" : "/";
        const response = await fetch(`http://127.0.0.1:${ports[role]}${path}`, { signal: AbortSignal.timeout(1000) });
        if (response.ok || (role === "model" && response.status === 404)) return;
      }
    } catch {}
    await delay(250, undefined, { signal: cancellation.signal });
  }
  throw new Error(`${role} did not become ready; see its printed log`);
}
try {
  await controlRole(debugRoot, "stack", async () => {
    lease = await claimRole(debugRoot, "stack", async () => {});
    await launch("model");
    await launch("backend");
    await launch("frontend");
    if (includeNano) await launch("nanoclaw");
  });
  console.log(`[debug] ${includeNano ? "Web + Nano local lab" : "Web"} ready: http://127.0.0.1:${ports.frontend}; Ctrl+C stops this stack`);
  await new Promise(resolve => {
    if (cancellation.signal.aborted) resolve();
    else cancellation.signal.addEventListener("abort", resolve, { once: true });
  });
} catch (error) { if (!cancellation.signal.aborted) failed = error; }
finally {
  cancellation.abort();
  // Signal only the child launchers created by this invocation, never a new replacement.
  for (const { child } of [...children].reverse()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.all(children.map(item => item.exit));
  await lease?.release();
}
if (failed) { console.error(failed.message); process.exitCode = 1; }
