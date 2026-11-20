import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeService } from '../src/service.mjs';
import { normalizeDraft } from '../src/validation.mjs';

const a = 'workspace:ws-a', b = 'workspace:ws-b';
const makeCaller = (sessionId = 's-a', workspaceId = 'ws-a', callId = 'call-1') =>
  ({ sessionId, agentId: sessionId + '-agent', workspaceId, callId, signal: new AbortController().signal });
const fields = (title = '试用知识') => ({ title, detail: '合成测试资料', tags: ['测试'], confidence: null, evidence: [], relations: [] });
const checkError = code => ({ code });

function setup(t, mode = 'trial') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-service-'));
  let now = 1_700_000_000_000;
  const items = [{ id: 'ws-a', title: 'A' }, { id: 'ws-b', title: 'B' }];
  const service = new KnowledgeService({ root, mode, workspaceList: () => items, now: () => now });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, advance: ms => { now += ms; }, removeWorkspace: id => {
    const i = items.findIndex(item => item.id === id);
    if (i !== -1) items.splice(i, 1);
  } };
}

function stage(service, library, kind, extras = {}) {
  return service.human({ op: 'stage', library, kind, ...extras }).proposal;
}
function decide(service, library, proposal, decision = 'approve') {
  return service.human({ op: 'decide', library, id: proposal.id, digest: proposal.digest, decision });
}
function create(service, library = a, draft = fields()) {
  const p = stage(service, library, 'create', { draft });
  assert.equal(decide(service, library, p).state,'applied');
  return p.targetId;
}
function requestOf(service, sessionId, library, operation) {
  const row = service.human({ op: 'readRequests' }).requests.find(r =>
    r.sessionId === sessionId && r.library === library && (!operation || operation === r.operation));
  assert.ok(row);
  return row;
}
function authorize(service, library, caller, operation, args, decision = 'session') {
  assert.throws(() => service.model(operation, args, caller), checkError('READ_APPROVAL_REQUIRED'));
  const row = requestOf(service, caller.sessionId, library, operation);
  service.human({ op: 'decideRead', id: row.id, decision });
  return row;
}

test('preview exposes only human-managed data and never silently resolves an unknown workspace', t => {
  const { service, root } = setup(t, 'preview');
  assert.equal(service.human({ op: 'libraries' }).mode, 'preview');
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => service.model('search',{scope:'global'},makeCaller()),checkError('MODEL_DISABLED'));
  assert.throws(() => service.human({op:'entries',library:'workspace:other'}),checkError('WORKSPACE_UNAVAILABLE'));
  assert.throws(() => stage(service,'global','create',{draft:fields()}),checkError('PROMOTION_REQUIRED'));
  assert.deepEqual(readdirSync(root), []);
});

test('bound workspaces are readable immediately without a lease or fallback to another library', t => {
  const { service, removeWorkspace } = setup(t);
  const id = create(service, a, fields('仅 A'));
  const otherId = create(service, b, fields('仅 B'));
  const caller = makeCaller();
  assert.equal(service.model('get', { scope: 'workspace', id }, caller).id, id);
  assert.deepEqual(service.model('search', { scope: 'workspace' }, caller).items.map(row => row.id), [id]);
  assert.throws(() => service.model('get', { scope: 'workspace', id: otherId }, caller), checkError('NOT_FOUND'));
  assert.throws(() => service.model('search', { scope: 'workspace', workspaceId: 'ws-b' }, caller), checkError('BAD_INPUT'));
  const unbound = { ...caller }; delete unbound.workspaceId;
  assert.throws(() => service.model('search', { scope: 'workspace' }, unbound), checkError('WORKSPACE_UNAVAILABLE'));
  assert.deepEqual(service.human({ op: 'readRequests', library: a }), { requests: [], grants: [] });
  assert.deepEqual(service.human({ op: 'readRequests' }), { requests: [], grants: [] });
  removeWorkspace('ws-a');
  assert.throws(() => service.model('get', { scope: 'workspace', id }, caller), checkError('WORKSPACE_UNAVAILABLE'));
});

test('global once grants bind normalized args and actor; unauthorized queries do not open the global DB', t => {
  const { service, root } = setup(t);
  const caller = makeCaller();
  const args = { scope: 'global', q: '测试' };
  authorize(service, 'global', caller, 'search', args, 'once');
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => service.model('search', { ...args, q: 'other' }, caller), checkError('READ_APPROVAL_REQUIRED'));
  assert.throws(() => service.model('search', args, makeCaller('child')), checkError('READ_APPROVAL_REQUIRED'));
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(service.model('search', args, caller), { items: [], hasMore: false });
  assert.throws(() => service.model('search', args, caller), checkError('READ_APPROVAL_REQUIRED'));
  assert.deepEqual(service.model('search', { scope: 'workspace' }, caller), { items: [], hasMore: false });
  assert.deepEqual(service.human({ op: 'readRequests', library: a }), { requests: [], grants: [] });
});

test('global grants expire and are revoked, including already-read receipts', t => {
  const { service, advance } = setup(t);
  const caller = makeCaller();
  const args = { scope: 'global' };
  const expired = authorize(service, 'global', caller, 'search', args, 'once');
  advance(5 * 60 * 1000 + 1);
  assert.throws(() => service.model('search', args, caller), checkError('READ_APPROVAL_REQUIRED'));
  assert.throws(() => service.human({ op: 'revokeRead', id: expired.id }), checkError('NOT_FOUND'));
  let row = requestOf(service, caller.sessionId, 'global');
  service.human({ op: 'decideRead', id: row.id, decision: 'session' });
  assert.deepEqual(service.model('search', args, caller).items, []);
  service.invalidateSession(caller.sessionId);
  assert.throws(() => service.model('search', args, caller), checkError('READ_APPROVAL_REQUIRED'));
  row = requestOf(service, caller.sessionId, 'global');
  service.human({ op: 'decideRead', id: row.id, decision: 'reject' });
  assert.throws(() => service.model('search', args, caller), checkError('READ_DENIED'));
});

test('preview toggle requires explicit acknowledgment and resets session access when toggled without removing drafts', t => {
  const { service } = setup(t, 'preview');
  const caller = makeCaller();
  const global = { scope: 'global' };
  assert.throws(() => service.human({ op: 'setSessionTools', enabled: true }), checkError('TRIAL_CONFIRMATION_REQUIRED'));
  assert.equal(service.mode, 'preview');
  assert.deepEqual(service.human({ op: 'setSessionTools', enabled: true, confirmTrial: true }), { mode: 'trial' });
  authorize(service, 'global', caller, 'search', global);
  assert.deepEqual(service.model('search', global, caller).items, []);
  const p = service.model('propose', { scope: 'workspace', kind: 'create', draft: fields('主动补充') }, caller);
  assert.equal(p.state, 'pending');
  assert.deepEqual(service.human({ op: 'entries', library: a }).items, []);
  service.human({ op: 'setSessionTools', enabled: false });
  assert.throws(() => service.model('search', { scope: 'workspace' }, caller), checkError('MODEL_DISABLED'));
  assert.deepEqual(service.human({ op: 'readRequests' }), { requests: [], grants: [] });
  const preview = service.human({ op: 'proposal', library: a, id: p.id }).proposal;
  assert.equal(preview.state, 'pending');
  assert.equal(decide(service, a, preview).state, 'applied');
  service.human({ op: 'setSessionTools', enabled: true, confirmTrial: true });
  assert.equal(service.model('search', { scope: 'workspace' }, caller).items[0].title, '主动补充');
  assert.throws(() => service.model('search', global, caller), checkError('READ_APPROVAL_REQUIRED'));
});

test('staging and deciding are idempotent; stale and rejected mutations leave official data alone', t => {
  const { service } = setup(t);
  const data = { draft: fields(), requestId: randomUUID() };
  const first = stage(service,a,'create',data);
  const second = stage(service,a,'create',data);
  assert.equal(first.id,second.id);
  assert.deepEqual(service.human({op:'entries',library:a,query:{status:'all'}}).items,[]);
  assert.equal(decide(service,a,first).resultRevision,1);
  assert.equal(decide(service,a,second).resultRevision,1);
  const editInput = {targetId:first.targetId,baseRevision:1,draft:fields('新标题'),requestId:randomUUID()};
  const edited = stage(service,a,'update',editInput);
  const stale = stage(service,a,'archive',{targetId:first.targetId,baseRevision:1,reason:'待审'});
  assert.equal(decide(service,a,edited).state,'applied');
  const retry = stage(service,a,'update',editInput);
  assert.equal(retry.id,edited.id);
  assert.equal(retry.state,'applied');
  assert.equal(decide(service,a,stale).state,'conflict');
  const next = stage(service,a,'archive',{targetId:first.targetId,baseRevision:2,reason:'待审'});
  assert.equal(decide(service,a,next,'reject').state,'rejected');
  assert.equal(service.human({op:'entry',library:a,id:first.targetId}).title,'新标题');
  assert.deepEqual(service.human({op:'history',library:a,id:first.targetId}).items.map(e=>e.revision),[1]);
  assert.deepEqual(service.human({op:'entries',library:b}).items,[]);
});

test('promotion requires a proven source, validates it at approval, and exposes only approved global data', t => {
  const { service } = setup(t);
  const id = create(service,a,{...fields('私有源'),detail:'源私密文本',evidence:[{kind:'file',label:'内部附件',reference:'notes/internal.txt'}]});
  const caller = makeCaller();
  const getSource = {scope:'workspace',id};
  const promote = {scope:'global',kind:'promote',sources:[{entryId:id,revision:1}],reason:'可共享的经验',draft:fields('公开摘要')};
  assert.throws(() => service.model('propose',promote,caller),checkError('READ_ENTRY_FIRST'));
  assert.equal(service.model('get',getSource,caller).revision,1);
  assert.deepEqual(service.human({ op: 'readRequests' }), { requests: [], grants: [] });
  const privateDraft={...promote,draft:{...promote.draft,evidence:[{kind:'file',label:'不要发出',reference:'notes/internal.txt'}]}};
  assert.throws(() => service.model('propose',privateDraft,caller),checkError('BAD_INPUT'));
  const old = service.model('propose',promote,caller).id;
  const update = stage(service,a,'update',{targetId:id,baseRevision:1,draft:fields('修订源')});
  decide(service,a,update);
  const p = service.human({op:'proposal',library:'global',id:old}).proposal;
  assert.equal(decide(service,'global',p).state,'conflict');
  const source = service.model('get',getSource,caller);
  const ready = service.model('propose',{...promote,sources:[{entryId:id,revision:source.revision}]},makeCaller('s-a','ws-a','call-2'));
  const proposal = service.human({op:'proposal',library:'global',id:ready.id}).proposal;
  assert.equal(proposal.draft.sources[0].revision,2);
  assert.equal(decide(service,'global',proposal).state,'applied');
  const globalId = proposal.targetId;
  const before = service.human({op:'entry',library:'global',id:globalId});
  assert.equal(before.detail,promote.draft.detail);
  assert.throws(() => stage(service,'global','update',{targetId:globalId,baseRevision:1,draft:{title:'重写',detail:'覆盖正文'}}),
    checkError('PROMOTION_REQUIRED'));
  const editorial = stage(service,'global','update',{targetId:globalId,baseRevision:1,draft:{title:'公开摘要（修订措辞）',tags:[],confidence:0.7}});
  assert.equal(decide(service,'global',editorial).state,'applied');
  authorize(service,'global',caller,'get',{scope:'global',id:globalId});
  const modelView = service.model('get',{scope:'global',id:globalId},caller);
  assert.equal(modelView.title,'公开摘要（修订措辞）');
  assert.equal(modelView.detail,before.detail);
  assert.equal('sources' in modelView,false);
});

function batchRead(service, library, id) {
  return service.human({ op: 'batchProposal', library, id });
}
function batchDecide(service, library, batch, decision = 'approve') {
  return service.human({ op: 'decideBatch', library, id: batch.id, digest: batch.digest, decision });
}

test('a session proactively stages a batch in its own library; approval applies every item once', t => {
  const { service } = setup(t);
  const caller = makeCaller();
  const args = { scope: 'workspace', reason: '测试准备', items: [
    { kind: 'create', draft: fields('第一项') }, { kind: 'create', draft: fields('第二项') },
  ] };
  const group = service.model('propose_batch', args, caller);
  assert.equal(group.state, 'pending');
  assert.equal(group.itemCount, 2);
  assert.equal(service.model('propose_batch', args, caller).id, group.id);
  assert.deepEqual(service.model('proposal_status', { scope: 'workspace', id: group.id, batch: true }, caller),
    { id: group.id, state: 'pending', itemCount: 2 });
  assert.throws(() => service.model('proposal_status', { scope: 'workspace', id: group.id, batch: true },
    makeCaller('another')), checkError('NOT_FOUND'));
  assert.deepEqual(service.human({ op: 'entries', library: a }).items, []);
  assert.deepEqual(service.human({ op: 'proposals', library: a }).items, []);
  assert.deepEqual(service.human({ op: 'batchProposals', library: a }).items.map(r => r.id), [group.id]);
  assert.deepEqual(service.human({ op: 'batchProposals', library: b }).items, []);
  const { batch, items } = batchRead(service, a, group.id);
  assert.deepEqual(items.map(item => item.proposal.draft.title), ['第一项', '第二项']);
  assert.deepEqual(items.map(item => item.before), [null, null]);
  assert.throws(() => decide(service, a, items[0].proposal), checkError('NOT_FOUND'));
  assert.equal(batchDecide(service, a, batch).state, 'applied');
  assert.equal(batchDecide(service, a, batch).state, 'applied');
  assert.deepEqual(service.model('search', { scope: 'workspace' }, caller).items.map(row => row.title).sort(), ['第一项', '第二项']);
});

test('one target version conflict rejects an entire batch; repeated targets and oversize drafts cannot be staged', t => {
  const { service } = setup(t);
  const id = create(service);
  const update = { kind: 'update', targetId: id, baseRevision: 1, draft: fields('组内修订') };
  assert.throws(() => service.human({ op: 'stageBatch', library: a, items: [update, update] }), checkError('BAD_INPUT'));
  const big = { ...fields('大草稿'), detail: 'a'.repeat(64 * 1024) };
  assert.throws(() => service.human({ op: 'stageBatch', library: a,
    items: Array.from({ length: 4 }, () => ({ kind: 'create', draft: big })) }), checkError('BATCH_LIMIT'));
  const mixed = service.human({ op: 'stageBatch', library: a, items: [
    update, { kind: 'create', draft: fields('组内新增') },
  ] });
  assert.equal(batchRead(service, a, mixed.batch.id).items[0].before.revision, 1);
  decide(service, a, stage(service, a, 'update', { targetId: id, baseRevision: 1, draft: fields('并发修订') }));
  assert.equal(batchDecide(service, a, mixed.batch).state, 'conflict');
  assert.deepEqual(service.human({ op: 'entries', library: a }).items.map(row => row.title), ['并发修订']);
});

test('global batch promotion needs a separate write approval and refuses all items if one source becomes stale', t => {
  const { service } = setup(t);
  const caller = makeCaller();
  const first = create(service, a, fields('来源一'));
  const second = create(service, a, fields('来源二'));
  const promote = (entries, callId) => service.model('propose_batch', { scope: 'global', reason: '抽取共享经验',
    items: entries.map((item, index) => ({ kind: 'promote', sources: [{ entryId: item.id, revision: item.revision }],
      draft: fields('公开 ' + index) })),
  }, { ...caller, callId });
  const available = () => service.model('get_many', { scope: 'workspace', ids: [first, second] }, caller);
  const read = available();
  assert.deepEqual(read.items.map(item => item.id), [first, second]);
  assert.deepEqual(read.unavailable, []);
  assert.deepEqual(read.remaining, []);
  const stale = promote(read.items, 'batch-old');
  assert.deepEqual(service.human({ op: 'entries', library: 'global' }).items, []);
  decide(service, a, stage(service, a, 'update', { targetId: second, baseRevision: 1, draft: fields('来源二新版') }));
  assert.equal(batchDecide(service, 'global', batchRead(service, 'global', stale.id).batch).state, 'conflict');
  assert.deepEqual(service.human({ op: 'entries', library: 'global' }).items, []);
  const pending = promote(available().items, 'batch-new');
  const review = batchRead(service, 'global', pending.id);
  const ids = review.items.map(item => item.proposal.targetId);
  const globalBatch = { scope: 'global', ids };
  authorize(service, 'global', caller, 'get_many', globalBatch, 'once');
  // Global read authorization is not a separate way to publish the proposal.
  assert.deepEqual(service.model('get_many', globalBatch, caller), { items: [], unavailable: ids, remaining: [] });
  assert.equal(batchRead(service, 'global', pending.id).batch.state, 'pending');
  assert.equal(batchDecide(service, 'global', review.batch).state, 'applied');
  assert.throws(() => service.model('get_many', globalBatch, caller), checkError('READ_APPROVAL_REQUIRED'));
  const row = requestOf(service, caller.sessionId, 'global', 'get_many');
  service.human({ op: 'decideRead', id: row.id, decision: 'once' });
  assert.throws(() => service.model('get_many', { ...globalBatch, ids: [...ids].reverse() }, caller), checkError('READ_APPROVAL_REQUIRED'));
  const shared = service.model('get_many', globalBatch, caller);
  assert.deepEqual(shared.items.map(item => item.id), ids);
  assert.ok(shared.items.every(item => !Object.hasOwn(item, 'sources')));
});

test('revoking a consumed global read removes permission for new global update proposals without affecting workspace reads', t => {
  const { service } = setup(t);
  const caller = makeCaller();
  const sourceId = create(service);
  const source = service.model('get', { scope: 'workspace', id: sourceId }, caller);
  const created = service.model('propose', { scope: 'global', kind: 'promote', reason: '测试发布',
    sources: [{ entryId: source.id, revision: source.revision }], draft: fields('可共享'),
  }, caller);
  const published = service.human({ op: 'proposal', library: 'global', id: created.id }).proposal;
  assert.equal(decide(service, 'global', published).state, 'applied');
  const args = { scope: 'global', id: published.targetId };
  const lease = authorize(service, 'global', caller, 'get', args, 'once');
  const read = service.model('get', args, caller);
  const propose = { scope: 'global', kind: 'update', targetId: read.id, baseRevision: read.revision,
    draft: { title: '新标题措辞', tags: read.tags, confidence: read.confidence } };
  const first = service.model('propose', propose, { ...caller, callId: 'edit-with-auth' });
  assert.equal(first.state, 'pending');
  service.human({ op: 'revokeRead', id: lease.id });
  assert.throws(() => service.model('propose', propose, { ...caller, callId: 'edit-revoked' }), checkError('READ_ENTRY_FIRST'));
  assert.equal(service.model('get', { scope: 'workspace', id: sourceId }, caller).id, sourceId);
  assert.equal(service.human({ op: 'entry', library: 'global', id: read.id }).title, '可共享');
});

test('batch read bounds output and reports remaining and unavailable IDs without losing order', t => {
  const { service } = setup(t);
  const caller = makeCaller();
  const ids = Array.from({ length: 4 }, (_, index) => create(service, a,
    { ...fields('大条目 ' + index), detail: 'A'.repeat(64 * 1024) }));
  const missing = randomUUID();
  const input = [missing, ...ids];
  const first = service.model('get_many', { scope: 'workspace', ids: input }, caller);
  assert.deepEqual(first.items.map(row => row.id), ids.slice(0, 2));
  assert.deepEqual(first.unavailable, [missing]);
  assert.deepEqual(first.remaining, ids.slice(2));
  const second = service.model('get_many', { scope: 'workspace', ids: first.remaining }, caller);
  assert.deepEqual(second.items.map(row => row.id), ids.slice(2));
  assert.deepEqual(second.remaining, []);
  assert.throws(() => service.model('get_many', { scope: 'workspace', ids: [ids[0], ids[0]] }, caller), checkError('BAD_INPUT'));
});

test('export is scoped, independent, and single use', async t => {
  const { service,root } = setup(t);
  create(service,a,fields('仅工作区 A'));
  create(service,b,fields('仅工作区 B'));
  stage(service,a,'create',{draft:fields('未审批草稿')});
  const exports = service.human({op:'prepareExport',library:a});
  const response = service.download({ticket:exports.ticket});
  assert.match(response.headers.get('Content-Type'),/sqlite/);
  assert.throws(() => service.download({ticket:exports.ticket}),checkError('NOT_FOUND'));
  const bytes = new Uint8Array(await response.arrayBuffer());
  const copied = join(root,'download.sqlite');
  writeFileSync(copied,bytes);
  const db = new DatabaseSync(copied,{readOnly:true});
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('SELECT title FROM entry_revision').all().map(row=>row.title),['仅工作区 A']);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
    assert.equal(tables.some(name=>name.startsWith('proposal') || name === 'revision_source'),false);
  } finally { db.close(); }
});

test('rejects malformed, absolute or executable evidence references', () => {
  for (const [kind,reference] of [['url','javascript:alert(1)'],['url','https://user:pass@example.invalid/'],['file','../private'],['file','C:/private'],['file','/private']]) {
    assert.throws(() => normalizeDraft({...fields(),evidence:[{kind,label:'引用',reference}]}),checkError('BAD_INPUT'));
  }
});
