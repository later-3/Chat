import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {bindWorkflowLaunch, resumeWorkflowLaunch} from '../../src/workflows/launch-binding.ts';

test('a crash after binding recovers the same SDK Run, once, before dispatch', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chat-launch-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const calls=[];
 const world={queue:async(...args)=>{calls.push(args);return {}}};
 const wrapper=bindWorkflowLaunch({projectDataDir:dir,invocationId:'test-round',bind:async id=>{calls.push(id);throw new Error('process lost before dispatch')}},world);
 const dispatch=wrapper.queue('workflow', {runId:'wrun_same', runInput:{input:new Uint8Array([1,2,3])}});
 await assert.rejects(dispatch,/process lost/);
 assert.deepEqual(calls,['wrun_same'],'receipt binding precedes the only dispatch');
 const bound=[];
 assert.equal(await resumeWorkflowLaunch(dir,'test-round',async id=>bound.push(id),world),'wrun_same');
 assert.deepEqual(bound,['wrun_same']);assert.equal(calls[1][1].runId,'wrun_same');
 assert.deepEqual([...calls[1][1].runInput.input],[1,2,3]);
 assert.equal(await resumeWorkflowLaunch(dir,'test-round',async()=>assert.fail('already consumed'),world),undefined);
 assert.equal(calls.length,2);
});
