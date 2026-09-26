import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../long-agents/daily-fixture.mjs";
import { appendTopicCreationDraft, canonicalTopicDraftJson, parseTopicCreationDraft, planSha256Hex, readTopicCreationDraft, renderTopicCreationPreview } from "../../src/workflows/topic-session-create/creation-draft.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { readTopicGraph } from "../../src/long-agents/topics.ts";
import { writeSessionMemoryEntry } from "../../src/long-agents/session-memory.ts";

const VALID_DOCUMENT = [
  "<!-- chat-planner-output {\"schemaVersion\":1,\"readiness\":\"ready_for_review\",\"blockingQuestions\":[]} -->",
  "<!-- chat-topic-draft {\"title\":\"订单页空指针\",\"purpose\":\"定位并沉淀\",\"integrationSummary\":\"userId 为 null\",\"frozenProjectContext\":null,\"initialMemory\":[]} -->",
].join("\n");

test("topic-session-create: the draft is the single source; the preview is its deterministic render and a second prose copy is rejected", () => {
  const { draft } = parseTopicCreationDraft(VALID_DOCUMENT);
  assert.equal(draft.title, "订单页空指针");
  assert.equal(draft.frozenProjectContext, null);
  assert.deepEqual(draft.initialMemory, []);
  const preview = renderTopicCreationPreview(draft);
  assert.match(preview, /# 订单页空指针/);
  assert.match(preview, /无协作项目/);
  assert.doesNotMatch(preview, /chat-topic-draft/, "the machine draft never reaches the preview");
  // The preview is a pure function of the draft: the same draft always renders the same text.
  assert.equal(renderTopicCreationPreview(draft), preview);
  assert.equal(planSha256Hex(canonicalTopicDraftJson(draft)).length, 64);

  // A second, independently authored prose copy is refused: it could contradict the draft.
  assert.throws(
    () => parseTopicCreationDraft([VALID_DOCUMENT.split("\n")[0], "# 另一份正文", VALID_DOCUMENT.split("\n")[1]].join("\n")),
    /只能包含结构化草稿/,
  );
  assert.throws(() => parseTopicCreationDraft("# 没有草稿注释"), /chat-topic-draft/);
  // A different draft hashes and renders differently.
  const other = { ...draft, frozenProjectContext: "collab" };
  assert.notEqual(planSha256Hex(canonicalTopicDraftJson(other)), planSha256Hex(canonicalTopicDraftJson(draft)));
  assert.match(renderTopicCreationPreview(other), /collab/);
});

test("topic-session-create: commit_creation creates the real node from the APPROVED draft and cannot be re-targeted", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  t.after(() => { if (previousHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousHome; });
  const { writeLongAgentRegistry, readLongAgentRegistry, readLongAgentState } = await import("../../src/long-agents/storage.ts");
  const registry = await readLongAgentRegistry(base.home);
  const friend = registry.agents.find((agent) => agent.id === "friend");
  friend.definition = { ...friend.definition, tools: { ...friend.definition.tools, addresses: ["system:tool/topic_manage"] } };
  await writeLongAgentRegistry(registry, base.home);

  // A real daily session + memory entry gives the approved draft real provenance.
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { registerFauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/compat");
  const faux = registerFauxProvider({ api: "chat-topic-create-faux", provider: "chat-topic-create-faux" });
  t.after(() => faux.unregister());
  const model = faux.getModel();
  fs.writeFileSync(path.join(base.home, "agent/settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false } }));
  fs.writeFileSync(path.join(base.home, "agent/models.json"), JSON.stringify({ providers: { [model.provider]: {
    baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key", models: [{ id: model.id, name: model.name,
      reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } } }));
  faux.setResponses([fauxAssistantMessage("今天的现场记录")]);
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend", turnId: "tc-daily-1", text: "记录现场", source: "chat-web" });
  await drainLongAgentTurns(base.home, "friend");
  const daily = (await readLongAgentState(base.home)).dailySessions.find((day) => day.longAgentId === "friend");
  const memory = (await writeSessionMemoryEntry({ chatHome: base.home, longAgentId: "friend", sessionId: daily.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "空指针来源", expectedRevision: 0 })).entries.at(-1);

  const prepareSessionId = "topic-create-tc-1";
  const { session: prepare } = await ensureChatSessionWithId({ chatHome: base.home, projectId: "friend" }, prepareSessionId, "主题创建");
  const draft = { title: "订单页空指针", purpose: "定位并沉淀", integrationSummary: "userId 为 null",
    frozenProjectContext: null, initialMemory: [{ storageProjectId: "friend", sessionId: daily.sessionId, entryId: memory.entryId, content: "空指针来源" }] };
  const planSha256 = planSha256Hex(canonicalTopicDraftJson(draft));
  appendTopicCreationDraft(prepare.manager, { planRevision: 1, planSha256, draft });
  prepare.manager.flush();
  assert.deepEqual(readTopicCreationDraft(prepare.manager.getEntries(), { planRevision: 1, planSha256 })?.title, "订单页空指针");

  const { TOPIC_MANAGE_TOOL_PROVIDER } = await import("../../src/tools/builtins/topic-manage/index.ts");
  const tool = TOPIC_MANAGE_TOOL_PROVIDER.create({
    purpose: "execution", projectId: "friend", chatHome: base.home, cwd: base.home,
    sessionManager: prepare.manager, sessionId: prepareSessionId, agentId: "friend", longAgentId: "friend",
    topicCreation: { longAgentId: "friend", requestId: "tc-1", sourceSessionId: daily.sessionId, sourceTurnId: null, parents: [] },
    topicCreationApproval: { planRevision: 1, planSha256 },
  });
  const created = (await tool.execute("call-1", { operation: "commit_creation" })).details;
  assert.equal(created.created, true);
  assert.equal(created.node.title, "订单页空指针");
  const graph = await readTopicGraph(base.home, "friend");
  assert.equal(graph.nodes.filter((node) => node.createdByRequestId === "tc-1").length, 1, "exactly one node for the approved request");
  assert.equal(created.sessionId, graph.nodes.find((node) => node.createdByRequestId === "tc-1")?.sessionId);

  // A retry under the same approval reuses the product instead of creating a second node.
  const retry = (await tool.execute("call-2", { operation: "commit_creation" })).details;
  assert.equal(retry.created, false);
  assert.equal((await readTopicGraph(base.home, "friend")).nodes.filter((node) => node.createdByRequestId === "tc-1").length, 1);

  // Without the trusted binding the tool refuses: only the creation Workflow's create step may commit.
  const untrusted = TOPIC_MANAGE_TOOL_PROVIDER.create({
    purpose: "execution", projectId: "friend", chatHome: base.home, cwd: base.home,
    sessionManager: prepare.manager, sessionId: prepareSessionId, agentId: "friend", longAgentId: "friend",
  });
  await assert.rejects(untrusted.execute("call-3", { operation: "commit_creation" }), /主题创建 Workflow/);
});

test("topic-session-create: the collector stage is READ-ONLY — create attempts are refused and the graph gains nothing", async (t) => {
  const base = await fixture(t);
  const { writeLongAgentRegistry, readLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  const registry = await readLongAgentRegistry(base.home);
  const friend = registry.agents.find((agent) => agent.id === "friend");
  friend.definition = { ...friend.definition, tools: { ...friend.definition.tools, addresses: ["system:tool/topic_manage"] } };
  await writeLongAgentRegistry(registry, base.home);
  const { ensureChatSessionWithId } = await import("../../src/chat-session.ts");
  const { TOPIC_MANAGE_TOOL_PROVIDER } = await import("../../src/tools/builtins/topic-manage/index.ts");
  const sessionId = "topic-collect-guard";
  const { session } = await ensureChatSessionWithId({ chatHome: base.home, projectId: "friend" }, sessionId, "整理");
  const tool = TOPIC_MANAGE_TOOL_PROVIDER.create({
    purpose: "execution", projectId: "friend", chatHome: base.home, cwd: base.home,
    sessionManager: session.manager, sessionId, agentId: "friend", longAgentId: "friend",
    topicReadOnly: true,
  });
  const before = await readTopicGraph(base.home, "friend");
  for (const operation of ["create_topic", "create_node", "add_parent", "update_node_status", "relay", "commit_creation", "request_topic"]) {
    await assert.rejects(tool.execute("c", { operation, requestId: "x", title: "t", purpose: "p" }), /只读/, `collector must not run ${operation}`);
  }
  const after = await readTopicGraph(base.home, "friend");
  assert.equal(after.topics.length, before.topics.length, "no topic was created by the collector");
  assert.equal(after.nodes.length, before.nodes.length, "no node was created by the collector");
  // Read-only operations still work for the collector.
  const readBack = (await tool.execute("c", { operation: "read_graph" })).details;
  assert.equal(readBack.operation, "read_graph");
});
