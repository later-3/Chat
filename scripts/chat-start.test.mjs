import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { startMacServices, parseStartOptions, linuxStartInvocation } from "./chat-start.mjs";
import { macServices, command, controlNormal } from "./chat-services.mjs";
import { stopNormal } from "./chat-stop.mjs";

const token = "isolated-start-test-service-token-32-chars";
function fixture({ running = [], failure } = {}) {
  const calls = [], active = new Set(running);
  const backend = { kind: "Backend", label: "chat", program: "/fixture/backend", port: 43110,
    environment: { PORT: "43110", CHAT_CHANNEL_GATEWAY_TOKEN: token },
  };
  const nano = { kind: "NanoClaw", label: "nano", program: "/fixture/nano", port: 3000,
    environment: { NANOCLAW_EXECUTION_MODE: "chat-pi", CHAT_BACKEND_URL: "http://127.0.0.1:43110",
      CHAT_INTEGRATION_INSTANCE_ID: "local", CHAT_CHANNEL_GATEWAY_TOKEN: token, WEBHOOK_PORT: "3000" },
  };
  for (const service of [backend, nano]) Object.assign(service, {
    read: () => ({ active: active.has(service.kind), pid: active.has(service.kind) ? 123 : null, state: active.has(service.kind) ? "running" : "unloaded" }),
    start() { calls.push(`start:${service.kind}`); active.add(service.kind); },
    stop() { calls.push(`stop:${service.kind}`); active.delete(service.kind); },
  });
  const options = { log() {}, portFree: async () => {}, checkFile: async () => {},
    backendReady: async () => { calls.push("ready:Backend"); if (failure === "backend") throw new Error("backend failed"); },
    gatewayReady: async () => { calls.push("ready:NanoClaw"); if (failure === "nano") throw new Error("nano failed"); },
  };
  return { backend, nano, services: [nano, backend], options, calls, active };
}

test("normal start orders Backend readiness before Nano; repeat start does not restart", async () => {
  const f = fixture();
  delete f.nano.environment.WEBHOOK_PORT; // Native default port is a valid installed configuration.
  await startMacServices(f.services, f.options);
  assert.deepEqual(f.calls, ["start:Backend", "ready:Backend", "start:NanoClaw", "ready:NanoClaw"]);
  f.calls.length = 0;
  await startMacServices(f.services, f.options);
  assert.deepEqual(f.calls, ["ready:Backend", "ready:NanoClaw"]);
});

test("startup failure rolls back only newly started components in reverse order", async () => {
  for (const running of [[], ["Backend"], ["Backend", "NanoClaw"]]) {
    const f = fixture({ running, failure: "nano" });
    await assert.rejects(startMacServices(f.services, f.options), /nano failed/);
    assert.deepEqual([...f.active].sort(), [...running].sort());
    assert.deepEqual(f.calls.filter(c => c.startsWith("stop:")),
      running.length === 0 ? ["stop:NanoClaw", "stop:Backend"] : running.length === 1 ? ["stop:NanoClaw"] : []);
  }
  const f = fixture({ failure: "backend" });
  await assert.rejects(startMacServices(f.services, f.options), /backend failed/);
  assert.deepEqual(f.calls, ["start:Backend", "ready:Backend", "stop:Backend"]);
});

test("ownership, port, missing artifacts and connection mismatch fail before any start", async () => {
  for (const kind of ["ownership", "port", "artifact", "token", "duplicate"]) {
    const f = fixture();
    if (kind === "ownership") f.nano.read = () => { throw new Error("wrong checkout"); };
    if (kind === "port") f.options.portFree = async () => { throw new Error("occupied"); };
    if (kind === "artifact") f.options.checkFile = async () => { throw new Error("missing"); };
    if (kind === "token") f.nano.environment.CHAT_CHANNEL_GATEWAY_TOKEN = "wrong-secret";
    if (kind === "duplicate") f.services.push(f.backend);
    await assert.rejects(startMacServices(f.services, f.options));
    assert.deepEqual(f.calls, []);
  }
});

test("check is read-only; backend-only does not require Nano config; Nano requires ready Backend", async () => {
  const f = fixture();
  await startMacServices(f.services, { ...f.options, check: true });
  assert.deepEqual(f.calls, []);
  f.nano.environment = {};
  await startMacServices(f.services, { ...f.options, only: "backend" });
  assert.deepEqual(f.calls, ["start:Backend", "ready:Backend"]);
  const n = fixture({ failure: "backend" });
  await assert.rejects(startMacServices(n.services, { ...n.options, only: "nanoclaw" }), /backend failed/);
  assert.deepEqual(n.calls, ["ready:Backend"]);
  await assert.rejects(startMacServices([n.backend], { ...n.options, only: "nanoclaw" }), /尚未安装/);
  const solo = fixture();
  await startMacServices([solo.backend], solo.options);
  assert.deepEqual(solo.calls, ["start:Backend", "ready:Backend"]);
});

test("CLI options reject mistakes and Linux forwards to installed chatctl without building", () => {
  const options = parseStartOptions(["--", "--only", "nanoclaw", "--env-file", "/fixture/chat.env", "--check"]);
  const invocation = linuxStartInvocation("/fixture/repo", options, { CHAT_SERVICE: "custom" });
  assert.deepEqual(invocation, { file: "bash", args: ["/fixture/repo/deploy/chatctl", "status", "--only", "nanoclaw", "--env-file", "/fixture/chat.env"], env: { CHAT_SERVICE: "custom", CHAT_ROOT: "/fixture/repo" } });
  assert.deepEqual(linuxStartInvocation("/repo", parseStartOptions([]), {}).args, ["/repo/deploy/chatctl", "start"]);
  for (const args of [["--only"], ["--only", "web"], ["--build"], ["--env-file"]]) assert.throws(() => parseStartOptions(args));
});

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chat-start-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("normal service start/stop excludes concurrent controllers and releases its lock", async t => {
  const root = await temporary(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = controlNormal(root, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  await ready;
  await assert.rejects(controlNormal(root, async () => {}), /already in progress/);
  release(); await hold;
  await controlNormal(root, async () => {});
});

test("macOS adapter bootstraps unloaded services and kickstarts loaded idle ones without -k", async t => {
  const root = await temporary(t), dir = join(root, "Library/LaunchAgents");
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "test.plist"), "fixture");
  let loaded = false;
  const calls = [];
  const run = (file, args) => {
    if (file === "plutil") return { ok: true, text: JSON.stringify({ Label: "test.start", WorkingDirectory: root, ProgramArguments: [process.execPath, join(root, ".output/server/index.mjs")] }) };
    if (args[0] === "print") return loaded ? { ok: true, text: `state = waiting\nworking directory = ${root}\narguments = {\n${join(root, ".output/server/index.mjs")}\n}\n` } : { ok: false, error: "Could not find service" };
    calls.push(args); loaded = true; return { ok: true, text: "" };
  };
  const [service] = await macServices(root, { home: root, run });
  service.start(); service.start();
  assert.equal(calls[0][0], "bootstrap");
  assert.equal(calls[1][0], "kickstart");
  assert.ok(calls.every(args => !args.includes("-k")));
});

test("real launchd startup, health, repeat PID and stop are isolated from user services", { skip: process.platform !== "darwin", timeout: 25000 }, async t => {
  const root = await temporary(t);
  const socket = createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const dir = join(root, "Library/LaunchAgents"), program = join(root, ".output/server/index.mjs");
  await mkdir(dir, { recursive: true }); await mkdir(join(root, ".output/server"), { recursive: true });
  await writeFile(program, `import http from "node:http";http.createServer((q,s)=>{if(q.url==="/api/health"){s.setHeader("content-type","application/json");s.end(JSON.stringify({ok:true,service:"chat"}));}else if(q.url==="/app.js"){s.setHeader("content-type","text/javascript");s.end("export {};");}else{s.setHeader("content-type","text/html");s.end('<div id="root"></div><script type="module" src="/app.js"></script>');}}).listen(Number(process.env.PORT),"127.0.0.1");`);
  const label = `com.chat-start-fixture.${process.pid}.${port}`, path = join(dir, `${label}.plist`);
  const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  await writeFile(path, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>WorkingDirectory</key><string>${xml(root)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(program)}</string></array><key>EnvironmentVariables</key><dict><key>PORT</key><string>${port}</string><key>CHAT_HOME</key><string>${xml(join(root, "home"))}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`);
  t.after(() => command("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]));
  const nanoSocket = createServer().listen(0, "127.0.0.1"); await once(nanoSocket, "listening");
  const nanoPort = nanoSocket.address().port; await new Promise(resolve => nanoSocket.close(resolve));
  const nanoRoot = join(root, "nanoclaw"), nanoProgram = join(nanoRoot, "dist/index.js"), nanoLabel = `${label}.nano`;
  await mkdir(join(nanoRoot, "dist"), { recursive: true });
  await writeFile(nanoProgram, `require("node:http").createServer((q,s)=>{if(q.headers.authorization!==${JSON.stringify(`Bearer ${token}`)}){s.statusCode=401;s.end();return;}s.end(JSON.stringify({schemaVersion:1,ok:true,instanceId:"local"}));}).listen(${nanoPort},"127.0.0.1");`);
  await writeFile(join(nanoRoot, ".env"), `NANOCLAW_EXECUTION_MODE=chat-pi\nCHAT_BACKEND_URL=http://127.0.0.1:${port}\nCHAT_INTEGRATION_INSTANCE_ID=local\nCHAT_CHANNEL_GATEWAY_TOKEN=${token}\nWEBHOOK_PORT=${nanoPort}\n`);
  await writeFile(join(root, ".env"), `CHAT_CHANNEL_GATEWAY_TOKEN=${token}\nCHAT_NANOCLAW_GATEWAY_URL=http://127.0.0.1:${nanoPort}/webhook/chat-backend\n`);
  await writeFile(join(dir, `${nanoLabel}.plist`), `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${nanoLabel}</string><key>WorkingDirectory</key><string>${xml(nanoRoot)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(nanoProgram)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`);
  t.after(() => command("launchctl", ["bootout", `gui/${process.getuid()}/${nanoLabel}`]));
  const services = await macServices(root, { home: root });
  assert.equal(services.length, 2);
  await startMacServices(services, { log() {} });
  const pids = services.map(service => service.read().pid); assert.ok(pids.every(Boolean));
  await startMacServices(services, { log() {} });
  assert.deepEqual(services.map(service => service.read().pid), pids);
  assert.equal(await stopNormal(services, { log() {} }), true);
  assert.ok(services.every(service => !service.read().active));
  assert.match(await readFile(path, "utf8"), /KeepAlive/);
});

test("healthy Backend cannot hide broken Web pages or missing entry assets", async t => {
  const { createServer: httpServer } = await import("node:http");
  const { checkBackend } = await import("./chat-start.mjs");
  let scenario = "ok";
  const server = httpServer((request, response) => {
    if (request.url === "/api/health") { response.setHeader("content-type", "application/json"); response.end('{"ok":true,"service":"chat"}'); return; }
    if (request.url === "/") {
      if (scenario === "page500") response.statusCode = 500;
      if (scenario === "redirect") { response.writeHead(302, { location: "/login" }); response.end(); return; }
      response.setHeader("content-type", "text/html");
      response.end(scenario === "noEntry" ? '<h1>login</h1>' : '<div id="root"></div><script type="module" src="/app.js"></script><link rel="stylesheet" href="/app.css">'); return;
    }
    response.setHeader("content-type", request.url.endsWith("js") ? "text/javascript" : "text/css");
    if (scenario === "missingJs" && request.url.endsWith("js")) response.statusCode = 404;
    if (scenario === "htmlFallback" && request.url.endsWith("css")) response.setHeader("content-type", "text/html");
    response.end("fixture");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = { label: "fixture", port: server.address().port, read: () => ({ pid: process.pid }) };
  await checkBackend(service, { attempts: 1 });
  for (scenario of ["page500", "redirect", "missingJs", "htmlFallback", "noEntry"]) {
    await assert.rejects(checkBackend(service, { attempts: 1 }), /Backend存活但Web未就绪/);
  }
});
