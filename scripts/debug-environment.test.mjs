import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assertPortFree, cleanEnvironment, ports } from "./debug-environment.mjs";
import { createDebugModelServer, debugModelReply } from "./debug-model.mjs";

test("debug launch contracts use dedicated ports, browser profile, and independent NanoClaw cwd", async () => {
  const launch = JSON.parse((await readFile(".vscode/launch.json", "utf8")).replace(/^\s*\/\/.*$/gm, ""));
  const names = new Set(launch.configurations.map(config => config.name));
  for (const compound of launch.compounds) {
    assert.equal(compound.stopAll, true);
    for (const name of compound.configurations) assert.ok(names.has(name));
  }
  for (const config of launch.configurations) {
    if (config.serverReadyAction?.name) assert.ok(names.has(config.serverReadyAction.name));
    if (config.type === "node") assert.ok(config.program.endsWith("scripts/debug-launch.mjs"));
  }
  const browser = launch.configurations.find(config => config.name === "Debug Browser");
  assert.equal(browser.url, `http://127.0.0.1:${ports.frontend}`);
  assert.equal(browser.userDataDir, "${workspaceFolder}/.data/debug/browser");
  assert.equal(browser.webRoot, "${workspaceFolder}/frontend");
  const backend = launch.configurations.find(config => config.name === "Debug Backend");
  assert.ok(backend.outFiles.includes("${workspaceFolder}/node_modules/.nitro-debug/**/*.mjs"));
  assert.equal(new Set(Object.values(ports)).size, 4);
  for (const port of Object.values(ports)) assert.ok(![43110, 43112, 30145, 3000].includes(port));
});

test("debug environment drops production configuration while preserving debugger auto-attach", () => {
  const env = cleanEnvironment({ PATH: "/bin", HOME: "/home/test", NODE_OPTIONS: "--require /debugger.js",
    VSCODE_INSPECTOR_OPTIONS: "debug", CHAT_HOME: "/production", CHAT_CHANNEL_GATEWAY_TOKEN: "secret",
    OPENAI_API_KEY: "secret", TELEGRAM_BOT_TOKEN: "secret", WEBHOOK_PORT: "3000", PORT: "43110" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NODE_OPTIONS", "PATH", "VSCODE_INSPECTOR_OPTIONS"].sort());
});

test("occupied debug ports fail without terminating their owner", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(assertPortFree(server.address().port), /occupied/);
    assert.equal(server.listening, true);
  } finally { await new Promise(accept => server.close(accept)); }
});

test("preparation preserves private edits, pins backend isolation, and refuses redirected data", async t => {
  const root = await mkdtemp(join(tmpdir(), "chat-debug-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await copyFile("scripts/debug-environment.mjs", join(root, "scripts/debug-environment.mjs"));
  const debug = await import(pathToFileURL(join(root, "scripts/debug-environment.mjs")));
  await debug.prepareDebug();
  const settings = join(debug.debugHome, "agent/settings.json");
  await writeFile(settings, '{"defaultProvider":"my-debug-provider"}\n');
  await debug.prepareDebug();
  assert.match(await readFile(settings, "utf8"), /my-debug-provider/);
  const envFile = join(debug.debugRoot, "backend.env");
  const original = await readFile(envFile, "utf8");
  await writeFile(envFile, original + "CHAT_HOME=/production\nPORT=43110\nWORKFLOW_LOCAL_DATA_DIR=/production\n");
  const env = await debug.debugEnvironment("backend");
  assert.equal(env.CHAT_HOME, debug.debugHome);
  assert.equal(env.PORT, "45112");
  assert.equal(env.CHAT_NITRO_BUILD_DIR, join(debug.repositoryRoot, "node_modules/.nitro-debug"));
  assert.equal(env.WORKFLOW_LOCAL_DATA_DIR, join(debug.debugHome, "runtime/workflow-data"));
  await rm(settings);
  const outside = join(root, "private-settings.json");
  await writeFile(outside, "unchanged");
  await symlink(outside, settings);
  await assert.rejects(debug.prepareDebug(), /symlinks/);
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});

test("local model exercises text, tool-disabled, and read-result paths without external access", async () => {
  assert.match(debugModelReply({ messages: [{ role: "user", content: "hello" }] }).content, /DEBUG_OK/);
  const request = { messages: [{ role: "user", content: "DEBUG_READ_SKILL" }] };
  assert.match(debugModelReply(request).content, /DEBUG_READ_UNAVAILABLE/);
  request.tools = [{ function: { name: "read" } }];
  assert.equal(debugModelReply(request).tool_calls[0].function.name, "read");
  request.messages.push({ role: "tool", content: "DEBUG_SKILL_LOADED" });
  assert.equal(debugModelReply(request).content, "DEBUG_SKILL_LOADED");
  request.messages.push({ role: "user", content: "hello again" });
  assert.match(debugModelReply(request).content, /DEBUG_OK/);
  const server = createDebugModelServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: \[DONE\]/);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally { await new Promise(accept => server.close(accept)); }
});

test("launcher startup error releases its lock without touching another directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "chat-debug-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const name of ["debug-launch.mjs", "debug-environment.mjs", "debug-processes.mjs"]) await copyFile(`scripts/${name}`, join(root, "scripts", name));
  // Missing backend program fails after taking the lock. No actual service or credentials are used.
  const child = spawn(process.execPath, [join(root, "scripts/debug-launch.mjs"), "backend"], { stdio: "pipe" });
  let output = "";
  child.stderr.on("data", chunk => { output += chunk; });
  assert.notEqual((await once(child, "exit"))[0], 0);
  // This test can also encounter an occupied debug port on a developer machine.
  assert.match(output, /MODULE_NOT_FOUND|occupied/);
  await assert.rejects(readFile(join(root, ".data/debug/backend.lock")), { code: "ENOENT" });
});

test("Stop reaps an owned grandchild even after its parent exits, and preserves an unrelated listener", { timeout: 12000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "chat-debug-stop-"));
  const debug = join(root, "debug");
  await mkdir(join(root, "scripts"));
  await mkdir(join(debug, "logs"), { recursive: true });
  await copyFile("scripts/debug-launch.mjs", join(root, "scripts/debug-launch.mjs"));
  await copyFile("scripts/debug-processes.mjs", join(root, "scripts/debug-processes.mjs"));
  // Stub only environment discovery; exercise the real launcher, logs, lock and process-group cleanup.
  await writeFile(join(root, "scripts/debug-environment.mjs"), `
    export const repositoryRoot=${JSON.stringify(root)}, debugRoot=${JSON.stringify(debug)}, nanoRoot=${JSON.stringify(root)};
    export const ports={backend:0};
    export async function prepareDebug(){}
    export async function assertPortFree(){}
    export async function debugEnvironment(){return {PATH:process.env.PATH};}
  `);
  await writeFile(join(root, "scripts/debug-backend.mjs"), `
    import {spawn} from 'node:child_process';
    spawn(process.execPath,[${JSON.stringify(join(root, "grandchild.mjs"))}],{stdio:'inherit'});
    process.on('SIGTERM',()=>process.exit(0));
  `);
  await writeFile(join(root, "grandchild.mjs"), `
    import {writeFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{});
    writeFileSync(${JSON.stringify(join(root, "ready"))},String(process.pid));
    setInterval(()=>{},1000);
  `);
  // Reproduce macOS returning EPERM instead of ESRCH after the owned group exits.
  // Live groups still use real OS signals, including the stubborn grandchild.
  await writeFile(join(root, "macos-exit.mjs"), `
    const kill=process.kill.bind(process);
    process.kill=(pid,signal)=>{try{return kill(pid,signal)}catch(error){
      if(pid<0 && error.code==='ESRCH') error.code='EPERM';
      throw error;
    }};
  `);
  const unrelated = createServer();
  unrelated.listen(0, "127.0.0.1");
  await once(unrelated, "listening");
  const child = spawn(process.execPath, ["--import", join(root, "macos-exit.mjs"), join(root, "scripts/debug-launch.mjs"), "backend"], { stdio: "ignore" });
  const exited = once(child, "exit");
  let grandchild;
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (grandchild) { try { process.kill(grandchild, "SIGKILL"); } catch {} }
    await new Promise(accept => unrelated.close(accept));
    await rm(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { grandchild = Number(await readFile(join(root, "ready"), "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; await delay(20); }
  }
  assert.ok(grandchild);
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(grandchild, 0); await delay(20); }
    catch (error) { assert.equal(error.code, "ESRCH"); grandchild = undefined; break; }
  }
  assert.equal(grandchild, undefined, "launcher leaked its grandchild");
  assert.equal(unrelated.listening, true);
  await assert.rejects(readFile(join(debug, "backend.lock")), { code: "ENOENT" });
});

test("repeated launch replaces only its own instance and recovers a killed launcher", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "chat-debug-restart-"));
  const debug = join(root, "debug");
  await mkdir(join(root, "scripts"));
  await mkdir(join(debug, "logs"), { recursive: true });
  for (const name of ["debug-launch.mjs", "debug-processes.mjs"]) await copyFile(`scripts/${name}`, join(root, "scripts", name));
  const reserved = createServer(); reserved.listen(0, "127.0.0.1"); await once(reserved, "listening");
  const port = reserved.address().port;
  await new Promise(accept => reserved.close(accept));
  await writeFile(join(root, "scripts/debug-environment.mjs"), `
    export const repositoryRoot=${JSON.stringify(root)},debugRoot=${JSON.stringify(debug)},nanoRoot=${JSON.stringify(root)};
    export const ports={backend:${port}};
    export async function prepareDebug(){}
    export {assertPortFree} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/debug-environment.mjs")).href)};
    export async function debugEnvironment(){return {PATH:process.env.PATH};}
  `);
  await writeFile(join(root, "scripts/debug-backend.mjs"), `
    import {createServer} from 'node:http';
    const server=createServer((req,res)=>res.end(String(process.pid)));
    server.listen(${port},'127.0.0.1');
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `);
  const children = [];
  let servicePid;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (servicePid) { try { process.kill(servicePid, "SIGTERM"); } catch {} }
    await Promise.all(children.map(child => child.done));
    await rm(root, { recursive: true, force: true });
  });
  function launch() {
    const child = spawn(process.execPath, [join(root, "scripts/debug-launch.mjs"), "backend"], { stdio: "pipe" });
    child.output = "";
    child.stdout.on("data", chunk => { child.output += chunk; });
    child.stderr.on("data", chunk => { child.output += chunk; });
    child.done = once(child, "exit"); children.push(child); return child;
  }
  async function ready(child) {
    for (const deadline = Date.now() + 35000; Date.now() < deadline;) {
      if (child.exitCode !== null) throw new Error(child.output);
      try {
        const owner = JSON.parse(await readFile(join(debug, "backend.lock"), "utf8"));
        const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(100) });
        const pid = Number(await response.text());
        if (owner.owner.pid === child.pid && owner.child.pid === pid) { servicePid = pid; return pid; }
      } catch {}
      await delay(50);
    }
    throw new Error(`not ready: ${child.output}`);
  }
  const first = launch(); const firstPid = await ready(first);
  const second = launch(); const secondPid = await ready(second);
  assert.notEqual(secondPid, firstPid);
  assert.equal((await first.done)[0], 0);
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
  second.kill("SIGKILL"); await second.done;
  const third = launch(); const thirdPid = await ready(third);
  assert.notEqual(thirdPid, secondPid);
  assert.throws(() => process.kill(secondPid, 0), { code: "ESRCH" });
  third.kill("SIGSTOP");
  const fourth = launch(); await ready(fourth);
  assert.equal((await third.done)[1], "SIGKILL");
  assert.throws(() => process.kill(thirdPid, 0), { code: "ESRCH" });
  fourth.kill("SIGTERM"); assert.equal((await fourth.done)[0], 0);
  servicePid = undefined;
  await assert.rejects(readFile(join(debug, "backend.lock")), { code: "ENOENT" });
  // An unrelated occupant remains alive and makes startup fail clearly.
  const other = createServer(); other.listen(port, "127.0.0.1"); await once(other, "listening");
  try {
    const rejected = launch(); assert.notEqual((await rejected.done)[0], 0);
    assert.match(rejected.output, /occupied/); assert.equal(other.listening, true);
  } finally { await new Promise(accept => other.close(accept)); }
});

test("lab bootstrap retries partial setup without duplicate identities or overwriting config", async () => {
  const { ensureDebugLab } = await import("./debug-bootstrap.mjs");
  const rows = { groups: [], "messaging-groups": [], wirings: [] };
  let registry, saves = 0, failResource = true;
  const dependencies = {
    ncl: async (kind, verb, ...args) => {
      if (verb === "list") return rows[kind];
      const value = flag => args[args.indexOf(flag) + 1];
      const entry = { id: `${kind}-1`, folder: value("--folder"),
        channel_type: value("--channel-type"), instance: value("--instance"), platform_id: value("--platform-id"),
        messaging_group_id: value("--messaging-group-id"), agent_group_id: value("--agent-group-id") };
      rows[kind].push(entry); return entry;
    },
    gateway: async () => {
      if (failResource) throw new Error("resource temporarily unavailable");
      return { agentGroup: { id: "groups-1", workspace: { memoryFileCount: 3 } } };
    },
    save: async value => { saves++; registry = value; },
  };
  await assert.rejects(ensureDebugLab(dependencies), /temporarily/);
  failResource = false;
  await ensureDebugLab(dependencies);
  registry.agents[0].name = "My edited name";
  await ensureDebugLab({ ...dependencies, registry });
  assert.deepEqual(Object.values(rows).map(entries => entries.length), [1, 1, 1]);
  assert.equal(saves, 1);
  assert.equal(registry.agents[0].name, "My edited name");
  await assert.rejects(ensureDebugLab({ ...dependencies, registry: { agents: [], instances: [] } }), /differs/);
});

test("concurrent control is refused and a recycled PID record never signals the current process", async t => {
  const { controlRole, stopRole, identity } = await import("./debug-processes.mjs");
  const root = await mkdtemp(join(tmpdir(), "chat-debug-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await controlRole(root, "backend", async () => {
    await assert.rejects(controlRole(root, "backend", async () => {}), /already in progress/);
  });
  await writeFile(join(root, "backend.control"), JSON.stringify({ owner: { ...identity(process.pid), started: "previous lifetime" } }));
  let active = 0, maximum = 0;
  const recover = () => controlRole(root, "backend", async () => { active++; maximum = Math.max(maximum, active); await delay(50); active--; });
  const results = await Promise.allSettled([recover(), recover()]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal(maximum, 1);
  await writeFile(join(root, "backend.lock"), JSON.stringify({ schema: 1, role: "backend", root,
    owner: { ...identity(process.pid), started: "an earlier lifetime" }, child: null, token: "stale" }));
  await controlRole(root, "backend", () => stopRole(root, "backend", async () => {}));
  assert.ok(identity(process.pid));
  await assert.rejects(readFile(join(root, "backend.lock")), { code: "ENOENT" });
});
