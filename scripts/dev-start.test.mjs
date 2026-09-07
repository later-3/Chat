import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await delay(100);
  }
  assert.fail(description);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Fake pnpm still forks a real HTTP child: the launcher must reap descendants, not only pnpm.
const fakePnpm = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const frontend = args.includes('--strictPort');
const name = frontend ? 'frontend' : 'backend';
if (frontend && process.env.FAKE_FRONTEND_FAIL) process.exit(2);
const port = frontend ? args[args.indexOf('--port') + 1] : process.env.PORT;
const child = spawn(process.execPath, ['-e', 'require("node:http").createServer((q,s)=>s.end("ready")).listen(Number(process.env.FAKE_PORT),"127.0.0.1")'], {
  env: { ...process.env, FAKE_PORT: port }, stdio: 'inherit'
});
writeFileSync(process.env.FAKE_STATE + '/' + name + '.json', JSON.stringify({ pid: process.pid, child: child.pid, home: process.env.CHAT_HOME, appVersion: process.env.VITE_APP_VERSION, piVersion: process.env.VITE_PI_VERSION, backendUrl: process.env.CHAT_BACKEND_URL }));
child.on('exit', code => process.exit(code || 0));
`;

async function fixture(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chat-dev-start-"));
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "bin/pnpm"), fakePnpm, { mode: 0o700 });
  const backend = await freePort();
  let frontend = await freePort();
  while (frontend === backend) frontend = await freePort();
  const child = spawn("bash", ["scripts/dev-start.sh", "--backend-port", String(backend), "--frontend-port", String(frontend)], {
    env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, CHAT_HOME: join(directory, "chat-home"), FAKE_STATE: directory, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    // If the assertion failed, do not leave fake HTTP descendants running.
    for (const name of ["backend", "frontend"]) {
      try {
        const state = JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
        for (const pid of [state.child, state.pid]) if (alive(pid)) process.kill(pid, "SIGKILL");
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { child, exited, directory, backend, output: () => output };
}

test("launcher passes frontend versions and backend address, then cleans up both process trees", { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await until(() => f.output().includes("Chat 开发环境已启动:"), "launcher did not become ready");
  const states = await Promise.all(["backend", "frontend"].map(async name => JSON.parse(await readFile(join(f.directory, `${name}.json`), "utf8"))));
  const frontendPackage = JSON.parse(await readFile("frontend/package.json", "utf8"));
  const piPackage = JSON.parse(await readFile("pi/packages/coding-agent/package.json", "utf8"));
  assert.equal(states[1].appVersion, frontendPackage.version);
  assert.equal(states[1].piVersion, piPackage.version);
  assert.equal(states[1].backendUrl, `http://127.0.0.1:${f.backend}`);
  assert.equal(states[0].home, join(f.directory, "chat-home"));
  f.child.kill("SIGTERM");
  assert.equal((await f.exited)[0], 143);
  await until(() => states.every(s => !alive(s.pid) && !alive(s.child)), "launcher leaked a descendant");
});

test("frontend startup failure exits nonzero and stops the backend", { timeout: 25000 }, async t => {
  const f = await fixture(t, { FAKE_FRONTEND_FAIL: "1" });
  assert.equal((await f.exited)[0], 1);
  const state = JSON.parse(await readFile(join(f.directory, "backend.json"), "utf8"));
  await until(() => !alive(state.pid) && !alive(state.child), "failed startup leaked the backend");
});

test("invalid or occupied ports are rejected without terminating the occupant", { timeout: 10000 }, async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const port of ["invalid", "0", "65536", String(server.address().port)]) {
      const child = spawn("bash", ["scripts/dev-start.sh", "--backend-port", port], { stdio: "ignore" });
      assert.equal((await once(child, "exit"))[0], 1);
    }
    assert.ok(server.listening);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
