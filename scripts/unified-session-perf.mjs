/** Read-only contact navigation against an isolated, production-built server. No response interception.
 * node scripts/unified-session-perf.mjs http://127.0.0.1:<isolated-port> [samples]
 * Private message content is never written to evidence; identity/count ensure the target history rendered.
 */
import { launchBrowser } from './cdp.mjs';
import fs from 'node:fs';
const base = process.argv[2];
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || base.endsWith(':43110')) throw new Error('Provide an isolated loopback server, not production');
// Before sharing a copied-data preview, validate every listed Session against the actual running
// Backend. Listing alone does not prove its native cwd still matches the registered Project root.
if (process.argv[3] === '--audit-sessions') {
 const overviewResponse = await fetch(`${base}/api/sessions/overview`);
 if (!overviewResponse.ok) throw new Error(`overview HTTP ${overviewResponse.status}`);
 const overview = await overviewResponse.json();
 if (!Array.isArray(overview.sessions)) throw new Error('Invalid overview sessions');
 const results = []; let index = 0;
 await Promise.all(Array.from({length: 4}, async () => {
  while (index < overview.sessions.length) {
   const session = overview.sessions[index++];
   if (typeof session.projectId !== 'string' || typeof session.id !== 'string') throw new Error('Invalid Session identity');
   const query = new URLSearchParams({projectId: session.projectId, view:'chat', deferThinking:'1', deferMedia:'1'});
   const response = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}?${query}`, {signal:AbortSignal.timeout(30_000)});
   const body = await response.json();
   const valid = response.ok && body.sessionId === session.id && Array.isArray(body.context?.messages);
   results.push({projectId:session.projectId, sessionId:session.id, status:response.status, valid,
    ...(valid ? {messages:body.context.messages.length} : {error:body.message ?? body.statusMessage ?? 'invalid detail'})});
  }
 }));
 results.sort((a,b)=>a.sessionId.localeCompare(b.sessionId));
 const report = {at:new Date().toISOString(), total:results.length, passed:results.filter(r=>r.valid).length,
  failures:results.filter(r=>!r.valid), sessions:results};
 const output = new URL('../.data/verification/unified-session/', import.meta.url); fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(new URL('session-audit.json',output),JSON.stringify(report,null,2));
 console.log(JSON.stringify({total:report.total,passed:report.passed,failures:report.failures},null,2));
 process.exitCode = report.failures.length === 0 ? 0 : 1;
} else {
const count = Number(process.argv[3] ?? 50);
const ids = ['nexus','architecture-muse','coder-muse'];
const targets = {}; const messageCounts = {};
for (const id of ids) {
 const daily = await (await fetch(`${base}/api/long-agents/${id}/daily`)).json();
 targets[id] = daily.days.find(day=>day.date===daily.today)?.sessionId;
 if (!targets[id]) throw new Error(`No current daily Session for ${id}`);
 const detail = await (await fetch(`${base}/api/sessions/${targets[id]}?projectId=${id}&view=chat`)).json();
 if(!Array.isArray(detail.context?.messages)) throw new Error(`Cannot read isolated session ${id}`);
 messageCounts[id] = detail.context.messages.length;
}
const browser = await launchBrowser();
const samples = [];
const output = new URL('../.data/verification/unified-session/', import.meta.url);
fs.mkdirSync(output,{recursive:true});
try {
 const p = await browser.newPage('about:blank');
 await p.send('Network.enable');
 await p.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await p.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
  window.__spans=[];window.__tasks=[];window.__polls=0;
  new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__tasks.push({start:e.startTime,ms:e.duration}))).observe({type:'longtask',buffered:true});
  const raw=window.fetch.bind(window);window.fetch=async(...args)=>{
   const url=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);
   if(url.pathname==='/api/sessions/overview')window.__polls++;
   const span={url:url.pathname+url.search,begin:performance.now()};window.__spans.push(span);
   const response=await raw(...args);span.headers=performance.now();
   const json=response.json.bind(response);response.json=async()=>{span.parseBegin=performance.now();const data=await json();span.parseEnd=performance.now();return data};return response;
  };
 })()`});
 await p.send('Page.navigate',{url:base+'/?session='+targets['architecture-muse']+'&projectId=architecture-muse'});
 await p.waitFor(`document.querySelector('[data-rendered-session="${targets['architecture-muse']}"] [data-chat-composer]')!==null`,{timeoutMs:60000});
 let last='architecture-muse';
 for (const [mode,n] of [['first_visit',3],['warm',count],['poll_overlap',10]]) {
  for(let i=0;i<n;i++){
   let id=ids[i%ids.length];if(id===last)id=ids[(i+1)%ids.length];
   if(mode==='poll_overlap') { const serial=await p.evaluate('window.__polls');await p.waitFor(`window.__polls>${serial}`,{timeoutMs:15000}); }
   const result=await p.evaluate(`(async()=>{
    const id=${JSON.stringify(id)},sid=${JSON.stringify(targets[id])};window.__spans=[];window.__tasks=[];performance.clearResourceTimings();const begin=performance.now();let selected=null,input=null,history=null;
    document.querySelector('[data-long-agent-open="'+id+'"]').click();
    await new Promise((resolve,reject)=>{const tick=()=>{const now=performance.now(),row=document.querySelector('[data-long-agent-open="'+id+'"]'),surface=document.querySelector('[data-workspace-chat]'),view=surface?.querySelector('[data-rendered-session="'+sid+'"]'),composer=view?.querySelector('[data-chat-composer]');
     if(selected===null&&row?.getAttribute('aria-current')==='page')selected=now;
     if(view&&surface&&!surface.hidden&&composer&&!composer.disabled&&composer.getBoundingClientRect().height>0){input??=now;if(Number(view.dataset.renderedMessageCount)===${messageCounts[id]})history??=now;}
     if(selected!==null&&input!==null&&history!==null){requestAnimationFrame(()=>requestAnimationFrame(resolve));return}
     if(now-begin>30000){reject(new Error(JSON.stringify({reason:'target history/composer did not render',id,sid,url:location.href,selected,input,history,rendered:[...document.querySelectorAll('[data-rendered-session]')].map(e=>({session:e.dataset.renderedSession,count:e.dataset.renderedMessageCount})),row:row?.getAttribute('aria-current'),input:composer===null?null:{disabled:composer?.disabled,height:composer?.getBoundingClientRect().height}})));return}requestAnimationFrame(tick)};requestAnimationFrame(tick)});
    return {agent:id,selectedMs:selected-begin,inputMs:input-begin,historyMs:history-begin,paintMs:performance.now()-begin,spans:window.__spans.map(s=>({...s,begin:s.begin-begin,headers:s.headers-begin,parseBegin:s.parseBegin-begin,parseEnd:s.parseEnd-begin})),longTasks:window.__tasks};
   })()`);
   samples.push({mode,...result});last=id; if(i%10===0)console.log(JSON.stringify({mode,i,...Object.fromEntries(Object.entries(result).filter(([key])=>key.endsWith("Ms")))}));
  }
 }
 const stats=values=>{values.sort((a,b)=>a-b);return{p50:values[Math.floor(values.length*.5)],p95:values[Math.ceil(values.length*.95)-1],max:values.at(-1)}};
 const summary=['first_visit','warm','poll_overlap'].map(mode=>({mode,n:samples.filter(s=>s.mode===mode).length,...Object.fromEntries(['selectedMs','inputMs','historyMs','paintMs'].map(key=>[key,stats(samples.filter(s=>s.mode===mode).map(s=>s[key]))]))}));
 fs.writeFileSync(new URL('navigation.json',output),JSON.stringify({summary,samples},null,2));
 console.log(JSON.stringify(summary,null,2));
} finally { const exited=new Promise(resolve=>browser.child.once("exit",resolve));browser.child.kill("SIGKILL");if(browser.child.exitCode===null)await exited;await browser.close(); }

}
