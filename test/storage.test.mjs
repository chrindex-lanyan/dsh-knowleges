import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LibraryStore, StorageError } from '../src/storage.mjs';

const DAY = 86_400_000;
const TIME = Date.UTC(2026, 10, 18);
const workspaceId = 'ssh-workspace-a';
const human = { kind: 'human' };
const session = { kind: 'session', sessionId: 'session-a', agentId: 'agent-a', workspaceId };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-storage-test-'));
  const handles = [];
  let time = TIME;
  const now = () => time;
  const open = (name = 'workspace', scope = 'workspace', workspace = workspaceId, clock = now) => {
    const store = new LibraryStore(join(root, name + '.sqlite'), {
      scope, ...(scope === 'workspace' ? { workspaceId: workspace } : {}), now: clock,
    });
    handles.push(store);
    return store;
  };
  const raw = (name = 'workspace', options = {}) => {
    const db = new DatabaseSync(join(root, name + '.sqlite'), options);
    handles.push(db);
    return db;
  };
  t.after(() => {
    try { for (const db of handles.reverse()) db.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, open, raw, now, setTime: value => { time = value; }, advance: (ms = 1) => { time += ms; } };
}

function draft(fields = {}) {
  return {
    title: '可复用资料', detail: '', tags: [], confidence: null, status: 'active',
    evidence: [], relations: [], sources: [], ...fields,
  };
}

function content(entry, patch = {}) {
  const { title, detail, tags, confidence, status, evidence, relations, sources } = entry;
  return draft({ title, detail, tags, confidence, status, evidence, relations, sources, ...patch });
}

function request(now, options = {}) {
  return {
    id: randomUUID(), idempotencyKey: randomUUID(), kind: 'create', targetId: randomUUID(), baseRevision: null,
    actor: human, reason: '拟记入资料库', draft: draft(), expiresAt: now + DAY, ...options,
  };
}

function batchItem(options = {}) {
  return { id: randomUUID(), kind: 'create', targetId: randomUUID(), baseRevision: null,
    draft: draft(), reason: '批量成员', ...options };
}

function batchRequest(now, items, options = {}) {
  return { id: randomUUID(), idempotencyKey: randomUUID(), actor: human, reason: '一起确认',
    expiresAt: now + DAY, items, ...options };
}

function changeItem(entry, patch, kind = 'update') {
  return batchItem({ kind, targetId: entry.id, baseRevision: entry.revision, draft: content(entry, patch) });
}

function decideBatch(store, proposal, decision = 'approve', check) {
  return store.decideBatch({ id: proposal.id, digest: proposal.digest, decision, check });
}

function decide(store, proposal, decision = 'approve', check) {
  return store.decide({ id: proposal.id, digest: proposal.digest, decision, check });
}

function create(store, now, fields = {}, options = {}) {
  const pending = store.stage(request(now, { draft: draft(fields), ...options }));
  assert.equal(decide(store, pending).state, 'applied');
  return store.read(pending.targetId);
}

function revise(store, now, entry, patch, kind = 'update') {
  return store.stage(request(now, {
    kind, targetId: entry.id, baseRevision: entry.revision, draft: content(entry, patch),
  }));
}

function code(wanted) {
  return error => error instanceof StorageError && error.code === wanted;
}

test('creates a WAL library with a durable scope binding; preserves a foreign database', t => {
  const f = fixture(t);
  const store = f.open();
  const item = create(store, f.now());
  const raw = f.raw('workspace', { readOnly: true });
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
  assert.match(raw.prepare('SELECT library_uuid FROM library_meta').get().library_uuid, /^[0-9a-f-]{36}$/);
  assert.throws(() => f.open('workspace', 'workspace', 'another-machine'), code('SCOPE_MISMATCH'));
  assert.throws(() => f.open('workspace', 'global'), code('SCOPE_MISMATCH'));
  store.close();
  store.close();
  assert.throws(() => store.read(item.id), code('STORAGE_CLOSED'));
  const reopened = f.open();
  assert.deepEqual(reopened.read(item.id), item);

  const foreign = f.raw('foreign');
  foreign.exec("CREATE TABLE sqliteXowned_elsewhere (value TEXT); INSERT INTO sqliteXowned_elsewhere VALUES ('keep')");
  assert.throws(() => f.open('foreign'), code('UNSUPPORTED_SCHEMA'));
  assert.equal(foreign.prepare('SELECT value FROM sqliteXowned_elsewhere').get().value, 'keep');
  assert.equal(foreign.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
});

test('publishes only after confirmation and saves full immutable snapshots with normalized tags', t => {
  const f = fixture(t);
  const store = f.open();
  const sibling = create(store, f.now(), { title: '关联目标' });
  const before = request(f.now(), {
    actor: session,
    draft: draft({
      title: '  范例资料  ', detail: '内容含 %_，按字面搜索。', confidence: 0,
      tags: ['稳定', 'DSH', 'DSH'],
      evidence: [
        { kind: 'text', label: '说明', note: '初版', reference: null },
        { kind: 'url', label: '规范', note: '', reference: 'https://example.test/spec' },
        { kind: 'session', label: '讨论', note: '', reference: 'session-a#12' },
        { kind: 'file', label: '资料位置', note: '', reference: 'docs/foo.md#L3' },
      ],
      relations: [{ type: 'related', targetId: sibling.id }],
    }),
  });
  const staged = store.stage(before);
  assert.equal(staged.state, 'pending');
  assert.equal(staged.draft.title, '范例资料');
  assert.deepEqual(staged.draft.tags, ['DSH', '稳定']);
  assert.deepEqual(staged.actor, session);
  assert.equal(store.read(staged.targetId), null);
  assert.equal(store.proposals().length, 1);
  assert.equal(Object.hasOwn(store.proposals()[0], 'draft'), false);
  assert.deepEqual(store.proposal(staged.id), staged);
  assert.throws(() => store.decide({ id: staged.id, digest: 'obsolete', decision: 'approve' }), code('DIGEST_MISMATCH'));
  assert.equal(store.read(staged.targetId), null);
  const result = decide(store, staged);
  assert.equal(result.resultRevision, 1);
  assert.equal(Object.hasOwn(result, 'draft'), false);
  const v1 = store.read(staged.targetId);
  assert.deepEqual(v1, { id: staged.targetId, revision: 1, createdAt: TIME, updatedAt: TIME, ...staged.draft });
  assert.deepEqual(store.history(v1.id), []);

  f.advance();
  const change = revise(store, f.now(), v1, {
    confidence: 0.8, tags: ['更新时间', '稳定'], detail: '修改后的资料', evidence: [...v1.evidence].reverse(),
  });
  assert.equal(decide(store, change).resultRevision, 2);
  const v2 = store.read(v1.id);
  assert.equal(v2.updatedAt, TIME + 1);
  assert.equal(v2.createdAt, TIME);
  assert.deepEqual(store.history(v1.id), [v1]);
  assert.deepEqual(store.read(v1.id, 1), v1);
  assert.deepEqual(v2.relations, v1.relations);
  assert.deepEqual(v2.evidence, [...v1.evidence].reverse());
  assert.equal(store.list({ q: '修改后' })[0].id, v1.id);
  assert.equal(store.list({ q: '%_' }).length, 0); // Neither historical text nor SQL wildcard matching.
  assert.equal(store.list({ tag: '稳定' })[0].id, v1.id);
  const keys = Object.keys(store.list({ q: '范例' })[0]);
  assert.deepEqual(keys.sort(), ['confidence', 'createdAt', 'id', 'revision', 'status', 'tags', 'title', 'updatedAt']);

  f.advance();
  const noop = revise(store, f.now(), v2, { tags: [...v2.tags].reverse() });
  const unchanged = decide(store, noop);
  assert.equal(unchanged.state, 'no_change');
  assert.equal(unchanged.resultRevision, 2);
  assert.deepEqual(store.read(v1.id), v2);
  assert.equal(store.metrics().decisions.no_change, 1);
  assert.equal(f.raw().prepare('SELECT count(*) AS n FROM proposal_evidence').get().n, 0);
});

test('bulk reads use current snapshots and preserve request order including absent IDs', t => {
  const { open, now } = fixture(t);
  const store = open();
  const a = create(store, now(), { title: 'first' });
  const b = create(store, now(), { title: 'second' });
  assert.equal(decide(store, revise(store, now(), a, { title: 'first revision' })).state, 'applied');
  assert.deepEqual(store.readMany([b.id, 'missing', a.id.toUpperCase()]).map(entry => entry?.title ?? null),
    ['second', null, 'first revision']);
  assert.throws(() => store.readMany([]), code('INVALID_INPUT'));
  assert.throws(() => store.readMany(Array(21).fill(a.id)), code('INVALID_INPUT'));
});

test('uses literal queries, stable paging, and explicit stale/invalid/archive filters', t => {
  const f = fixture(t);
  const store = f.open();
  const old = create(store, f.now(), { title: '旧 %_ 条目', tags: ['ＰＲＯＪＥＣＴ'] });
  assert.deepEqual(store.list({ q: '%_' }).map(x => x.id), [old.id]);
  assert.deepEqual(store.list({ q: '旧 %x' }), []);
  assert.deepEqual(store.list({ tag: 'project' }).map(x => x.id), [old.id]);
  assert.deepEqual(store.list({ q: '', tag: '', status: 'active', limit: 20, offset: 0 }).map(x => x.id), [old.id]);
  f.advance(180 * DAY);
  const recent = create(store, f.now(), { title: '新资料' });
  const invalid = create(store, f.now(), { title: '过时说明' });
  const archived = create(store, f.now(), { title: '归档参考' });
  assert.equal(decide(store, revise(store, f.now(), invalid, { status: 'invalid' }, 'invalidate')).state, 'applied');
  assert.equal(decide(store, revise(store, f.now(), archived, { status: 'archived' }, 'archive')).state, 'applied');
  assert.deepEqual(store.list().map(x => x.id), [recent.id, old.id]);
  assert.deepEqual(store.list({ status: 'candidates' }).map(x => x.id), [invalid.id, old.id]);
  assert.deepEqual(store.list({ status: 'candidates', staleOnly: true }).map(x => x.id), [old.id]);
  assert.deepEqual(store.list({ status: 'invalid' }).map(x => x.id), [invalid.id]);
  assert.deepEqual(store.list({ status: 'archived' }).map(x => x.id), [archived.id]);
  assert.equal(store.list({ status: 'all' }).length, 4);
  assert.equal(store.list({ limit: 1, offset: 1 })[0].id, old.id);
  f.advance();
  assert.equal(decide(store, revise(store, f.now(), store.read(archived.id), { status: 'active' }, 'restore')).resultRevision, 3);
  assert.equal(store.read(archived.id).status, 'active');
  assert.deepEqual(store.history(archived.id).map(x => x.status), ['archived', 'active']);
  assert.deepEqual(store.history(archived.id, { limit: 1, offset: 1 }).map(x => x.revision), [1]);
  assert.deepEqual(store.metrics().counts, { active: 3, invalid: 1, archived: 0 });
});

test('deduplicates staging and decisions across connections and rejects competing creates or stale updates', t => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  const input = request(f.now());
  const first = a.stage(input);
  const retry = b.stage({ ...input, id: randomUUID(), expiresAt: input.expiresAt + DAY });
  assert.deepEqual(retry, first);
  assert.throws(() => b.stage({ ...input, draft: draft({ title: 'changed' }) }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => b.stage({ ...input, idempotencyKey: randomUUID() }), code('IDEMPOTENCY_CONFLICT'));
  const duplicateCreate = b.stage(request(f.now(), { targetId: first.targetId }));
  let checks = 0;
  const applied = decide(a, first, 'approve', () => { checks++; return true; });
  assert.deepEqual(decide(b, first, 'reject', () => { checks++; return false; }), applied);
  assert.equal(checks, 1);
  assert.equal(decide(b, duplicateCreate).state, 'conflict');
  assert.equal(b.read(first.targetId).revision, 1);
  assert.equal(a.history(first.targetId).length, 0);
  assert.deepEqual(b.stage(input), applied);

  const base = a.read(first.targetId);
  const stale = revise(a, f.now(), base, { title: '起初的改动' });
  const winner = revise(b, f.now(), base, { title: '已经应用' });
  assert.equal(decide(b, winner).resultRevision, 2);
  assert.equal(decide(a, stale).state, 'conflict');
  assert.equal(decide(a, stale).state, 'conflict');
  assert.equal(a.read(first.targetId).title, '已经应用');
  assert.deepEqual(b.history(first.targetId).map(entry => entry.revision), [1]);
  assert.equal(a.metrics().decisions.conflict, 2);
});

test('retains current + 30 old versions, binds trim preview to exact revisions, and keeps idempotent results', t => {
  const f = fixture(t);
  const store = f.open();
  const oldInput = request(f.now(), {
    draft: draft({ tags: ['v1'], evidence: [{ kind: 'text', label: 'v1', note: '', reference: null }] }),
  });
  const oldProposal = store.stage(oldInput);
  const oldDecision = decide(store, oldProposal);
  const version = n => {
    f.advance();
    const head = store.read(oldProposal.targetId);
    return decide(store, revise(store, f.now(), head, {
      title: 'Version ' + n, tags: ['v' + n],
      evidence: [{ kind: 'text', label: 'v' + n, note: '', reference: null }],
    }));
  };
  for (let n = 2; n <= 33; n++) assert.equal(version(n).resultRevision, n);
  const id = oldProposal.targetId;
  assert.deepEqual(store.settings(), { maxHistory: 30, staleAfterDays: 180, revision: 1 });
  assert.equal(store.read(id).revision, 33);
  assert.equal(store.read(id, 2), null);
  const history = store.history(id);
  assert.deepEqual(history.map(row => row.revision), Array.from({ length: 30 }, (_, i) => 32 - i));
  assert.deepEqual(history.at(-1).tags, ['v3']);
  assert.equal(history.at(-1).evidence[0].label, 'v3');
  const raw = f.raw('workspace', { readOnly: true });
  for (const table of ['entry_revision', 'revision_tag', 'revision_evidence']) {
    assert.equal(raw.prepare('SELECT count(*) AS n FROM ' + table).get().n, 31);
  }
  const settings = { maxHistory: 2, staleAfterDays: 365, expectedRevision: 1 };
  const initialPreview = store.previewSettings(settings);
  assert.equal(initialPreview.trimCount, 28);
  assert.equal(version(34).resultRevision, 34); // Same number of rows to trim, but a different set.
  assert.throws(() => store.saveSettings({ ...settings, previewToken: initialPreview.token }), code('SETTINGS_CONFLICT'));
  const nextPreview = store.previewSettings(settings);
  assert.equal(nextPreview.trimCount, 28);
  assert.notEqual(initialPreview.token, nextPreview.token);
  assert.deepEqual(store.saveSettings({ ...settings, previewToken: nextPreview.token }), {
    maxHistory: 2, staleAfterDays: 365, revision: 2,
  });
  assert.equal(raw.prepare('SELECT trimmed_count FROM settings_audit').get().trimmed_count, 28);
  assert.deepEqual(store.history(id).map(row => row.revision), [33, 32]);
  assert.equal(store.metrics().historyCount, 2);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM revision_evidence').get().n, 3);
  assert.equal(store.read(id, 31), null);
  assert.equal(store.read(id).revision, 34);
  assert.deepEqual(decide(store, oldProposal), oldDecision);
  assert.deepEqual(store.stage(oldInput), oldDecision);
  assert.throws(() => store.previewSettings(settings), code('SETTINGS_CONFLICT'));
  const raise = { ...settings, maxHistory: 30, expectedRevision: 2 };
  store.saveSettings({ ...raise, previewToken: store.previewSettings(raise).token });
  assert.equal(store.history(id).length, 2);
});

test('discards expired and rejected drafts atomically without leaving any official versions', t => {
  const f = fixture(t);
  const store = f.open();
  const fields = draft({ tags: ['草稿'], evidence: [{ kind: 'text', label: '未确认', note: '草稿正文', reference: null }] });
  const expired = store.stage(request(f.now(), { expiresAt: f.now() + 1, draft: fields }));
  const rejected = store.stage(request(f.now(), { draft: fields }));
  const rejectedResult = decide(store, rejected, 'reject');
  assert.equal(rejectedResult.state, 'rejected');
  assert.deepEqual(decide(store, rejected), rejectedResult);
  assert.equal(store.proposals().length, 1);
  f.advance();
  assert.equal(store.proposal(expired.id).state, 'expired');
  assert.equal(Object.hasOwn(store.proposal(expired.id), 'draft'), false);
  assert.equal(decide(store, expired).state, 'expired');
  assert.equal(store.proposals().length, 0);
  assert.equal(store.proposals({ state: 'all' }).length, 2);
  assert.equal(store.proposal('missing'), null);
  assert.equal(store.read(expired.targetId), null);
  assert.equal(store.read(rejected.targetId), null);
  assert.equal(store.metrics().decisions.expired, 1);
  assert.equal(store.metrics().decisions.rejected, 1);
  const raw = f.raw();
  for (const table of ['proposal_draft', 'proposal_tag', 'proposal_evidence', 'entry_revision']) {
    assert.equal(raw.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
  }
});

test('rolls back partial reads/writes on check exceptions or foreign-key failure; checks cannot mutate a draft', t => {
  const f = fixture(t);
  const store = f.open();
  const absent = randomUUID();
  const proposal = store.stage(request(f.now(), {
    draft: draft({
      detail: 'digest-bound body', tags: ['t'], evidence: [{ kind: 'text', label: 'n', note: '', reference: null }],
      relations: [{ type: 'related', targetId: absent }],
    }),
  }));
  assert.throws(() => decide(store, proposal, 'approve', () => { throw new Error('check failed'); }), /check failed/);
  assert.throws(() => decide(store, proposal, 'approve', () => Promise.resolve(true)), code('INVALID_INPUT'));
  assert.throws(() => decide(store, proposal), code('CONSTRAINT_VIOLATION'));
  const raw = f.raw('workspace', { readOnly: true });
  for (const table of ['entry', 'entry_revision', 'revision_tag', 'revision_evidence', 'proposal_decision']) {
    assert.equal(raw.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
  }
  assert.deepEqual(store.proposal(proposal.id), proposal);
  assert.equal(store.metrics().pendingCount, 1);
  create(store, f.now(), { title: 'related item' }, { targetId: absent });
  const result = decide(store, proposal, 'approve', copy => {
    copy.draft.detail = 'unreviewed body';
    copy.draft.relations.length = 0;
    return true;
  });
  assert.equal(result.resultRevision, 1);
  assert.equal(store.read(proposal.targetId).detail, 'digest-bound body');
  assert.deepEqual(store.read(proposal.targetId).relations, [{ type: 'related', targetId: absent }]);
  assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('takes a synchronous no-write source guard; competing writers see a retryable busy error', t => {
  const f = fixture(t);
  const source = f.open();
  const other = f.open();
  const item = create(source, f.now());
  const input = request(f.now());
  assert.throws(() => source.withWriteGuard(() => {
    assert.deepEqual(source.read(item.id), item);
    assert.throws(() => source.stage(input), code('TRANSACTION_ACTIVE'));
    assert.throws(() => other.stage(input), code('BUSY_RETRY'));
    throw new Error('release guard');
  }), /release guard/);
  assert.throws(() => source.withWriteGuard(() => Promise.resolve(true)), code('INVALID_INPUT'));
  assert.equal(source.withWriteGuard(() => 'read-only result'), 'read-only result');
  assert.equal(other.proposal(input.id), null);
  assert.equal(other.stage(input).state, 'pending');
});

test('requires guarded source validation for global promotion and restores only after revalidation', t => {
  const f = fixture(t);
  const workspace = f.open();
  const global = f.open('global', 'global');
  const src = create(workspace, f.now(), { title: 'workspace-only details' });
  const targetId = randomUUID();
  const promotion = (source, options = {}) => request(f.now(), {
    targetId, kind: 'promote', actor: session,
    draft: draft({ title: '全局整理稿', detail: '人工审核后可见', sources: [{ workspaceId, entryId: source.id, revision: source.revision }] }),
    ...options,
  });
  const checkSource = pending => pending.draft.sources.every(ref => {
    const head = workspace.read(ref.entryId);
    return head?.status === 'active' && head.revision === ref.revision && ref.workspaceId === workspaceId;
  });
  const approveFromSource = pending => workspace.withWriteGuard(() => decide(global, pending, 'approve', checkSource));
  assert.throws(() => global.stage(request(f.now())), code('INVALID_INPUT'));
  assert.throws(() => global.stage(promotion(src, { actor: human })), code('INVALID_INPUT'));
  assert.throws(() => global.stage(promotion(src, {
    draft: draft({ sources: [
      { workspaceId, entryId: src.id, revision: 1 }, { workspaceId: 'a different workspace', entryId: randomUUID(), revision: 1 },
    ] }),
  })), code('INVALID_INPUT'));
  const p1 = global.stage(promotion(src));
  assert.throws(() => decide(global, p1), code('CHECK_REQUIRED'));
  assert.equal(decide(workspace, revise(workspace, f.now(), src, { title: 'Revised workspace source' })).resultRevision, 2);
  assert.equal(approveFromSource(p1).state, 'conflict');
  assert.equal(global.read(targetId), null);
  const p2 = global.stage(promotion(workspace.read(src.id)));
  assert.equal(approveFromSource(p2).resultRevision, 1);
  const v1 = global.read(targetId);
  assert.equal(v1.sources[0].revision, 2);
  const publicMeta = revise(global, f.now(), v1, { tags: ['可发布'], confidence: 0.9 });
  assert.equal(decide(global, publicMeta).resultRevision, 2);
  const v2 = global.read(targetId);
  assert.deepEqual(v2.sources, v1.sources);
  const directEdit = revise(global, f.now(), v2, { detail: 'not derived from workspace' });
  assert.throws(() => decide(global, directEdit), code('INVALID_INPUT'));
  assert.deepEqual(global.read(targetId), v2);
  assert.throws(() => revise(global, f.now(), v2, {
    evidence: [{ kind: 'session', label: 'Private', note: '', reference: 'session-a' }],
  }), code('INVALID_INPUT'));
  assert.equal(decide(global, revise(global, f.now(), v2, { status: 'archived' }, 'archive')).resultRevision, 3);
  const archived = global.read(targetId);
  const restore = revise(global, f.now(), archived, { status: 'active' }, 'restore');
  assert.throws(() => decide(global, restore), code('CHECK_REQUIRED'));
  assert.equal(approveFromSource(restore).resultRevision, 4);
  assert.equal(global.read(targetId).status, 'active');
});

test('exports only committed, allowed tables into a portable SQLite file, with no origin data or sidecars', t => {
  const f = fixture(t);
  const global = f.open('global', 'global');
  const sourceId = randomUUID();
  const origin = 'private-workspace-binding-8234';
  const p1 = global.stage(request(f.now(), {
    kind: 'promote', actor: { ...session, workspaceId: origin },
    draft: draft({
      title: 'public v1', detail: 'public text v1', tags: ['公开'],
      sources: [{ workspaceId: origin, entryId: sourceId, revision: 99 }],
      evidence: [{ kind: 'url', label: 'Public guide', note: '', reference: 'https://example.test/guide' }],
    }),
  }));
  assert.equal(decide(global, p1, 'approve', () => true).state, 'applied');
  f.advance();
  const v1 = global.read(p1.targetId);
  const p2 = revise(global, f.now(), v1, { title: 'public v2' });
  assert.equal(decide(global, p2).resultRevision, 2);
  const v2 = global.read(p1.targetId);
  const privateDraft = revise(global, f.now(), v2, { title: 'UNAPPROVED-DRAFT-CONTROL-CONTENT' });
  assert.ok(global.proposal(privateDraft.id).draft);
  assert.ok(existsSync(join(f.root, 'global.sqlite-wal')));

  const writer = f.raw('global');
  writer.exec('BEGIN IMMEDIATE');
  try {
    writer.prepare('UPDATE entry_revision SET title = ? WHERE revision = 2').run('UNCOMMITTED MUTATION');
    global.exportTo(join(f.root, 'artifact.sqlite'));
  } finally { writer.exec('ROLLBACK'); }
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('artifact.sqlite')), ['artifact.sqlite']);
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.dsh-library-export-')), false);
  const copy = f.raw('artifact', { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(copy.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(x => x.name), [
    'entry', 'entry_revision', 'library_meta', 'revision_evidence', 'revision_relation', 'revision_tag',
  ]);
  assert.deepEqual(copy.prepare('SELECT title FROM entry_revision ORDER BY revision').all().map(x => x.title), ['public v1', 'public v2']);
  assert.equal(copy.prepare('SELECT count(*) AS n FROM revision_evidence').get().n, 2);
  assert.equal(copy.prepare('SELECT scope FROM library_meta').get().scope, 'global');
  const bytes = readFileSync(join(f.root, 'artifact.sqlite'));
  for (const secret of [origin, sourceId, privateDraft.id, 'UNAPPROVED-DRAFT-CONTROL-CONTENT', 'UNCOMMITTED MUTATION']) {
    assert.equal(bytes.includes(secret), false);
  }
  assert.throws(() => global.exportTo(join(f.root, 'artifact.sqlite')), code('EXPORT_EXISTS'));
  assert.throws(() => global.exportTo(join(f.root, 'global.sqlite')), code('EXPORT_EXISTS'));
  assert.deepEqual(bytes, readFileSync(join(f.root, 'artifact.sqlite')));
  assert.throws(() => f.open('artifact', 'global'), code('UNSUPPORTED_SCHEMA'));
});

test('rejects malformed draft fields and invalid settings before writing', t => {
  const f = fixture(t);
  const store = f.open();
  const targetId = randomUUID();
  for (const fields of [
    { title: '' }, { confidence: Infinity }, { confidence: '0.5' }, { status: 'archived' },
    { tags: ['ok', null] }, { evidence: [{ kind: 'url', label: 'bad', note: '', reference: 'javascript:alert(1)' }] },
    { evidence: [{ kind: 'file', label: 'bad', note: '', reference: '../not-in-workspace' }] },
    { relations: [{ type: 'related', targetId }] },
  ]) assert.throws(() => store.stage(request(f.now(), { targetId, draft: draft(fields) })), code('INVALID_INPUT'));
  assert.throws(() => store.stage(request(f.now(), { targetId: 'not-a-uuid' })), code('INVALID_INPUT'));
  assert.throws(() => store.previewSettings({ maxHistory: 0, staleAfterDays: 1, expectedRevision: 1 }), code('INVALID_INPUT'));
  assert.throws(() => store.list({ limit: 101 }), code('INVALID_INPUT'));
  assert.equal(store.proposals({ state: 'all' }).length, 0);
});

test('migrates the exact v1 table layout without replacing official data, pending drafts or settings', t => {
  const f = fixture(t);
  const first = f.open();
  const v1 = create(first, f.now(), { title: 'Legacy first revision', tags: ['legacy'] });
  assert.equal(decide(first, revise(first, f.now(), v1, { title: 'Legacy second revision' })).state, 'applied');
  const v2 = first.read(v1.id);
  const input = request(f.now(), { kind: 'update', targetId: v2.id, baseRevision: v2.revision,
    draft: content(v2, { title: 'Legacy pending title', evidence: [{ kind: 'text', label: 'Legacy evidence' }] }) });
  const pending = first.stage(input);
  const change = { expectedRevision: 1, maxHistory: 4, staleAfterDays: 123 };
  const settings = first.saveSettings({ ...change, previewToken: first.previewSettings(change).token });
  first.close();

  // Schema v2 is additive: remove its three new tables to reproduce the v1 layout.
  const raw = f.raw();
  raw.exec('BEGIN IMMEDIATE; DROP TRIGGER proposal_batch_member_decision_guard; DROP TABLE proposal_batch_decision; ' +
    'DROP TABLE proposal_batch_member; DROP TABLE proposal_batch; PRAGMA user_version = 1; COMMIT;');
  const binding = raw.prepare('SELECT * FROM library_meta').get();
  assert.throws(() => f.open('workspace', 'workspace', 'other-scope'), code('SCOPE_MISMATCH'));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);

  // A mid-migration fault must not leave the first v2 table or advance the version.
  raw.exec('CREATE TABLE proposal_batch_member (fixture_fault TEXT) STRICT;');
  assert.throws(() => f.open(), code('STORAGE_ERROR'));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'proposal_batch'").get(), undefined);
  assert.equal(raw.prepare('SELECT title FROM proposal_draft WHERE proposal_id = ?').get(pending.id).title, pending.draft.title);
  raw.exec('DROP TABLE proposal_batch_member;');

  const migrated = f.open();
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(raw.prepare('SELECT * FROM library_meta').get(), binding);
  assert.deepEqual(migrated.settings(), settings);
  assert.deepEqual(migrated.read(v1.id), v2);
  assert.deepEqual(migrated.history(v1.id), [v1]);
  assert.deepEqual(migrated.proposal(pending.id), pending);
  assert.deepEqual(migrated.stage({ ...input, id: randomUUID(), expiresAt: f.now() + DAY * 2 }), pending);
  assert.equal(decide(migrated, pending).resultRevision, 3);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  const batch = migrated.stageBatch(batchRequest(f.now(), [batchItem(), batchItem()]));
  assert.equal(decideBatch(migrated, batch).state, 'applied');
});

test('stages an ordered batch once, hides its members from single-proposal paths, and settles once', t => {
  const f = fixture(t);
  const store = f.open();
  const peer = f.open();
  const existing = create(store, f.now());
  const unrelated = store.stage(request(f.now()));
  const newEntry = batchItem({ draft: draft({ title: 'B second' }) });
  const first = batchItem({ draft: draft({ title: 'A first', tags: ['\uE000', '📗'],
    relations: [{ type: 'related', targetId: newEntry.targetId }] }) });
  const unchanged = changeItem(existing, {});
  const input = batchRequest(f.now(), [first, newEntry, unchanged]);
  const batch = store.stageBatch(input);
  assert.equal(batch.state, 'pending');
  assert.equal(batch.itemCount, 3);
  assert.deepEqual(batch.items.map(item => item.id), input.items.map(item => item.id));
  assert.equal(store.metrics().pendingCount, 2);
  assert.equal(store.read(first.targetId), null);
  assert.deepEqual(store.proposals().map(item => item.id), [unrelated.id]);
  assert.equal(store.proposals({ state: 'all' }).some(item => item.id === first.id), false);
  assert.deepEqual(store.batches().map(x => [x.id, x.itemCount]), [[batch.id, 3]]);
  assert.equal(Object.hasOwn(store.batches()[0], 'items'), false);
  assert.deepEqual(peer.batch(batch.id), batch);
  assert.equal(peer.batch(newEntry.id), null);
  assert.equal(peer.proposal(first.id), null);
  assert.throws(() => decide(peer, batch.items[0]), code('NOT_FOUND'));
  assert.throws(() => f.raw().prepare('INSERT INTO proposal_decision VALUES (?, ?, ?, ?)')
    .run(first.id, 'applied', f.now(), 1), /requires its batch decision/);
  assert.throws(() => store.stage(request(f.now(), { id: first.id })), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.stage(request(f.now(), { id: batch.id })), code('IDEMPOTENCY_CONFLICT'));
  const retry = { ...input, id: randomUUID(), expiresAt: f.now() + 2 * DAY,
    items: input.items.map(item => ({ ...item, id: randomUUID() })) };
  assert.deepEqual(peer.stageBatch(retry), batch);
  assert.throws(() => peer.stageBatch({ ...input, items: [...input.items].reverse() }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.decideBatch({ id: batch.id, digest: batch.items[0].digest, decision: 'approve' }), code('DIGEST_MISMATCH'));
  const settled = decideBatch(peer, batch, 'approve', candidate => {
    assert.deepEqual(candidate, batch);
    candidate.items[0].draft.title = 'ignore this edit';
    candidate.items.reverse();
    return true;
  });
  assert.equal(settled.state, 'applied');
  assert.deepEqual(settled.items.map(x => [x.id, x.state, x.resultRevision]), [
    [first.id, 'applied', 1], [newEntry.id, 'applied', 1], [unchanged.id, 'no_change', 1],
  ]);
  assert.ok(settled.items.every(item => !Object.hasOwn(item, 'draft')));
  assert.equal(store.read(first.targetId).title, 'A first');
  assert.deepEqual(store.read(first.targetId).relations, [{ type: 'related', targetId: newEntry.targetId }]);
  assert.deepEqual(store.read(existing.id), existing);
  assert.deepEqual(store.batches(), []);
  assert.equal(store.metrics().pendingCount, 1);
  assert.equal(store.metrics().decisions.applied, 2); // One previous single and one batch.
  assert.equal(store.metrics().decisions.no_change, 0); // No per-member double count.
  assert.deepEqual(peer.stageBatch(retry), settled);
  assert.deepEqual(decideBatch(store, batch, 'reject'), settled);
  assert.equal(store.proposal(first.id), null);
  assert.throws(() => decide(store, batch.items[0]), code('NOT_FOUND'));
});

test('rejects empty, oversized, repeated or aliased batch targets before staging', t => {
  const f = fixture(t);
  const store = f.open();
  const first = batchItem();
  assert.throws(() => store.stageBatch(batchRequest(f.now(), [])), code('INVALID_INPUT'));
  assert.throws(() => store.stageBatch(batchRequest(f.now(), Array.from({ length: 21 }, () => batchItem()))), code('INVALID_INPUT'));
  assert.throws(() => store.stageBatch(batchRequest(f.now(), [first, batchItem({ targetId: first.targetId.toUpperCase() })])), code('INVALID_INPUT'));
  assert.throws(() => store.stageBatch(batchRequest(f.now(), [first, batchItem({ id: first.id })])), code('INVALID_INPUT'));
  assert.throws(() => store.stageBatch(batchRequest(f.now(), [first], { id: first.id })), code('INVALID_INPUT'));
  assert.deepEqual(store.batches({ state: 'all' }), []);
  assert.deepEqual(store.proposals({ state: 'all' }), []);
  const full = store.stageBatch(batchRequest(f.now(), Array.from({ length: 20 }, () => batchItem())));
  assert.equal(full.itemCount, 20);
  assert.equal(decideBatch(store, full, 'reject').items.filter(x => x.state === 'rejected').length, 20);
  assert.equal(store.list().length, 0);
  assert.equal(store.metrics().decisions.rejected, 1);
});

test('one stale member turns the whole batch into a conflict without publishing any other member', t => {
  const f = fixture(t);
  const store = f.open();
  const peer = f.open();
  const a = create(store, f.now());
  const b = create(store, f.now());
  const newcomer = batchItem();
  const staged = store.stageBatch(batchRequest(f.now(), [newcomer, changeItem(a, { title: 'change A' }),
    changeItem(b, { status: 'invalid' }, 'invalidate')]));
  assert.equal(decide(peer, revise(peer, f.now(), b, { title: 'concurrent edit' })).state, 'applied');
  const result = decideBatch(store, staged);
  assert.equal(result.state, 'conflict');
  assert.equal(result.items.every(item => item.state === 'conflict' && item.resultRevision === null), true);
  assert.equal(store.read(newcomer.targetId), null);
  assert.deepEqual(store.read(a.id), a);
  assert.deepEqual(store.history(a.id), []);
  assert.equal(store.read(b.id).title, 'concurrent edit');
  assert.deepEqual(store.history(b.id), [b]);
  assert.equal(store.metrics().decisions.conflict, 1);
});

test('rolls back an earlier changed version and history trim when a later member violates a foreign key', t => {
  const f = fixture(t);
  const store = f.open();
  const change = { expectedRevision: 1, maxHistory: 1, staleAfterDays: 180 };
  store.saveSettings({ ...change, previewToken: store.previewSettings(change).token });
  const v1 = create(store, f.now());
  assert.equal(decide(store, revise(store, f.now(), v1, { title: 'before batch' })).state, 'applied');
  const v2 = store.read(v1.id);
  const bad = batchItem({ draft: draft({ relations: [{ type: 'related', targetId: randomUUID() }] }) });
  const batch = store.stageBatch(batchRequest(f.now(), [changeItem(v2, { title: 'should not persist' }), bad]));
  assert.throws(() => decideBatch(store, batch), code('CONSTRAINT_VIOLATION'));
  assert.deepEqual(store.read(v1.id), v2);
  assert.deepEqual(store.history(v1.id), [v1]);
  assert.equal(store.read(bad.targetId), null);
  assert.deepEqual(store.batch(batch.id), batch);
  assert.equal(store.metrics().pendingCount, 1);
  const raw = f.raw();
  assert.equal(raw.prepare('SELECT count(*) AS n FROM proposal_batch_decision').get().n, 0);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
});

test('rolls back existing heads on late compare-and-swap failure and after expiry during application', t => {
  const f = fixture(t);
  const store = f.open();
  const a = create(store, f.now());
  const b = create(store, f.now());
  const raw = f.raw();
  raw.exec("CREATE TRIGGER ignore_head BEFORE UPDATE OF current_revision ON entry WHEN OLD.id = '" + b.id +
    "' BEGIN SELECT RAISE(IGNORE); END;");
  const staged = store.stageBatch(batchRequest(f.now(), [changeItem(a, { title: 'would change first' }),
    changeItem(b, { title: 'second declined by SQLite' })]));
  assert.equal(decideBatch(store, staged).state, 'conflict');
  assert.deepEqual(store.read(a.id), a);
  assert.deepEqual(store.read(b.id), b);
  raw.exec('DROP TRIGGER ignore_head;');

  const newcomer = batchItem();
  const expires = store.stageBatch(batchRequest(f.now(), [changeItem(a, { title: 'temporarily written' }), newcomer]));
  let clockReads = 0;
  const nearExpiry = f.open('workspace', 'workspace', workspaceId, () => ++clockReads >= 3 ? expires.expiresAt : TIME);
  assert.equal(decideBatch(nearExpiry, expires).state, 'expired');
  assert.equal(clockReads, 3);
  assert.deepEqual(store.read(a.id), a);
  assert.equal(store.read(newcomer.targetId), null);
  assert.equal(store.metrics().decisions.expired, 1);
});

test('verifies all digest-bound snapshots before applying and expires batches with their relational drafts', t => {
  const f = fixture(t);
  const store = f.open();
  const items = [batchItem({ draft: draft({ tags: ['草稿'] }) }), batchItem({ draft: draft({ title: 'as previewed' }) })];
  const batch = store.stageBatch(batchRequest(f.now(), items));
  const raw = f.raw();
  raw.prepare('UPDATE proposal_draft SET title = ? WHERE proposal_id = ?').run('as previewed ', items[1].id);
  assert.throws(() => decideBatch(store, batch), code('DIGEST_MISMATCH'));
  assert.deepEqual(store.list(), []);
  f.setTime(batch.expiresAt);
  assert.deepEqual(store.batches(), []);
  const expired = store.batch(batch.id);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.items.every(item => item.state === 'expired' && !Object.hasOwn(item, 'draft')), true);
  assert.deepEqual(decideBatch(store, batch), expired);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM proposal_draft').get().n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM proposal_tag').get().n, 0);
  assert.equal(store.metrics().decisions.expired, 1);
});

test('requires synchronous source approval for global batches and does not export pending drafts or provenance', t => {
  const f = fixture(t);
  const global = f.open('global', 'global');
  const source = { workspaceId, entryId: randomUUID(), revision: 1 };
  const makePromotion = title => batchItem({ kind: 'promote', draft: draft({ title, sources: [source] }) });
  const p1 = makePromotion('Public from batch');
  const p2 = makePromotion('Public second batch item');
  const batch = global.stageBatch(batchRequest(f.now(), [p1, p2], { actor: session }));
  assert.throws(() => decideBatch(global, batch), code('CHECK_REQUIRED'));
  assert.throws(() => decideBatch(global, batch, 'approve', async () => { throw new Error('async check denied'); }),
    code('INVALID_INPUT'));
  assert.throws(() => decideBatch(global, batch, 'approve', () => { throw new Error('source I/O failed'); }), /source I\/O failed/);
  assert.deepEqual(global.list(), []);
  let checkCalls = 0;
  assert.equal(decideBatch(global, batch, 'approve', input => {
    checkCalls++;
    assert.deepEqual(input.items.map(item => item.draft.sources), [[source], [source]]);
    return true;
  }).state, 'applied');
  assert.equal(checkCalls, 1);
  const row = global.read(p1.targetId);
  assert.equal(decide(global, revise(global, f.now(), row, { status: 'archived' }, 'archive')).state, 'applied');
  const restore = changeItem(global.read(row.id), { status: 'active' }, 'restore');
  const draftOnly = makePromotion('PENDING BATCH NO EXPORT');
  const pending = global.stageBatch(batchRequest(f.now(), [restore, draftOnly], { actor: session }));
  assert.throws(() => decideBatch(global, pending), code('CHECK_REQUIRED'));
  const out = join(f.root, 'batch-artifact.sqlite');
  global.exportTo(out);
  const copy = f.raw('batch-artifact', { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(copy.prepare('PRAGMA integrity_check').all().map(item => item.integrity_check), ['ok']);
  assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'proposal%' OR name = 'revision_source'").all(), []);
  assert.equal(copy.prepare('SELECT count(*) AS n FROM entry').get().n, 2);
  const bytes = readFileSync(out);
  for (const secret of [source.entryId, source.workspaceId, pending.id, draftOnly.id, 'PENDING BATCH NO EXPORT']) {
    assert.equal(bytes.includes(secret), false);
  }
  assert.equal(decideBatch(global, pending, 'approve', () => false).state, 'conflict');
  assert.equal(global.read(row.id).status, 'archived');
  assert.equal(global.read(draftOnly.targetId), null);
});
