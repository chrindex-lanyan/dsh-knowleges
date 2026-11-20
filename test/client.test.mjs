import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeService } from '../src/service.mjs'
import {
  asEditorDraft, asEntryQuery, batchDecisionInput, BATCH_LIMIT, batchStageInput, batchStatusAllowed,
  globalReadAccess, initialEditor, inspectBatch, inspectProposal, selectedLibrary, settingsInput, sourceEntryQuery,
} from '../src/client/model.mjs'
import { createKnowledgeApi, KNOWLEDGE_ROUTE, sqliteFileName } from '../src/client/transport.mjs'

const example = {
  id: 'entry', revision: 4, title: '可核对条目', detail: '<b>仅文字</b>', status: 'active',
  confidence: 0, tags: ['甲', '乙'],
  evidence: [{ kind: 'text', label: '证据', note: '说明', reference: null }],
  relations: [{ type: 'related', targetId: 'related' }],
  sources: [{ workspaceId: 'other', entryId: 'source', revision: 1 }],
}

function envelope(body, options) { return Response.json(body, options) }

test('confirmed session toggle sends only the intended flags and broadcasts validated mode changes', async () => {
  const calls = []
  const api = createKnowledgeApi(async (path, options) => {
    assert.equal(path, KNOWLEDGE_ROUTE)
    const input = JSON.parse(options.body)
    calls.push(input)
    return envelope({ ok: true, value: { mode: input.enabled ? 'trial' : 'preview' } })
  })
  const changes = []
  const unsubscribe = api.subscribeSessionMode(mode => changes.push(mode))
  await assert.rejects(api.setSessionTools(true, false), { code: 'TRIAL_CONFIRMATION_REQUIRED' })
  assert.deepEqual(calls, [])
  assert.deepEqual(await api.setSessionTools(true, true), { mode: 'trial' })
  assert.deepEqual(await api.setSessionTools(false), { mode: 'preview' })
  unsubscribe()
  await api.setSessionTools(true, true)
  assert.deepEqual(changes, ['trial', 'preview'])
  assert.deepEqual(calls.slice(0, 2), [
    { op: 'setSessionTools', enabled: true, confirmTrial: true },
    { op: 'setSessionTools', enabled: false },
  ])
  const inconsistent = createKnowledgeApi(async () => envelope({ ok: true, value: { mode: 'preview' } }))
  let announced = false
  inconsistent.subscribeSessionMode(() => { announced = true })
  await assert.rejects(inconsistent.setSessionTools(true, true), { code: 'INVALID_RESPONSE' })
  assert.equal(announced, false)
})

test('access UI never presents a non-global lease, even from an unexpected response', () => {
  const decision = { id: 'global-id', library: 'global' }
  const hidden = [{ id: 'wrong-workspace', library: 'workspace:other' }, { id: 'unknown' }, null]
  assert.deepEqual(globalReadAccess({ requests: [...hidden, decision], grants: [decision, ...hidden] }),
    { requests: [decision], grants: [decision] })
  assert.deepEqual(globalReadAccess({ grants: 'surprise' }), { requests: [], grants: [] })
})

test('batch staging reuses entry fields and pins distinct same-library target revisions', () => {
  const library = 'workspace:mine'
  const form = initialEditor(example)
  const drafts = batchStageInput(library, 'create', [form, { ...form, title: '第二条' }], ' 示例 ')
  assert.deepEqual(drafts, { library, reason: '示例', items: [
    { kind: 'create', draft: asEditorDraft(form, false) },
    { kind: 'create', draft: asEditorDraft({ ...form, title: '第二条' }, false) },
  ] })
  assert.throws(() => batchStageInput('global', 'create', [form], ''), /全局/)
  assert.throws(() => batchStageInput(library, 'create', [], ''), /1–20/)
  assert.throws(() => batchStageInput(library, 'create', Array(BATCH_LIMIT + 1).fill(form), ''), /1–20/)
  assert.throws(() => batchStageInput(library, 'create', Array(4).fill({ ...form, detail: 'x'.repeat(64 * 1024) }), ''), /224 KiB/)
  const rows = [{ ...example, library }, { ...example, library, id: 'another', revision: 2 }]
  assert.deepEqual(batchStageInput(library, 'archive', rows, ' 过时 '), { library, reason: '过时', items: [
    { kind: 'archive', targetId: 'entry', baseRevision: 4, reason: '过时' },
    { kind: 'archive', targetId: 'another', baseRevision: 2, reason: '过时' },
  ] })
  assert.equal(batchStatusAllowed('restore', { status: 'invalid' }), true)
  assert.equal(batchStatusAllowed('invalidate', { status: 'invalid' }), false)
  for (const badRows of [[rows[0], rows[0]], [rows[0], { ...rows[1], library: 'workspace:elsewhere' }],
    [rows[0], { ...rows[1], revision: 0 }]]) {
    assert.throws(() => batchStageInput(library, 'archive', badRows, '整理'), /同库、不重复且带基准版本/)
  }
  assert.throws(() => batchStageInput(library, 'archive', rows, ''), /整理理由/)
  assert.throws(() => batchStageInput(library, 'archive', [rows[0], { ...rows[1], status: 'archived' }], '整理'), /状态不一致/)
})

test('batch approval uses only the outer digest and requires usable exact baselines and complete member drafts', () => {
  const library = 'global'
  const proposal = { id: 'update', kind: 'update', targetId: example.id, baseRevision: example.revision,
    digest: 'child-update', state: 'pending', draft: { ...example, title: '改题' }, batchId: 'batch' }
  const promoted = { id: 'promote', kind: 'promote', targetId: 'new-entry', baseRevision: null, digest: 'child-promotion',
    state: 'pending', draft: { ...example, title: '公开资料' }, batchId: 'batch' }
  const first = { proposal, before: example }
  const second = { proposal: promoted, before: null }
  const batch = { id: 'batch', digest: 'batch-digest', state: 'pending', itemCount: 2, items: [proposal, promoted] }
  const review = { batch, items: [first, second] }
  const { previews, complete } = inspectBatch(review, library)
  assert.equal(complete, true)
  assert.equal(previews[0].preview.after.title, '改题')
  assert.equal(previews[1].preview.after.detail, example.detail)
  assert.deepEqual(previews[1].preview.sources, example.sources)
  assert.deepEqual(batchDecisionInput(library, review, 'approve'), { library, id: batch.id, digest: 'batch-digest', decision: 'approve' })
  for (const incomplete of [
    { batch, items: [first] },
    { batch, items: [first, first] },
    { batch, items: [first, { ...second, proposal: { ...promoted, targetId: example.id } }] },
    { batch, items: [{ ...first, before: { ...example, revision: 5 } }, second] },
    { batch, items: [{ ...first, before: { id: example.id, revision: example.revision } }, second] },
    { batch, items: [{ ...first, before: { ...example, id: 'not-the-target' } }, second] },
    { batch, items: [{ ...first, proposal: { ...proposal, draft: { title: 'fallback' } } }, second] },
    { batch, items: [first, { ...second, proposal: { ...promoted, draft: { ...promoted.draft, sources: [] } } }] },
    { batch, items: [first, { ...second, proposal: { ...promoted, draft: { ...promoted.draft, evidence: [null] } } }] },
    { batch, items: [first, { proposal: promoted, before: undefined }] },
    { batch, items: [first, { ...second, proposal: { ...promoted, state: 'expired' } }] },
    { batch: { ...batch, items: [proposal, { ...promoted, digest: 'out-of-date' }] }, items: [first, second] },
  ]) {
    assert.equal(inspectBatch(incomplete, library).complete, false)
    assert.throws(() => batchDecisionInput(library, incomplete, 'approve'), /全部成员/)
  }
  assert.deepEqual(batchDecisionInput(library, { batch, items: [] }, 'reject'), { library, id: batch.id, digest: 'batch-digest', decision: 'reject' })
  assert.throws(() => batchDecisionInput(library, { ...review, batch: { ...batch, state: 'applied' } }, 'reject'), /已处理/)
})

test('new UI flows interoperate with real batch approval and global-only access in preview and trial', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-knowledge-batch-ui-'))
  const workspaceId = 'synthetic-workspace'
  const library = 'workspace:' + workspaceId
  const service = new KnowledgeService({ root: directory, workspaceList: () => [{ id: workspaceId, title: '合成数据演示' }] })
  t.after(() => {
    service.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const requests = []
  const api = createKnowledgeApi(async (path, options) => {
    assert.equal(path, KNOWLEDGE_ROUTE)
    const input = JSON.parse(options.body)
    requests.push(input)
    try { return envelope({ ok: true, value: service.human(input) }) }
    catch (error) { return envelope({ ok: false, error: { code: error.code, message: error.message } }, { status: 400 }) }
  })
  const list = async () => (await api.rpc('entries', { library, query: { status: 'all' } })).items
  const caller = { sessionId: 'test-session', agentId: 'test-agent', workspaceId, callId: 'model-batch-call' }
  const forms = ['第一条', '第二条'].map(title => initialEditor({ title, detail: '测试资料' }))
  assert.equal((await api.rpc('libraries')).mode, 'preview')
  const review = await api.rpc('stageBatch', batchStageInput(library, 'create', forms, '合成资料测试'))
  assert.equal(inspectBatch(review, library).complete, true)
  assert.equal((await api.rpc('batchProposals', { library, state: 'pending' })).items[0].id, review.batch.id)
  assert.equal((await api.rpc('proposals', { library, state: 'pending' })).items.length, 0)
  const detail = await api.rpc('batchProposal', { library, id: review.batch.id })
  assert.equal(inspectBatch(detail, library).complete, true)
  const firstChild = detail.items[0].proposal
  await assert.rejects(api.rpc('decide', { library, id: firstChild.id, digest: firstChild.digest, decision: 'approve' }), { code: 'NOT_FOUND' })
  assert.deepEqual(await list(), [])
  assert.equal((await api.rpc('decideBatch', batchDecisionInput(library, detail, 'approve'))).state, 'applied')
  const active = await list()
  assert.equal(active.length, 2)
  const organize = await api.rpc('stageBatch', batchStageInput(library, 'archive', active.map(entry => ({ ...entry, library })), '合成状态变更'))
  assert.equal(inspectBatch(organize, library).complete, true)
  const update = await api.rpc('stage', { library, kind: 'update', targetId: active[1].id, baseRevision: active[1].revision,
    draft: asEditorDraft({ ...forms[1], title: '基准发生变化' }, false) })
  assert.equal((await api.rpc('decide', { library, id: update.proposal.id, digest: update.proposal.digest, decision: 'approve' })).state, 'applied')
  assert.equal((await api.rpc('decideBatch', batchDecisionInput(library, organize, 'approve'))).state, 'conflict')
  const after = await list()
  assert.ok(after.every(entry => entry.status === 'active'))
  assert.throws(() => service.model('search', { scope: 'workspace' }, caller), { code: 'MODEL_DISABLED' })
  await assert.rejects(api.rpc('setSessionTools', { enabled: true }), { code: 'TRIAL_CONFIRMATION_REQUIRED' })
  assert.equal((await api.setSessionTools(true, true)).mode, 'trial')
  assert.equal(service.model('search', { scope: 'workspace' }, caller).items.length, 2)
  assert.throws(() => service.model('search', { scope: 'global' }, caller), { code: 'READ_APPROVAL_REQUIRED' })
  const lease = globalReadAccess(await api.rpc('readRequests', { library: 'global' })).requests[0]
  assert.equal(lease.library, 'global')
  await api.rpc('decideRead', { id: lease.id, decision: 'session' })
  assert.deepEqual(service.model('search', { scope: 'global' }, caller).items, [])
  const proposed = service.model('propose_batch', { scope: 'workspace', items: batchStageInput(library, 'create', forms, '').items }, caller)
  assert.equal(proposed.state, 'pending')
  assert.equal((await api.setSessionTools(false)).mode, 'preview')
  assert.deepEqual(await list(), after)
  assert.equal((await api.rpc('batchProposal', { library, id: proposed.id })).batch.state, 'pending')
  assert.deepEqual(globalReadAccess(await api.rpc('readRequests', { library: 'global' })), { requests: [], grants: [] })
  assert.deepEqual(requests.filter(item => item.op === 'decideBatch').map(item => item.id), [review.batch.id, organize.batch.id])
})


test('source inspection targets only the exact workspace entry version', () => {
  assert.deepEqual(sourceEntryQuery({ workspaceId: 'ssh:bound', entryId: 'source', revision: 3 }),
    { library: 'workspace:ssh:bound', id: 'source', revision: 3 })
  assert.equal(sourceEntryQuery({ workspaceId: 'other', entryId: 'source' }), null)
  assert.equal(sourceEntryQuery({ workspaceId: 'other', entryId: 'source', revision: 0 }), null)
})

test('sends an authenticated document-relative exact request without a DSH RPC envelope', async () => {
  const signal = new AbortController().signal
  const api = createKnowledgeApi(async (path, options) => {
    assert.equal(path, KNOWLEDGE_ROUTE)
    assert.equal(options.method, 'POST')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.redirect, 'error')
    assert.equal(options.signal, signal)
    assert.deepEqual(JSON.parse(options.body), { op: 'entries', library: 'workspace:abc', query: { offset: 20, limit: 20 } })
    return envelope({ ok: true, value: { items: ['found'], hasMore: false } })
  })
  assert.deepEqual(await api.rpc('entries', { library: 'workspace:abc', query: { offset: 20, limit: 20 } }, signal), { items: ['found'], hasMore: false })
})

test('extracts business codes and fails closed on permission, carrier and malformed responses', async () => {
  await assert.rejects(createKnowledgeApi(async () => envelope({ ok: false, error: { code: 'PROPOSAL_CONFLICT', message: '请重新预览' } }, { status: 409 })).rpc('decide'), {
    code: 'PROPOSAL_CONFLICT', status: 409, message: '请重新预览',
  })
  for (const status of [401, 403]) {
    await assert.rejects(createKnowledgeApi(async () => new Response('Forbidden', { status })).rpc('libraries'), { code: 'ACCESS_DENIED', status })
  }
  await assert.rejects(createKnowledgeApi(async () => new Response('<html>登录失败</html>')).rpc('libraries'), { code: 'INVALID_RESPONSE' })
  await assert.rejects(createKnowledgeApi(async () => { throw new Error('aborted by carrier') }).rpc('libraries'), { code: 'NETWORK_ERROR' })
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(createKnowledgeApi(async () => envelope({ ok: true, value: {} })).rpc('libraries', {}, abort.signal), { name: 'AbortError' })
})

test('prefers the DSH client transport hook when provided', async () => {
  const previous = globalThis.__DSH_TRANSPORT__
  const transport = { marker: Symbol(), fetch(path) {
    assert.equal(this.marker, transport.marker)
    assert.equal(path, KNOWLEDGE_ROUTE)
    return envelope({ ok: true, value: 'official transport' })
  } }
  globalThis.__DSH_TRANSPORT__ = transport
  try { assert.equal(await createKnowledgeApi().rpc('libraries'), 'official transport') }
  finally {
    if (previous === undefined) delete globalThis.__DSH_TRANSPORT__
    else globalThis.__DSH_TRANSPORT__ = previous
  }
})

test('export sends only a ticket and validates the SQLite signature before exposing a Blob', async () => {
  const data = new TextEncoder().encode('SQLite format 3\0valid bytes')
  const api = createKnowledgeApi(async (path, options) => {
    assert.equal(path, KNOWLEDGE_ROUTE + '/export')
    assert.deepEqual(JSON.parse(options.body), { ticket: 'ticket123' })
    return new Response(data, { headers: { 'content-type': 'application/vnd.sqlite3' } })
  })
  const blob = await api.exportDatabase('ticket123')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data)
  await assert.rejects(createKnowledgeApi(async () => new Response('<script></script>')).exportDatabase('bad'), { code: 'INVALID_EXPORT' })
  await assert.rejects(createKnowledgeApi(async () => envelope({ ok: false, error: { code: 'EXPORT_EXPIRED', message: '凭证过期' } })).exportDatabase('expired'), {
    code: 'EXPORT_EXPIRED', message: '凭证过期',
  })
  assert.equal(sqliteFileName('../目录/项目.SQLITE'), '项目.sqlite')
  assert.equal(sqliteFileName('..\\'), 'knowledge-library.sqlite')
  assert.equal(sqliteFileName('..' + String.fromCharCode(0x202e) + 'report.sqlite'), '_report.sqlite')
})

test('selects only a returned library and generates scoped search requests', () => {
  const global = { key: 'global', scope: 'global' }
  const workspace = { key: 'workspace:id', scope: 'workspace' }
  assert.equal(selectedLibrary([workspace, global], workspace.key), workspace)
  assert.equal(selectedLibrary([workspace, global], 'workspace:unknown'), global)
  assert.equal(selectedLibrary([], 'global'), undefined)
  assert.deepEqual(asEntryQuery({ q: ' 文档 ', tag: ' ', status: 'candidates', staleOnly: true }, 0, 20), { q: '文档', status: 'candidates', offset: 0, limit: 20 })
  assert.deepEqual(asEntryQuery({ q: '', tag: '甲', status: 'active', staleOnly: true }, 20, 20), { tag: '甲', status: 'active', staleOnly: true, offset: 20, limit: 20 })
})

test('manual edits retain zero confidence and omit sources; global edits send only allowed metadata', () => {
  const form = initialEditor(example)
  assert.deepEqual(asEditorDraft(form, true), { title: example.title, tags: example.tags, confidence: 0 })
  const full = asEditorDraft(form, false)
  assert.equal(full.detail, '<b>仅文字</b>')
  assert.deepEqual(full.evidence, example.evidence)
  assert.deepEqual(full.relations, example.relations)
  for (const key of ['sources', 'status', 'id', 'revision']) assert.equal(Object.hasOwn(full, key), false)
  assert.equal(asEditorDraft({ ...form, confidence: '' }, false).confidence, null)
  assert.throws(() => asEditorDraft({ ...form, confidence: '-1' }, false), /置信度/)
  assert.throws(() => asEditorDraft({ ...form, detail: '中'.repeat(30_000) }, false), /64 KiB/)
})

test('approval requires a matching exact baseline and shows status and metadata changes', () => {
  const change = { kind: 'update', targetId: example.id, baseRevision: example.revision, draft: { title: '更新', tags: ['乙', '甲'], confidence: null } }
  const valid = inspectProposal(change, example)
  assert.equal(valid.complete, true)
  assert.deepEqual(valid.changes.map(row => row.field), ['title', 'confidence'])
  assert.equal(valid.after.detail, example.detail)
  assert.deepEqual(valid.sources, example.sources)
  assert.equal(inspectProposal(change, { ...example, revision: 5 }).complete, false)
  assert.equal(inspectProposal(change, { ...example, id: 'another-entry' }).complete, false)
  assert.equal(inspectProposal({ ...change, draft: undefined }, example).complete, false)
  const archive = inspectProposal({ ...change, kind: 'archive', draft: undefined }, example)
  assert.deepEqual(archive.changes, [{ field: 'status', label: '状态', before: 'active', after: 'archived' }])
})

test('promotion previews public fields and requires independent source metadata', () => {
  const draft = asEditorDraft(initialEditor(example), false)
  const proposal = { kind: 'promote', targetId: 'new', baseRevision: null, draft }
  assert.equal(inspectProposal(proposal, null).complete, false)
  const reviewed = inspectProposal({ ...proposal, draft: { ...draft, sources: example.sources } }, null)
  assert.equal(reviewed.complete, true)
  assert.equal(reviewed.after.title, example.title)
  assert.deepEqual(reviewed.sources, example.sources)
  const newSource = { ...example.sources[0], revision: 2 }
  const update = inspectProposal({ ...proposal, targetId: example.id, baseRevision: example.revision, draft: { ...draft, sources: [newSource] } }, example)
  assert.equal(update.complete, true)
  assert.equal(update.sourceChanged, true)
  assert.deepEqual(update.changes, [])
  assert.deepEqual(update.previousSources, example.sources)
  assert.equal(inspectProposal({ ...proposal, draft: { ...draft, sources: [{}] } }, null).complete, false)
})

test('settings preserve revision checks and reject non-integer or out-of-range values', () => {
  assert.deepEqual(settingsInput({ revision: 7 }, { maxHistory: '30', staleAfterDays: '180' }), { expectedRevision: 7, maxHistory: 30, staleAfterDays: 180 })
  for (const bad of ['', '0', '-1', '2.5', '1e3', '9007199254740992']) {
    assert.throws(() => settingsInput({ revision: 7 }, { maxHistory: bad, staleAfterDays: '180' }), /正整数/)
  }
})

test('uses a same-origin mode on the regular DSH browser carrier', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async (path, options) => {
    assert.equal(path, KNOWLEDGE_ROUTE)
    assert.equal(options.mode, 'same-origin')
    return envelope({ ok: true, value: 'same-origin' })
  }
  try { assert.equal(await createKnowledgeApi().rpc('libraries'), 'same-origin') }
  finally { globalThis.fetch = previous }
})

test('client transport and inspector interoperate with the actual host service DTOs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-knowledge-ui-'))
  const service = new KnowledgeService({ root: directory, workspaceList: () => [{ id: 'synthetic-workspace', title: '演示' }] })
  const api = createKnowledgeApi(async (path, options) => {
    const input = JSON.parse(options.body)
    try {
      if (path === KNOWLEDGE_ROUTE + '/export') return service.download(input, options.signal)
      assert.equal(path, KNOWLEDGE_ROUTE)
      return envelope({ ok: true, value: service.human(input) })
    } catch (error) {
      return envelope({ ok: false, error: { code: error.code, message: error.message } }, { status: 400 })
    }
  })
  try {
    const { mode, libraries } = await api.rpc('libraries')
    assert.equal(mode, 'preview')
    const library = libraries.find(item => item.scope === 'workspace').key
    const draft = asEditorDraft(initialEditor({ ...example, relations: [] }), false)
    const stage = { library, kind: 'create', requestId: '54bbc0f7-4f06-45c0-be48-c21f236d225e', draft }
    const preview = await api.rpc('stage', stage)
    assert.equal(inspectProposal(preview.proposal, preview.before).complete, true)
    assert.equal((await api.rpc('stage', stage)).proposal.id, preview.proposal.id)
    const query = { status: 'all', limit: 20, offset: 0 }
    assert.equal((await api.rpc('entries', { library, query })).items.length, 0)
    const apply = ({ proposal }) => api.rpc('decide', { library, id: proposal.id, digest: proposal.digest, decision: 'approve' })
    const result = await apply(preview)
    assert.equal(result.state, 'applied')
    const current = await api.rpc('entry', { library, id: result.targetId })
    assert.equal(current.confidence, 0)
    assert.equal(current.detail, example.detail)
    const archive = await api.rpc('stage', { library, kind: 'archive', targetId: current.id, baseRevision: current.revision, reason: '演示旧条目整理' })
    assert.deepEqual(inspectProposal(archive.proposal, archive.before).changes.map(row => row.field), ['status'])
    await apply(archive)
    assert.equal((await api.rpc('history', { library, id: current.id })).items[0].revision, 1)
    const { settings } = await api.rpc('settings', { library })
    const input = { library, ...settingsInput(settings, { maxHistory: '1', staleAfterDays: '180' }) }
    const proposed = await api.rpc('previewSettings', input)
    assert.equal(proposed.trimCount, 0)
    assert.equal((await api.rpc('saveSettings', { ...input, previewToken: proposed.token })).maxHistory, 1)
    const { ticket } = await api.rpc('prepareExport', { library })
    assert.ok((await api.exportDatabase(ticket)).size >= 512)
    await assert.rejects(api.exportDatabase(ticket), { code: 'NOT_FOUND' })
  } finally {
    service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
