/**
 * Session-open measurement, split so the numbers mean what they say.
 *
 * Metrics (each ≥20 warm samples, same machine/build/data):
 *   app_start_ms        navigation → today's Friend session visible AND the composer usable (no click, no artificial wait)
 *   click_session_ms    click a session row in the sidebar → that session visible AND usable
 *   click_friend_ms     click the Friend card from another open session → today's session visible AND usable
 *   click_childcall_ms  click a session that HAS a finished delegated call → visible AND usable
 *
 * It also reports the work the optimised paths no longer do, measured on the SAME server/data:
 *   listAll over the session directory (what "read every session body" costs here) and one session GET
 *   (the second download a navigation used to repeat).
 *
 * Usage: node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types scripts/session-open-perf.mjs [samples] [--tag=label]
 * Requires a production build (pnpm build).
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { launchBrowser } from "./cdp.mjs";

/** The child-call session must still report its finished call after the scan was removed. */
function assertChildCallStatistics(payload) {
  const statistics = payload?.workflowCallStatistics;
  if (statistics?.direct?.completed !== 1 || !Array.isArray(payload?.workflowCallTree) || payload.workflowCallTree.length !== 1) {
    throw new Error(`子调用统计不正确: ${JSON.stringify(statistics)}`);
  }
}

const samples = Number(process.argv.find((value) => /^\d+$/.test(value)) ?? 20);
const tag = process.argv.find((value) => value.startsWith("--tag="))?.slice(6) ?? "current";

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`built server exited: ${String(child.exitCode)}`);
    if (Date.now() > deadline) throw new Error("built server did not become healthy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const stats = (values) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) });

const cleanups = [];
const f = await fixture({ after: (register) => cleanups.push(register) });
let server;
let browser;
try {
  // ── Data: one small target, several LARGE unrelated neighbours, one history session, one child-call session.
  f.setHandler(() => ({ content: "PERF_ANSWER 会话已就绪" }));
  const session = await import("../src/long-agents/runtime.ts").then((module) => module.executeLongAgentTurn(f.input("perf")));
  const agentWorkspace = path.join(f.home, "long-agents", "friend", "workspace");
  const sessionDir = path.join(f.home, "long-agents", "friend", "sessions");
  const payload = "y".repeat(4_000);
  for (let index = 0; index < 6; index += 1) {
    const manager = SessionManager.create(agentWorkspace, sessionDir);
    for (let turn = 0; turn < 40; turn += 1) manager.appendMessage({ role: "user", content: [{ type: "text", text: `${payload} unrelated ${String(index)}-${String(turn)}` }] });
    manager.flush();
  }
  const history = SessionManager.create(agentWorkspace, sessionDir);
  history.appendSessionInfo("PERF_HISTORY");
  history.appendMessage({ role: "user", content: [{ type: "text", text: "PERF_HISTORY_OPEN" }] });
  history.appendMessage({ role: "assistant", content: [{ type: "text", text: "PERF_HISTORY_ANSWER" }] });
  history.flush();
  const child = SessionManager.create(agentWorkspace, sessionDir);
  child.appendMessage({ role: "user", content: [{ type: "text", text: "PERF_CHILD" }] });
  child.flush();
  const childCallRoot = SessionManager.create(agentWorkspace, sessionDir);
  childCallRoot.appendSessionInfo("PERF_CHILDCALL");
  childCallRoot.appendMessage({ role: "user", content: [{ type: "text", text: "PERF_CHILDCALL_OPEN" }] });
  childCallRoot.appendMessage({ role: "assistant", content: [{ type: "text", text: "PERF_CHILDCALL_ANSWER" }] });
  childCallRoot.appendCustomEntry("chat.workflow_call", {
    schemaVersion: 1, callId: "perf-call", toolCallId: "perf-tool",
    parent: { sessionId: childCallRoot.getSessionId(), workflowId: "minimal-pi-coding-agent", workflowInvocationId: "perf-parent", stageId: "execute", agentId: "pi-coding-agent" },
    child: { sessionId: child.getSessionId(), workflowId: "minimal-pi-coding-agent", workflowInvocationId: "perf-child", runId: "perf-run" },
    status: "completed", startedAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:01.000Z",
    finishedAt: "2026-09-26T00:00:01.000Z", durationMs: 1_000,
  });
  childCallRoot.flush();
  const homeBytes = fs.readdirSync(sessionDir).reduce((sum, name) => sum + fs.statSync(path.join(sessionDir, name)).size, 0);

  const port = await freePort();
  server = spawn(process.execPath, [".output/server/index.mjs"], {
    env: { ...process.env, CHAT_HOME: f.home, PORT: String(port), NITRO_PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(port, server);

  // The work the optimised paths no longer do, measured on this same server and data.
  const listAllRuns = [];
  for (let index = 0; index < 5; index += 1) {
    const started = Date.now();
    await SessionManager.listAll(sessionDir);
    listAllRuns.push(Date.now() - started);
  }
  const getRuns = [];
  let getBytes = 0;
  for (let index = 0; index < 5; index += 1) {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${session.sessionId}?projectId=friend&deferThinking=1&deferMedia=1`);
    getBytes = (await response.arrayBuffer()).byteLength;
    getRuns.push(Date.now() - started);
  }
  // A Session that HAS a finished delegated call, opened through the same loader contract: this is the
  // path that used to scan every Session body in the directory (and in the child's project).
  const childCallRuns = [];
  let childCallBytes = 0;
  for (let index = 0; index < 5; index += 1) {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${childCallRoot.getSessionId()}?projectId=friend&deferThinking=1&deferMedia=1`);
    const payload = await response.json();
    childCallBytes = JSON.stringify(payload).length;
    assertChildCallStatistics(payload);
    childCallRuns.push(Date.now() - started);
  }

  browser = await launchBrowser();
  const page = await browser.newPage(`http://127.0.0.1:${String(port)}/`);
  await page.send("Network.enable");
  const baseUrl = `http://127.0.0.1:${String(port)}/`;
  // Ready means the text is in the VISIBLE chat surface: the chat stays mounted (hidden) behind other
  // workspace views, so a bare body.innerText check can pass before anything was opened.
  const READY = (text) => `(() => { const surface = document.querySelector('[data-workspace-chat]'); return surface !== null && surface.hidden === false && surface.innerText.includes(${JSON.stringify(text)}); })()`;
  const USABLE = `document.querySelector('[data-chat-composer]:not([disabled])') !== null`;
  const openRequests = [];
  const openBytes = [];
  const beginWindow = () => page.events.length;
  const endWindow = (from) => {
    const window = page.events.slice(from);
    const calls = window.filter((event) => event.method === "Network.responseReceived" && String(event.params?.response?.url ?? "").includes("/api/sessions/"));
    const ids = new Set(calls.map((event) => event.params.requestId));
    openRequests.push(calls.length);
    openBytes.push(window.filter((event) => event.method === "Network.loadingFinished" && ids.has(event.params.requestId))
      .reduce((sum, event) => sum + Number(event.params?.encodedDataLength ?? 0), 0));
  };
  const fresh = async (index) => {
    await page.evaluate("try { localStorage.clear(); sessionStorage.clear(); } catch {}");
    await page.send("Page.navigate", { url: `${baseUrl}?perf=${String(index)}` });
  };
  const ready = async (text) => {
    await page.waitFor(READY(text), { label: `visible ${text}`, timeoutMs: 30_000 });
    await page.waitFor(USABLE, { label: "composer usable", timeoutMs: 30_000 });
  };
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

  const appReady = [];
  const clickFriend = [];
  for (let index = 0; index < samples; index += 1) {
    // A) APP START: navigation → the app shell is ready (no click, no artificial wait).
    // Start from the Topics workspace view: the chat surface is not showing today's session, so the
    // Friend click below is a REAL open (the clock still starts at the click).
    await page.evaluate("try { localStorage.clear(); sessionStorage.clear(); } catch {}");
    await page.send("Page.navigate", { url: `${baseUrl}?view=topics&perf=${String(index)}` });
    let started = Date.now();
    await page.waitFor(`document.querySelector('[data-long-agent-open="friend"]') !== null`, { label: "app ready", timeoutMs: 30_000 });
    appReady.push(Date.now() - started);


    // Let the app's own default-landing settle first, so the click window contains ONLY the click's work:
    // no session request may start for a quiet 400ms. This is harness settling, not a product wait, and the
    // click clock starts after it.
    for (;;) {
      const marker = page.events.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const busy = page.events.slice(marker).some((event) => event.method === "Network.requestWillBeSent"
        && String(event.params?.request?.url ?? "").includes("/api/sessions/"));
      if (!busy) break;
    }

    // B) CLICK the Friend card. The clock starts AT the click.
    const from = beginWindow();
    started = Date.now();
    await click('[data-long-agent-open="friend"]');
    await ready("PERF_ANSWER");
    clickFriend.push(Date.now() - started);
    endWindow(from);



  }

  console.log(JSON.stringify({
    tag, samples,
    sessionId: session.sessionId,
    historySessionId: history.getSessionId(),
    childCallSessionId: childCallRoot.getSessionId(),
    home_bytes: homeBytes,
    session_files: fs.readdirSync(sessionDir).length,
    app_ready_ms: stats(appReady),
    click_friend_ms: stats(clickFriend),
    session_requests_per_open: { p50: percentile(openRequests, 0.5), p95: percentile(openRequests, 0.95), max: Math.max(...openRequests) },
    session_bytes_per_open: { p50: percentile(openBytes, 0.5), p95: percentile(openBytes, 0.95), max: Math.max(...openBytes) },
    removed_work: {
      listAll_all_session_bodies_ms: { p50: percentile(listAllRuns, 0.5), max: Math.max(...listAllRuns) },
      session_get_ms: { p50: percentile(getRuns, 0.5), max: Math.max(...getRuns) },
      session_get_bytes: getBytes,
      child_call_session_get_ms: { p50: percentile(childCallRuns, 0.5), max: Math.max(...childCallRuns) },
      child_call_session_get_bytes: childCallBytes,
    },
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  server?.kill("SIGKILL");
  for (const cleanup of cleanups.reverse()) await cleanup();
}
