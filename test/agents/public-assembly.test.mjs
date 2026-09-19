import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";
import { readAssemblySnapshot } from "../../src/agents/assembly-context.ts";
import { openChatSession, reserveChatSession } from "../../src/chat-session.ts";
import { ensureAgentHomeProject, openProject } from "../../src/projects/registry.ts";
import { getMemoryStoreManager } from "../../src/memory/manager-runtime.ts";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-public-assembly-"));
  const agentDir = path.join(root, "chat-home", "agent");
  const home = path.join(root, "friend", "workspace");
  const sessionDir = path.join(root, "friend", "sessions");
  const projects = ["a", "b"].map((name) => path.join(root, name));
  for (const dir of [agentDir, home, sessionDir, ...projects]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "PERSONAL_RULE");
  for (const [index, dir] of projects.entries()) {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `PROJECT_${index}_RULE`);
  }
  const requests = [];
  let handler = () => ({ content: "ack" });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const delta = handler(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (change, finish) => ({
        id: `p1-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "seam-model",
        choices: [{ index: 0, delta: change, finish_reason: finish }],
      });
      res.write(`data: ${JSON.stringify(frame({ role: "assistant", ...delta }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...frame({}, delta.tool_calls ? "tool_calls" : "stop"),
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    "p1-local": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
      apiKey: "local-fake-key", models: [{ id: "seam-model", name: "P1 local",
        reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  } }));
  const modelRuntime = await ModelRuntime.create({
    modelsPath: path.join(agentDir, "models.json"), authPath: path.join(agentDir, "auth.json"),
  });
  const model = modelRuntime.getModel("p1-local", "seam-model");
  assert.ok(model);
  const chatHome = path.join(root, "chat-home");
  const storage = await ensureAgentHomeProject("friend", "Friend", chatHome);
  const projectsById = await Promise.all(projects.map((dir, i) => openProject({ path: dir, chatHome, name: `project-${i}` })));
  const chatSession = await openChatSession({ projectId: storage.projectId, chatHome });
  const manager = chatSession.manager;
  const ownRoot = path.dirname(storage.cwd);
  fs.writeFileSync(path.join(storage.cwd, "AGENTS.md"), "FRIEND_OWN_RULE");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "p1-local", defaultModel: "seam-model", retry: { enabled: false } }));
  const definition = { schemaVersion: 1, id: "friend", name: "Friend", description: "Stable identity",
    systemPrompt: { mode: "replace", text: "FRIEND_BASE" }, customInstructions: [{ text: "FRIEND_IDENTITY" }],
    tools: { mode: "explicit", names: ["read", "write", "edit"], exclude: [], addresses: ["system:tool/memory_record", "system:tool/memory_search"] },
    resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } };
  let turn = 0;
  async function assemble(cwd, sessionManager = manager, options = {}) {
    const target = projectsById.find((project) => project.cwd === fs.realpathSync(cwd));
    const created = await createChatPiAgentSession({
      chatSession, sessionManager, agent: options.agent ?? definition,
      invocation: { turnId: options.turnId ?? `turn-${++turn}`, ownWorkspace: storage.cwd, ownResourceRoot: ownRoot,
        projectId: options.projectId === undefined ? target?.projectId ?? null : options.projectId },
      toolContext: { purpose: "execution", agentId: "friend", longAgentId: "friend", longAgentTurnId: `turn-${turn}` },
    });
    const { session } = created;
    t.after(() => session.dispose());
    return session;
  }
  return { root, home: storage.cwd, chatHome, chatSession, definition, ownRoot, projectsById, projects, manager, requests, assemble, setHandler: (next) => { handler = next; } };
}


function system(request) { return JSON.stringify(request.messages.filter((m) => ["system", "developer"].includes(m.role))); }
function call(name, args) { return { tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }; }

test("public factory: same stored Session writes A then B then own workspace with current rules only", async (t) => {
  const f = await fixture(t);
  f.setHandler((body) => body.messages.at(-1).role === "tool" ? { content: "written" } : call("write", { path: "result.txt", content: "done" }));
  const id = f.manager.getSessionId();
  for (const [i, cwd] of [...f.projects, f.home].entries()) {
    const session = await f.assemble(cwd);
    assert.equal(session.model.provider, "p1-local");
    await session.prompt(`turn ${i}`);
    session.dispose();
    assert.equal(fs.readFileSync(path.join(cwd, "result.txt"), "utf8"), "done");
    const prompt = system(f.requests[i * 2]);
    assert.match(prompt, /FRIEND_IDENTITY/);
    assert.match(prompt, /FRIEND_OWN_RULE/);
    assert.match(prompt, /PERSONAL_RULE/);
    if (i < 2) assert.match(prompt, new RegExp(`PROJECT_${i}_RULE`));
    if (i !== 0) assert.doesNotMatch(prompt, /PROJECT_0_RULE/);
    if (i === 2) assert.doesNotMatch(prompt, /PROJECT_1_RULE/);
  }
  assert.equal(f.manager.getSessionId(), id);
  assert.equal(f.manager.getCwd(), f.home);
  assert.equal(f.manager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 3);
  assert.match(JSON.stringify(f.requests[4]), /turn 0/);
  assert.equal(readAssemblySnapshot(f.manager, "turn-2").projectId, f.projectsById[1].projectId);
  assert.ok(f.requests[0].tools.some((tool) => tool.function.name === "memory_record"));
});

test("public factory freezes instructions across edit/reopen/retry, next turn adopts new rules and ignores project model", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.projects[0], ".pi"));
  fs.writeFileSync(path.join(f.projects[0], ".pi/settings.json"), JSON.stringify({ defaultProvider: "bad-provider", defaultModel: "wrong-model" }));
  const first = await f.assemble(f.projects[0], f.manager, { turnId: "frozen" });
  fs.writeFileSync(path.join(f.projects[0], "AGENTS.md"), "UPDATED_RULE");
  await first.prompt("first frozen turn");
  first.dispose();
  assert.match(system(f.requests[0]), /PROJECT_0_RULE/);
  assert.doesNotMatch(system(f.requests[0]), /UPDATED_RULE/);
  const restored = SessionManager.open(f.manager.getSessionFile());
  const retry = await f.assemble(f.projects[1], restored, { turnId: "frozen" });
  assert.match(retry.systemPrompt, /PROJECT_0_RULE/);
  assert.doesNotMatch(retry.systemPrompt, /PROJECT_1_RULE|UPDATED_RULE/);
  assert.equal(retry.model.provider, "p1-local");
  retry.dispose();
  const next = await f.assemble(f.projects[0], restored);
  assert.match(next.systemPrompt, /UPDATED_RULE/);
});

test("unavailable targets, invalid rule files and file path escapes fail without falling back to Home", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.assemble(f.projects[0], f.manager, { projectId: "missing-project" }));
  fs.unlinkSync(path.join(f.projects[0], "AGENTS.md"));
  const noRules = await f.assemble(f.projects[0]);
  assert.doesNotMatch(noRules.systemPrompt, /PROJECT_0_RULE/);
  noRules.dispose();
  fs.mkdirSync(path.join(f.projects[0], "AGENTS.override.md"));
  await assert.rejects(f.assemble(f.projects[0]), /不是文件/);
  fs.rmdirSync(path.join(f.projects[0], "AGENTS.override.md"));
  fs.symlinkSync(path.join(f.projects[1], "AGENTS.md"), path.join(f.projects[0], "AGENTS.override.md"));
  await assert.rejects(f.assemble(f.projects[0]), /不能越过/);
  fs.unlinkSync(path.join(f.projects[0], "AGENTS.override.md"));
  const session = await f.assemble(f.projects[0]);
  const write = session.getToolDefinition("write");
  await assert.rejects(write.execute("escape", { path: "../b/escape.txt", content: "bad" }), /超出/);
  fs.symlinkSync(f.projects[1], path.join(f.projects[0], "elsewhere"));
  await assert.rejects(write.execute("escape-link", { path: "elsewhere/escape.txt", content: "bad" }), /超出/);
  assert.equal(fs.existsSync(path.join(f.projects[1], "escape.txt")), false);
  await write.execute("nested", { path: "new/child/result.txt", content: "ok" });
  assert.equal(fs.readFileSync(path.join(f.projects[0], "new/child/result.txt"), "utf8"), "ok");
});

test("explicit resources stay explicit; own skill/body is pinned while running and changed resource rejects old-turn recovery", async (t) => {
  const f = await fixture(t);
  const skillDir = path.join(f.ownRoot, "skills", "own-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, "---\nname: own-skill\ndescription: own skill\n---\nORIGINAL_BODY");
  const explicit = await f.assemble(f.projects[0]);
  assert.doesNotMatch(explicit.systemPrompt, /own-skill/);
  explicit.dispose();
  const agent = { ...f.definition, resources: { ...f.definition.resources, skillPaths: ["skills/own-skill"] } };
  const session = await f.assemble(f.projects[0], f.manager, { agent, turnId: "skill-frozen" });
  assert.match(session.systemPrompt, /own-skill/);
  fs.writeFileSync(skillPath, "---\nname: own-skill\ndescription: changed\n---\nNEW_BODY");
  const read = await session.getToolDefinition("read").execute("read-skill", { path: skillPath });
  assert.match(read.content[0].text, /ORIGINAL_BODY/);
  assert.doesNotMatch(read.content[0].text, /NEW_BODY/);
  session.dispose();
  await assert.rejects(f.assemble(f.projects[0], f.manager, { agent, turnId: "skill-frozen" }), /版本已不可用/);
  const next = await f.assemble(f.projects[0], f.manager, { agent });
  assert.match(next.systemPrompt, /changed/);
});

test("Memory default targets follow work project while source remains storage Session; null target requires explicit choice", async (t) => {
  const f = await fixture(t);
  const { MemoryStoreManager } = await import("../../src/memory/manager.ts");
  const { MemoryRepository } = await import("../../src/memory/repository.ts");
  const { MemoryService } = await import("../../src/memory/service.ts");
  const manager = getMemoryStoreManager(f.chatSession.projectContext.chatHome);
  const isolated = new MemoryStoreManager(f.chatSession.projectContext.chatHome, async (target) => {
    const project = f.projectsById.find((p) => p.projectId === target.projectId);
    assert.ok(project, "must never write Project Memory to Agent home");
    return new MemoryService(new MemoryRepository(path.join(project.memoryDir, "catalog.db")), async () => ({
      add: async (record) => `local:${record.id}`, exists: async () => true,
    }), target);
  });
  t.mock.method(manager, "createMany", isolated.createMany.bind(isolated));
  for (const [i, cwd] of f.projects.entries()) {
    const session = await f.assemble(cwd);
    const result = await session.getToolDefinition("memory_record").execute(`memory-${i}`, { text: `fact-${i}` });
    const memory = result.details[0].memory;
    assert.equal(memory.sourceProjectId, "friend");
    assert.equal(memory.sourceSessionId, f.manager.getSessionId());
    assert.equal(memory.projectId, f.projectsById[i].projectId);
    assert.ok(fs.existsSync(path.join(f.projectsById[i].memoryDir, "catalog.db")));
    session.dispose();
  }
  const personal = await f.assemble(f.home);
  await assert.rejects(personal.getToolDefinition("memory_record").execute("no-target", { text: "fact" }), /明确指定目标/);
});

test("cross-project Workflow child keeps native parent lineage with explicit storage authorization", async (t) => {
  const f = await fixture(t);
  f.manager.flush();
  const child = await reserveChatSession({ projectId: f.projectsById[0].projectId, chatHome: f.chatHome }, "delegated", {
    parentSessionManager: f.manager, parentProjectId: "friend",
  });
  assert.equal(child.manager.getHeader().parentSession, f.manager.getSessionFile());
  assert.equal(child.cwd, f.projectsById[0].cwd);
  await assert.rejects(reserveChatSession({ projectId: f.projectsById[1].projectId, chatHome: f.chatHome }, "forged", {
    parentSessionManager: f.manager, parentProjectId: f.projectsById[0].projectId,
  }));
});

test("changed extension code is rejected before import on interrupted-turn recovery", async (t) => {
  const f = await fixture(t);
  const extension = path.join(f.ownRoot, "extension.mjs");
  const marker = path.join(f.root, "extension-imported.txt");
  const content = (value) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)}); export default function() {}`;
  fs.writeFileSync(extension, content("original"));
  const agent = { ...f.definition, resources: { ...f.definition.resources, extensionPaths: [extension] } };
  const session = await f.assemble(f.projects[0], f.manager, { agent, turnId: "extension-frozen" });
  assert.equal(fs.readFileSync(marker, "utf8"), "original");
  session.dispose();
  await assert.rejects(f.assemble(f.projects[0], f.manager, { agent, turnId: "extension-frozen" }), /扩展实例已不可恢复/);
  fs.writeFileSync(extension, content("changed"));
  await assert.rejects(f.assemble(f.projects[0], f.manager, { agent, turnId: "extension-frozen" }), /版本已不可用/);
  assert.equal(fs.readFileSync(marker, "utf8"), "original");
});

test("ordinary Workflow wrapper freezes root rules for retries without changing existing resource policy", async (t) => {
  const f = await fixture(t);
  const { createWorkflowAgentSession } = await import("../../src/workflows/agent-definition.ts");
  const chatSession = await openChatSession({ projectId: f.projectsById[0].projectId, chatHome: f.chatHome });
  const assemble = (invocation) => createWorkflowAgentSession({ chatSession, sessionManager: chatSession.manager,
    agent: { ...f.definition, tools: { mode: "explicit", names: ["read"], exclude: [] } },
    toolContext: { purpose: "execution", agentId: "friend", workflowId: "test", workflowInvocationId: invocation, stageId: "test" } });
  const first = await assemble("workflow-1");
  assert.deepEqual(first.session.getActiveToolNames(), ["read"]);
  first.session.dispose();
  fs.writeFileSync(path.join(f.projects[0], "AGENTS.md"), "WORKFLOW_CHANGED");
  const retry = await assemble("workflow-1");
  assert.match(retry.session.systemPrompt, /PROJECT_0_RULE/);
  assert.doesNotMatch(retry.session.systemPrompt, /WORKFLOW_CHANGED/);
  retry.session.dispose();
  const next = await assemble("workflow-2");
  assert.match(next.session.systemPrompt, /WORKFLOW_CHANGED/);
  next.session.dispose();
});

test("ordinary nested project keeps its own identity and blocks parent/sibling reads and writes, including symlinks", async (t) => {
  const f = await fixture(t);
  const { createWorkflowAgentSession } = await import("../../src/workflows/agent-definition.ts");
  const parent = path.join(f.root, "host-chat");
  const nested = path.join(parent, "workspaces", "thinking");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(parent, "README.md"), "HOST_CHAT_README_MUST_NOT_LEAK");
  fs.writeFileSync(path.join(nested, "notes.md"), "THINKING_PROJECT_NOTES");
  fs.symlinkSync(path.join(parent, "README.md"), path.join(nested, "outside.md"));
  const project = await openProject({ path: nested, id: "thinking", name: "思考", description: "记录日常思考与反思", chatHome: f.chatHome });
  const chatSession = await openChatSession({ projectId: project.projectId, chatHome: f.chatHome });
  const assemble = (key, purpose = "execution") => createWorkflowAgentSession({ chatSession, sessionManager: chatSession.manager,
    agent: { ...f.definition, tools: { mode: "explicit", names: ["read", "write", "edit", "ls", "find", "grep"], exclude: [], addresses: [] } },
    toolContext: { purpose, agentId: "friend", workflowId: "test", workflowInvocationId: key, stageId: "test" } });
  const first = await assemble("nested-project"); t.after(() => first.session.dispose());
  assert.match(first.session.systemPrompt, /"name":"思考"/);
  assert.match(first.session.systemPrompt, /记录日常思考与反思/);
  assert.doesNotMatch(first.session.systemPrompt, /HOST_CHAT_README_MUST_NOT_LEAK/);
  const read = first.session.getToolDefinition("read");
  for (const target of [path.join(parent, "README.md"), "outside.md", path.join(f.projects[1], "AGENTS.md")]) {
    await assert.rejects(read.execute("outside", { path: target }), /超出本轮/);
  }
  assert.match((await read.execute("inside", { path: "notes.md" })).content[0].text, /THINKING_PROJECT_NOTES/);
  for (const name of ["write", "edit", "ls", "find", "grep"]) {
    await assert.rejects(first.session.getToolDefinition(name).execute("outside", {
      path: name === "write" ? path.join(parent, "created.md") : path.join(parent, "README.md"),
      content: "changed", edits: [{ oldText: "HOST", newText: "CHANGED" }], pattern: "README",
    }), /超出本轮/);
  }
  assert.equal(fs.existsSync(path.join(parent, "created.md")), false);
  // A model really requests the wrong absolute path; it receives a denial, never the parent's text.
  f.setHandler((body) => body.messages.at(-1).role === "tool" ? { content: "project boundary respected" } : call("read", { path: path.join(parent, "README.md") }));
  await first.session.prompt("这是一个啥项目");
  assert.match(JSON.stringify(f.requests.at(-1)), /超出本轮/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /HOST_CHAT_README_MUST_NOT_LEAK/);
  const manifest = path.join(nested, ".chat/project.json");
  const content = JSON.parse(fs.readFileSync(manifest, "utf8"));
  fs.writeFileSync(manifest, JSON.stringify({ ...content, name: "后来的名字", description: "新的用途" }));
  const reopened = await openChatSession({ projectId: project.projectId, sessionId: chatSession.manager.getSessionId(), chatHome: f.chatHome });
  const retry = await createWorkflowAgentSession({ chatSession: reopened, sessionManager: reopened.manager,
    agent: { ...f.definition, tools: { mode: "explicit", names: ["read"], exclude: [], addresses: [] } },
    toolContext: { purpose: "inspection", agentId: "friend" } });
  assert.match(retry.session.systemPrompt, /后来的名字/);
  await assert.rejects(retry.session.getToolDefinition("read").execute("outside", { path: path.join(parent, "README.md") }), /超出本轮/);
  retry.session.dispose();
  const resumed = await createWorkflowAgentSession({ chatSession: reopened, sessionManager: reopened.manager,
    agent: { ...f.definition, tools: { mode: "explicit", names: ["read", "write", "edit", "ls", "find", "grep"], exclude: [], addresses: [] } },
    toolContext: { purpose: "execution", agentId: "friend", workflowId: "test", workflowInvocationId: "nested-project", stageId: "test" } });
  assert.match(resumed.session.systemPrompt, /"name":"思考"/);
  assert.doesNotMatch(resumed.session.systemPrompt, /后来的名字/);
  resumed.session.dispose();
});

test("inherit selects Friend and current Project skills; Workflow reads selected Skill from its frozen body", async (t) => {
  const f = await fixture(t);
  const writeSkill = (root, name) => {
    const file = path.join(root, "skills", name, "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} description\n---\nFROZEN_SKILL_BODY`);
    return file;
  };
  writeSkill(f.ownRoot, "friend-skill");
  fs.mkdirSync(path.join(f.ownRoot, "extensions"), { recursive: true });
  const projectSkill = writeSkill(f.projectsById[0].projectConfigDir, "project-a-skill");
  const agent = { ...f.definition, resources: { mode: "inherit" } };
  const a = await f.assemble(f.projects[0], f.manager, { agent });
  assert.match(a.systemPrompt, /friend-skill/);
  assert.match(a.systemPrompt, /project-a-skill/);
  a.dispose();
  const b = await f.assemble(f.projects[1], f.manager, { agent });
  assert.match(b.systemPrompt, /friend-skill/);
  assert.doesNotMatch(b.systemPrompt, /project-a-skill/);
  b.dispose();
  const { createWorkflowAgentSession } = await import("../../src/workflows/agent-definition.ts");
  const chatSession = await openChatSession({ projectId: f.projectsById[0].projectId, chatHome: f.chatHome });
  const created = await createWorkflowAgentSession({ chatSession, sessionManager: chatSession.manager,
    agent: { ...agent, tools: { mode: "explicit", names: ["read"], exclude: [] } },
    toolContext: { purpose: "execution", agentId: "friend", workflowId: "test", workflowInvocationId: "skill-test", stageId: "test" } });
  t.after(() => created.session.dispose());
  fs.writeFileSync(projectSkill, "changed after assembly");
  const read = await created.session.getToolDefinition("read").execute("skill-read", { path: projectSkill });
  assert.match(read.content[0].text, /FROZEN_SKILL_BODY/);
});

test("unreadable rule shapes and required-region overflow fail before contacting model", async (t) => {
  const f = await fixture(t);
  const rule = path.join(f.projects[0], "AGENTS.md");
  fs.writeFileSync(rule, Buffer.from([0xff, 0xfe, 0xff]));
  await assert.rejects(f.assemble(f.projects[0]));
  fs.unlinkSync(rule);
  fs.symlinkSync(path.join(f.projects[0], "missing.md"), rule);
  await assert.rejects(f.assemble(f.projects[0]));
  fs.unlinkSync(rule);
  fs.writeFileSync(rule, "large mandatory rule ".repeat(15000));
  await assert.rejects(f.assemble(f.projects[0]), /必需区域超过安全输入预算/);
  assert.equal(f.requests.length, 0);
});

test("retry cannot silently change active tools through Personal defaults", async (t) => {
  const f = await fixture(t);
  const settings = path.join(f.chatHome, "agent", "settings.json");
  const initial = JSON.parse(fs.readFileSync(settings));
  fs.writeFileSync(settings, JSON.stringify({ ...initial, defaultTools: ["read"] }));
  const agent = { ...f.definition, tools: { mode: "pi-default" } };
  const first = await f.assemble(f.projects[0], f.manager, { agent, turnId: "tool-frozen" });
  assert.deepEqual(first.getActiveToolNames(), ["read"]);
  first.dispose();
  fs.writeFileSync(settings, JSON.stringify({ ...initial, defaultTools: ["read", "write"] }));
  await assert.rejects(f.assemble(f.projects[0], f.manager, { agent, turnId: "tool-frozen" }), /工具选择或版本已变化/);
  const next = await f.assemble(f.projects[0], f.manager, { agent });
  assert.ok(next.getActiveToolNames().includes("write"));
});
