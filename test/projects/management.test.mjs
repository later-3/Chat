import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureDailyProject, openProject, readProjectRegistry, resolveProjectContext } from "../../src/projects/registry.ts";
import { resolveChatSystemTools, listChatSystemTools } from "../../src/tools/registry.ts";
import { writeProjectChatConfig, resolveChatConfig } from "../../src/chat-config.ts";
import { updateAgentDurableConfig } from "../../src/workflows/agent-model-config.ts";
import { fileRevision } from "../../src/persistence/versioned-file.ts";
import { ensureProjectManagementSkill } from "../../src/resources/project-management-skill.ts";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-management-"));
  const chatHome = path.join(base, "home");
  const project = await ensureDailyProject(chatHome);
  const manager = SessionManager.inMemory(project.cwd);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const context = { purpose: "execution", projectId: "daily", chatHome, cwd: project.cwd,
    sessionManager: manager, sessionId: manager.getSessionId(), agentId: "nexus", longAgentId: "nexus", longAgentTurnId: "turn-1",
    authorizedToolAddresses: listChatSystemTools().map((t) => t.address), authorizedToolNames: ["read", "bash", "write", "edit"] };
  const definitions = resolveChatSystemTools(listChatSystemTools().filter((t) => t.manifest.name.startsWith("project_")).map((t) => t.address), context);
  async function call(name, input) {
    try { return await definitions.find((t) => t.manifest.name === name).definition.execute(`call-${name}`, input); }
    catch (error) { return { isError: true, details: JSON.parse(error.message) }; }
  }
  async function ok(name, input) {
    const result = await call(name, input);
    assert.notEqual(result.isError, true, JSON.stringify(result.details));
    return result.details;
  }
  return { base, project, context, call, ok };
}

test("create a Chinese learning project, replay safely and expose it after reopening", async (t) => {
  const { ok, context } = await fixture(t);
  const request = { name: "学习道德经", description: "逐章阅读和整理问题", requestId: "learn-1" };
  const created = await ok("project_create", request);
  const replay = await ok("project_create", request);
  assert.equal(created.status, "created");
  assert.equal(replay.status, "existing");
  assert.equal(replay.project.projectId, created.project.projectId);
  const project = await resolveProjectContext(created.project.projectId, context.chatHome);
  assert.equal(project.cwd, fs.realpathSync(path.join(context.chatHome, "workspaces", project.projectId)));
  assert.deepEqual(JSON.parse(fs.readFileSync(project.projectConfigPath)), { schemaVersion: 1 });
  assert.equal(context.projectId, "daily");
  assert.notEqual(context.cwd, project.cwd);
  assert.equal(new URL(created.navigation.url, "http://chat.local").searchParams.get("cwd"), project.cwd);
  const list = await ok("project_search", { query: "道德经" });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].projectId, project.projectId);
  const second = await ok("project_create", { ...request, requestId: "learn-2" });
  assert.notEqual(second.project.projectId, project.projectId);
  const audit = fs.readFileSync(path.join(context.chatHome, "logs/audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const event = audit.find((e) => e.action === "project.create");
  assert.equal(event.source.projectId, "daily");
  assert.equal(event.target.projectId, project.projectId);
  assert.equal(event.source.longAgentId, "nexus");
});

test("reject changed idempotency input, extra source identities and blank names", async (t) => {
  const { ok, call } = await fixture(t);
  await ok("project_create", { name: "旅游", requestId: "travel" });
  assert.equal((await call("project_create", { name: "读书", requestId: "travel" })).details.code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await call("project_create", { name: "旅游", requestId: "extra", sessionId: "forged" })).isError, true);
  assert.equal((await call("project_create", { name: "  ", requestId: "blank" })).isError, true);
});

test("pending creation survives interruption before registration with the same ID", async (t) => {
  const { ok, context } = await fixture(t);
  const input = { name: "旅游规划", requestId: "resume" };
  const first = await ok("project_create", input);
  const markers = path.join(context.chatHome, "runtime/project-operations");
  const markerPath = path.join(markers, fs.readdirSync(markers)[0]);
  const marker = JSON.parse(fs.readFileSync(markerPath));
  marker.status = "pending";
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const registryPath = path.join(context.chatHome, "projects/registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath));
  registry.projects = registry.projects.filter((p) => p.projectId !== first.project.projectId);
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const resumed = await ok("project_create", input);
  assert.equal(resumed.project.projectId, first.project.projectId);
  assert.equal((await readProjectRegistry(context.chatHome)).projects.length, 2);
});

test("external open requires an exact prior grant and rejects symlink identity escapes", async (t) => {
  const { base, context, call, ok } = await fixture(t);
  const external = path.join(base, "external"); fs.mkdirSync(external);
  assert.equal((await call("project_open", { path: external, requestId: "open" })).details.code, "PATH_NOT_ALLOWED");
  const registered = await openProject({ path: external, chatHome: context.chatHome });
  assert.equal((await ok("project_open", { path: external, requestId: "open" })).project.projectId, registered.projectId);
  const nested = path.join(external, "nested"); fs.mkdirSync(nested);
  assert.equal((await call("project_open", { path: nested, requestId: "nested" })).details.code, "PATH_NOT_ALLOWED");
  const other = path.join(base, "other"); fs.mkdirSync(other);
  const config = registered.projectConfigPath;
  fs.symlinkSync(path.join(other, "secret.json"), config);
  const response = await call("project_configure", { projectId: registered.projectId, target: { kind: "project" }, expectedRevision: "absent", operations: [{ op: "set", path: ["defaultWorkflowId"], value: "memory" }] });
  assert.equal(response.isError, true);
  assert.equal(fs.existsSync(path.join(other, "secret.json")), false);
});

test("manifest updates compare revisions, preserve IDs and reject invalid fields", async (t) => {
  const { ok, call } = await fixture(t);
  const created = await ok("project_create", { name: "旅游", requestId: "update" });
  const projectId = created.project.projectId;
  const read = await ok("project_read", { projectId });
  const results = await Promise.all([
    call("project_update", { projectId, expectedRevision: read.revision, changes: { name: "云南旅游" } }),
    call("project_update", { projectId, expectedRevision: read.revision, changes: { name: "四川旅游" } }),
  ]);
  assert.equal(results.filter((r) => r.isError).length, 1);
  assert.equal(results.find((r) => r.isError).details.code, "REVISION_CONFLICT");
  const winner = results.find((r) => !r.isError).details.project;
  assert.equal((await ok("project_search", { query: winner.name })).items[0].projectId, projectId);
  assert.equal((await call("project_update", { projectId, expectedRevision: read.revision, changes: { id: "changed" } })).isError, true);
});

test("configuration patch preserves other settings, supports preview/unset, and rejects stale writes", async (t) => {
  const { ok, call, context } = await fixture(t);
  await writeProjectChatConfig("daily", { schemaVersion: 1, sessions: { removedRetentionDays: 91 } }, context.chatHome);
  const read = await ok("project_read", { view: "configuration" });
  const input = { target: { kind: "project" }, expectedRevision: read.configuration.revision, operations: [{ op: "set", path: ["defaultWorkflowId"], value: "memory" }] };
  assert.equal((await ok("project_configure", { ...input, validateOnly: true })).status, "validated");
  assert.equal((await resolveChatConfig("daily", context.chatHome)).project.defaultWorkflowId, undefined);
  const changed = await ok("project_configure", input);
  assert.equal(changed.configuration.sessions.removedRetentionDays, 91);
  assert.equal((await call("project_configure", input)).details.code, "REVISION_CONFLICT");
  await ok("project_configure", { ...input, expectedRevision: changed.revision, operations: [{ op: "unset", path: ["defaultWorkflowId"] }] });
  assert.equal((await resolveChatConfig("daily", context.chatHome)).project.defaultWorkflowId, undefined);
});

test("invalid references, overlapping paths and prototype pollution do not modify configuration", async (t) => {
  const { ok, call, project } = await fixture(t);
  const read = await ok("project_read", { view: "configuration" });
  const revision = read.configuration.revision;
  for (const operations of [
    [{ op: "set", path: ["defaultWorkflowId"], value: "not-real" }],
    [{ op: "set", path: ["__proto__", "polluted"], value: true }],
    [{ op: "set", path: ["sessions"], value: {} }, { op: "set", path: ["sessions", "removedRetentionDays"], value: 30 }],
    [{ op: "set", path: ["workflows", "minimal-pi-coding-agent", "agents", "pi-coding-agent", "resources"], value: { mode: "explicit", skillPaths: ["missing"] } }],
  ]) assert.equal((await call("project_configure", { target: { kind: "project" }, expectedRevision: revision, operations })).isError, true);
  assert.equal(await fileRevision(project.projectConfigPath), revision);
  assert.equal({}.polluted, undefined);
});

test("Workflow Agent durable settings use their own revision and remove empty overrides", async (t) => {
  const { ok, call, project } = await fixture(t);
  const workflowId = "minimal-pi-coding-agent", agentId = "pi-coding-agent";
  const read = await ok("project_read", { view: "configuration", workflowId, agentId });
  assert.equal(read.agent.revision, "absent");
  const target = { kind: "workflow-agent", workflowId, agentId };
  const changed = await ok("project_configure", { target, expectedRevision: "absent", operations: [{ op: "set", path: ["thinkingLevel"], value: "high" }] });
  await updateAgentDurableConfig(project.projectDataDir, workflowId, agentId, { tools: { mode: "none" } });
  assert.equal((await call("project_configure", { target, expectedRevision: changed.revision, operations: [{ op: "unset", path: ["thinkingLevel"] }] })).details.code, "REVISION_CONFLICT");
  const latest = await ok("project_read", { view: "configuration", workflowId, agentId });
  const removed = await ok("project_configure", { target, expectedRevision: latest.agent.revision, operations: [{ op: "unset", path: ["thinkingLevel"] }, { op: "unset", path: ["tools"] }] });
  assert.equal(removed.configuration, null);
  assert.equal(removed.revision, "absent");
  const invalid = await call("project_configure", { target, expectedRevision: "absent", operations: [{ op: "set", path: ["model"], value: { provider: "missing", modelId: "none" } }] });
  assert.equal(invalid.isError, true);
});

test("bundled Personal Skill is discoverable in the same Pi assembly and respects user edits", async (t) => {
  const { context, project } = await fixture(t);
  const installed = await ensureProjectManagementSkill(context.chatHome);
  const definition = { schemaVersion: 1, id: "project-agent", name: "Project agent", description: "", systemPrompt: { mode: "pi-default" }, customInstructions: [], resources: { mode: "inherit" }, tools: { mode: "explicit", names: ["read"], exclude: [], addresses: ["system:tool/project_create", "system:tool/project_read"] } };
  const created = await createChatPiAgentSession({ chatSession: { projectContext: project, cwd: project.cwd, agentDir: project.agentDir, sessionDir: project.sessionDir, manager: context.sessionManager }, sessionManager: context.sessionManager, agent: definition, toolContext: context });
  t.after(() => created.session.dispose());
  assert.equal(created.resourceLoader.getSkills().skills.some((s) => s.name === "project-management"), true);
  assert.ok(created.session.getActiveToolNames().includes("project_create"));
  fs.appendFileSync(installed.path, "\n用户自定义说明\n");
  assert.equal((await ensureProjectManagementSkill(context.chatHome)).status, "user-owned");
  assert.match(fs.readFileSync(installed.path, "utf8"), /用户自定义说明/);
});

test("inspection cannot execute tools and unselected system tools cannot be granted", async (t) => {
  const { context, project, ok } = await fixture(t);
  const inspected = resolveChatSystemTools(["system:tool/project_create"], { ...context, purpose: "inspection" })[0].definition;
  await assert.rejects(inspected.execute("inspect", { name: "forbidden", requestId: "x" }), /INSPECTION_ONLY/);
  const configure = resolveChatSystemTools(["system:tool/project_configure"], { ...context, authorizedToolAddresses: [] })[0].definition;
  const read = await ok("project_read", { view: "configuration", workflowId: "minimal-pi-coding-agent", agentId: "pi-coding-agent" });
  await assert.rejects(configure.execute("grant", { target: { kind: "workflow-agent", workflowId: "minimal-pi-coding-agent", agentId: "pi-coding-agent" }, expectedRevision: read.agent.revision, operations: [{ op: "set", path: ["tools"], value: { mode: "explicit", names: ["read"], addresses: ["system:tool/project_update"] } }] }), /PATH_NOT_ALLOWED/);
});

test("unset removes empty ancestors so Personal defaults really become effective", async (t) => {
  const { ok, context } = await fixture(t);
  const { writeChatRootConfig } = await import("../../src/chat-config.ts");
  await writeChatRootConfig({ schemaVersion: 1, defaultWorkflowId: "memory", workflows: {
    "minimal-pi-coding-agent": { agents: { "pi-coding-agent": { tools: { mode: "none" } } } },
  }, sessions: { removedRetentionDays: 42 } }, context.chatHome);
  await writeProjectChatConfig("daily", { schemaVersion: 1, workflows: {
    "minimal-pi-coding-agent": { agents: { "pi-coding-agent": { tools: { mode: "none" } } } },
  }, sessions: { removedRetentionDays: 7 } }, context.chatHome);
  const read = await ok("project_read", { view: "configuration" });
  const result = await ok("project_configure", { target: { kind: "project" }, expectedRevision: read.configuration.revision, operations: [
    { op: "unset", path: ["workflows", "minimal-pi-coding-agent", "agents", "pi-coding-agent", "tools"] },
    { op: "unset", path: ["sessions", "removedRetentionDays"] },
  ] });
  assert.deepEqual(result.configuration, { schemaVersion: 1 });
  const effective = (await resolveChatConfig("daily", context.chatHome)).effective;
  assert.equal(effective.sessions.removedRetentionDays, 42);
  assert.equal(effective.workflows["minimal-pi-coding-agent"].agents["pi-coding-agent"].tools.mode, "none");
});

test("committed configuration with audit failure reports applied instead of claiming rollback", async (t) => {
  const { ok, call, context } = await fixture(t);
  const read = await ok("project_read", { view: "configuration" });
  const audit = path.join(context.chatHome, "logs/audit.jsonl");
  fs.unlinkSync(audit); fs.mkdirSync(audit);
  const result = await call("project_configure", { target: { kind: "project" }, expectedRevision: read.configuration.revision, operations: [{ op: "set", path: ["defaultWorkflowId"], value: "memory" }] });
  assert.equal(result.isError, true);
  assert.equal(result.details.applied, true);
  assert.equal(result.details.code, "PERSISTENCE_INCOMPLETE");
  assert.equal((await resolveChatConfig("daily", context.chatHome)).project.defaultWorkflowId, "memory");
});

test("existing full-document writers can repair malformed files while patches refuse corrupt state", async (t) => {
  const { project, context, call } = await fixture(t);
  fs.writeFileSync(project.projectConfigPath, "not-json");
  const revision = await fileRevision(project.projectConfigPath);
  assert.equal((await call("project_configure", { target: { kind: "project" }, expectedRevision: revision, operations: [{ op: "set", path: ["defaultWorkflowId"], value: "memory" }] })).isError, true);
  await writeProjectChatConfig("daily", { schemaVersion: 1, defaultWorkflowId: "memory" }, context.chatHome);
  assert.equal((await resolveChatConfig("daily", context.chatHome)).project.defaultWorkflowId, "memory");
  const { agentModelConfigPath, writeAgentDurableConfig, readAgentDurableConfig } = await import("../../src/workflows/agent-model-config.ts");
  const file = agentModelConfigPath(project.projectDataDir, "minimal-pi-coding-agent", "pi-coding-agent");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "broken");
  await writeAgentDurableConfig(project.projectDataDir, "minimal-pi-coding-agent", "pi-coding-agent", { schemaVersion: 1, thinkingLevel: "high" });
  assert.equal((await readAgentDurableConfig(project.projectDataDir, "minimal-pi-coding-agent", "pi-coding-agent")).thinkingLevel, "high");
});
