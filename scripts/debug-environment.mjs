import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ports = Object.freeze({ backend: 45112, frontend: 35145, nanoclaw: 45300, model: 45401 });
export const debugRoot = join(repositoryRoot, ".data/debug");
export const debugHome = join(debugRoot, "chat-home");
export const nanoRoot = join(debugRoot, "nanoclaw");

async function assertUnredirected(path) {
  let cursor = path;
  while (cursor !== repositoryRoot && cursor.startsWith(repositoryRoot + "/")) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Debug paths must not contain symlinks"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = dirname(cursor);
  }
}

/** Refuse occupied ports; never kill, attach to, or silently reuse another instance. */
export async function assertPortFree(port) {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", () => reject(new Error(`Debug port ${port} is occupied; its owner was not stopped.`)));
    server.listen(port, "127.0.0.1", accept);
  });
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

/** Keep OS/debugger transport, but do not inherit production credentials or service endpoints. */
export function cleanEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && (
    /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|LANG|LC_.*|TZ|SYSTEMROOT|COMSPEC)$/i.test(key)
    || /^(VSCODE_|ELECTRON_RUN_AS_NODE$)/.test(key)
    || key === "NODE_OPTIONS"
    || /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)
  )));
}

// Preparation is repeatable and never replaces a developer's private configuration.
async function createOnce(path, content) {
  await assertUnredirected(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Debug data paths must not contain symlinks");
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Debug files must not be symlinks");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

export async function prepareDebug() {
  await assertUnredirected(debugRoot);
  await mkdir(debugRoot, { recursive: true, mode: 0o700 });
  // A symlink here could redirect every data write back to a normal installation.
  if (await realpath(debugRoot) !== debugRoot) throw new Error("Debug root must not contain symlinks");
  await createOnce(join(debugRoot, "backend.env"), [
    "# Private debug credentials only. Never copy production environment files here.",
    `CHAT_CHANNEL_GATEWAY_TOKEN=${randomBytes(32).toString("hex")}`,
    "CHAT_WEB_AUTH_USERNAME=chat", "CHAT_WEB_AUTH_PASSWORD=123456",
    `CHAT_WEB_AUTH_SESSION_SECRET=${randomBytes(32).toString("hex")}`, "",
  ].join("\n"));
  await createOnce(join(debugHome, "agent/settings.json"), JSON.stringify({
    defaultProvider: "debug-local", defaultModel: "debug-model", defaultThinkingLevel: "off",
  }, null, 2) + "\n");
  await createOnce(join(debugHome, "agent/models.json"), JSON.stringify({ providers: {
    "debug-local": {
      baseUrl: `http://127.0.0.1:${ports.model}/v1`, api: "openai-completions", apiKey: "debug-only",
      models: [{ id: "debug-model", name: "Local debug fixture", reasoning: false, input: ["text"],
        contextWindow: 32768, maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  } }, null, 2) + "\n");
  const lab = join(debugHome, "workspaces/debug-lab");
  await createOnce(join(lab, ".chat/project.json"), JSON.stringify({
    schemaVersion: 1, id: "debug-lab", name: "Debug Lab",
  }, null, 2) + "\n");
  await createOnce(join(lab, ".chat/skills/debug-trace/SKILL.md"), [
    "---", "name: debug-trace", "description: Read this skill when practicing DEBUG_READ_SKILL.", "---",
    "# Debug trace", "This harmless fixture contains DEBUG_SKILL_LOADED. Read it and report that marker.", "",
  ].join("\n"));
  for (const folder of [debugHome, join(debugRoot, "logs"), join(debugRoot, "empty-env"), join(debugRoot, "nano-home")]) {
    await assertUnredirected(folder);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (await realpath(folder) !== folder) throw new Error("Debug directories must not contain symlinks");
  }
}

export async function debugEnvironment(role) {
  const privateValues = parseEnv(await readFile(join(debugRoot, "backend.env"), "utf8"));
  const base = cleanEnvironment();
  base.NO_PROXY = [base.NO_PROXY ?? base.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
  base.no_proxy = base.NO_PROXY;
  if (role === "backend") return {
    ...base, ...privateValues,
    CHAT_HOME: debugHome, HOST: "127.0.0.1", PORT: String(ports.backend),
    CHAT_PUBLIC_URL: `http://127.0.0.1:${ports.frontend}`,
    CHAT_NITRO_BUILD_DIR: join(repositoryRoot, "node_modules/.nitro-debug"),
    WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: join(debugHome, "runtime/workflow-data"),
  };
  if (role === "nanoclaw") {
    for (const name of [".env", "data", "groups", "store"]) await assertUnredirected(join(nanoRoot, name));
    if (await realpath(nanoRoot) !== nanoRoot) throw new Error("NanoClaw debug checkout must not be a symlink");
    const nanoValues = parseEnv(await readFile(join(nanoRoot, ".env"), "utf8"));
    if (nanoValues.CHAT_CHANNEL_GATEWAY_TOKEN !== privateValues.CHAT_CHANNEL_GATEWAY_TOKEN) {
      throw new Error("Debug Backend/NanoClaw service credentials differ");
    }
    // Protected settings cannot be overridden by an inherited production .env.
    return { ...base, ...nanoValues, HOME: join(debugRoot, "nano-home"), NANOCLAW_EXECUTION_MODE: "chat-pi",
      CHAT_BACKEND_URL: `http://127.0.0.1:${ports.backend}`, CHAT_INTEGRATION_INSTANCE_ID: "debug",
      WEBHOOK_PORT: String(ports.nanoclaw), LOG_LEVEL: nanoValues.LOG_LEVEL ?? "info" };
  }
  return { ...base, CHAT_BACKEND_URL: `http://127.0.0.1:${ports.backend}` };
}

async function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`${command} failed (${code})`)));
  });
}

/** A real worktree preserves NanoClaw's native cwd/data and upgrade identity contracts. */
export async function prepareNano() {
  await prepareDebug();
  await assertPortFree(ports.nanoclaw);
  const source = join(repositoryRoot, "nanoclaw");
  try { await stat(join(nanoRoot, ".git")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    execFileSync("git", ["-C", source, "worktree", "add", "--detach", nanoRoot, "HEAD"], { stdio: "inherit" });
  }
  if (await realpath(nanoRoot) !== nanoRoot) throw new Error("Invalid NanoClaw debug checkout");
  // Do not switch an existing worktree or discard edits. Updates are a deliberate developer operation.
  const values = parseEnv(await readFile(join(debugRoot, "backend.env"), "utf8"));
  await createOnce(join(nanoRoot, ".env"), [
    "# Dedicated test Bot/account only; blank Telegram + disabled WeChat by default.",
    "NANOCLAW_EXECUTION_MODE=chat-pi", `CHAT_BACKEND_URL=http://127.0.0.1:${ports.backend}`,
    "CHAT_INTEGRATION_INSTANCE_ID=debug", `CHAT_CHANNEL_GATEWAY_TOKEN=${values.CHAT_CHANNEL_GATEWAY_TOKEN}`,
    `WEBHOOK_PORT=${ports.nanoclaw}`, "TELEGRAM_BOT_TOKEN=", "TELEGRAM_INSTANCES=", "WECHAT_ENABLED=false", "",
  ].join("\n"));
  const env = cleanEnvironment();
  await run("pnpm", ["install", "--frozen-lockfile"], nanoRoot, env);
  for (const name of ["format:check", "typecheck", "build"]) await run("pnpm", [name], nanoRoot, env);
  // Same isolated tests required by the deployment contract, without installing/restarting any service.
  await run("pnpm", ["exec", "vitest", "run", "--testTimeout=30000", "--maxWorkers=2"], nanoRoot, env);
  await run("pnpm", ["exec", "tsx", "scripts/upgrade-state.ts", "set"], nanoRoot, env);
  console.log(`NanoClaw debug checkout ready: ${nanoRoot}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === "prepare") await prepareDebug();
  else if (action === "prepare-nanoclaw") await prepareNano();
  else throw new Error("Expected prepare or prepare-nanoclaw");
}
