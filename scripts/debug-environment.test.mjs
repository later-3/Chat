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
  for (const name of ["debug-launch.mjs", "debug-environment.mjs"]) await copyFile(`scripts/${name}`, join(root, "scripts", name));
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
