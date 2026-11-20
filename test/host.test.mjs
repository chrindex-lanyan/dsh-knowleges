import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPORT_PATH, RPC_PATH, mountKnowledge } from '../src/host.mjs';

function setup(t, mode = 'preview') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-host-'));
  const mirrorRoot = join(root, 'remote-workspaces');
  const remoteDir = join(mirrorRoot, 'ssh-machine', 'repo');
  const local = { id: 'local-id', title: '试用本地', path: join(root, 'repo'), sessionIds: ['local-session'] };
  const ssh = { id: 'remote-id', title: '试用远程', path: remoteDir, sessionIds: ['remote-session'] };
  const remoteA = { dir: remoteDir, machineId:'stable-registry-id', host:'machine-a.invalid', port:22, username:'test', remotePath:'/home/test/repo' };
  let projects = [remoteA];
  let readProjects = async () => projects;
  const remote = { apiVersion:1, listRemoteProjects: () => readProjects() };
  const registry = { list: () => [local, ssh], archivedSessionIds: [] };
  const routes = new Map(), tools = new Map(), events = new Map(), disposers = [];
  const browser = { principal:{kind:'owner'}, interactions:'answer', signal:new AbortController().signal };
  const automation = { ...browser };
  const connection = {
    browserPeer: browser,
    admit(request) {
      switch (request.headers.get('x-fixture-channel')) {
        case 'browser': return { peer: browser };
        case 'program': return { peer: automation };
        default: return { rejection:401 };
      }
    },
    fetch: { register(route) { assert.equal(route.requestBody,'streaming'); routes.set(route.path,route); } },
  };
  const actors = new Map(['local-session','remote-session'].map(id => [id, { id, session: { id }, status:'running' }]));
  const promptSections = new Map();
  let rejectTool;
  function installEffect(start) {
    const result = start();
    const owned = [];
    if (typeof result === 'function') owned.push(result);
    else if (typeof result?.next === 'function') {
      try { for (const dispose of result) owned.push(dispose); }
      catch (error) { for (const dispose of owned.reverse()) dispose(); throw error; }
    }
    let cleaned = false;
    const dispose = () => {
      if (cleaned) return;
      cleaned = true;
      for (const cleanup of owned.reverse()) cleanup();
    };
    disposers.push(dispose);
    return dispose;
  }
  const ctx = {
    effect:installEffect,
    on(name, handler) { events.set(name,handler); },
    workspaceRegistry:registry,
    connection,
    systemPrompt:{section(section){ promptSections.set(section.name,section); }},
    tools:{register(def, options){
      if (def.name === rejectTool) throw Error('fixture registration failed');
      if (tools.has(def.name)) throw Error('duplicate fixture registration');
      tools.set(def.name,{def,when:options.when});
      return () => { tools.delete(def.name); };
    }},
    get(name){
      if (name === 'dshRemote') return remote;
      if (name === 'agents') return { get:id => actors.get(id) };
    },
  };
  mountKnowledge(ctx,{mode,root:join(root,'knowledge'),mirrorRoot});
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); rmSync(root,{recursive:true,force:true}); });
  const call = (op, body={}, channel='browser', path=RPC_PATH) => routes.get(path).fetch(new Request('http://dsh.internal'+path,{
    method:'POST',headers:{'content-type':'application/json','x-fixture-channel':channel},body:JSON.stringify(op ? {op,...body} : body),
  }));
  const read = async (op,body) => {
    const response=await call(op,body); const data=await response.json(); assert.equal(data.ok,true,JSON.stringify(data)); return data.value;
  };
  const exec = (sessionId = 'local-session', excluded = []) => {
    const agent = actors.get(sessionId);
    const signal = new AbortController().signal;
    const admitted = new Map([...tools].filter(([name,item]) => !excluded.includes(name) && item.when({agent,signal}))
      .map(([name,item]) => [name,item.def]));
    const toolSet = {view(scope){ return scope === agent ? new Map([...admitted].filter(([name,def]) => tools.get(name)?.def === def)) : new Map(); }};
    return {agent,callId:randomUUID(),signal,toolSet};
  };
  const guidance = (exec, extra = {}) => [...promptSections.values()].map(s => s.text({
    agent:exec.agent,scope:exec.agent,signal:exec.signal,toolSet:exec.toolSet,...extra,
  })).join('');
  const execute = (name, args, caller = exec()) => tools.get('knowledge_' + name)?.def.execute(args,caller);
  return { routes,tools,events,registry,actors,read,call,exec,guidance,execute,remoteA,
    rejectRegistration:name => {rejectTool=name;}, setProjects:list => {projects=list;}, readProjects:fn => {readProjects=fn;},
    failProjects:() => { readProjects=async () => {throw Error('fixture registry unavailable');}; },
  };
}

const toolNames = ['search','get','get_many','stale_candidates','propose','propose_batch','proposal_status'].map(name => 'knowledge_' + name);

test('preview has no tools; only the browser owner can explicitly switch the synthetic trial', async t => {
  const f=setup(t);
  assert.deepEqual([...f.routes.keys()],[RPC_PATH,EXPORT_PATH]);
  assert.equal(f.tools.size,0);
  const old = f.exec();
  assert.equal(f.guidance(old),'');
  const enable = {enabled:true, confirmTrial:true};
  assert.equal((await f.call('libraries',{},'program')).status,403);
  assert.equal((await f.call('libraries',{},'anonymous')).status,403);
  assert.equal((await f.call(undefined,{ticket:'x'},'program',EXPORT_PATH)).status,403);
  assert.equal((await f.call('setSessionTools',enable,'program')).status,403);
  assert.equal((await f.call('setSessionTools',{enabled:true})).status,400);
  assert.equal(f.tools.size,0);
  const malformed=await f.routes.get(RPC_PATH).fetch(new Request('http://dsh.internal'+RPC_PATH,{
    method:'POST',headers:{'content-type':'application/json','x-fixture-channel':'browser'},body:'{unfinished',
  }));
  assert.equal((await malformed.json()).error.code,'BAD_INPUT');
  assert.equal((await f.call('libraries',{ignored:'x'.repeat(300_000)})).status,413);
  const lists=await f.read('libraries');
  assert.equal(lists.mode,'preview');
  assert.equal(lists.libraries.length,3);
  assert.equal(JSON.stringify(lists).includes('machine-a.invalid'),false);
  assert.deepEqual(await f.read('setSessionTools',enable),{mode:'trial'});
  assert.deepEqual([...f.tools.keys()],toolNames);
  assert.equal(f.guidance(old),'');
  const step = f.exec();
  assert.deepEqual([...step.toolSet.view(step.agent).keys()],toolNames);
  const prompt = f.guidance(step);
  assert.match(prompt,/knowledge_propose_batch/);
  assert.match(prompt,/global reads require independent authorization/);
  assert.match(prompt,/Every write needs separate human confirmation/);
  for (const privateText of ['machine-a.invalid','local-session','workspace:ssh:','/home/test/repo']) {
    assert.equal(prompt.includes(privateText),false);
  }
  assert.equal(f.guidance(step,{toolSet:undefined}),'');
  assert.equal(f.guidance(step,{agent:undefined}),'');
  assert.equal(f.guidance(step,{scope:f.actors.get('remote-session')}),'');
  assert.equal(f.guidance(step,{signal:AbortSignal.abort()}),'');
  const restricted = f.exec('local-session',['knowledge_propose_batch']);
  assert.doesNotMatch(f.guidance(restricted),/knowledge_propose_batch/);
  assert.equal((await f.execute('search',{scope:'workspace'},old)).error.code,'ACCESS_DENIED');
  const held = f.tools.get('knowledge_search').def;
  assert.deepEqual(await f.read('setSessionTools',{enabled:false}),{mode:'preview'});
  assert.equal(f.tools.size,0);
  assert.equal(f.guidance(step),'');
  assert.equal((await held.execute({scope:'workspace'},step)).error.code,'MODEL_DISABLED');
  await f.read('setSessionTools',enable);
  assert.notEqual(f.tools.get('knowledge_search').def,held);
  assert.equal((await held.execute({scope:'workspace'},step)).error.code,'MODEL_DISABLED');
  assert.equal((await f.execute('search',{scope:'workspace'},step)).error.code,'ACCESS_DENIED');
});

test('failed tool registration rolls back the mode and does not leave partially active registrations',async t=>{
  const f=setup(t);
  f.rejectRegistration('knowledge_get_many');
  const response=await f.call('setSessionTools',{enabled:true,confirmTrial:true});
  assert.equal(response.status,503);
  assert.equal((await f.read('libraries')).mode,'preview');
  assert.equal(f.tools.size,0);
  f.rejectRegistration(undefined);
  assert.equal((await f.read('setSessionTools',{enabled:true,confirmTrial:true})).mode,'trial');
  assert.deepEqual([...f.tools.keys()],toolNames);
});

test('an in-flight binding lookup does not cross a disable or revive after re-enable',async t=>{
  const f=setup(t,'trial');
  const step=f.exec();
  let release;
  f.readProjects(() => new Promise(resolve => { release=resolve; }));
  const read=f.execute('search',{scope:'workspace'},step);
  assert.deepEqual(await f.read('setSessionTools',{enabled:false}),{mode:'preview'});
  assert.deepEqual(await f.read('setSessionTools',{enabled:true,confirmTrial:true}),{mode:'trial'});
  release([f.remoteA]);
  assert.equal((await read).error.code,'MODEL_DISABLED');
});

test('model bridge derives SSH identity from Host registry and never trusts a tool parameter or process path',async t=>{
  const f=setup(t,'trial');
  const scope={scope:'workspace'};
  const caller=f.exec('remote-session');
  assert.equal((await f.execute('search',{...scope,workspaceId:'remote-id'},caller)).error.code,'BAD_INPUT');
  assert.equal((await f.execute('search',scope,{...caller,agent:{...caller.agent}})).error.code,'ACCESS_DENIED');
  const allowed=await f.read('libraries');
  const oldKey=allowed.libraries.find(x=>x.title==='试用远程').key;
  assert.match(oldKey,/^workspace:ssh:[a-f0-9]{64}$/);
  const accepted=await f.execute('propose',{...scope,kind:'create',draft:{title:'一号 SSH 合成库',detail:'合成测试'}},caller);
  assert.equal(accepted.ok,true,JSON.stringify(accepted));
  const { proposal } = await f.read('proposal',{library:oldKey,id:accepted.value.id});
  await f.read('decide',{library:oldKey,id:proposal.id,digest:proposal.digest,decision:'approve'});
  assert.equal((await f.execute('search',scope,caller)).value.items[0].title,'一号 SSH 合成库');
  assert.deepEqual((await f.read('readRequests')).requests,[]);
  f.setProjects([{...f.remoteA,host:'machine-b.invalid'}]);
  const nextKey=(await f.read('libraries')).libraries.find(x=>x.title==='试用远程').key;
  assert.notEqual(nextKey,oldKey);
  assert.deepEqual((await f.execute('search',scope,caller)).value,{items:[],hasMore:false});
  assert.equal((await f.call('entries',{library:oldKey})).status,404);
  f.setProjects([f.remoteA,{...f.remoteA,host:'ambiguous.invalid'}]);
  assert.equal((await f.execute('search',scope,caller)).error.code,'WORKSPACE_UNAVAILABLE');
  f.setProjects([]);
  assert.equal((await f.execute('search',scope,caller)).error.code,'WORKSPACE_UNAVAILABLE');
  assert.deepEqual((await f.execute('search',scope)).value,{items:[],hasMore:false});
  f.failProjects();
  assert.equal((await f.execute('search',scope)).error.code,'WORKSPACE_UNAVAILABLE');
});

test('workspace batches stage writes for owner approval; global batch reads still need authorization',async t=>{
  const f=setup(t,'trial');
  const scope={scope:'workspace'};
  const staged=await f.execute('propose_batch',{...scope,items:[
    {kind:'create',draft:{title:'合成甲',detail:'合成测试'}},{kind:'create',draft:{title:'合成乙',detail:'合成测试'}},
  ]});
  assert.equal(staged.ok,true,JSON.stringify(staged));
  const library='workspace:local-id';
  const { id,itemCount,state }=staged.value;
  assert.equal(state,'pending');
  assert.equal(itemCount,2);
  assert.deepEqual(await f.read('entries',{library}),{items:[],hasMore:false});
  assert.equal((await f.call('batchProposal',{library,id},'program')).status,403);
  const { batch }=await f.read('batchProposal',{library,id});
  assert.equal((await f.read('decideBatch',{library,id,digest:batch.digest,decision:'approve'})).state,'applied');
  assert.deepEqual((await f.execute('proposal_status',{...scope,id,batch:true})).value,{id,state:'applied',itemCount:2});
  const entries = await f.read('entries',{library});
  const ids=entries.items.map(item => item.id);
  const missing=randomUUID();
  const read=await f.execute('get_many',{...scope,ids:[...ids,missing]});
  assert.equal(read.ok,true,JSON.stringify(read));
  assert.deepEqual(read.value.items.map(item => item.id),ids);
  assert.deepEqual(read.value.unavailable,[missing]);
  assert.deepEqual(read.value.remaining,[]);
  assert.ok(read.value.items.every(item => !Object.hasOwn(item,'sources')));
  assert.equal((await f.execute('get_many',{scope:'global',ids})).error.code,'READ_APPROVAL_REQUIRED');
  assert.equal((await f.execute('get_many',{scope:'global',ids:Array.from({length:21},()=>randomUUID())})).error.code,'BAD_INPUT');
});

test('archiving or ending an Agent’s session clears grants and denies late calls and guidance',async t=>{
  const f=setup(t,'trial');
  const caller=f.exec();
  const scope={scope:'global'};
  assert.equal((await f.execute('search',scope,caller)).error.code,'READ_APPROVAL_REQUIRED');
  const grant=(await f.read('readRequests')).requests[0];
  await f.read('decideRead',{id:grant.id,decision:'session'});
  assert.equal((await f.execute('search',scope,caller)).ok,true);
  caller.agent.status='idle';
  assert.equal(f.guidance(caller),'');
  assert.equal((await f.execute('search',scope,caller)).error.code,'ACCESS_DENIED');
  assert.equal(f.exec().toolSet.view(caller.agent).size,0);
  caller.agent.status='running';
  f.registry.archivedSessionIds.push(caller.agent.session.id);
  f.events.get('workspace/session-archived')({sessionId:caller.agent.session.id});
  assert.equal((await f.execute('search',scope,caller)).error.code,'ACCESS_DENIED');
  assert.equal(f.guidance(caller),'');
  assert.deepEqual((await f.read('readRequests')).grants,[]);
  f.registry.archivedSessionIds.length=0;
  assert.equal((await f.execute('search',scope,caller)).error.code,'READ_APPROVAL_REQUIRED');
  const second=(await f.read('readRequests')).requests[0];
  await f.read('decideRead',{id:second.id,decision:'session'});
  f.actors.delete(caller.agent.id);
  f.events.get('agent/disposed')({agent:caller.agent});
  assert.equal((await f.execute('search',scope,caller)).error.code,'ACCESS_DENIED');
  assert.equal(f.guidance(caller),'');
  assert.deepEqual((await f.read('readRequests')).grants,[]);
});
