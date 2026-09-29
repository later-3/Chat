import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { isSessionMemoryWriterRequest } from "./fake-model-stages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const selected = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return selected;
}

test("Friend keeps its Pi Session while switching default -> reviewed Workflow -> default through real Runtime", { timeout: 240_000 }, async t => {
  const cleanup = [];
  const f = await fixture({ after: fn => cleanup.push(fn) });
  const buildDir = fs.mkdtempSync(path.join(root, "node_modules/.nitro-unified-session-"));
  const selectedPort = await port();
  const base = `http://127.0.0.1:${selectedPort}`;
  let output = "";
  f.setHandler(body => {
    if (isSessionMemoryWriterRequest(body.messages)) return { content: "本轮无需写入" };
    const system = body.messages.filter(m => m.role === "system").map(m => JSON.stringify(m.content)).join("\n");
    if (system.includes("你是Planning Execution Workflow中的Planner Agent")) return { content:
      '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\n# Plan\nAnswer with the approved result.' };
    return { content: `Unified answer ${f.requests.length}` };
  });
  const launch = () => spawn(process.execPath, [path.join(root, "node_modules/nitro/dist/cli/index.mjs"), "dev", "--host", "127.0.0.1", "--port", String(selectedPort)], {
    cwd: root, env: { ...process.env, CHAT_HOME: f.home, CHAT_NITRO_BUILD_DIR: buildDir,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(f.home, "runtime/workflow-data"), WORKFLOW_LOCAL_BASE_URL: base, MEM0_TELEMETRY: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let server = launch();
  function observeServer() { server.stdout.on("data", chunk => { output += chunk; }); server.stderr.on("data", chunk => { output += chunk; }); }
  observeServer();
  t.after(async () => {
    server.kill("SIGINT");
    await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
    if (process.env.UNIFIED_DEBUG === "1") console.log(output);
    fs.rmSync(buildDir, { recursive: true, force: true });
    for (const fn of cleanup) await fn();
  });
  async function wait(read, predicate, timeout = 30_000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await read(); if (predicate(last)) return last; } catch (error) { last = String(error); }
      await pause(50);
    }
    assert.fail(`${JSON.stringify(last)}\n${output.slice(-15_000)}`);
  }
  await wait(async () => (await fetch(`${base}/api/health`)).status, value => value === 200, 90_000);
  let sessionId;
  const post = async (workflow, memory = "off", text = `Continue ${workflow}`) => {
    const response = await fetch(`${base}/api/long-agents/friend/turns`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: 1,
        requestId: `${workflow}-${f.requests.length}`, ...(workflow === undefined ? {} : {workflow}), text,
        sessionMemory: memory, contextProjectId: null, ...(sessionId ? { sessionId } : {}) }) });
    const value = await response.json();
    assert.equal(response.status, 202, JSON.stringify(value));
    if (sessionId) assert.equal(value.sessionId, sessionId); else sessionId = value.sessionId;
    return value;
  };
  const receipt = ref => fetch(`${base}/api/long-agents/friend/turns/${encodeURIComponent(ref.id)}`).then(r => r.json());
  const first = await post(undefined, "off", "Continue minimal-pi-coding-agent");
  const finished = await wait(() => receipt(first), v => ["completed", "failed", "interrupted"].includes(v.execution?.status));
  assert.equal(finished.execution.status, "completed", JSON.stringify(finished.execution) + output.slice(-10000));
  assert.ok(finished.execution.workflow.runId.startsWith("wrun_"));
  assert.equal((await fetch(`${base}/api/long-agents/friend/turns/${encodeURIComponent(first.id)}`,{method:"DELETE"})).status,200,"stopping an ended run is idempotent");
  assert.match(JSON.stringify(f.requests[0]), /Stable Friend/);

  const second = await post("planning-execution");
  const bound = await wait(() => receipt(second), v => typeof v.execution?.workflow?.runId === "string");
  const wf = bound.execution.workflow;
  const query = new URLSearchParams({ projectId: "friend", workflowInvocationId: wf.invocationId });
  const review = await wait(() => fetch(`${base}/runs/${wf.runId}?${query}`).then(r => r.json()), v => v.phase === "waiting_review" || v.status === "failed");
  assert.equal(review.phase, "waiting_review", JSON.stringify(review) + output.slice(-10000));
  const reviewMaintenance = await fetch(`${base}/api/sessions/${sessionId}/maintenance?projectId=friend`).then(r=>r.json());
  const busyCompaction = await fetch(`${base}/api/sessions/${sessionId}/maintenance`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:"friend",requestId:"during-review",kind:"compact",expectedLeafId:reviewMaintenance.leafId})});
  assert.equal(busyCompaction.status,409,"a waiting Workflow owns its Session and refuses manual compaction");
  // A review survives an actual Backend process replacement; the receipt retains the SAME SDK run.
  const exited = new Promise(resolve => server.once("exit", resolve));
  server.kill("SIGKILL"); await exited;
  server = launch(); observeServer();
  await wait(async () => (await fetch(`${base}/api/health`)).status, value => value === 200, 90_000);
  const restored = await wait(() => receipt(second), v => v.execution?.workflow?.runId === wf.runId);
  assert.equal(restored.execution.workflow.invocationId, wf.invocationId);
  const decision = await fetch(`${base}/runs/${wf.runId}/review`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "friend", decision: { kind: "approve", reviewId: review.review.reviewId,
      workflowInvocationId: wf.invocationId, planRevision: review.review.planRevision, planSha256: review.review.planSha256 } }) });
  assert.ok(decision.ok, await decision.text());
  const secondDone = await wait(() => receipt(second), v => ["completed", "failed"].includes(v.execution?.status));
  assert.equal(secondDone.execution.status, "completed", JSON.stringify(secondDone.execution) + output.slice(-10000));
  const third = await post("minimal-pi-coding-agent", "on");
  const thirdDone = await wait(() => receipt(third), v => ["completed", "failed"].includes(v.execution?.status));
  assert.equal(thirdDone.execution.status, "completed", JSON.stringify(thirdDone.execution));
  const detail = await fetch(`${base}/api/sessions/${sessionId}?projectId=friend`).then(r => r.json());
  assert.equal(detail.sessionId, sessionId);
  assert.equal(detail.context.messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes("Continue ")).length, 3);
  const workRequests = f.requests.filter(body => !isSessionMemoryWriterRequest(body.messages));
  assert.match(JSON.stringify(workRequests.at(-1)), /Continue planning-execution/);
  const memory = f.requests.filter(body => isSessionMemoryWriterRequest(body.messages));
  assert.equal(memory.length, 1);
  assert.match(JSON.stringify(memory[0]), /Continue minimal-pi-coding-agent/);
  assert.doesNotMatch(JSON.stringify(memory[0]), /Continue planning-execution/);

  // Cancellation uses the public Friend control while Pi is inside the shared memory Step.
  let writerStarted;
  const arrived = new Promise(resolve => { writerStarted = resolve; });
  let releaseWriter;
  const release = new Promise(resolve => { releaseWriter = resolve; });
  f.setHandler(async body => {
    if (isSessionMemoryWriterRequest(body.messages)) { writerStarted(); await release; return {content:"unused memory"}; }
    return {content:"ANSWER_BEFORE_MEMORY"};
  });
  const cancelling = await post("minimal-pi-coding-agent", "on", "Stop in memory");
  let deadline;
  try { await Promise.race([arrived, new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error("writer not reached"+output.slice(-8000))),30000);})]); }
  finally { clearTimeout(deadline); }
  assert.equal((await receipt(cancelling)).execution.capabilities.steer,false,"memory cannot consume work steering");
  const stop = await fetch(`${base}/api/long-agents/friend/turns/${encodeURIComponent(cancelling.id)}`, {method:"DELETE"});
  releaseWriter();
  assert.ok(stop.ok, await stop.text());
  const cancelled = await wait(() => receipt(cancelling), v => ["cancelled","failed","completed"].includes(v.execution?.status));
  assert.equal(cancelled.execution.status, "cancelled", JSON.stringify(cancelled.execution) + output.slice(-8000));

  // Native compaction in the work Step must still bound the writer's next provider request. This
  // exercises Nitro's real bundle, Workflow Run, public assembly, Pi, and the HTTP model transport.
  const settingsPath = path.join(f.home, "agent/settings.json");
  const originalSettings = fs.readFileSync(settingsPath, "utf8");
  const compactingSettings = JSON.parse(originalSettings);
  compactingSettings.compaction.enabled = true;
  fs.writeFileSync(settingsPath, JSON.stringify(compactingSettings));
  let workResponded = false;
  let writerRequest;
  f.setHandler(body => {
    if (isSessionMemoryWriterRequest(body.messages)) {
      writerRequest = body;
      return { content: "本轮无需写入" };
    }
    if (!workResponded) {
      workResponded = true;
      return { content: "WORK_BEFORE_NATIVE_COMPACTION", usage: { prompt_tokens: 127000, completion_tokens: 10, total_tokens: 127010 } };
    }
    return { content: "NATIVE_COMPACTED_ROUND: preserve the current task conclusion and distinguish prior history." };
  });
  const compacting = await post("minimal-pi-coding-agent", "on", "RAW_ROUND_TEXT_MUST_NOT_RETURN " + "long round context ".repeat(1000));
  const compacted = await wait(() => receipt(compacting), v => ["completed", "failed"].includes(v.execution?.status));
  assert.equal(compacted.execution.status, "completed", JSON.stringify(compacted.execution) + output.slice(-8000));
  assert.ok(writerRequest, "the actual writer provider request was observed");
  assert.match(JSON.stringify(writerRequest.messages), /NATIVE_COMPACTED_ROUND/);
  assert.doesNotMatch(JSON.stringify(writerRequest.messages), /RAW_ROUND_TEXT_MUST_NOT_RETURN/,
    "a transform must not restore archived user text after native compaction");
  const afterCompaction = await fetch(`${base}/api/sessions/${sessionId}?projectId=friend`).then(r => r.json());
  assert.equal(afterCompaction.sessionId, sessionId);
  assert.match(JSON.stringify(afterCompaction.context.messages), /NATIVE_COMPACTED_ROUND/);
  fs.writeFileSync(settingsPath, originalSettings);

  // Failed and cancelled summaries must not become durable checkpoints. All control operations
  // here go through the actual HTTP acceptance/Workflow/Step chain (no mocked transport).
  const { openChatSession: openCompactionSession } = await import("../src/chat-session.ts");
  const readNative = async () => (await openCompactionSession({chatHome:f.home, projectId:"friend", sessionId})).manager;
  for (const scenario of ["length", "quota", "cancel", "crash"]) {
    fs.writeFileSync(settingsPath, JSON.stringify({ ...compactingSettings,
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000, provider: { maxRetries: 0 } } }));
    const initialEntries = (await readNative()).getEntries();
    const compactionsBefore = initialEntries.filter(e => e.type === "compaction").length;
    let summaryArrived = false;
    let releaseSummary;
    const heldSummary = new Promise(resolve => { releaseSummary = resolve; });
    f.setHandler(async body => {
      const isSummary = JSON.stringify(body.messages.filter(m=>m.role === "system")).includes("context summarization assistant");
      if (!isSummary) return { content:`ANSWER_BEFORE_${scenario}`, usage:{prompt_tokens:127000,completion_tokens:10,total_tokens:127010} };
      summaryArrived = true;
      if (scenario === "crash") { await heldSummary; return {content:"DISCARDED_AFTER_CRASH"}; }
      if (scenario === "length") return {content:"UNSAFE_TRUNCATED_CHECKPOINT",finishReason:"length"};
      return {error:scenario === "cancel" ? "terminated" : "insufficient_quota"};
    });
    const ref = await post("minimal-pi-coding-agent", "off", `PRESERVE_${scenario}_HISTORY ` + "history ".repeat(100));
    const streamed = scenario === "crash" ? null : fetch(`${base}/api/long-agents/friend/turns/${encodeURIComponent(ref.id)}/events?after=0`).then(r=>r.text());
    await wait(async()=>summaryArrived, Boolean);
    if (scenario === "cancel") {
      // The provider's transient error enters native backoff; cancel through the public control.
      const stop = await fetch(`${base}/api/long-agents/friend/turns/${encodeURIComponent(ref.id)}`, {method:"DELETE"});
      assert.ok(stop.ok, await stop.text());
    }
    if (scenario === "crash") {
      const died = new Promise(resolve=>server.once("exit",resolve));
      server.kill("SIGKILL"); await died; releaseSummary();
      const count = f.requests.length;
      server = launch(); observeServer();
      await wait(async()=>(await fetch(`${base}/api/health`)).status,v=>v===200,90_000);
      const ended = await wait(()=>receipt(ref),v=>["interrupted","failed","completed"].includes(v.execution?.status));
      assert.equal(ended.execution.status,"interrupted");
      assert.equal(f.requests.length,count,"restart must not repeat an uncertain summary or work request");
    } else {
      const ended = await wait(()=>receipt(ref),v=>["completed","cancelled","failed"].includes(v.execution?.status));
      assert.equal(ended.execution.status,scenario === "cancel" ? "cancelled" : "completed",JSON.stringify(ended));
      const events = await streamed;
      assert.match(events,/compaction_end/);
      assert.match(events,scenario === "cancel" ? /"aborted":true/ : /token cap|quota/);
    }
    const saved = (await readNative()).getEntries();
    assert.equal(saved.filter(e=>e.type === "compaction").length,compactionsBefore);
    assert.match(JSON.stringify(saved),new RegExp(`PRESERVE_${scenario}_HISTORY`));
    assert.doesNotMatch(JSON.stringify(saved),/UNSAFE_TRUNCATED_CHECKPOINT|DISCARDED_AFTER_CRASH/);
    // Restore settings and continue through a NEW accepted turn of the SAME Session.
    fs.writeFileSync(settingsPath, originalSettings);
    f.setHandler(()=>({content:`RECOVERED_${scenario}`}));
    const continuation = await post("minimal-pi-coding-agent","off",`Continue after ${scenario}`);
    const resumed = await wait(()=>receipt(continuation),v=>["completed","failed"].includes(v.execution?.status));
    assert.equal(resumed.execution.status,"completed",JSON.stringify(resumed));
    assert.match(JSON.stringify(f.requests.at(-1)),new RegExp(`PRESERVE_${scenario}_HISTORY`));
  }

  // User-facing native controls use the same Session, survive refresh/restart and never replay work.
  const maintenanceUrl = `${base}/api/sessions/${sessionId}/maintenance`;
  const readMaintenance = () => fetch(`${maintenanceUrl}?projectId=friend`).then(r => r.json());
  const maintain = body => fetch(maintenanceUrl, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const statsBefore = await readMaintenance();
  assert.equal(statsBefore.schemaVersion,1); assert.equal(statsBefore.capabilities.compact,true);
  assert.ok(statsBefore.stats.tokens.total > 0);
  f.setHandler(()=>({content:"MANUAL_NATIVE_SUMMARY"}));
  const compactInput = {projectId:"friend",requestId:"manual-compact",kind:"compact",expectedLeafId:statsBefore.leafId};
  assert.equal((await maintain(compactInput)).status,202);
  const manualCompacted = await wait(readMaintenance,v=>v.operation?.status!=="running");
  assert.equal(manualCompacted.operation.status,"completed",JSON.stringify(manualCompacted));
  assert.equal(manualCompacted.stats.contextUsage.tokens,null);
  const callsAfterCompact=f.requests.length;
  assert.equal((await (await maintain(compactInput)).json()).status,"completed");
  assert.equal(f.requests.length,callsAfterCompact);
  assert.equal((await maintain({...compactInput,requestId:"stale-client"})).status,409);

  const oldAssistant = (await readNative()).getEntries().find(e=>e.type==="message"&&e.message.role==="assistant"&&e.message.stopReason==="stop");
  const continued = await maintain({projectId:"friend",requestId:"continue-history",kind:"continue",entryId:oldAssistant.id,expectedLeafId:manualCompacted.leafId});
  assert.equal(continued.status,200,await continued.text());
  assert.doesNotMatch(JSON.stringify((await readNative()).buildSessionContext().messages),/RECOVERED_crash/);
  assert.match(JSON.stringify((await readNative()).getEntries()),/RECOVERED_crash/);
  f.setHandler(()=>({content:"CONTINUED_NATIVE_BRANCH"}));
  const branchTurn=await post("minimal-pi-coding-agent","off","Continue selected historical branch");
  assert.equal((await wait(()=>receipt(branchTurn),v=>["completed","failed"].includes(v.execution?.status))).execution.status,"completed");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)),/RECOVERED_crash/);

  let manualEntered=false, releaseManual;
  const manualGate=new Promise(resolve=>{releaseManual=resolve});
  f.setHandler(async()=>{manualEntered=true;await manualGate;return{content:"DISCARDED_MANUAL_CRASH"}});
  const crashInput={projectId:"friend",requestId:"manual-crash",kind:"compact",expectedLeafId:(await readMaintenance()).leafId};
  assert.equal((await maintain(crashInput)).status,202);
  await wait(async()=>manualEntered,Boolean);
  assert.equal((await readMaintenance()).operation.status,"running","refresh observes the accepted native operation");
  assert.equal((await maintain({...crashInput,requestId:"while-busy"})).status,409);
  const manualDead=new Promise(resolve=>server.once("exit",resolve));server.kill("SIGKILL");await manualDead;releaseManual();
  const manualCalls=f.requests.length;server=launch();observeServer();
  await wait(async()=>(await fetch(`${base}/api/health`)).status,v=>v===200,90000);
  assert.equal((await readMaintenance()).operation.status,"interrupted");
  assert.equal((await (await maintain(crashInput)).json()).status,"interrupted");
  assert.equal(f.requests.length,manualCalls,"manual maintenance is never replayed after Backend replacement");
  assert.doesNotMatch(JSON.stringify((await readNative()).getEntries()),/DISCARDED_MANUAL_CRASH/);

  // The all-project roster observes native edits and supports conditional polling without stale authority.
  const roster = await fetch(`${base}/api/sessions/overview`);
  const etag = roster.headers.get("etag");
  const page = await roster.json();
  assert.ok(page.sessions.some(item => item.id === sessionId));
  assert.equal((await fetch(`${base}/api/sessions/overview`, {headers:{"If-None-Match":etag}})).status,304);
  const {openChatSession} = await import("../src/chat-session.ts");
  const native = await openChatSession({chatHome:f.home,projectId:"friend",sessionId});
  native.manager.appendSessionInfo("Renamed outside the browser"); native.manager.flush();
  const changed = await fetch(`${base}/api/sessions/overview`, {headers:{"If-None-Match":etag}});
  assert.equal(changed.status,200);
  assert.equal((await changed.json()).sessions.find(item=>item.id===sessionId).name,"Renamed outside the browser");

  // A Topic's selected business Workflow uses the same SDK (not the default Friend work helper).
  f.setHandler(() => ({content:"DIAGNOSIS_IN_NODE"}));
  const {createTopic,createTopicNodeWithSession} = await import("../src/long-agents/topics.ts");
  const topic = (await createTopic({chatHome:f.home,longAgentId:"friend",title:"Runtime topic",purpose:"test",requestId:"sdk-topic",expectedRevision:0})).topic;
  const node = (await createTopicNodeWithSession({chatHome:f.home,longAgentId:"friend",topicId:topic.topicId,title:"SDK node",requestId:"sdk-topic",createdBy:"agent",sessionMemory:"off"})).node;
  const nodeResponse = await fetch(`${base}/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.nodeId}/messages`, {
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({schemaVersion:1,requestId:"node-diagnosis",workflow:"problem-diagnosis",text:"Diagnose this problem"})});
  assert.equal(nodeResponse.status,202);
  const nodeRef = await nodeResponse.json();
  const nodeDone = await wait(()=>receipt(nodeRef),v=>["completed","failed"].includes(v.execution?.status));
  assert.equal(nodeDone.execution.status,"completed",JSON.stringify(nodeDone));
  assert.equal(nodeDone.execution.workflow.id,"problem-diagnosis");
  assert.ok(nodeDone.execution.workflow.runId.startsWith("wrun_"));
  const anchors = await fetch(`${base}/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.nodeId}/anchors`).then(r=>r.json());
  assert.equal(anchors.anchors.length,1);

  // Losing an executing Pi Step is not permission to replay tools. Both stages become interrupted;
  // a waiting review above, in contrast, resumed the same durable hook after process replacement.
  for (const phase of ["work","remember"]) {
    let entered = false, releaseModel;
    const modelGate = new Promise(resolve=>{releaseModel=resolve});
    f.setHandler(async body => {
      if ((phase === "remember") === isSessionMemoryWriterRequest(body.messages)) {
        entered=true; await modelGate; return {content:"IGNORED_AFTER_CRASH"};
      }
      return {content:"WORK_BEFORE_CRASH"};
    });
    const crashed = await post("minimal-pi-coding-agent",phase === "remember" ? "on" : "off",`Crash ${phase}`);
    await wait(async()=>entered,v=>v===true);
    const requestsBefore = f.requests.length;
    const dead = new Promise(resolve=>server.once("exit",resolve));
    server.kill("SIGKILL"); await dead; releaseModel();
    server=launch();observeServer();
    await wait(async()=>(await fetch(`${base}/api/health`)).status,v=>v===200,90000);
    const recovered = await wait(()=>receipt(crashed),v=>["interrupted","failed","completed"].includes(v.execution?.status));
    assert.equal(recovered.execution.status,"interrupted",JSON.stringify(recovered.execution)+output.slice(-8000));
    assert.equal(f.requests.length,requestsBefore,"recovery must not replay an uncertain model/tool step");
  }

});
