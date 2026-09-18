import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { prepareTuiProject } from "./debug-tui.mjs";

test("TUI preparation waits for Backend, authenticates, and registers the server project", async t => {
  const requests = [];
  let healthChecks = 0, loginStatus = 200, projectId = "debug-lab";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, cookie: request.headers.cookie, body: body ? JSON.parse(body) : undefined });
    if (request.url === "/api/health") { response.writeHead(++healthChecks === 1 ? 503 : 200); response.end(); }
    else if (request.url === "/api/auth/session") {
      response.writeHead(loginStatus, { "Set-Cookie": "chat-session=test; HttpOnly; Path=/" }); response.end();
    } else if (request.url === "/api/projects/open") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ projectId }));
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const args = { url: `http://127.0.0.1:${server.address().port}`, username: "fixture", password: "fixture-only",
    projectPath: "/isolated/workspaces/debug-lab", signal: new AbortController().signal, timeoutMs: 2000 };
  await prepareTuiProject(args);
  assert.equal(healthChecks, 2);
  assert.deepEqual(requests.find(request => request.path === "/api/auth/session").body, { username: "fixture", password: "fixture-only" });
  const opened = requests.find(request => request.path === "/api/projects/open");
  assert.equal(opened.cookie, "chat-session=test");
  assert.deepEqual(opened.body, { path: args.projectPath });
  loginStatus = 401; requests.length = 0;
  await assert.rejects(prepareTuiProject(args), /login failed \(401\)/);
  assert.ok(!requests.some(request => request.path === "/api/projects/open"));
  loginStatus = 200; projectId = "unexpected";
  await assert.rejects(prepareTuiProject(args), /identity differs/);
  const cancellation = new AbortController(); cancellation.abort(); requests.length = 0;
  await assert.rejects(prepareTuiProject({ ...args, signal: cancellation.signal }), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("TUI launchers reject piped terminals before preparing services", async () => {
  for (const args of [["scripts/debug-launch.mjs", "tui"], ["scripts/debug-start.mjs", "--tui"]]) {
    const child = spawn(process.execPath, args, { stdio: "pipe" });
    let output = "";
    child.stderr.on("data", chunk => { output += chunk; });
    assert.notEqual((await once(child, "close"))[0], 0);
    assert.match(output, /interactive terminal/);
  }
});

test("stack services cannot consume foreground terminal input and are reaped on stop", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "chat-stack-stdin-"));
  await mkdir(join(root, "scripts"));
  const debug = join(root, "debug"); await mkdir(debug);
  for (const name of ["debug-start.mjs", "debug-processes.mjs"]) await copyFile(`scripts/${name}`, join(root, "scripts", name));
  const ports = {};
  const reservations = [];
  for (const role of ["model", "backend", "frontend"]) {
    const server = createServer().listen(0, "127.0.0.1"); await once(server, "listening");
    reservations.push(server); ports[role] = server.address().port;
  }
  await writeFile(join(root, "scripts/debug-environment.mjs"), `
    export const repositoryRoot=${JSON.stringify(root)},debugRoot=${JSON.stringify(debug)},ports=${JSON.stringify(ports)};
    export async function prepareDebug(){}
  `);
  // Real HTTP processes with a stdin reader reproduce Vite's shortcut ownership.
  await writeFile(join(root, "scripts/debug-launch.mjs"), `
    import {writeFileSync} from 'node:fs'; import {createServer} from 'node:http';
    import {debugRoot,ports} from './debug-environment.mjs';
    const role=process.argv[2]; let input='';
    process.stdin.on('data',chunk=>input+=chunk);
    process.stdin.on('end',()=>writeFileSync(debugRoot+'/'+role+'.input',input));
    const server=createServer((request,response)=>response.end('ready')).listen(ports[role],'127.0.0.1',()=>{
      writeFileSync(debugRoot+'/'+role+'.lock',JSON.stringify({owner:{pid:process.pid},child:{pid:process.pid}}));
    });
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
  `);
  await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  const child = spawn(process.execPath, [join(root, "scripts/debug-start.mjs")], { stdio: "pipe" });
  const exited = once(child, "close");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM"); await exited;
    for (const role of Object.keys(ports)) {
      try { const record = JSON.parse(await readFile(join(debug, role + ".lock"))); process.kill(record.child.pid, "SIGKILL"); }
      catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  child.stdin.end("DEBUG_HELLO\n");
  // Parallel tooling tests also spawn process trees; allow startup headroom
  // while still requiring HTTP readiness and verifying every child exits.
  for (let attempt = 0; attempt < 300 && !output.includes("Web ready:"); attempt++) {
    assert.equal(child.exitCode, null, output); await delay(50);
  }
  assert.match(output, /Web ready:/);
  for (const role of Object.keys(ports)) assert.equal(await readFile(join(debug, role + ".input"), "utf8"), "");
  child.kill("SIGTERM"); assert.equal((await exited)[0], 0);
  for (const role of Object.keys(ports)) {
    const record = JSON.parse(await readFile(join(debug, role + ".lock")));
    assert.throws(() => process.kill(record.child.pid, 0), { code: "ESRCH" });
  }
});
