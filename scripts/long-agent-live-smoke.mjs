// Explicit, paid-model acceptance only; deliberately excluded from pnpm verify/CI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mock } from "node:test";
import { parseArgs } from "node:util";
import { createRouter } from "nitro/h3";
import { ensureAgentHomeProject, openProject } from "../src/projects/registry.ts";
import { openChatSession } from "../src/chat-session.ts";
import { writeLongAgentRegistry, readLongAgentRegistry, readLongAgentState } from "../src/long-agents/storage.ts";
import { prepareLongAgentAssembly } from "../src/long-agents/assembly.ts";
import { createChatPiAgentSession } from "../src/agents/pi-agent-session.ts";
import { maintainLongAgentDays } from "../src/long-agents/daily-maintenance.ts";
import { readLongAgentSummary } from "../src/long-agents/summaries.ts";
import messages from "../src/routes/api/long-agents/[longAgentId]/messages.post.ts";
import daily from "../src/routes/api/long-agents/[longAgentId]/daily.get.ts";

const { values } = parseArgs({ options: {
  "allow-paid-model": { type: "boolean", default: false },
  "source-home": { type: "string" }, provider: { type: "string" }, model: { type: "string" },
} });
assert.equal(values["allow-paid-model"], true, "显式传入 --allow-paid-model；本命令会调用真实模型，不能加入 CI");
assert.ok(values["source-home"] && path.isAbsolute(values["source-home"]), "--source-home 必须是已授权的模型配置目录绝对路径");
assert.ok(values.provider && values.model, "必须明确指定 --provider 和 --model");
const sourceAgent = path.join(values["source-home"], "agent");
const providers = JSON.parse(fs.readFileSync(path.join(sourceAgent, "models.json"), "utf8")).providers;
const provider = providers[values.provider];
assert.ok(provider?.models?.some((model) => model.id === values.model), "所选模型不在指定目录中");
const origin = new URL(provider.baseUrl);
assert.equal(origin.protocol, "https:", "真实模型验收仅接受 HTTPS Provider");
const authPath = path.join(sourceAgent, "auth.json");
const auth = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : {};
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-friend-live-")));
const home = path.join(root, "home");
const previousHome = process.env.CHAT_HOME;
const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
process.env.CHAT_HOME = home;
process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "isolated-live-model-check-not-a-real-nano-token";
const realNow = Date.now();
const started = performance.now();
const report = { model: `${values.provider}/${values.model}`, endpointHost: origin.hostname,
  scope: "Real provider + production H3 handlers + shared Pi assembly; synthetic Nano identity; Date-only clock; no browser or external delivery",
  checks: [], replies: [], passed: false };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const pass = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
const session = (sessionId) => openChatSession({ chatHome: home, projectId: "live-friend", sessionId });
const router = createRouter();
router.post("/api/long-agents/:longAgentId/messages", messages);
router.get("/api/long-agents/:longAgentId/daily", daily);
async function send(requestId, contextProjectId, text) {
  console.log(`RUN message ${requestId}`);
  const begin = performance.now();
  const response = await router.fetch(new Request("http://isolated.test/api/long-agents/live-friend/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, projectId: "live-friend", contextProjectId, text }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, body.statusMessage ?? body.message ?? "消息执行失败");
  assert.equal(body.completed, true);
  assert.deepEqual(body.model, { provider: values.provider, modelId: values.model });
  report.replies.push({ requestId, sessionId: body.sessionId, elapsedMs: Math.round(performance.now() - begin), text: body.text });
  return body;
}
try {
  await ensureAgentHomeProject("live-friend", "Live Friend", home);
  write(path.join(home, "agent/models.json"), { providers: { [values.provider]: provider } });
  write(path.join(home, "agent/auth.json"), auth[values.provider] ? { [values.provider]: auth[values.provider] } : {});
  write(path.join(home, "agent/settings.json"), { defaultProvider: values.provider, defaultModel: values.model,
    compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1 } });
  await writeLongAgentRegistry({ schemaVersion: 1,
    instances: [{ id: "isolated", name: "Isolated fixture", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{ id: "live-friend", name: "Live Friend", description: "Temporary acceptance fixture", enabled: true,
      timeZone: "Asia/Shanghai", instanceId: "isolated", nanoclawAgentGroupId: "live-group", defaultProjectId: "live-friend",
      definition: { schemaVersion: 1, id: "live-friend", name: "Live Friend", description: "Temporary acceptance fixture",
        model: { provider: values.provider, modelId: values.model }, thinkingLevel: "off", systemPrompt: { mode: "pi-default" },
        customInstructions: ["使用中文简洁答复。只操作本轮已授权的测试项目，不寻找模型凭据。"],
        tools: { mode: "explicit", names: ["read", "write"], exclude: [], addresses: [] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } } }],
  }, home);
  // Model is real; Nano identity is synthetic to avoid reading or mutating a user's Friend.
  const snapshotDir = path.join(home, "runtime/long-agents/live-friend"); fs.mkdirSync(snapshotDir, { recursive: true });
  const revision = `sha256:${"a".repeat(64)}`;
  const memory = (file, content) => ({ path: file, content, size: Buffer.byteLength(content), updatedAt: new Date(realNow).toISOString(), revision });
  write(path.join(snapshotDir, "agent-group-snapshot.json"), { schemaVersion: 1, longAgentId: "live-friend", agentGroupId: "live-group",
    fetchedAt: new Date(realNow).toISOString(), snapshot: { id: "live-group", name: "Live Friend", standingInstructions: "你是验收用 Friend，跨项目保持身份。",
      revision, workspace: { folder: "live-friend", memoryFileCount: 2 }, coreMemory: {
        index: memory("index.md", "Synthetic test memory only."), definition: memory("system/definition.md", "Long-lived Friend acceptance identity."),
      } } });
  const nonce = randomBytes(5).toString("hex");
  const dirs = {};
  for (const id of ["alpha", "beta"]) {
    const cwd = path.join(root, id); fs.mkdirSync(cwd); dirs[id] = cwd;
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), `当前项目规则标记：RULE_${id}_${nonce}。这是用户项目，不是你的专属 Workspace。回复需注明本轮项目规则标记。`);
    fs.writeFileSync(path.join(cwd, "task.txt"), `FILE_${id}_${nonce}`);
    await openProject({ chatHome: home, path: cwd, id, name: id });
  }
  mock.timers.enable({ apis: ["Date"], now: realNow - 86_400_000 });
  const pending = `HANDOFF_${nonce}_BETA_PENDING`;
  const textA = "读取当前项目 task.txt，把读取到的内容逐字写入当前项目 result.txt。完成后报告本轮规则标记、项目名与你自己的 Workspace。";
  const a = await send("a", "alpha", textA);
  assert.equal(fs.readFileSync(path.join(dirs.alpha, "result.txt"), "utf8").trim(), `FILE_alpha_${nonce}`);
  assert.match(a.text, new RegExp(`RULE_alpha_${nonce}`));
  pass("project A: real read/write and AGENTS.md rule");
  const b = await send("b", "beta", `读取当前项目 task.txt，把读取到的内容逐字写入 result.txt，报告本轮规则标记。另外记住：明天待办是核对 beta 的验收清单，交接验证码为 ${pending}。此待办今天不执行，也不写入任何文件。`);
  assert.equal(fs.readFileSync(path.join(dirs.beta, "result.txt"), "utf8").trim(), `FILE_beta_${nonce}`);
  assert.equal(fs.readFileSync(path.join(dirs.alpha, "result.txt"), "utf8").trim(), `FILE_alpha_${nonce}`);
  assert.match(b.text, new RegExp(`RULE_beta_${nonce}`)); assert.equal(a.sessionId, b.sessionId);
  pass("project B: same Friend/day, isolated writes and updated rules");
  const beforeReplay = (await session(a.sessionId)).manager.getEntries().length;
  const replay = await send("a", "alpha", textA);
  assert.equal(replay.text, a.text); assert.equal((await session(a.sessionId)).manager.getEntries().length, beforeReplay);
  pass("duplicate request: existing output, no new native messages");
  const agent = (await readLongAgentRegistry(home)).agents[0];
  const chatSession = await session(a.sessionId);
  const prepared = await prepareLongAgentAssembly({ agent, chatHome: home, projectId: "beta", turnId: "live-compaction" });
  const created = await createChatPiAgentSession({ chatSession, sessionManager: chatSession.manager, ...prepared,
    toolContext: { purpose: "execution", agentId: agent.id, longAgentId: agent.id, longAgentTurnId: "live-compaction" } });
  console.log("RUN native compaction (real provider, native retry policy)");
  try { await created.session.compact("保留 alpha/beta 两个项目的工作事实、规则标记、待办及完整交接验证码。区分项目与 Friend Workspace。"); }
  finally { created.session.dispose(); }
  const compacted = (await session(a.sessionId)).manager.getEntries().filter((entry) => entry.type === "compaction");
  assert.equal(compacted.length, 1); assert.match(compacted[0].summary, new RegExp(pending));
  const continued = await send("after-compact", "beta", "读取当前项目 result.txt 核对结果，说明未完成的明天待办及交接验证码，今天不要执行。报告本轮规则标记。");
  assert.match(continued.text, new RegExp(pending)); assert.match(continued.text, new RegExp(`RULE_beta_${nonce}`));
  pass("real Pi compaction, reopen, tool call and unfinished-work continuity");
  mock.timers.setTime(realNow);
  console.log("RUN daily summary (real provider)");
  await maintainLongAgentDays(home);
  const oldDay = (await readLongAgentState(home)).dailySessions[0];
  assert.equal(oldDay.summary.status, "completed", oldDay.summary.error ?? "日终总结未完成");
  const summary = await readLongAgentSummary(home, agent.id, oldDay.date);
  assert.match(JSON.stringify(summary), new RegExp(pending)); assert.equal(summary.source.sessionId, a.sessionId);
  report.summary = summary;
  assert.equal((await readLongAgentState(home)).dailySessions.length, 1);
  await maintainLongAgentDays(home);
  assert.equal((await readLongAgentState(home)).dailySessions[0].summary.attempts, 1);
  pass("real-model day summary: JSON/source persisted, idempotent, no idle day");
  const next = await send("next-day", "beta", "根据昨天的交接，告诉我今天应继续哪个项目、什么待办，以及完整交接验证码。不要读文件，也先不要执行待办。报告本轮规则标记。");
  assert.notEqual(next.sessionId, a.sessionId); assert.match(next.text, new RegExp(pending)); assert.match(next.text, /beta/i);
  assert.match(next.text, new RegExp(`RULE_beta_${nonce}`));
  pass("new day: new native Session, yesterday handoff plus today's project rules");
  const view = await (await router.fetch(new Request("http://isolated.test/api/long-agents/live-friend/daily"))).json();
  assert.equal(view.days.length, 2); assert.ok(view.requests.every((request) => request.status === "completed"));
  const entries = [];
  for (const id of [a.sessionId, next.sessionId]) entries.push(...(await session(id)).manager.getEntries());
  const assistant = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
  report.usage = { nativeAssistantMessages: assistant.length, toolResults: entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length,
    input: assistant.reduce((sum, entry) => sum + entry.message.usage.input, 0), output: assistant.reduce((sum, entry) => sum + entry.message.usage.output, 0),
    cacheRead: assistant.reduce((sum, entry) => sum + entry.message.usage.cacheRead, 0),
    note: "Native assistant usage only; Pi compaction's internal request is not included." };
  pass("daily API: two dates and completed execution receipts");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  mock.timers.reset();
  report.elapsedMs = Math.round(performance.now() - started);
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.rmSync(home, { recursive: true, force: true });
  for (const id of ["alpha", "beta"]) fs.rmSync(path.join(root, id), { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousHome;
  if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken;
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, elapsedMs: report.elapsedMs, report: path.join(root, "report.json"), error: report.error }));
}
