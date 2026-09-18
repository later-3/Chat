import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { claimRole, controlRole, signalGroup, stopGroup } from "./debug-processes.mjs";
import { assertPortFree, debugEnvironment, debugRoot, nanoRoot, ports, prepareDebug, repositoryRoot } from "./debug-environment.mjs";

const role = process.argv[2];
if (role !== "tui" && !Object.hasOwn(ports, role)) throw new Error("Expected backend, frontend, nanoclaw, model, or tui");
if (role === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Debug TUI needs an interactive terminal (VS Code integratedTerminal or a shell)");
await prepareDebug();
const env = await debugEnvironment(role);
const commands = {
  backend: [process.execPath, [join(repositoryRoot, "scripts/debug-backend.mjs")], repositoryRoot],
  frontend: [process.execPath, [join(repositoryRoot, "scripts/run-frontend.mjs"), "exec", "vite", "--config",
    join(repositoryRoot, "scripts/debug-vite.config.mjs"), "--host", "127.0.0.1", "--port", String(ports.frontend), "--strictPort"], repositoryRoot],
  nanoclaw: [process.execPath, [...(process.allowedNodeEnvironmentFlags.has("--use-env-proxy") ? ["--use-env-proxy"] : []), "--import", "tsx", "src/index.ts"], nanoRoot],
  model: [process.execPath, [join(repositoryRoot, "scripts/debug-model.mjs")], repositoryRoot],
  tui: [process.execPath, [join(repositoryRoot, "cli/dist/main.js"), "tui", "--project", "debug-lab"], repositoryRoot],
};
const [command, args, cwd] = commands[role];
let child, lease, outcome, log;
let stopping = false;
const initialization = new AbortController();
let forceTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  initialization.abort();
  if (child?.pid) {
    signalGroup(child.pid, "SIGTERM");
    forceTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 5000);
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await controlRole(debugRoot, role, async () => {
    lease = await claimRole(debugRoot, role, () => role === "tui" ? Promise.resolve() : assertPortFree(ports[role]), !process.argv.includes("--no-replace"));
    if (role === "tui") {
      const { prepareDebugTui } = await import("./debug-tui.mjs");
      await prepareDebugTui(env, initialization.signal);
    }
    if (stopping) throw new Error("Debug startup interrupted");
    const logPath = join(debugRoot, "logs", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${role}.log`);
    log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    const description = `[debug] ${role} ${role === "tui" ? "client (no listening port)" : `port=${ports[role]}`} cwd=${cwd}\n[debug] log=${logPath}`;
    console.log(description);
    log.write(description + "\n");
    child = spawn(command, args, { cwd, env, detached: true, stdio: role === "tui" ? "inherit" : ["inherit", "pipe", "pipe"] });
    outcome = new Promise(resolve => {
      child.once("error", error => resolve({ code: 1, error }));
      child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }));
    });
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream?.on("data", chunk => { output.write(chunk); log.write(chunk); });
    }
    if (child.pid) await lease.attach(child.pid);
  });
  if (role === "nanoclaw") {
    const { bootstrapDebugLab } = await import("./debug-bootstrap.mjs");
    await Promise.race([bootstrapDebugLab(initialization.signal), outcome.then(() => { throw new Error("NanoClaw exited before lab initialization"); })]);
  }
  const result = await outcome;
  log.write(`[debug] ${role} exited (${result.code})\n`);
  if (result.error) console.error(result.error.message);
  process.exitCode = stopping ? 0 : result.code;
} finally {
  initialization.abort();
  clearTimeout(forceTimer);
  if (child?.pid) await stopGroup(child.pid);
  log?.end();
  await lease?.release();
}
