import { randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { LibraryStore } from './storage.mjs';
import {
  activeScope, cloneDraft, configuration, fail, fingerprint, identity, integer, listQuery,
  mutationKinds, normalizeDraft, object, oneOf, page, revision, sourceVersions, text, uuid,
} from './validation.mjs';

const MINUTE = 60_000;
const PROPOSAL_TTL = 7 * 24 * 60 * MINUTE;
const REQUEST_TTL = 10 * MINUTE;
const ONCE_TTL = 5 * MINUTE;
const RECEIPT_TTL = 30 * MINUTE;
const EXPORT_TTL = 2 * MINUTE;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_ITEMS = 20;
const MAX_BATCH_DRAFT_BYTES = 224 * 1024;
const MAX_BATCH_READ_BYTES = 192 * 1024;
const ITEM_FIELDS = ['kind', 'targetId', 'baseRevision', 'draft', 'reason', 'sources'];
const WORKSPACE = 'workspace:';
const GLOBAL = Object.freeze({ key: 'global', scope: 'global', title: '全局资料库' });
const contentFields = draft => ({ detail: draft.detail, evidence: draft.evidence, relations: draft.relations });
const derivedId = hash => hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-8' + hash.slice(13, 16)
  + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32);

function paginated(get, options) {
  const items = get(options);
  const more = items.length === options.limit && options.offset + options.limit <= 100_000
    && get({ ...options, offset: options.offset + options.limit, limit: 1 }).length > 0;
  return { items, hasMore: more };
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) fail('STORE_UNAVAILABLE', '资料库目录不是受支持的目录。');
}

function checkLocalFile(path) {
  try {
    if (!lstatSync(path).isFile()) fail('STORE_UNAVAILABLE', '资料库文件不是受支持的普通文件。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export class KnowledgeService {
  #root;
  #mode;
  #now;
  #workspaceList;
  #originIsCurrent;
  #stores = new Map();
  #requests = new Map();
  #grants = new Map();
  #receipts = new Map();
  #denials = new Map();
  #tickets = new Map();
  #streams = new Set();
  #exports = new Map();
  #deniedReads = new Map();
  #sweepTimer;
  #closed = false;

  constructor({ root, mode = 'preview', workspaceList = () => [], originIsCurrent = () => true, now = Date.now }) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('Knowledge data root must be absolute');
    this.#root = resolve(root);
    this.#mode = oneOf(mode, ['preview', 'trial'], '运行模式');
    this.#workspaceList = workspaceList;
    this.#originIsCurrent = originIsCurrent;
    this.#now = now;
    this.#sweepTimer = setInterval(() => this.#sweep(), MINUTE);
    this.#sweepTimer.unref();
  }

  get mode() { return this.#mode; }

  #clearSessionAccess() {
    for (const map of [this.#requests, this.#grants, this.#receipts, this.#denials]) map.clear();
  }

  #setSessionTools(input) {
    object(input, ['op', 'enabled', 'confirmTrial']);
    if (typeof input.enabled !== 'boolean') fail('BAD_INPUT', '会话工具开关必须为布尔值。');
    if (input.enabled && input.confirmTrial !== true) {
      fail('TRIAL_CONFIRMATION_REQUIRED', '启用前请确认本库仅用于合成测试资料。');
    }
    const next = input.enabled ? 'trial' : 'preview';
    if (this.#mode !== next) {
      this.#clearSessionAccess();
      this.#mode = next;
    }
    return { mode: this.#mode };
  }

  #catalog() {
    const workspaces = new Map();
    const ambiguous = new Set();
    for (const item of this.#workspaceList()) {
      if (typeof item?.id !== 'string' || item.id.trim() === '' || Buffer.byteLength(item.id) > 256 || item.id.includes('\0')) continue;
      if (workspaces.has(item.id)) ambiguous.add(item.id);
      workspaces.set(item.id, {
        key: WORKSPACE + item.id, scope: 'workspace', workspaceId: item.id,
        title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 200) : '工作区资料库',
      });
    }
    for (const id of ambiguous) workspaces.delete(id);
    return workspaces;
  }

  #library(key) {
    if (key === 'global') return GLOBAL;
    if (typeof key === 'string' && key.startsWith(WORKSPACE)) {
      const library = this.#catalog().get(key.slice(WORKSPACE.length));
      if (library) return library;
    }
    fail('WORKSPACE_UNAVAILABLE', '无法确认此工作区资料库。');
  }

  #store(library, existingOnly = false) {
    if (this.#closed) fail('STORE_UNAVAILABLE', '资料库已关闭。');
    const existing = this.#stores.get(library.key);
    if (existing) return existing;
    const basename = library.scope === 'global' ? 'global.sqlite'
      : 'workspace-' + fingerprint(library.workspaceId) + '.sqlite';
    const file = join(this.#root, basename);
    if (existingOnly) {
      try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    }
    privateDirectory(this.#root);
    for (const suffix of ['', '-wal', '-shm', '-journal']) checkLocalFile(file + suffix);
    const store = new LibraryStore(file, { scope: library.scope, workspaceId: library.workspaceId, now: this.#now });
    this.#stores.set(library.key, store);
    return store;
  }

  #assertOpen() {
    if (this.#closed) fail('STORE_UNAVAILABLE', '资料库已关闭。');
    this.#sweep();
  }

  #sweep() {
    const now = this.#now();
    for (const map of [this.#requests, this.#grants, this.#receipts, this.#denials]) {
      for (const [id, row] of map) if (row.expiresAt !== null && row.expiresAt <= now) map.delete(id);
    }
    for (const [id, row] of this.#tickets) {
      if (row.expiresAt > now) continue;
      this.#tickets.delete(id);
      this.#removeExport(row.path);
    }
  }

  #bound(actor) {
    if (actor.kind !== 'session' || actor.workspaceId === undefined) return true;
    return this.#catalog().has(actor.workspaceId) && this.#originIsCurrent(actor);
  }

  #actor(caller) {
    if (this.#mode !== 'trial') fail('MODEL_DISABLED', '会话资料库工具未启用，请在设置中确认试用。');
    if (!caller || caller.signal?.aborted) fail('ACCESS_DENIED', '此操作需要有效的宿主会话。');
    const actor = {
      kind: 'session',
      sessionId: identity(caller.sessionId, '会话标识'),
      agentId: identity(caller.agentId, 'Agent 标识'),
    };
    if (caller.workspaceId !== undefined) {
      actor.workspaceId = identity(caller.workspaceId, '工作区标识');
      if (!this.#bound(actor)) delete actor.workspaceId;
    }
    return actor;
  }

  #actorLibrary(scope, actor) {
    if (scope === 'global') return GLOBAL;
    if (actor.workspaceId === undefined) fail('WORKSPACE_UNAVAILABLE', '此会话没有可验证的工作区归属。');
    return this.#library(WORKSPACE + actor.workspaceId);
  }

  #lease(actor, library, operation, args) {
    // The caller is already limited by #actorLibrary to the workspace in the
    // Host's binding. Only global access uses a separate, human-granted lease.
    if (library.scope !== 'global') return;
    const actorKey = fingerprint(actor);
    const shared = fingerprint([actorKey, library.key]);
    const requestKey = fingerprint([shared, operation, args]);
    const sessionGrant = this.#grants.get(shared);
    if (sessionGrant) return;
    const once = this.#grants.get(requestKey);
    if (once && !once.used) {
      once.used = true;
      once.operation += '（已使用）';
      once.expiresAt = this.#now() + RECEIPT_TTL;
      return;
    }
    this.#deniedReads.set(library.key, (this.#deniedReads.get(library.key) ?? 0) + 1);
    const denial = this.#denials.get(requestKey);
    if (denial) fail('READ_DENIED', '用户已拒绝本次读取。');
    let request = this.#requests.get(requestKey);
    if (!request) {
      if (this.#requests.size >= 512 || [...this.#requests.values()].filter(row => row.actorKey === actorKey).length >= 8) {
        fail('READ_REQUEST_LIMIT', '待处理的读授权过多，请先在资料库面板处理。');
      }
      request = {
        id: randomUUID(), requestKey, actorKey, shared, actor, library: library.key, operation,
        expiresAt: this.#now() + REQUEST_TTL,
      };
      this.#requests.set(requestKey, request);
    }
    fail('READ_APPROVAL_REQUIRED', '全局读需要独立授权。请在「资料库 → 全局读授权」处理 ' + request.id + '，然后重试同一请求。');
  }

  #receipt(actor, library, entry) {
    const actorKey = fingerprint(actor);
    const key = fingerprint([actorKey, library.key, entry.id, entry.revision]);
    if (this.#receipts.size >= 8192 && !this.#receipts.has(key)) this.#receipts.delete(this.#receipts.keys().next().value);
    this.#receipts.set(key, {
      actor, actorKey, library: library.key, entryId: entry.id, revision: entry.revision,
      expiresAt: this.#now() + RECEIPT_TTL,
    });
  }

  #readEntryFirst(actor, library, entryId, version) {
    const actorKey = fingerprint(actor);
    const found = version === undefined ? [...this.#receipts.values()]
      .some(row => row.actorKey === actorKey && row.library === library.key && row.entryId === entryId)
      : this.#receipts.has(fingerprint([actorKey, library.key, entryId, version]));
    if (!found) fail('READ_ENTRY_FIRST', library.scope === 'global'
      ? '请先取得全局读授权并读取提议使用的条目版本。'
      : '请先读取本工作区中提议使用的确切条目版本。');
  }

  #before(store, id, baseRevision) {
    const before = store.read(id);
    if (!before || before.revision !== baseRevision) fail('PROPOSAL_CONFLICT', '目标条目版本已变化或不可用，请重新预览。');
    return before;
  }

  #provenanceCurrent(store, sources) {
    return sources.every(source => {
      const entry = store.read(source.entryId);
      return entry?.revision === source.revision && entry.status === 'active';
    });
  }

  #prepareItem(library, input, actor, id, targetSeed) {
    const kind = oneOf(input.kind, mutationKinds, '提案类型');
    const isModel = actor.kind === 'session';
    const isPromotion = kind === 'promote';
    const isNew = kind === 'create' || (isPromotion && input.targetId === undefined);
    if (kind === 'create' && library.scope === 'global') fail('PROMOTION_REQUIRED', '全局库条目只能由工作区会话提炼创建。');
    if (isPromotion && (!isModel || library.scope !== 'global' || actor.workspaceId === undefined)) {
      fail('PROMOTION_REQUIRED', '全局提炼须由有可信工作区归属的会话提交。');
    }
    if (kind === 'restore' && isModel) fail('ACCESS_DENIED', '恢复归档条目由人工发起。');
    if (input.sources !== undefined && !isPromotion) fail('BAD_INPUT', '只有全局提炼可提供来源。');
    if (isNew && (input.targetId !== undefined || input.baseRevision != null)) fail('BAD_INPUT', '新条目的 UUID 和版本由服务生成。');
    const targetId = isNew ? derivedId(targetSeed) : uuid(input.targetId);
    const baseRevision = isNew ? null : revision(input.baseRevision);
    if (isModel && !isNew) this.#readEntryFirst(actor, library, targetId, baseRevision);

    let sources = [];
    if (isPromotion) {
      const sourceLibrary = this.#actorLibrary('workspace', actor);
      sources = sourceVersions(input.sources).map(source => {
        this.#readEntryFirst(actor, sourceLibrary, source.entryId, source.revision);
        return { ...source, workspaceId: actor.workspaceId };
      });
      if (!this.#provenanceCurrent(this.#store(sourceLibrary), sources)) {
        fail('PROPOSAL_CONFLICT', '已有来源版本不再适用，请重新读取并提炼。');
      }
    }

    const store = this.#store(library);
    const before = isNew ? null : this.#before(store, targetId, baseRevision);
    const reason = text(input.reason, 4000, '提案理由', { optional: !isPromotion && !['invalidate', 'archive'].includes(kind), empty: false });
    let draft;
    if (kind === 'archive' || kind === 'invalidate' || kind === 'restore') {
      if (input.draft !== undefined) fail('BAD_INPUT', '状态提案不能同时编辑内容。');
      if ((kind === 'invalidate' && before.status === 'archived') || (kind === 'restore' && before.status === 'active')) {
        fail('BAD_INPUT', '条目当前状态不支持此操作。');
      }
      draft = cloneDraft(before, { archive: 'archived', invalidate: 'invalid', restore: 'active' }[kind]);
    } else {
      const inputDraft = library.scope === 'global' && !isPromotion
        ? { ...contentFields(before), ...object(input.draft, ['title', 'detail', 'tags', 'confidence', 'evidence', 'relations', 'status'], '全局条目草稿') }
        : input.draft;
      draft = normalizeDraft(inputDraft, { targetId, status: isPromotion ? 'active' : before?.status ?? 'active',
        sources: isPromotion ? sources : before?.sources ?? [] });
      if (library.scope === 'global') {
        if (!isPromotion && fingerprint(contentFields(draft)) !== fingerprint(contentFields(before))) {
          fail('PROMOTION_REQUIRED', '全局正文、证据和关联须用工作区提炼提案修改。');
        }
        if (isPromotion && draft.evidence.some(item => !['text', 'url'].includes(item.kind))) {
          fail('BAD_INPUT', '全局提炼不会公开工作区文件或会话位置。');
        }
      }
    }
    for (const relation of draft.relations) {
      if (isModel && !before?.relations.some(item => item.targetId === relation.targetId)) {
        this.#readEntryFirst(actor, library, relation.targetId);
      }
      if (!store.read(relation.targetId)) fail('BAD_INPUT', '关联目标必须是同一本库的已入库条目。');
    }
    return { item: { id, kind, targetId, baseRevision, reason, draft }, before };
  }

  #stage(library, input, actor, requestId) {
    const requestKey = fingerprint([actor, library.key, requestId]);
    // An exact retransmission can return the receipt after the source, target
    // or read grant has changed. No new content is read by the model or written.
    const id = derivedId(fingerprint(['proposal', requestKey, input]));
    const known = this.#store(library, true);
    const previous = known?.proposal(id);
    if (previous) return { proposal: previous, before: actor.kind === 'human' ? this.#baseFor(known, previous) : null };
    const { item, before } = this.#prepareItem(library, input, actor, id, requestKey);
    const proposal = this.#store(library).stage({ ...item, idempotencyKey: requestKey,
      actor, expiresAt: this.#now() + PROPOSAL_TTL });
    return { proposal, before };
  }

  #baseFor(store, proposal) {
    return proposal.baseRevision === null ? null : store.read(proposal.targetId, proposal.baseRevision);
  }

  #batchReview(store, batch) {
    const { items, ...summary } = batch;
    return { batch: summary, items: (items ?? []).map(proposal => ({ proposal, before: this.#baseFor(store, proposal) })) };
  }

  #stageBatch(library, input, actor, requestId) {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_BATCH_ITEMS) {
      fail('BAD_INPUT', '同库批量提案必须包含 1–20 项。');
    }
    const reason = text(input.reason, 4000, '批量提案理由', { optional: true });
    for (const row of input.items) object(row, ITEM_FIELDS, '批量成员');
    if (Buffer.byteLength(JSON.stringify(input.items)) > MAX_BATCH_DRAFT_BYTES) {
      fail('BATCH_LIMIT', '批量草稿总大小超过 224 KiB，请分批。');
    }
    const requestKey = fingerprint(['batch', actor, library.key, requestId]);
    const id = derivedId(fingerprint(['batch-proposal', requestKey, { items: input.items, reason }]));
    const known = this.#store(library, true);
    const previous = known?.batch(id);
    if (previous) return actor.kind === 'human' ? this.#batchReview(known, previous) : { batch: previous };
    const targets = new Set();
    const items = input.items.map((row, index) => {
      const definition = row.reason === undefined && reason ? { ...row, reason } : row;
      const itemId = derivedId(fingerprint(['batch-item', id, index]));
      const targetSeed = fingerprint(['batch-target', requestKey, index]);
      const { item } = this.#prepareItem(library, definition, actor, itemId, targetSeed);
      if (targets.has(item.targetId)) fail('BAD_INPUT', '同一条目在一个批次中只能操作一次。');
      targets.add(item.targetId);
      return item;
    });
    if (Buffer.byteLength(JSON.stringify(items)) > MAX_BATCH_DRAFT_BYTES) {
      fail('BATCH_LIMIT', '批量草稿及所引用的当前内容合计超过 224 KiB，请分批。');
    }
    const store = this.#store(library);
    const batch = store.stageBatch({ id, idempotencyKey: requestKey, actor, reason,
      expiresAt: this.#now() + PROPOSAL_TTL, items });
    return actor.kind === 'human' ? this.#batchReview(store, batch) : { batch };
  }

  #proposal(store, id) {
    const proposal = store.proposal(id);
    if (!proposal) fail('NOT_FOUND', '找不到此提案。');
    return proposal;
  }

  #batch(store, id) {
    const batch = store.batch(id);
    if (!batch) fail('NOT_FOUND', '找不到此批量提案。');
    return batch;
  }

  #decide(library, id, digest, decision, batch = false) {
    const store = this.#store(library);
    const proposal = batch ? this.#batch(store, id) : this.#proposal(store, id);
    const apply = check => batch ? store.decideBatch({ id, digest, decision, check })
      : store.decide({ id, digest, decision, check });
    if (decision === 'reject' || proposal.state !== 'pending' || proposal.expiresAt <= this.#now()) return apply();
    const checkActor = () => this.#bound(proposal.actor);
    if (library.scope !== 'global') return apply(checkActor);
    const items = (batch ? proposal.items : [proposal]).filter(row => ['promote', 'restore'].includes(row.kind));
    if (!items.length) return apply(checkActor);
    const grouped = new Map();
    for (const item of items) {
      const sources = item.draft?.sources ?? [];
      if (!sources.length || new Set(sources.map(source => source.workspaceId)).size !== 1) return apply(() => false);
      for (const source of sources) {
        if (!grouped.has(source.workspaceId)) grouped.set(source.workspaceId, new Map());
        grouped.get(source.workspaceId).set(source.entryId + ':' + source.revision, source);
      }
    }
    const catalog = this.#catalog();
    const bindings = [...grouped.keys()].sort().map(key => ({
      library: catalog.get(key), sources: [...grouped.get(key).values()],
    }));
    if (!checkActor() || bindings.some(binding => !binding.library)) return apply(() => false);
    const guards = bindings.map(({ library: source, sources }) => ({ store: this.#store(source), sources }));
    // All source locks are read-only and ordered before acquiring the sole
    // destination transaction. A busy source causes a retry, not partial writes.
    const lock = index => index === guards.length
      ? apply(() => checkActor() && guards.every(guard => this.#provenanceCurrent(guard.store, guard.sources)))
      : guards[index].store.withWriteGuard(() => lock(index + 1));
    return lock(0);
  }

  #entryFlags(args) {
    for (const flag of ['includeInvalid', 'includeArchived']) {
      if (args[flag] !== undefined && typeof args[flag] !== 'boolean') fail('BAD_INPUT', '无效的条目状态筛选。');
    }
    return { includeInvalid: args.includeInvalid === true, includeArchived: args.includeArchived === true };
  }

  #publicEntry(entry, flags) {
    if (!entry || (entry.status === 'archived' && !flags.includeArchived) || (entry.status === 'invalid' && !flags.includeInvalid)) {
      return null;
    }
    const { sources: _private, ...modelEntry } = entry;
    return modelEntry;
  }

  model(operation, args, caller) {
    this.#assertOpen();
    const actor = this.#actor(caller);
    switch (operation) {
      case 'search':
      case 'stale_candidates': {
        object(args, ['scope', 'q', 'tag', 'limit', 'offset']);
        const { scope, ...rest } = args;
        const library = this.#actorLibrary(activeScope(scope), actor);
        const query = listQuery({ ...rest, status: operation === 'search' ? 'active' : 'candidates' });
        this.#lease(actor, library, operation, query);
        return paginated(options => this.#store(library).list(options), query);
      }
      case 'get': {
        object(args, ['scope', 'id', 'includeInvalid', 'includeArchived']);
        const flags = this.#entryFlags(args);
        const library = this.#actorLibrary(activeScope(args.scope), actor);
        const id = uuid(args.id);
        this.#lease(actor, library, operation, { id, ...flags });
        const entry = this.#publicEntry(this.#store(library).read(id), flags);
        if (!entry) fail('NOT_FOUND', '此条目不可用。');
        this.#receipt(actor, library, entry);
        return entry;
      }
      case 'get_many': {
        object(args, ['scope', 'ids', 'includeInvalid', 'includeArchived']);
        if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > MAX_BATCH_ITEMS) {
          fail('BAD_INPUT', '同库批量读取必须指定 1–20 个条目。');
        }
        const ids = args.ids.map(id => uuid(id));
        if (new Set(ids).size !== ids.length) fail('BAD_INPUT', '批量读取条目 UUID 不能重复。');
        const flags = this.#entryFlags(args);
        const library = this.#actorLibrary(activeScope(args.scope), actor);
        this.#lease(actor, library, operation, { ids, ...flags });
        const entries = this.#store(library).readMany(ids);
        const items = [], unavailable = [];
        let bytes = 0;
        for (const [index, id] of ids.entries()) {
          const entry = this.#publicEntry(entries[index], flags);
          if (!entry) { unavailable.push(id); continue; }
          const length = Buffer.byteLength(JSON.stringify(entry));
          if (bytes + length > MAX_BATCH_READ_BYTES && items.length) {
            return { items, unavailable, remaining: ids.slice(index) };
          }
          bytes += length;
          items.push(entry);
          this.#receipt(actor, library, entry);
        }
        return { items, unavailable, remaining: [] };
      }
      case 'propose': {
        object(args, ['scope', 'kind', 'targetId', 'baseRevision', 'draft', 'reason', 'sources']);
        const library = this.#actorLibrary(activeScope(args.scope), actor);
        const { proposal } = this.#stage(library, args, actor, identity(caller.callId, '调用标识'));
        return { id: proposal.id, state: proposal.state, message: '提案须由人工在资料库面板确认。' };
      }
      case 'propose_batch': {
        object(args, ['scope', 'reason', 'items']);
        const library = this.#actorLibrary(activeScope(args.scope), actor);
        const { batch } = this.#stageBatch(library, args, actor, identity(caller.callId, '调用标识'));
        return { id: batch.id, state: batch.state, itemCount: batch.itemCount,
          message: '批量提案须由人工一次确认，任一冲突均不写入。' };
      }
      case 'proposal_status': {
        object(args, ['scope', 'id', 'batch']);
        if (args.batch !== undefined && typeof args.batch !== 'boolean') fail('BAD_INPUT', '批次选项必须为布尔值。');
        const library = this.#actorLibrary(activeScope(args.scope), actor);
        const id = uuid(args.id, '提案 UUID');
        const store = this.#store(library, true);
        const proposal = args.batch ? store?.batch(id) : store?.proposal(id);
        if (!proposal || fingerprint(proposal.actor) !== fingerprint(actor)) fail('NOT_FOUND', '找不到此提案。');
        return { id, state: proposal.state, ...(args.batch ? { itemCount: proposal.itemCount } : {}) };
      }
      default: fail('ACCESS_DENIED', '不支持以会话调用此操作。');
    }
  }

  #publicLease(row) {
    return {
      id: row.id, library: row.library, sessionId: row.actor.sessionId, agentId: row.actor.agentId,
      operation: row.operation, expiresAt: row.expiresAt,
    };
  }

  #readRequests(input) {
    object(input, ['op', 'library']);
    const library = input.library === undefined ? GLOBAL : this.#library(input.library);
    if (library.scope !== 'global') return { requests: [], grants: [] };
    const list = rows => [...rows.values()].filter(row => row.library === GLOBAL.key && this.#bound(row.actor))
      .map(row => this.#publicLease(row));
    return { requests: list(this.#requests), grants: list(this.#grants) };
  }

  #decideRead(input) {
    object(input, ['op', 'id', 'decision']);
    if (this.#mode !== 'trial') fail('MODEL_DISABLED', '本机预览未启用会话读授权。');
    const id = uuid(input.id, '授权申请 UUID');
    const decision = oneOf(input.decision, ['once', 'session', 'reject'], '授权决定');
    const request = [...this.#requests.values()].find(row => row.id === id);
    if (!request || !this.#bound(request.actor)) fail('NOT_FOUND', '找不到有效的读授权申请。');
    if (decision !== 'reject' && this.#grants.size >= 512) fail('READ_REQUEST_LIMIT', '活动授权过多，请先撤销不再使用的授权。');
    this.#requests.delete(request.requestKey);
    if (decision === 'reject') {
      if (this.#denials.size >= 512) this.#denials.delete(this.#denials.keys().next().value);
      this.#denials.set(request.requestKey, { expiresAt: this.#now() + MINUTE });
    } else if (decision === 'session') {
      this.#grants.set(request.shared, { ...request, operation: '会话读授权', expiresAt: null });
      for (const [key, other] of this.#requests) if (other.shared === request.shared) this.#requests.delete(key);
    } else {
      this.#grants.set(request.requestKey, { ...request, expiresAt: this.#now() + ONCE_TTL });
    }
    return { id, decision };
  }

  #revokeRead(input) {
    object(input, ['op', 'id']);
    const id = uuid(input.id, '授权 UUID');
    const grant = [...this.#grants.values()].find(row => row.id === id);
    if (!grant) fail('NOT_FOUND', '找不到此授权。');
    for (const rows of [this.#grants, this.#requests, this.#receipts]) {
      for (const [key, row] of rows) if (row.actorKey === grant.actorKey && row.library === grant.library) rows.delete(key);
    }
    return { id, revoked: true };
  }

  human(input) {
    this.#assertOpen();
    const operation = text(input?.op, 80, '操作');
    if (operation === 'libraries') {
      object(input, ['op']);
      return { mode: this.#mode, libraries: [GLOBAL, ...this.#catalog().values()] };
    }
    if (operation === 'setSessionTools') return this.#setSessionTools(input);
    if (operation === 'readRequests') return this.#readRequests(input);
    if (operation === 'decideRead') return this.#decideRead(input);
    if (operation === 'revokeRead') return this.#revokeRead(input);
    const library = this.#library(input.library);
    const store = () => this.#store(library);
    switch (operation) {
      case 'entries': {
        object(input, ['op', 'library', 'query']);
        return paginated(q => store().list(q), listQuery(input.query));
      }
      case 'entry': {
        object(input, ['op', 'library', 'id', 'revision']);
        const entry = store().read(uuid(input.id), input.revision === undefined ? undefined : revision(input.revision));
        if (!entry) fail('NOT_FOUND', '找不到此条目或版本。');
        return entry;
      }
      case 'history': {
        object(input, ['op', 'library', 'id', 'offset', 'limit']);
        const id = uuid(input.id);
        const pg = page(input);
        return paginated(q => store().history(id, q), pg);
      }
      case 'proposals': {
        object(input, ['op', 'library', 'state', 'offset', 'limit']);
        const state = input.state === undefined ? 'pending' : oneOf(input.state, ['pending', 'all'], '提案状态');
        return paginated(q => store().proposals(q), { ...page(input), state });
      }
      case 'proposal': {
        object(input, ['op', 'library', 'id']);
        const proposal = this.#proposal(store(), uuid(input.id, '提案 UUID'));
        return { proposal, before: this.#baseFor(store(), proposal) };
      }
      case 'batchProposals': {
        object(input, ['op', 'library', 'state', 'offset', 'limit']);
        const state = input.state === undefined ? 'pending' : oneOf(input.state, ['pending', 'all'], '批量提案状态');
        return paginated(q => store().batches(q), { ...page(input), state });
      }
      case 'batchProposal': {
        object(input, ['op', 'library', 'id']);
        return this.#batchReview(store(), this.#batch(store(), uuid(input.id, '批量提案 UUID')));
      }
      case 'stage': {
        object(input, ['op', 'library', 'kind', 'targetId', 'baseRevision', 'draft', 'reason', 'requestId']);
        return this.#stage(library, input, { kind: 'human' }, input.requestId === undefined ? randomUUID() : uuid(input.requestId, '提交 UUID'));
      }
      case 'stageBatch': {
        object(input, ['op', 'library', 'items', 'reason', 'requestId']);
        return this.#stageBatch(library, input, { kind: 'human' },
          input.requestId === undefined ? randomUUID() : uuid(input.requestId, '提交 UUID'));
      }
      case 'decide':
      case 'decideBatch': {
        object(input, ['op', 'library', 'id', 'digest', 'decision']);
        const digest = text(input.digest, 64, '预览摘要');
        if (!/^[0-9a-f]{64}$/.test(digest)) fail('BAD_INPUT', '预览摘要无效。');
        return this.#decide(library, uuid(input.id, '提案 UUID'), digest, oneOf(input.decision, ['approve', 'reject'], '决定'), operation === 'decideBatch');
      }
      case 'settings': {
        object(input, ['op', 'library']);
        return { settings: store().settings(), metrics: {
          ...store().metrics(), deniedReads: this.#deniedReads.get(library.key) ?? 0, lastExport: this.#exports.get(library.key) ?? null,
        } };
      }
      case 'previewSettings': {
        object(input, ['op', 'library', 'maxHistory', 'staleAfterDays', 'expectedRevision']);
        return store().previewSettings(configuration(input));
      }
      case 'saveSettings': {
        object(input, ['op', 'library', 'maxHistory', 'staleAfterDays', 'expectedRevision', 'previewToken']);
        return store().saveSettings({ ...configuration(input), previewToken: text(input.previewToken, 128, '配置预览摘要') });
      }
      case 'prepareExport': {
        object(input, ['op', 'library']);
        return this.#prepareExport(library);
      }
      default: fail('BAD_INPUT', '不支持此资料库操作。');
    }
  }

  #removeExport(path) {
    try { rmSync(path, { force: true }); } catch { /* export stays in the host-only private directory */ }
  }

  #prepareExport(library) {
    if (this.#tickets.size + this.#streams.size >= 4) fail('EXPORT_BUSY', '已有导出正在等待，请稍后重试。');
    const store = this.#store(library);
    if (store.metrics().fileBytes > MAX_EXPORT_BYTES) fail('EXPORT_LIMIT', '试用版的在线导出限制为 32 MiB。');
    const dir = join(this.#root, 'export');
    privateDirectory(dir);
    const ticket = randomUUID();
    const path = join(dir, ticket + '.sqlite');
    try {
      store.exportTo(path);
      const bytes = statSync(path).size;
      if (bytes > MAX_EXPORT_BYTES) fail('EXPORT_LIMIT', '试用版的在线导出限制为 32 MiB。');
      const fileName = library.scope === 'global' ? 'knowledge-global.sqlite' : 'knowledge-workspace.sqlite';
      this.#tickets.set(ticket, { path, library: library.key, fileName, bytes, expiresAt: this.#now() + EXPORT_TTL });
      return { ticket, fileName };
    } catch (error) {
      this.#removeExport(path);
      this.#exports.set(library.key, { status: 'failed', at: this.#now() });
      throw error;
    }
  }

  download(input, signal) {
    this.#assertOpen();
    object(input, ['ticket']);
    const ticket = uuid(input.ticket, '导出凭证');
    const row = this.#tickets.get(ticket);
    if (!row || signal?.aborted) fail('NOT_FOUND', '下载凭证无效、过期或已经使用。');
    this.#library(row.library);
    this.#tickets.delete(ticket);
    const stream = createReadStream(row.path, { signal });
    this.#streams.add(stream);
    let finished = false;
    stream.once('end', () => { finished = true; });
    stream.once('close', () => {
      this.#streams.delete(stream);
      this.#removeExport(row.path);
      this.#exports.set(row.library, { status: finished ? 'success' : 'failed', at: this.#now(), size: row.bytes });
    });
    return new Response(Readable.toWeb(stream), { headers: {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': 'attachment; filename="' + row.fileName + '"',
      'Content-Length': String(row.bytes),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  }

  invalidateSession(sessionId) {
    for (const rows of [this.#grants, this.#requests, this.#receipts]) {
      for (const [key, row] of rows) if (row.actor.sessionId === sessionId) rows.delete(key);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    for (const stream of this.#streams) stream.destroy();
    for (const row of this.#tickets.values()) this.#removeExport(row.path);
    this.#tickets.clear();
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
    this.#clearSessionAccess();
  }
}
