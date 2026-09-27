import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './daily-fixture.mjs';
import { buildLongAgentActivity } from '../../src/long-agents/activity.ts';
import { manageFriendDuty, listFriendDuties, reconcileFriendDuties } from '../../src/long-agents/duties/service.ts';
import { dispatchTaskOccurrences } from '../../src/long-agents/tasks/service.ts';
import { listFriendWork } from '../../src/long-agents/work.ts';
import { drainLongAgentTurns } from '../../src/long-agents/turn-queue.ts';

test('real native summary usage must appear in activity and duty totals', async t => {
  const f = await fixture(t);
  const projections = new Map();
  const original = globalThis.fetch;
  const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = 'test-duty-projection-token-32-characters-long';
  t.after(() => { if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!String(url).includes('/v1/task-projections')) return original(url, init);
    const body = JSON.parse(init.body);
    if (body.operation === 'claim') return Response.json({ schemaVersion: 1, timeZone: 'Asia/Shanghai', tasks: [] });
    if (body.operation === 'preview') return Response.json({ schemaVersion: 1, nextAt: null });
    if (body.operation === 'apply') { const p = body.projection; projections.set(p.taskId, { taskId: p.taskId, revision: p.revision, nextAt: null }); return Response.json({ schemaVersion: 1, ...projections.get(p.taskId) }); }
    return Response.json({ schemaVersion: 1, projections: [...projections.values()] });
  });
  const settingsPath = path.join(f.home, 'agent/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 } }));
  let ordinary = 0, summaries = 0, providerTokens = 0;
  f.setHandler(body => {
    const summary = body.messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('context summarization assistant'));
    if (summary) summaries++; else ordinary++;
    const usage = summary ? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      : ordinary === 1 ? { prompt_tokens: 127000, completion_tokens: 10, total_tokens: 127010 }
      : { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
    providerTokens += usage.total_tokens;
    return { content: summary ? 'AUDIT_NATIVE_SUMMARY' : 'AUDIT_COMPLETED', usage };
  });
  const command = body => manageFriendDuty(f.home, 'friend', { schemaVersion: 1, source: 'user', ...body });
  const duty = (await command({ operation: 'create', requestId: 'audit-duty', definition: {
    name: 'Audit', objective: 'Read ' + 'history '.repeat(300), materials: ['materials/example.md'], outcome: 'Notes',
    contextProjectId: null, timeZone: 'Asia/Shanghai', cadence: { kind: 'none' }, allowedHours: null,
    budget: { tokensPerDay: 200000 }, totalUnits: null,
  } })).duties[0];
  await command({ operation: 'advance', dutyId: duty.id, expectedRevision: duty.revision, requestId: 'audit-advance' });
  await dispatchTaskOccurrences(f.home, 'friend');
  for (const item of (await listFriendWork(f.home, 'friend')).works) await drainLongAgentTurns(f.home, 'friend', item.work.sessionId);
  await reconcileFriendDuties(f.home, 'friend');
  const result = (await listFriendDuties(f.home, 'friend')).duties[0];
  const activity = await buildLongAgentActivity({ chatHome: f.home, longAgentId: 'friend', from: '2026-01-01', to: '2099-12-31' });
  const actual = { dutyTokens: result.tokensToday, activityTokens: activity.days.reduce((n,d) => n + d.tokens.total, 0) };
  console.log(JSON.stringify({ probe: 'native-summary-metering', ordinary, summaries, providerTokens, ...actual }));
  assert.ok(summaries > 0, 'native compaction must reach the local HTTP provider');
  assert.deepEqual(actual, { dutyTokens: providerTokens, activityTokens: providerTokens });
});

test('activity day uses the configured Friend timezone', async t => {
  const f = await fixture(t);
  const previousTz = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });
  const dir = path.join(f.home, 'long-agents/friend/sessions');
  fs.writeFileSync(path.join(dir, 'audit-zone.jsonl'), JSON.stringify({
    type: 'message', timestamp: '2026-09-26T20:00:00.000Z',
    message: { role: 'assistant', provider: 'test', model: 'test', usage: { input: 5, output: 5, totalTokens: 10 } },
  }) + '\n');
  const activity = await buildLongAgentActivity({ chatHome: f.home, longAgentId: 'friend', from: '2026-09-26', to: '2026-09-27' });
  console.log(JSON.stringify({ probe: 'activity-timezone', host: 'UTC', friend: 'Asia/Shanghai', expectedDate: '2026-09-27', actual: activity.days.map(d => d.date) }));
  assert.deepEqual(activity.days.map(d => d.date), ['2026-09-27']);
});

test('usage includes cache and branch summaries without charging unrelated metadata', async () => {
  const { nativeEntryUsage } = await import('../../src/long-agents/session-usage.ts');
  const usage = { input: 10, output: 2, cacheRead: 4, cacheWrite: 3, totalTokens: 19 };
  for (const entry of [{ type:'compaction', usage }, {type:'branch_summary',usage}, {type:'message',message:{role:'toolResult',usage}}]) {
    assert.deepEqual(nativeEntryUsage(entry), {input:10,output:2,total:19});
  }
  assert.equal(nativeEntryUsage({type:'custom',usage}).total,0);
  assert.equal(nativeEntryUsage({type:'compaction',usage:{input:-1,output:NaN}}).total,0);
});
