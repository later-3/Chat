import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { migrateAgentHomeNormalization } from '../../src/migrations/agent-home-normalization.ts';
import { ensureAgentHomeProject, openProject, readProjectRegistry } from '../../src/projects/registry.ts';
import { readLongAgentRegistry, readLongAgentState, updateLongAgentState, writeLongAgentRegistry } from '../../src/long-agents/storage.ts';
import { ensureProjectLongAgent, projectLongAgentId } from '../../src/long-agents/project-agent.ts';
import { readChatSession, requireChatSession } from '../../src/session-read-model.ts';

const stamp = '2026-09-01T00:00:00.000Z';
const definition = { schemaVersion: 1, id: 'friend', name: 'Friend', description: 'Test', systemPrompt: { mode: 'pi-default' }, customInstructions: [], tools: { mode: 'pi-default' }, resources: { mode: 'inherit' } };
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-p5-migration-')));
  const home = path.join(root, 'home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = await ensureAgentHomeProject('friend', 'Friend', home);
  const registry = { schemaVersion: 1, instances: [{ id: 'local', name: 'Local', gatewayBaseUrl: 'http://127.0.0.1:1' }], agents: [{ id: 'friend', name: 'Friend', description: 'Test', enabled: true, instanceId: 'local', nanoclawAgentGroupId: 'group', defaultProjectId: 'daily-friend', timeZone: 'Asia/Shanghai', definition }] };
  await writeLongAgentRegistry(registry, home);
  const projects = {};
  for (const id of ['daily-friend', 'daily', 'business']) {
    const dir = path.join(home, 'workspaces', id); fs.mkdirSync(dir, { recursive: true });
    projects[id] = await openProject({ path: dir, chatHome: home, id, name: id });
  }
  function session(project, friend = false) {
    const manager = SessionManager.create(project.cwd, project.sessionDir);
    manager.appendMessage({ role: 'user', content: 'preserve history', timestamp: Date.parse(stamp) });
    if (friend) manager.appendCustomEntry('chat.long_agent_turn', { schemaVersion: 1, turnId: 'legacy-turn', longAgentId: 'friend', bindingId: projectLongAgentId(project.projectId, 'friend'), source: 'chat-web', channelType: null, inboundEventId: null, agentGroupContext: null, status: 'completed', startedAt: stamp, completedAt: stamp, error: null });
    manager.flush(); return manager;
  }
  const old = session(projects['daily-friend'], true), shared = session(projects.daily, true), plain = session(projects.daily), business = session(projects.business, true);
  const records = [['daily-friend', old], ['business', business]].map(([id, manager]) => ({ id: projectLongAgentId(id, 'friend'), projectId: id, longAgentId: 'friend', primarySessionId: manager.getSessionId(), status: 'active', createdAt: stamp, updatedAt: stamp }));
  await updateLongAgentState(home, (state) => ({ state: { ...state, projectAgents: records, bindings: records.map((record, index) => ({ id: `binding-${index}`, projectLongAgentId: record.id, nanoclawInstanceId: 'local', nanoclawAgentGroupId: 'group', nanoclawSessionId: `nano-${index}`, primaryMessagingGroupId: `mg-${index}`, source: { channelType: 'telegram', instance: 'telegram', platformId: `user-${index}`, threadId: null }, createdAt: stamp, updatedAt: stamp })) }, result: undefined }));
  return { root, home, own, registry, projects, old, shared, plain, business, dir: path.join(home, 'runtime/migrations/agent-home-normalization') };
}

test('P5 preserves original histories, Memory scope, channel context and old URLs without opening an idle day', async t => {
  const f = await fixture(t);
  const originals = [f.old, f.shared, f.plain, f.business].map(manager => [manager.getSessionFile(), fs.readFileSync(manager.getSessionFile())]);
  fs.writeFileSync(path.join(f.projects['daily-friend'].memoryDir, 'catalog.db'), 'private memory bytes');
  fs.writeFileSync(path.join(f.projects['daily-friend'].projectConfigDir, 'private-resource.md'), 'private config');
  const result = await migrateAgentHomeNormalization(f.home);
  assert.equal(result.schemaVersion, 2);
  assert.equal((await readLongAgentRegistry(f.home)).agents[0].defaultProjectId, 'friend');
  const state = await readLongAgentState(f.home);
  assert.equal(state.dailySessions.length, 0);
  assert.equal(state.projectAgents.length, 2);
  assert.deepEqual(state.bindings.map(binding => binding.contextProjectId), [null, 'business']);
  assert.deepEqual(state.bindings.map(binding => binding.nanoclawSessionId), ['nano-0', 'nano-1']);
  assert.ok((await readProjectRegistry(f.home)).projects.some(project => project.projectId === 'daily-friend'));
  for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readFileSync(path.join(f.projects['daily-friend'].memoryDir, 'catalog.db'), 'utf8'), 'private memory bytes');
  assert.equal(fs.existsSync(path.join(f.home, 'memory/personal/catalog.db')), false);
  for (const [projectId, manager] of [['daily-friend', f.old], ['daily', f.shared], ['business', f.business]]) {
    const view = await readChatSession(manager.getSessionId(), undefined, {}, projectId, f.home);
    assert.equal(view.session.owner.longAgentId, 'friend');
    assert.equal(view.session.readOnly, true);
    assert.equal(view.context.messages[0].content, 'preserve history');
  }
  assert.equal((await requireChatSession(f.plain.getSessionId(), 'daily', f.home)).owner.type, 'ordinary');
  await assert.rejects(requireChatSession(f.old.getSessionId(), 'business', f.home), /找不到Session/);
  assert.equal(await migrateAgentHomeNormalization(f.home), null);
});

test('P5 file conflict fails without data loss; retry keeps the original backup and no partial completion marker', async t => {
  const f = await fixture(t);
  const source = path.join(f.projects['daily-friend'].cwd, 'notes.md');
  const target = path.join(f.own.cwd, 'notes.md');
  fs.writeFileSync(source, 'old note'); fs.writeFileSync(target, 'current note');
  await assert.rejects(migrateAgentHomeNormalization(f.home), /冲突/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'old note');
  assert.equal(fs.readFileSync(target, 'utf8'), 'current note');
  assert.equal(fs.existsSync(path.join(f.dir, 'done-v2.json')), false);
  const backup = fs.readFileSync(path.join(f.dir, 'long-agent-state.v2.bak.json'));
  fs.renameSync(target, path.join(f.own.cwd, 'notes-reviewed.md'));
  await migrateAgentHomeNormalization(f.home);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old note');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'long-agent-state.v2.bak.json')), backup);
});

test('P5 rejects symlink escapes and malformed Session records rather than silently discarding evidence', async t => {
  const f = await fixture(t);
  const file = path.join(f.projects['daily-friend'].cwd, 'linked');
  fs.symlinkSync(f.root, file);
  await assert.rejects(migrateAgentHomeNormalization(f.home), /符号链接/);
  fs.unlinkSync(file);
  fs.appendFileSync(f.old.getSessionFile(), '\nBROKEN_JSON\n');
  await assert.rejects(migrateAgentHomeNormalization(f.home), SyntaxError);
  assert.match(fs.readFileSync(f.old.getSessionFile(), 'utf8'), /BROKEN_JSON/);
  assert.equal(fs.existsSync(path.join(f.dir, 'done-v2.json')), false);
});

test('P5 v1 receipt recovery restores Friend ownership and exact old links without rewriting native history', async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.copyFileSync(path.join(f.home, 'runtime/long-agent-state.json'), path.join(f.dir, 'long-agent-state.json.bak'));
  fs.copyFileSync(path.join(f.home, 'projects/registry.json'), path.join(f.dir, 'projects-registry.json.bak'));
  const bytes = fs.readFileSync(f.old.getSessionFile());
  fs.renameSync(f.old.getSessionFile(), path.join(f.own.sessionDir, path.basename(f.old.getSessionFile())));
  fs.rmSync(f.projects['daily-friend'].sessionDir, { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'done.json'), JSON.stringify({ schemaVersion: 1 }));
  await updateLongAgentState(f.home, state => ({ state: { ...state, projectAgents: [], bindings: [] }, result: undefined }));
  const result = await migrateAgentHomeNormalization(f.home);
  assert.equal(result.previousVersion, 1);
  const view = await requireChatSession(f.old.getSessionId(), 'daily-friend', f.home);
  assert.equal(view.projectId, 'friend'); assert.equal(view.readOnly, true); assert.equal(view.owner.longAgentId, 'friend');
  assert.deepEqual(fs.readFileSync(view.path), bytes);
});

test('P5 past days retain Friend ownership after daily rotation and stay read-only', async t => {
  const f = await fixture(t);
  await migrateAgentHomeNormalization(f.home);
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const yesterday = await ensureProjectLongAgent({ chatHome: f.home, projectId: 'friend', agent, now: new Date(Date.now() - 86400000) });
  const today = await ensureProjectLongAgent({ chatHome: f.home, projectId: 'friend', agent });
  const oldView = await requireChatSession(yesterday.day.sessionId, 'friend', f.home);
  assert.equal(oldView.owner.longAgentId, 'friend'); assert.equal(oldView.readOnly, true);
  assert.equal((await requireChatSession(today.day.sessionId, 'friend', f.home)).readOnly, false);
  await assert.rejects(ensureProjectLongAgent({ chatHome: f.home, projectId: 'friend', agent, requestedSessionId: yesterday.day.sessionId }), /历史保持只读/);
});

test('P5 definition split refuses conflicting files and serializes concurrent recovery', async t => {
  const f = await fixture(t);
  const marker = path.join(f.home, 'runtime/migrations/long-agent-definition-split/done.json');
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(f.home, 'long-agents.json'), JSON.stringify(f.registry));
  const definitionPath = path.join(f.home, 'long-agents/friend/definition.json');
  const changed = { ...definition, customInstructions: ['keep my edit'] };
  fs.writeFileSync(definitionPath, JSON.stringify(changed));
  await assert.rejects(readLongAgentRegistry(f.home), /定义迁移冲突/);
  assert.deepEqual(JSON.parse(fs.readFileSync(definitionPath)), changed);
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(definitionPath, JSON.stringify(definition));
  const results = await Promise.all(Array.from({ length: 8 }, () => readLongAgentRegistry(f.home)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'long-agents.json'))).agents[0].definition, undefined);
});

test('P5 state v3 upgrade repairs a missing completion receipt after interruption without replacing the backup', async t => {
  const f = await fixture(t);
  const { dailySessions, turns, works, ...old } = await readLongAgentState(f.home);
  const stateFile = path.join(f.home, 'runtime/long-agent-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ ...old, schemaVersion: 3 }));
  const upgraded = await readLongAgentState(f.home); assert.equal(upgraded.schemaVersion, 5);
  const dir = path.join(f.home, 'runtime/migrations/long-agent-daily-v4');
  const backup = fs.readFileSync(path.join(dir, 'source.json'));
  fs.unlinkSync(path.join(dir, 'complete.json'));
  assert.deepEqual(await readLongAgentState(f.home), upgraded);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'complete.json'))).targetSchema, 4);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'source.json')), backup);
});

test('P5 v1 ordinary Daily history has an exact read-only alias without becoming a Friend', async t => {
  const f = await fixture(t);
  const { ensureLongAgentShareProject } = await import('../../src/projects/registry.ts');
  const share = await ensureLongAgentShareProject(f.home);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.copyFileSync(path.join(f.home, 'projects/registry.json'), path.join(f.dir, 'projects-registry.json.bak'));
  fs.renameSync(f.plain.getSessionFile(), path.join(share.sessionDir, path.basename(f.plain.getSessionFile())));
  fs.writeFileSync(path.join(f.dir, 'done.json'), JSON.stringify({ schemaVersion: 1 }));
  await migrateAgentHomeNormalization(f.home);
  const view = await requireChatSession(f.plain.getSessionId(), 'daily', f.home);
  assert.equal(view.projectId, 'longagentshare'); assert.equal(view.owner.type, 'ordinary'); assert.equal(view.readOnly, true);
});

test('P5 schema 1 migration retains non-primary Web history when one Friend had multiple old channel Sessions', async t => {
  const f = await fixture(t);
  const legacy = (id, session, channelType) => ({ id, projectId: 'business', chatSessionId: session.getSessionId(), longAgentId: 'friend', nanoclawInstanceId: 'local', nanoclawAgentGroupId: 'group', nanoclawSessionId: channelType === 'chat-web' ? null : 'nano-1', primaryMessagingGroupId: channelType === 'chat-web' ? null : 'mg-1', source: { channelType, instance: channelType, platformId: id, threadId: null }, chatWebMessagingGroupId: null, chatWebPlatformId: id, createdAt: stamp, updatedAt: stamp });
  const second = SessionManager.create(f.projects.business.cwd, f.projects.business.sessionDir);
  second.appendMessage({ role: 'user', content: 'old Web history', timestamp: Date.now() }); second.flush();
  fs.writeFileSync(path.join(f.home, 'runtime/long-agent-state.json'), JSON.stringify({ schemaVersion: 1, cursors: { local: 0 }, bindings: [legacy('nano', f.business, 'telegram'), legacy('web', second, 'chat-web')] }));
  await migrateAgentHomeNormalization(f.home);
  assert.equal((await requireChatSession(second.getSessionId(), 'business', f.home)).owner.longAgentId, 'friend');
  assert.equal((await requireChatSession(second.getSessionId(), 'business', f.home)).readOnly, true);
});

test('P5 ordinary Workflow cannot take over a historical Friend even through the Backend entry', async t => {
  const f = await fixture(t); await migrateAgentHomeNormalization(f.home);
  const { startChatWorkflow } = await import('../../src/workflows/start-chat-workflow.ts');
  const { renameChatSession } = await import('../../src/session-name.ts');
  await assert.rejects(startChatWorkflow({ chatHome: f.home, projectId: 'business', sessionId: f.business.getSessionId(), cwd: f.projects.business.cwd, prompt: 'take over', workflow: 'minimal-pi-coding-agent' }), /Friend会话不能/);
  await assert.rejects(renameChatSession('business', f.business.getSessionId(), 'replace history', f.home), /历史会话只读/);
});
