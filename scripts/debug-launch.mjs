import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPortFree, debugEnvironment, debugRoot, nanoRoot, ports, prepareDebug, repositoryRoot } from "./debug-environment.mjs";

const role = process.argv[2];
if (!Object.hasOwn(ports, role)) throw new Error("Expected backend, frontend, nanoclaw, or model");
await prepareDebug();
await assertPortFree(ports[role]);
const env = await debugEnvironment(role);
const lockPath = join(debugRoot, `${role}.lock`);
try { await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
catch (error) {
  if (error.code !== "EEXIST") throw error;
  throw new Error(`Debug ${role} is locked. Check its PID/port before removing stale ${lockPath}`);
}
const commands = {
  backend: [process.execPath, [join(repositoryRoot, "scripts/debug-backend.mjs")], repositoryRoot],
  frontend: [process.execPath, [join(repositoryRoot, "scripts/run-frontend.mjs"), "exec", "vite", "--config",
    join(repositoryRoot, "scripts/debug-vite.config.mjs"), "--host", "127.0.0.1", "--port", String(ports.frontend), "--strictPort"], repositoryRoot],
  nanoclaw: [process.execPath, [...(process.allowedNodeEnvironmentFlags.has("--use-env-proxy") ? ["--use-env-proxy"] : []), "--import", "tsx", "src/index.ts"], nanoRoot],
  model: [process.execPath, [join(repositoryRoot, "scripts/debug-model.mjs")], repositoryRoot],
};
const [command, args, cwd] = commands[role];
const logPath = join(debugRoot, "logs", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${role}.log`);
const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
console.log(`[debug] ${role} port=${ports[role]} cwd=${cwd}\n[debug] log=${logPath}`);
// One process group per launch, so Stop only reaps descendants owned by this session.
const child = spawn(command, args, { cwd, env, detached: true, stdio: ["inherit", "pipe", "pipe"] });
for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on("data", chunk => { output.write(chunk); log.write(chunk); });
}
function signalGroup(signal) {
  try { process.kill(-child.pid, signal); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    // macOS can report EPERM while an exiting group has only zombies left.
    // Verify that no live group member remains; a real permission denial must
    // still fail and retain the lock. Never signal a broader set of processes.
    if (error.code === "EPERM") {
      const rows = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
      const live = rows.trim().split("\n").some(row => {
        const [group, state] = row.trim().split(/\s+/);
        return Number(group) === child.pid && !state.startsWith("Z");
      });
      if (!live) return false;
    }
    throw error;
  }
}
let stopping = false;
let forceTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  forceTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.once("error", async error => { console.error(error.message); log.end(); await unlink(lockPath); process.exitCode = 1; });
child.once("exit", async (code, signal) => {
  clearTimeout(forceTimer);
  signalGroup("SIGTERM");
  // The immediate child may exit before a grandchild. Keep the role locked until
  // the entire owned process group is gone, then force only this group if needed.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!signalGroup(0)) break;
    if (attempt === 49) signalGroup("SIGKILL");
    else await delay(100);
  }
  log.end();
  await unlink(lockPath);
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
});
