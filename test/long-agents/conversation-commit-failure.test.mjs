import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  revokeMember,
} from "../../src/long-agents/conversations/service.ts";
import { appendConversationUserMessage } from "../../src/long-agents/conversations/public-root.ts";
import { readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";
import {
  cancelConversationWork,
  drainConversationWorks,
  listConversationWorks,
  startConversationWork,
} from "../../src/long-agents/conversations/work.ts";
import {
  readDiscussionState,
  recordDiscussionModelCall,
  startConversationDiscussion,
} from "../../src/long-agents/conversations/discussions.ts";

async function setup(f, requestId) {
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "任务小组", requestId, memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const origin = await appendConversationUserMessage({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    clientMessageId: `origin-${requestId}`, text: "请后台研究一下这个问题",
  });
  return { conversation, bound, originEntryId: origin.message.entryId };
}

async function projection(f, conversation) {
  return readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
}


import { executeConversationWork } from "../../src/long-agents/conversations/work.ts";
import { queueSpeechAttempt } from "../../src/long-agents/conversations/discussions.ts";
import { dispatchConversationAttempt } from "../../src/long-agents/conversations/dispatch.ts";

import fsp from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
test("review failed commit-state read releases arbitration for subsequent cancellation",async t=>{
 const f=await fixture(t);const {conversation}=await setup(f,"read-error");
 const base={chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,longAgentId:"friend",title:"task",instruction:"work"};
 const {work}=await startConversationWork({...base,requestId:"w1"});
 const second=await startConversationWork({...base,requestId:"w2"});
 const original=fsp.readFile;let injected=false;
 fsp.readFile=async function(...args){
  if(!injected && String(args[0]).endsWith("works.json") && new Error().stack.includes("assertStillAuthorized")) {
   injected=true;throw Object.assign(new Error("review injected EIO"),{code:"EIO"});
  }
  return original.apply(this,args);
 };
 syncBuiltinESMExports();
 try {await assert.rejects(executeConversationWork({...base,workId:work.workId}),/review injected EIO/);}
 finally {fsp.readFile=original;syncBuiltinESMExports();}
 assert.equal(injected,true);
 let timer;
 try {
  const result=await Promise.race([cancelConversationWork({...base,workId:second.work.workId}),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:"blocked"}),500);})]);
  assert.equal(result.status,"cancelled","a transient read error must not permanently block this conversation");
 } finally {clearTimeout(timer);}
});

import {SessionManager} from "@earendil-works/pi-coding-agent";
for (const failure of ["append", "flush"]) {
 test(`publication ${failure} error releases both commit locks`,async t=>{
  const f=await fixture(t);const {conversation}=await setup(f,`failure-${failure}`);
  const base={chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,longAgentId:"friend",title:"task",instruction:"work"};
  const {work}=await startConversationWork({...base,requestId:"w1"});
  const second=await startConversationWork({...base,requestId:"w2"});
  const append=SessionManager.prototype.appendCustomEntry,flush=SessionManager.prototype.flush;
  let injected=false,publicManager;
  SessionManager.prototype.appendCustomEntry=function(type,...args){
   if(type==="chat.group-publication.v1") {
    publicManager=this;
    if(failure==="append" && !injected){injected=true;throw new Error("injected append");}
   }
   return append.call(this,type,...args);
  };
  SessionManager.prototype.flush=function(...args){
   if(failure==="flush" && this===publicManager && !injected){injected=true;throw new Error("injected flush");}
   return flush.apply(this,args);
  };
  try {await assert.rejects(executeConversationWork({...base,workId:work.workId}),new RegExp(`injected ${failure}`));}
  finally {SessionManager.prototype.appendCustomEntry=append;SessionManager.prototype.flush=flush;}
  assert.equal(injected,true);
  const cancelled=await cancelConversationWork({...base,workId:second.work.workId});
  assert.equal(cancelled.status,"cancelled");
  // A fresh publication must also pass the public-root lock after the failure.
  const third=await startConversationWork({...base,requestId:"w3"});
  const completed=await executeConversationWork({...base,workId:third.work.workId});
  assert.equal(completed.status,"completed");
 });
}
