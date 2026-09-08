import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { command, macServices, linuxServices, parseLaunchd, portStatus, stopNormal } from "./chat-stop.mjs";
import { devInvocation, stopDevelopment } from "./dev-stop.mjs";
import { identity } from "./debug-processes.mjs";

async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "chat-stop-test-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(100); }
  assert.fail("fixture did not reach the expected state");
}
function fakeService(kind, stopped, failure = false) {
  let active = true;
  return { kind, label: kind, manager: "fixture", port: 60000, autoStart: true, resume: "fixture start",
    read: () => ({ active, state: active ? "running" : "inactive", pid: null }),
    stop() { stopped.push(kind); if (failure) throw new Error("service manager denied"); active = false; } };
}
const quiet = { log() {}, status: async () => "空闲", wait: async () => {} };

test("normal check is read-only; stop orders Nano before Backend and is repeatable", async () => {
  const stopped = [], logs = [];
  const services = [fakeService("Backend", stopped), fakeService("NanoClaw", stopped)];
  assert.equal(await stopNormal(services, { ...quiet, check: true, log: line => logs.push(line) }), true);
  assert.deepEqual(stopped, []);
  assert.match(logs.join("\n"), /PID=.*端口=.*自启动=/);
  assert.equal(await stopNormal(services, quiet), true);
  assert.deepEqual(stopped, ["NanoClaw", "Backend"]);
  assert.equal(await stopNormal(services, quiet), true);
  assert.equal(stopped.length, 2);
});

test("ownership preflight blocks all stops; a manager failure still reports other components", async () => {
  const stopped = [];
  const mismatch = { ...fakeService("Backend", stopped), read() { throw new Error("wrong checkout"); } };
  await assert.rejects(stopNormal([fakeService("NanoClaw", stopped), mismatch], quiet), /wrong checkout/);
  assert.deepEqual(stopped, []);
  assert.equal(await stopNormal([fakeService("NanoClaw", stopped, true), fakeService("Backend", stopped)], quiet), false);
  assert.deepEqual(stopped, ["NanoClaw", "Backend"]);
});

test("a remaining listener or original process prevents false stop success", async () => {
  assert.equal(await stopNormal([fakeService("Backend", [])], { ...quiet, status: async () => "占用" }), false);
  let active = true;
  const service = { ...fakeService("Backend", []), read: () => ({ active, state: active ? "running" : "inactive", pid: active ? process.pid : null }), stop() { active = false; } };
  const owner = identity(process.pid);
  assert.equal(await stopNormal([service], { ...quiet, getIdentity: () => owner }), false);
  assert.ok(identity(process.pid));
});

test("launchd stale loaded definition is refused before bootout", async t => {
  const root = await temporary(t), directory = join(root, "Library/LaunchAgents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "fixture.plist"), "fixture");
  const mutations = [];
  const run = (file, args) => {
    if (file === "plutil") return { ok: true, text: JSON.stringify({ Label: "test.fixture", WorkingDirectory: root, ProgramArguments: [process.execPath, join(root, ".output/server/index.mjs")] }) };
    if (args[0] === "print") return { ok: true, text: "state = running\nworking directory = /another/checkout\narguments = {\n /another/entry.mjs\n}\n" };
    mutations.push(args); return { ok: true, text: "" };
  };
  await assert.rejects(stopNormal(await macServices(root, { home: root, run }), quiet), /checkout/);
  assert.deepEqual(mutations, []);
});

test("Linux stops system Chat and the actual user's Nano manager, preserving enablement", async t => {
  const root = await temporary(t), home = join(root, "user");
  const env = join(root, "chat.env");
  await writeFile(env, "PORT=45678\n");
  const calls = [], active = new Set(["chat.service", "nanoclaw-fixture.service"]);
  const run = (file, args) => {
    calls.push({ file, args });
    if (file === "getent") return { ok: true, text: `fixture:x:1234:1234::${home}:/bin/bash\n` };
    const unit = args.find(arg => arg.endsWith(".service"));
    if (args.includes("stop")) { active.delete(unit); return { ok: true, text: "" }; }
    const nano = unit.startsWith("nanoclaw");
    return { ok: true, text: `LoadState=loaded\nActiveState=${active.has(unit) ? "active" : "inactive"}\nMainPID=0\nWorkingDirectory=${nano ? join(root, "nanoclaw") : root}\nExecStart=${nano ? join(root, "nanoclaw/dist/index.js") : "/opt/chat/runtime/current/server/index.mjs"}\nUser=fixture\nEnvironment=PORT=49999\nEnvironmentFiles=${nano ? "" : `${env} (ignore_errors=no)`}\nUnitFileState=enabled\n` };
  };
  const services = await linuxServices(root, { run, uid: 0, listFiles: async path => path.includes("/user/.config/") ? ["nanoclaw-fixture.service"] : [] });
  assert.equal(services[0].port, 45678);
  assert.equal(await stopNormal(services, quiet), true);
  const stops = calls.filter(call => call.args.includes("stop"));
  assert.equal(stops.length, 2);
  assert.equal(stops[0].file, "runuser");
  assert.ok(stops[0].args.includes("XDG_RUNTIME_DIR=/run/user/1234"));
  assert.equal(stops[1].file, "systemctl");
  assert.ok(stops[1].args.includes("chat.service"));
  assert.ok(calls.every(call => !call.args.includes("disable")));
  assert.equal(await stopNormal(services, quiet), true);
});

test("macOS real KeepAlive fixture is unloaded without respawn; repeated stop keeps its plist", { skip: process.platform !== "darwin", timeout: 20000 }, async t => {
  const root = await temporary(t), port = await freePort();
  const directory = join(root, "Library/LaunchAgents"), program = join(root, ".output/server/index.mjs");
  await mkdir(directory, { recursive: true }); await mkdir(join(root, ".output/server"), { recursive: true });
  const ready = join(root, "ready.json");
  await writeFile(program, `import http from "node:http"; import {writeFileSync} from "node:fs"; const server=http.createServer((q,s)=>s.end("fixture")).listen(Number(process.env.PORT), "127.0.0.1",()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify(server.address())));\n`);
  const label = `com.chat-stop-fixture.${process.pid}.${port}`, path = join(directory, `${label}.plist`), target = `gui/${process.getuid()}/${label}`;
  const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  await writeFile(path, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(program)}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PORT</key><string>${port}</string></dict><key>StandardErrorPath</key><string>${xml(join(root, "stderr.log"))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`);
  t.after(() => command("launchctl", ["bootout", target]));
  assert.equal(command("launchctl", ["bootstrap", `gui/${process.getuid()}`, path]).ok, true);
  assert.equal(command("launchctl", ["kickstart", target]).ok, true);
  try { await until(async () => { try { return JSON.parse(await readFile(ready, "utf8")).port === port; } catch { return false; } }); }
  catch (error) { throw new Error(`${error.message}: ${JSON.stringify(parseLaunchd(command("launchctl", ["print", target]).text))}; ${await readFile(join(root, "stderr.log"), "utf8").catch(() => "no stderr")}`); }
  const services = await macServices(root, { home: root });
  assert.equal(services.length, 1);
  const owner = services[0].read().pid;
  assert.ok(owner);
  assert.equal(await stopNormal(services, { log() {} }), true);
  await delay(500);
  assert.equal(identity(owner), null);
  assert.equal(services[0].read().active, false);
  assert.equal(await portStatus(port), "空闲");
  assert.equal(await stopNormal(services, { log() {} }), true);
  assert.match(await readFile(path, "utf8"), /KeepAlive/);
});

test("ordinary dev only recognizes exact wrapper invocations", () => {
  assert.deepEqual(devInvocation("bash scripts/dev-start.sh --backend-port 45678 --frontend-port 45679", "/repo"), { backend: 45678, frontend: 45679 });
  for (const command of ["node scripts/dev-start.sh", "bash scripts/dev-start.sh.old", "bash scripts/dev-start.sh --backend-port 0", "bash /another/scripts/dev-start.sh", "bash scripts/dev-start.sh --unknown"]) assert.equal(devInvocation(command, "/repo"), null);
});

test("debug check creates no data; stop recovers an owned child while reporting an unknown occupied role", { timeout: 15000 }, async t => {
  const root = await temporary(t), debug = join(root, "debug"), backend = await freePort();
  const unrelated = createServer().listen(0, "127.0.0.1"); await once(unrelated, "listening");
  t.after(() => new Promise(accept => unrelated.close(accept)));
  for (const name of ["debug-stop.mjs", "debug-processes.mjs"]) await copyFile(join("scripts", name), join(root, name));
  await writeFile(join(root, "debug-environment.mjs"), `export const debugRoot=${JSON.stringify(debug)},ports={model:${unrelated.address().port},backend:${backend}};export {assertPortFree} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/debug-environment.mjs")).href)};`);
  const { stopDebug } = await import(pathToFileURL(join(root, "debug-stop.mjs")));
  const logs = [], log = line => logs.push(line);
  assert.equal(await stopDebug({ check: true, roles: ["model", "backend"], log }), true);
  await assert.rejects(readFile(join(debug, "backend.lock")), { code: "ENOENT" });
  const child = spawn(process.execPath, ["-e", `require("node:http").createServer((q,s)=>s.end("ready")).listen(${backend},"127.0.0.1",()=>console.log("ready"))`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  await once(child.stdout, "data");
  await mkdir(debug);
  await writeFile(join(debug, "backend.lock"), JSON.stringify({ schema: 1, role: "backend", root: debug, token: "fixture", owner: { pid: 2147483647, uid: process.getuid(), started: "stale", group: 2147483647 }, child: identity(child.pid) }));
  assert.equal(await stopDebug({ roles: ["model", "backend"], log }), false);
  assert.match(logs.join("\n"), /\[失败\] model/);
  assert.match(logs.join("\n"), /\[结果\] backend 已停止/);
  assert.equal(await portStatus(backend), "空闲");
  assert.equal(unrelated.listening, true);
  assert.equal(await stopDebug({ roles: ["backend"], log }), true);
});

test("ordinary dev stop reaps the real wrapper's children and preserves an unrelated listener", { timeout: 25000 }, async t => {
  const root = await temporary(t), backend = await freePort();
  let frontend = await freePort(); while (frontend === backend) frontend = await freePort();
  for (const path of ["scripts", "bin", "frontend", "pi/packages/coding-agent"]) await mkdir(join(root, path), { recursive: true });
  for (const name of ["dev-start.sh", "run-frontend.mjs"]) await copyFile(join("scripts", name), join(root, "scripts", name));
  for (const path of ["frontend/package.json", "pi/packages/coding-agent/package.json"]) await writeFile(join(root, path), '{"version":"0.0.0"}');
  await writeFile(join(root, "bin/pnpm"), '#!/usr/bin/env node\nconst http=require("node:http"); const a=process.argv;const p=a.includes("--port")?a[a.indexOf("--port")+1]:process.env.PORT; http.createServer((q,s)=>s.end("ready")).listen(Number(p),"127.0.0.1");', { mode: 0o700 });
  const unrelated = createServer().listen(0, "127.0.0.1"); await once(unrelated, "listening");
  t.after(() => new Promise(accept => unrelated.close(accept)));
  const child = spawn("bash", ["scripts/dev-start.sh", "--backend-port", String(backend), "--frontend-port", String(frontend)], { cwd: root, env: { ...process.env, CHAT_HOME: join(root, "home"), PATH: `${root}/bin:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
  await until(() => output.includes("Chat 开发环境已启动:"));
  // Host machine may have a real ordinary dev on the default ports. Inspect only fixture ports here.
  const options = { run: command, status: port => [43112, 30145].includes(port) ? Promise.resolve("空闲") : portStatus(port), log() {} };
  assert.equal(await stopDevelopment(root, { ...options, check: true }), true);
  assert.ok(identity(child.pid));
  assert.equal(await stopDevelopment(root, options), true);
  assert.equal((await exited)[0], 143);
  assert.equal(await portStatus(backend), "空闲"); assert.equal(await portStatus(frontend), "空闲");
  assert.equal(await stopDevelopment(root, options), true);
  assert.equal(unrelated.listening, true);
});
