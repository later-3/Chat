import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLongAgentActivity } from '../../src/long-agents/session-activity.ts';
import { withChatSessionOperationLock, chatSessionOperationKey, isChatSessionOperationBusy } from '../../src/session-operation-lock.ts';
const marker = status => ({id:'entry',type:'custom',customType:'chat.long_agent_turn',data:{schemaVersion:1,turnId:'turn',longAgentId:'agent',bindingId:'binding',source:'chat-web',channelType:null,inboundEventId:null,status,startedAt:'2026-09-19T00:00:00Z',completedAt:status==='running'?null:'2026-09-19T00:00:10Z',error:status==='failed'?'model failed':null}});
test('returning to a coworker recovers busy, successful, failed and interrupted states',async()=>{
 const running=[marker('running')];
 const entered=Promise.withResolvers();const finish=Promise.withResolvers();
 const operation=withChatSessionOperationLock(chatSessionOperationKey('p','s'),async()=>{entered.resolve();await finish.promise;});
 await entered.promise;
 assert.equal(projectLongAgentActivity(running,isChatSessionOperationBusy('p','s')).status,'running');
 assert.equal(isChatSessionOperationBusy('other','s'),false);
 finish.resolve();await operation;
 assert.equal(projectLongAgentActivity(running,isChatSessionOperationBusy('p','s')).status,'interrupted');
 assert.equal(projectLongAgentActivity([...running,marker('completed')],false).status,'completed');
 assert.equal(projectLongAgentActivity([...running,marker('failed')],false).error,'model failed');
 assert.equal(projectLongAgentActivity([],false).status,'idle');
 assert.equal(projectLongAgentActivity([],true).status,'running');
});
