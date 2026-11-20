import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x44534b4c; // DSKL
const EXPORT_APPLICATION_ID = 0x44534b45; // DSKE, not a writable library
const SCHEMA_VERSION = 2;
const EXPORT_SCHEMA_VERSION = 1; // The portable content format has not changed.
const DAY = 86_400_000;
const DEFAULT_HISTORY = 30;
const DEFAULT_STALE_DAYS = 180;
const BUSY_TIMEOUT_MS = 500;
const MAX_PAGE = 100;
const MAX_BATCH_ITEMS = 20;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const STATUSES = ['active', 'invalid', 'archived'];
const KINDS = ['create', 'update', 'invalidate', 'archive', 'restore', 'promote'];
const OUTCOMES = ['applied', 'rejected', 'expired', 'conflict', 'no_change'];
const STATE_CHANGES = { invalidate: 'invalid', archive: 'archived', restore: 'active' };

export class StorageError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code;
  }
}

function invalid(message) {
  throw new StorageError('INVALID_INPUT', message);
}

function sqlError(error) {
  if (error?.code !== 'ERR_SQLITE_ERROR') return error;
  switch (error.errcode & 0xff) {
    case 5: // SQLITE_BUSY
    case 6: // SQLITE_LOCKED
      return new StorageError('BUSY_RETRY', 'The library is busy; retry later.', error);
    case 19: // SQLITE_CONSTRAINT
      return new StorageError('CONSTRAINT_VIOLATION', 'The change violates a library constraint.', error);
    default:
      return new StorageError('STORAGE_ERROR', 'The database operation failed.', error);
  }
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field + ' must be an object.');
  return value;
}

function text(value, field, maxBytes, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\0') ||
      Buffer.byteLength(value) > maxBytes) invalid(field + ' is not valid text.');
  return value;
}

function integer(value, field, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field + ' is out of range.');
  return value;
}

function oneOf(value, field, choices) {
  if (!choices.includes(value)) invalid(field + ' is not supported.');
  return value;
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(field + ' must be a UUID.');
  return value.toLowerCase();
}

function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) invalid(field + ' must be a bounded array.');
  return Array.from(value);
}

function tagKey(tag) {
  return tag.normalize('NFKC').trim().toLowerCase();
}

function compareKey(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function page(input, defaultLimit = 20) {
  const { limit = defaultLimit, offset = 0 } = object(input, 'page');
  return [integer(limit, 'limit', 1, MAX_PAGE), integer(offset, 'offset', 0)];
}

function hash(value) {
  // The encoding is hashed in memory; neither drafts nor revisions use JSON columns.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function proposalRequestHash(actor, { kind, targetId, baseRevision, reason, draft }) {
  return hash({ kind, targetId, baseRevision, actor, reason, draft });
}

function batchRequestHash(actor, reason, items) {
  return hash({ actor, reason, items: items.map(item => item.requestHash) });
}

function batchDigest(libraryUuid, id, requestHash, expiresAt, items) {
  return hash(['batch', libraryUuid, id, requestHash, expiresAt, items.map(item => item.id)]);
}

function batchMemberDigest(digest, ordinal, id) { return hash(['batch-member', digest, ordinal, id]); }

function syncResult(value) {
  if (value != null && typeof value.then === 'function') {
    // Invalid async callbacks must not leave an unhandled rejection behind the rolled-back transaction.
    if (value instanceof Promise) void value.catch(() => {});
    invalid('Transaction callbacks must be synchronous.');
  }
  return value;
}

function normalizeActor(input) {
  const actor = object(input, 'actor');
  const normalized = { kind: oneOf(actor.kind, 'actor.kind', ['human', 'session']) };
  for (const field of ['sessionId', 'agentId', 'workspaceId']) {
    if (actor[field] !== undefined) normalized[field] = text(actor[field], 'actor.' + field, 512);
  }
  return normalized;
}

function normalizeEvidence(value, scope) {
  const row = object(value, 'evidence item');
  const kind = oneOf(row.kind, 'evidence.kind', ['text', 'url', 'session', 'file']);
  const label = text(row.label, 'evidence.label', 1024);
  const note = text(row.note === undefined ? '' : row.note, 'evidence.note', 8192, true);
  let reference = row.reference ?? null;
  if (kind === 'text') {
    if (reference !== null) invalid('Text evidence must not have a locator.');
  } else {
    reference = text(reference, 'evidence.reference', 4096);
    if (kind === 'url') {
      let url;
      try { url = new URL(reference); } catch { invalid('Invalid evidence URL.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
          !/^https?:\/\//i.test(reference) || /[\s\u0000-\u001f\u007f]/u.test(reference)) {
        invalid('Evidence URLs must be HTTP(S) and must not carry credentials.');
      }
    } else if (scope === 'global') {
      invalid('Global evidence cannot contain private session or file locators.');
    } else if (kind === 'file' && (/^(?:[\\/]|[a-z]+:)/i.test(reference) || reference.split(/[\\/]/).includes('..'))) {
      invalid('File evidence must be relative to the workspace.');
    }
  }
  return { kind, label, note, reference };
}

function normalizeDraft(input, targetId, scope) {
  const draft = object(input, 'draft');
  const title = text(draft.title, 'title', 800).trim();
  if ([...title].length > 200) invalid('title is too long.');
  const detail = text(draft.detail, 'detail', 64 * 1024, true);
  const confidence = draft.confidence;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    invalid('confidence must be null or a number between 0 and 1.');
  }
  const status = oneOf(draft.status, 'status', STATUSES);
  const tags = new Map();
  for (const raw of array(draft.tags, 'tags', 30)) {
    const tag = text(raw, 'tag', 512).trim();
    const key = tagKey(tag);
    if (!key) invalid('Normalized tag must not be empty.');
    if (!tags.has(key) || tag < tags.get(key)) tags.set(key, tag);
  }
  const evidence = array(draft.evidence, 'evidence', 50).map(row => normalizeEvidence(row, scope));
  const relationKeys = new Set();
  const relations = array(draft.relations, 'relations', 50).map(value => {
    const row = object(value, 'relation');
    const type = oneOf(row.type, 'relation.type', ['related', 'supersedes', 'duplicates']);
    const relatedId = uuid(row.targetId, 'relation.targetId');
    if (relatedId === targetId) invalid('Entries cannot relate to themselves.');
    const key = type + ':' + relatedId;
    if (relationKeys.has(key)) invalid('Duplicate relation.');
    relationKeys.add(key);
    return { type, targetId: relatedId };
  });
  const sourceKeys = new Set();
  const sources = array(draft.sources, 'sources', 50).map(value => {
    const row = object(value, 'source');
    const workspaceId = text(row.workspaceId, 'source.workspaceId', 512);
    const entryId = uuid(row.entryId, 'source.entryId');
    const revision = integer(row.revision, 'source.revision', 1);
    const key = JSON.stringify([workspaceId, entryId, revision]);
    if (sourceKeys.has(key)) invalid('Duplicate source.');
    sourceKeys.add(key);
    return { workspaceId, entryId, revision };
  });
  return {
    title, detail, tags: [...tags].sort(([a], [b]) => compareKey(a, b)).map(([, label]) => label),
    confidence, status, evidence, relations, sources,
  };
}

// Each list spec defines its normalized columns, ordering and DTO for both
// durable versions and staged drafts. The same public specs feed the export allowlist.
const LISTS = {
  tags: {
    table: 'tag', order: 'tag_key', cols: ['tag_key', 'label'],
    fields: 'tag_key TEXT NOT NULL, label TEXT NOT NULL',
    pack: label => [tagKey(label), label], unpack: row => row.label,
  },
  evidence: {
    table: 'evidence', order: 'ordinal', cols: ['ordinal', 'kind', 'label', 'note', 'reference'],
    fields: `ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('text', 'url', 'session', 'file')),
      label TEXT NOT NULL, note TEXT NOT NULL, reference TEXT
      CHECK ((kind = 'text' AND reference IS NULL) OR (kind <> 'text' AND reference IS NOT NULL))`,
    pack: (row, i) => [i, row.kind, row.label, row.note, row.reference],
    unpack: ({ kind, label, note, reference }) => ({ kind, label, note, reference }),
  },
  relations: {
    table: 'relation', order: 'ordinal', cols: ['ordinal', 'type', 'target_id'],
    fields: `ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      type TEXT NOT NULL CHECK (type IN ('related', 'supersedes', 'duplicates')), target_id TEXT NOT NULL`,
    pack: (row, i) => [i, row.type, row.targetId],
    unpack: ({ type, target_id }) => ({ type, targetId: target_id }),
  },
  sources: {
    table: 'source', order: 'ordinal', cols: ['ordinal', 'workspace_id', 'source_entry_id', 'source_revision'],
    fields: `ordinal INTEGER NOT NULL CHECK (ordinal >= 0), workspace_id TEXT NOT NULL,
      source_entry_id TEXT NOT NULL, source_revision INTEGER NOT NULL CHECK (source_revision >= 1)`,
    pack: (row, i) => [i, row.workspaceId, row.entryId, row.revision],
    unpack: ({ workspace_id, source_entry_id, source_revision }) => ({
      workspaceId: workspace_id, entryId: source_entry_id, revision: source_revision,
    }),
  },
};
const PUBLIC_LISTS = ['tags', 'evidence', 'relations'];
const ALL_LISTS = [...PUBLIC_LISTS, 'sources'];
const REVISION_COLUMNS = ['entry_id', 'revision', 'title', 'detail', 'confidence', 'status', 'updated_at', 'change_kind', 'actor_kind'];
const DRAFT_FIELDS = `title TEXT NOT NULL, detail TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid', 'archived'))`;
const ENTRY_SELECT = `FROM entry AS e JOIN entry_revision AS r ON r.entry_id = e.id`;
const PROPOSAL_SELECT = `SELECT p.*, d.state, d.result_revision FROM proposal AS p
  LEFT JOIN proposal_decision AS d ON p.id = d.proposal_id`;
const STANDALONE = `NOT EXISTS (SELECT 1 FROM proposal_batch_member AS m WHERE m.proposal_id = p.id)`;
const EXPIRABLE = `FROM proposal AS p WHERE p.expires_at <= ? AND ${STANDALONE} AND NOT EXISTS (
  SELECT 1 FROM proposal_decision AS d WHERE d.proposal_id = p.id)`;
const BATCH_SELECT = `SELECT b.*, d.state FROM proposal_batch AS b
  LEFT JOIN proposal_batch_decision AS d ON b.id = d.batch_id`;
const EXPIRABLE_BATCH = `FROM proposal_batch AS b WHERE b.expires_at <= ? AND NOT EXISTS (
  SELECT 1 FROM proposal_batch_decision AS d WHERE d.batch_id = b.id)`;
const TRIMMABLE = `FROM entry_revision AS r JOIN entry AS e ON e.id = r.entry_id
  WHERE r.revision < e.current_revision - ?`;

function listSchema(prefix, lists) {
  const revision = prefix === 'revision';
  const ownerFields = revision ? 'entry_id TEXT NOT NULL, revision INTEGER NOT NULL' : 'proposal_id TEXT NOT NULL';
  const ownerKey = revision ? 'entry_id, revision' : 'proposal_id';
  const parent = revision ? 'entry_revision(entry_id, revision)' : 'proposal_draft(proposal_id)';
  return lists.map(key => {
    const { table, order, fields } = LISTS[key];
    const relationConstraints = revision && key === 'relations'
      ? ', CHECK (entry_id <> target_id), FOREIGN KEY (target_id) REFERENCES entry(id)' : '';
    return `CREATE TABLE ${prefix}_${table} (
      ${ownerFields}, ${fields}, PRIMARY KEY (${ownerKey}, ${order}),
      FOREIGN KEY (${ownerKey}) REFERENCES ${parent} ON DELETE CASCADE${relationConstraints}
    ) STRICT;`;
  }).join('\n');
}

function contentSchema(privateData) {
  const workspaceField = privateData ? `, workspace_id TEXT,
    CHECK ((scope = 'global' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))` : '';
  return `CREATE TABLE library_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), library_uuid TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'workspace'))${workspaceField}
  ) STRICT;
  CREATE TABLE entry (
    id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    FOREIGN KEY (id, current_revision) REFERENCES entry_revision(entry_id, revision) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE TABLE entry_revision (
    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1), ${DRAFT_FIELDS},
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'invalidate', 'archive', 'restore', 'promote')),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'session')),
    PRIMARY KEY (entry_id, revision)
  ) STRICT;
  ${listSchema('revision', privateData ? ALL_LISTS : PUBLIC_LISTS)}
  CREATE INDEX revision_status_time ON entry_revision(status, updated_at DESC, entry_id);
  CREATE INDEX revision_tag_key ON revision_tag(tag_key, entry_id, revision);`;
}

const PRIVATE_SCHEMA = `CREATE TABLE library_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  max_history INTEGER NOT NULL CHECK (max_history >= 1),
  stale_after_days INTEGER NOT NULL CHECK (stale_after_days >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;
CREATE TABLE proposal (
  id TEXT PRIMARY KEY, actor_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'update', 'invalidate', 'archive', 'restore', 'promote')),
  target_id TEXT NOT NULL, base_revision INTEGER CHECK (base_revision >= 1),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'session')),
  session_id TEXT, agent_id TEXT, workspace_id TEXT,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  UNIQUE (actor_key, idempotency_key),
  CHECK (kind = 'promote' OR (kind = 'create') = (base_revision IS NULL))
) STRICT;
CREATE INDEX proposal_expiry ON proposal(expires_at);
CREATE INDEX proposal_time ON proposal(created_at DESC, id);
CREATE TABLE proposal_draft (
  proposal_id TEXT PRIMARY KEY REFERENCES proposal(id) ON DELETE CASCADE, ${DRAFT_FIELDS}
) STRICT;
${listSchema('proposal', ALL_LISTS)}
CREATE TABLE proposal_decision (
  proposal_id TEXT PRIMARY KEY REFERENCES proposal(id),
  state TEXT NOT NULL CHECK (state IN ('applied', 'rejected', 'expired', 'conflict', 'no_change')),
  decided_at INTEGER NOT NULL, result_revision INTEGER CHECK (result_revision >= 1),
  CHECK ((state IN ('applied', 'no_change')) = (result_revision IS NOT NULL))
) STRICT;
CREATE TABLE settings_audit (
  revision INTEGER PRIMARY KEY, changed_at INTEGER NOT NULL, previous_max_history INTEGER NOT NULL,
  max_history INTEGER NOT NULL, previous_stale_after_days INTEGER NOT NULL, stale_after_days INTEGER NOT NULL,
  trimmed_count INTEGER NOT NULL CHECK (trimmed_count >= 0)
) STRICT;`;

// Additive migration: member drafts and results use the existing relational proposal tables.
const BATCH_SCHEMA = `CREATE TABLE proposal_batch (
  id TEXT PRIMARY KEY, actor_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, digest TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'session')),
  session_id TEXT, agent_id TEXT, workspace_id TEXT,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND ${MAX_BATCH_ITEMS}),
  UNIQUE (actor_key, idempotency_key)
) STRICT;
CREATE INDEX proposal_batch_expiry ON proposal_batch(expires_at);
CREATE INDEX proposal_batch_time ON proposal_batch(created_at DESC, id);
CREATE TABLE proposal_batch_member (
  batch_id TEXT NOT NULL REFERENCES proposal_batch(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < ${MAX_BATCH_ITEMS}),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposal(id),
  PRIMARY KEY (batch_id, ordinal)
) STRICT;
CREATE TABLE proposal_batch_decision (
  batch_id TEXT PRIMARY KEY REFERENCES proposal_batch(id),
  state TEXT NOT NULL CHECK (state IN ('applied', 'rejected', 'expired', 'conflict', 'no_change')),
  decided_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER proposal_batch_member_decision_guard
BEFORE INSERT ON proposal_decision WHEN EXISTS (
  SELECT 1 FROM proposal_batch_member AS m WHERE m.proposal_id = NEW.proposal_id AND NOT EXISTS (
    SELECT 1 FROM proposal_batch_decision AS d WHERE d.batch_id = m.batch_id AND d.decided_at = NEW.decided_at
      AND (d.state = NEW.state OR (d.state = 'applied' AND NEW.state = 'no_change'))
  )
) BEGIN
  SELECT RAISE(ABORT, 'A batch member requires its batch decision');
END;`;

function insertStatement(db, table, columns) {
  // Table/column names come only from the static schema above, never from callers.
  return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
}

function privateFile(file) {
  closeSync(openSync(file, 'wx', 0o600));
}

function fileExists(file) {
  try { lstatSync(file); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function exportTargetFree(file) {
  if (['', '-wal', '-shm', '-journal'].some(suffix => fileExists(file + suffix))) {
    throw new StorageError('EXPORT_EXISTS', 'The export path or one of its SQLite sidecars already exists.');
  }
}

function fileSize(file) {
  try { return statSync(file).size; } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw new StorageError('STORAGE_ERROR', 'Could not read the library file size.', error);
  }
}

function actorOf(row) {
  return {
    kind: row.actor_kind,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
  };
}

export class LibraryStore {
  #db;
  #file;
  #scope;
  #workspaceId;
  #libraryUuid;
  #now;
  #transactionMode = null;
  #closed = false;

  constructor(file, options) {
    text(file, 'file', 8192);
    const { scope, workspaceId, now = Date.now } = object(options, 'library options');
    this.#scope = oneOf(scope, 'scope', ['global', 'workspace']);
    if (scope === 'workspace') this.#workspaceId = text(workspaceId, 'workspaceId', 512);
    else if (workspaceId !== undefined) invalid('The global library must not have a workspace ID.');
    if (typeof now !== 'function') invalid('now must be a function.');
    this.#now = now;
    this.#file = file === ':memory:' ? file : resolve(file);
    try {
      if (this.#file !== ':memory:') {
        try { privateFile(this.#file); } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          if (!lstatSync(this.#file).isFile()) invalid('The library file is not a regular file.');
        }
      }
      this.#db = new DatabaseSync(this.#file);
      this.#db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA secure_delete = ON;`);
      this.#write(() => this.#initialize());
      if (this.#file !== ':memory:' && this.#db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') {
        throw new StorageError('STORAGE_ERROR', 'The library filesystem did not allow WAL mode.');
      }
    } catch (error) {
      try { this.#db?.close(); } catch { /* Preserve the opening failure. */ }
      const mapped = sqlError(error);
      if (mapped instanceof StorageError) throw mapped;
      throw new StorageError('STORAGE_ERROR', 'Could not open the library file.', error);
    }
  }

  #initialize() {
    const applicationId = this.#db.prepare('PRAGMA application_id').get().application_id;
    const version = this.#db.prepare('PRAGMA user_version').get().user_version;
    const fresh = applicationId === 0 && version === 0 && !this.#db.prepare(
      'SELECT 1 FROM sqlite_schema LIMIT 1',
    ).get();
    if (fresh) {
      this.#db.exec(contentSchema(true) + PRIVATE_SCHEMA);
      this.#db.prepare('INSERT INTO library_meta VALUES (1, ?, ?, ?)').run(
        randomUUID(), this.#scope, this.#workspaceId ?? null,
      );
      this.#db.prepare('INSERT INTO library_settings VALUES (1, ?, ?, 1)').run(DEFAULT_HISTORY, DEFAULT_STALE_DAYS);
      this.#db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    } else if (applicationId !== APPLICATION_ID || (version !== 1 && version !== SCHEMA_VERSION)) {
      throw new StorageError('UNSUPPORTED_SCHEMA', 'This is not a supported writable library database.');
    }
    const meta = this.#db.prepare('SELECT library_uuid, scope, workspace_id FROM library_meta WHERE singleton = 1').get();
    if (!meta || meta.scope !== this.#scope || meta.workspace_id !== (this.#workspaceId ?? null)) {
      throw new StorageError('SCOPE_MISMATCH', 'The library binding does not match the requested scope.');
    }
    if (fresh || version === 1) {
      // Construction holds a write transaction: a failed migration leaves the v1 DB intact.
      this.#db.exec(BATCH_SCHEMA);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    this.#libraryUuid = meta.library_uuid;
  }

  #stamp() { return integer(this.#now(), 'clock value', 0); }

  #ensureOpen() {
    if (this.#closed) throw new StorageError('STORAGE_CLOSED', 'The library is closed.');
  }

  #ensureIdle() {
    this.#ensureOpen();
    if (this.#transactionMode) throw new StorageError('TRANSACTION_ACTIVE', 'The library transaction is already active.');
  }

  #transaction(mode, work) {
    this.#ensureIdle();
    try { this.#db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE'); } catch (error) { throw sqlError(error); }
    this.#transactionMode = mode;
    try {
      const result = syncResult(work());
      this.#db.exec(mode === 'guard' ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw sqlError(error);
    } finally {
      this.#transactionMode = null;
    }
  }

  #write(work) { return this.#transaction('write', work); }

  #snapshot(work) {
    this.#ensureOpen();
    if (!this.#transactionMode) return this.#transaction('read', work);
    try { return work(); } catch (error) { throw sqlError(error); }
  }

  withWriteGuard(fn) {
    if (typeof fn !== 'function') invalid('The source guard requires a synchronous function.');
    return this.#transaction('guard', fn);
  }

  #readList(prefix, key, id, revision) {
    const spec = LISTS[key];
    const owner = prefix === 'revision' ? 'entry_id = ? AND revision = ?' : 'proposal_id = ?';
    const statement = this.#db.prepare(`SELECT ${spec.cols.join(', ')} FROM ${prefix}_${spec.table}
      WHERE ${owner} ORDER BY ${spec.order}`);
    return statement.all(...(prefix === 'revision' ? [id, revision] : [id])).map(spec.unpack);
  }

  #writeLists(prefix, id, revision, draft) {
    const ownerColumns = prefix === 'revision' ? ['entry_id', 'revision'] : ['proposal_id'];
    const ownerValues = prefix === 'revision' ? [id, revision] : [id];
    for (const key of ALL_LISTS) {
      if (!draft[key].length) continue;
      const spec = LISTS[key];
      const statement = insertStatement(this.#db, prefix + '_' + spec.table, [...ownerColumns, ...spec.cols]);
      for (const [i, row] of draft[key].entries()) statement.run(...ownerValues, ...spec.pack(row, i));
    }
  }

  #draft(prefix, row, id, revision) {
    if (!row) throw new StorageError('STORAGE_ERROR', 'A proposal is missing its pending draft.');
    return {
      title: row.title,
      detail: row.detail,
      tags: this.#readList(prefix, 'tags', id, revision),
      confidence: row.confidence,
      status: row.status,
      evidence: this.#readList(prefix, 'evidence', id, revision),
      relations: this.#readList(prefix, 'relations', id, revision),
      sources: this.#readList(prefix, 'sources', id, revision),
    };
  }

  #entry(row) {
    return {
      id: row.entry_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...this.#draft('revision', row, row.entry_id, row.revision),
    };
  }

  #entryRow(id, revision) {
    return this.#db.prepare(`SELECT r.*, e.created_at ${ENTRY_SELECT} WHERE e.id = ?
      AND r.revision = ${revision === undefined ? 'e.current_revision' : '?'}`)
      .get(...(revision === undefined ? [id] : [id, revision]));
  }

  read(id, revision) {
    const key = text(id, 'id', 512).toLowerCase();
    if (revision !== undefined) integer(revision, 'revision', 1);
    return this.#snapshot(() => {
      const row = this.#entryRow(key, revision);
      return row ? this.#entry(row) : null;
    });
  }

  readMany(ids) {
    const keys = array(ids, 'ids', MAX_BATCH_ITEMS).map(id => text(id, 'id', 512).toLowerCase());
    if (!keys.length) invalid('At least one read target is required.');
    return this.#snapshot(() => {
      const placeholders = keys.map(() => '?').join(', ');
      const rows = this.#db.prepare(`SELECT r.*, e.created_at ${ENTRY_SELECT}
        WHERE e.id IN (${placeholders}) AND r.revision = e.current_revision`).all(...keys);
      const entries = new Map(rows.map(row => [row.entry_id, this.#entry(row)]));
      return keys.map(key => entries.get(key) ?? null);
    });
  }

  list(options = {}) {
    const [limit, offset] = page(options);
    const { q, tag, status = 'active', staleOnly = false } = options;
    oneOf(status, 'status', [...STATUSES, 'all', 'candidates']);
    if (typeof staleOnly !== 'boolean') invalid('staleOnly must be a boolean.');
    const query = q === undefined ? '' : text(q, 'q', 4096, true).trim();
    const tagFilter = tag === undefined ? '' : tagKey(text(tag, 'tag', 512, true));
    return this.#snapshot(() => {
      const where = ['r.revision = e.current_revision'];
      const params = [];
      if (staleOnly || status === 'candidates') {
        const threshold = this.#stamp() - this.#settings().staleAfterDays * DAY;
        if (status === 'candidates' && !staleOnly) {
          where.push("((r.status = 'active' AND r.updated_at <= ?) OR r.status = 'invalid')");
        } else {
          where.push('r.updated_at <= ?');
          if (status === 'candidates') where.push("r.status IN ('active', 'invalid')");
        }
        params.push(threshold);
      }
      if (STATUSES.includes(status)) {
        where.push('r.status = ?');
        params.push(status);
      }
      if (query) {
        where.push(`(instr(lower(r.title), lower(?)) > 0 OR instr(lower(r.detail), lower(?)) > 0 OR
          EXISTS (SELECT 1 FROM revision_tag AS t WHERE t.entry_id = r.entry_id AND t.revision = r.revision
            AND instr(t.tag_key, ?) > 0))`);
        params.push(query, query, tagKey(query));
      }
      if (tagFilter) {
        where.push(`EXISTS (SELECT 1 FROM revision_tag AS t
          WHERE t.entry_id = r.entry_id AND t.revision = r.revision AND t.tag_key = ?)`);
        params.push(tagFilter);
      }
      return this.#db.prepare(`SELECT r.entry_id, r.revision, r.title, r.confidence, r.status, r.updated_at, e.created_at
        ${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.updated_at DESC, r.entry_id ASC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset).map(row => ({
          id: row.entry_id, revision: row.revision, title: row.title,
          tags: this.#readList('revision', 'tags', row.entry_id, row.revision),
          confidence: row.confidence, status: row.status, updatedAt: row.updated_at, createdAt: row.created_at,
        }));
    });
  }

  history(id, options = {}) {
    const key = text(id, 'id', 512).toLowerCase();
    const [limit, offset] = page(options, MAX_PAGE);
    return this.#snapshot(() => this.#db.prepare(`SELECT r.*, e.created_at ${ENTRY_SELECT}
      WHERE e.id = ? AND r.revision < e.current_revision ORDER BY r.revision DESC LIMIT ? OFFSET ?`)
      .all(key, limit, offset).map(row => this.#entry(row)));
  }

  #proposalRow(id, standalone = false) {
    return this.#db.prepare(PROPOSAL_SELECT + ' WHERE p.id = ?' + (standalone ? ' AND ' + STANDALONE : '')).get(id);
  }

  #batchRow(id) { return this.#db.prepare(BATCH_SELECT + ' WHERE b.id = ?').get(id); }

  #proposal(row, now, includeDraft) {
    const state = row.state ?? (row.expires_at <= now ? 'expired' : 'pending');
    return {
      id: row.id, targetId: row.target_id, kind: row.kind, baseRevision: row.base_revision,
      actor: actorOf(row), reason: row.reason, createdAt: row.created_at, expiresAt: row.expires_at,
      digest: row.digest, state, resultRevision: row.result_revision,
      ...(includeDraft && state === 'pending' ? { draft: this.#draft('proposal', this.#db.prepare(
        'SELECT * FROM proposal_draft WHERE proposal_id = ?',
      ).get(row.id), row.id) } : {}),
    };
  }

  #batchView(row, now, includeItems) {
    const state = row.state ?? (row.expires_at <= now ? 'expired' : 'pending');
    const result = {
      id: row.id, actor: actorOf(row), reason: row.reason, createdAt: row.created_at,
      expiresAt: row.expires_at, digest: row.digest, state, itemCount: row.item_count,
    };
    if (!includeItems) return result;
    const items = this.#db.prepare(PROPOSAL_SELECT + `
      JOIN proposal_batch_member AS m ON m.proposal_id = p.id WHERE m.batch_id = ? ORDER BY m.ordinal`)
      .all(row.id).map(member => this.#proposal(member, now, state === 'pending'));
    if (items.length !== row.item_count || items.some(item => item.state !== state
      && !(state === 'applied' && item.state === 'no_change'))) {
      throw new StorageError('STORAGE_ERROR', 'The batch and its members do not agree.');
    }
    return { ...result, items };
  }

  #verifyBatchSnapshot(row, batch) {
    const items = batch.items.map(item => {
      // SQLite stores the exact labels, but BINARY tag order differs from JS
      // UTF-16 order; only restore the original canonical order, not the values.
      const tags = [...item.draft.tags].sort((a, b) => compareKey(tagKey(a), tagKey(b)));
      const requestHash = proposalRequestHash(batch.actor, { ...item, draft: { ...item.draft, tags } });
      return { id: item.id, requestHash };
    });
    const requestHash = batchRequestHash(batch.actor, batch.reason, items);
    if (row.request_hash !== requestHash
        || row.digest !== batchDigest(this.#libraryUuid, row.id, requestHash, row.expires_at, items)
        || batch.items.some((item, i) => item.digest !== batchMemberDigest(row.digest, i, item.id)
          || hash(item.actor) !== row.actor_key || item.createdAt !== row.created_at || item.expiresAt !== row.expires_at)) {
      throw new StorageError('DIGEST_MISMATCH', 'The saved changes no longer match the batch preview.');
    }
  }

  #recordProposalDecision(id, state, now, resultRevision = null) {
    this.#db.prepare('INSERT INTO proposal_decision VALUES (?, ?, ?, ?)').run(id, state, now, resultRevision);
    this.#db.prepare('DELETE FROM proposal_draft WHERE proposal_id = ?').run(id);
  }

  #settle(id, state, now, resultRevision = null) {
    this.#recordProposalDecision(id, state, now, resultRevision);
    return this.#proposal(this.#proposalRow(id), now, false);
  }

  #settleBatch(batch, state, now, plans) {
    this.#db.prepare('INSERT INTO proposal_batch_decision VALUES (?, ?, ?)').run(batch.id, state, now);
    for (const [i, item] of batch.items.entries()) {
      const plan = plans?.[i];
      this.#recordProposalDecision(item.id, plan?.state ?? state, now, plan?.revision ?? null);
    }
    return this.#batchView(this.#batchRow(batch.id), now, true);
  }

  #expireDue(now) {
    // Marking expiry and removing all corresponding draft children is atomic.
    const singles = this.#db.prepare(`INSERT INTO proposal_decision
      SELECT p.id, 'expired', ?, NULL ${EXPIRABLE}`).run(now, now);
    const batches = this.#db.prepare(`INSERT INTO proposal_batch_decision
      SELECT b.id, 'expired', ? ${EXPIRABLE_BATCH}`).run(now, now);
    if (batches.changes) this.#db.prepare(`INSERT INTO proposal_decision
      SELECT m.proposal_id, 'expired', ?, NULL FROM proposal_batch_decision AS d
      JOIN proposal_batch_member AS m ON m.batch_id = d.batch_id
      LEFT JOIN proposal_decision AS md ON md.proposal_id = m.proposal_id
      WHERE d.state = 'expired' AND d.decided_at = ? AND md.proposal_id IS NULL`).run(now, now);
    if (singles.changes || batches.changes) this.#db.exec(`DELETE FROM proposal_draft WHERE EXISTS (
      SELECT 1 FROM proposal_decision AS d WHERE d.proposal_id = proposal_draft.proposal_id
    );`);
  }

  #reapIfDue(now) {
    this.#ensureOpen();
    if (this.#transactionMode) return; // A source guard never writes, even during a read callback.
    try {
      if (this.#db.prepare('SELECT 1 ' + EXPIRABLE + ' LIMIT 1').get(now)
          || this.#db.prepare('SELECT 1 ' + EXPIRABLE_BATCH + ' LIMIT 1').get(now)) {
        this.#write(() => this.#expireDue(now));
      }
    } catch (error) { throw sqlError(error); }
  }

  #normalizeProposalItem(input, actor) {
    const data = object(input, 'proposal');
    const id = text(data.id, 'proposal.id', 512);
    const kind = oneOf(data.kind, 'kind', KINDS);
    const targetId = uuid(data.targetId, 'targetId');
    const baseRevision = data.baseRevision === null ? null : integer(data.baseRevision, 'baseRevision', 1);
    const reason = text(data.reason, 'reason', 4096, true);
    const draft = normalizeDraft(data.draft, targetId, this.#scope);
    if (kind !== 'promote' && (kind === 'create') !== (baseRevision === null)) {
      invalid('baseRevision does not match the proposal kind.');
    }
    const requiredStatus = kind === 'create' || kind === 'promote' ? 'active' :
      Object.hasOwn(STATE_CHANGES, kind) ? STATE_CHANGES[kind] : null;
    if (requiredStatus && draft.status !== requiredStatus) invalid('Draft status does not match the proposal kind.');
    if (this.#scope === 'workspace') {
      if (kind === 'promote' || draft.sources.length) invalid('Workspace entries cannot be promotion targets or carry private sources.');
      if (actor.workspaceId !== undefined && actor.workspaceId !== this.#workspaceId) invalid('Actor has a different workspace binding.');
    } else {
      if (kind === 'create') invalid('Global entries must be created by promotion.');
      if (kind === 'promote') {
        const sourceWorkspace = draft.sources[0]?.workspaceId;
        if (actor.kind !== 'session' || !sourceWorkspace ||
            (actor.workspaceId !== undefined && actor.workspaceId !== sourceWorkspace) ||
            draft.sources.some(source => source.workspaceId !== sourceWorkspace)) {
          invalid('A promotion requires a session and sources from one workspace.');
        }
      }
    }
    const requestHash = proposalRequestHash(actor, { kind, targetId, baseRevision, reason, draft });
    return { id, kind, targetId, baseRevision, reason, draft, requestHash };
  }

  #insertProposal(item, { actor, actorKey, key, digest, now, expiresAt }) {
    const { id, kind, targetId, baseRevision, draft, reason, requestHash } = item;
    this.#db.prepare(`INSERT INTO proposal (id, actor_key, idempotency_key, request_hash, digest, kind, target_id,
      base_revision, actor_kind, session_id, agent_id, workspace_id, reason, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, actorKey, key, requestHash, digest, kind, targetId, baseRevision, actor.kind,
      actor.sessionId ?? null, actor.agentId ?? null, actor.workspaceId ?? null, reason, now, expiresAt,
    );
    this.#db.prepare('INSERT INTO proposal_draft (proposal_id, title, detail, confidence, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, draft.title, draft.detail, draft.confidence, draft.status);
    this.#writeLists('proposal', id, undefined, draft);
  }

  #assertUnusedProposalId(id) {
    if (this.#proposalRow(id) || this.#batchRow(id)) {
      throw new StorageError('IDEMPOTENCY_CONFLICT', 'The proposal ID is already in use.');
    }
  }

  stage(input) {
    const data = object(input, 'proposal');
    const key = text(data.idempotencyKey, 'idempotencyKey', 512);
    const actor = normalizeActor(data.actor);
    const actorKey = hash(actor);
    const expiresAt = integer(data.expiresAt, 'expiresAt', 0);
    const item = this.#normalizeProposalItem(data, actor);
    const { id, requestHash } = item;
    return this.#write(() => {
      const now = this.#stamp();
      this.#expireDue(now);
      const existing = this.#db.prepare(PROPOSAL_SELECT + ' WHERE p.actor_key = ? AND p.idempotency_key = ? AND ' + STANDALONE)
        .get(actorKey, key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new StorageError('IDEMPOTENCY_CONFLICT', 'The request key was already used for a different proposal.');
        }
        return this.#proposal(existing, now, true);
      }
      this.#assertUnusedProposalId(id);
      if (expiresAt <= now) invalid('A new proposal must expire in the future.');
      const digest = hash([this.#libraryUuid, id, requestHash, expiresAt]);
      this.#insertProposal(item, { actor, actorKey, key, digest, now, expiresAt });
      return this.#proposal(this.#proposalRow(id), now, true);
    });
  }

  stageBatch(input) {
    const data = object(input, 'proposal batch');
    const id = text(data.id, 'batch.id', 512);
    const key = text(data.idempotencyKey, 'idempotencyKey', 512);
    const actor = normalizeActor(data.actor);
    const actorKey = hash(actor);
    const reason = text(data.reason, 'reason', 4096, true);
    const expiresAt = integer(data.expiresAt, 'expiresAt', 0);
    const items = array(data.items, 'items', MAX_BATCH_ITEMS).map(item => this.#normalizeProposalItem(item, actor));
    if (!items.length) invalid('A batch must contain at least one proposed change.');
    if (new Set([id, ...items.map(item => item.id)]).size !== items.length + 1) invalid('Batch and member IDs must be distinct.');
    if (new Set(items.map(item => item.targetId)).size !== items.length) invalid('A batch may change a target only once.');
    const requestHash = batchRequestHash(actor, reason, items);
    return this.#write(() => {
      const now = this.#stamp();
      this.#expireDue(now);
      const existing = this.#db.prepare(BATCH_SELECT + ' WHERE b.actor_key = ? AND b.idempotency_key = ?').get(actorKey, key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new StorageError('IDEMPOTENCY_CONFLICT', 'The request key was already used for a different batch.');
        }
        return this.#batchView(existing, now, true);
      }
      this.#assertUnusedProposalId(id);
      for (const item of items) this.#assertUnusedProposalId(item.id);
      if (expiresAt <= now) invalid('A new batch must expire in the future.');
      const digest = batchDigest(this.#libraryUuid, id, requestHash, expiresAt, items);
      this.#db.prepare(`INSERT INTO proposal_batch (id, actor_key, idempotency_key, request_hash, digest, actor_kind,
        session_id, agent_id, workspace_id, reason, created_at, expires_at, item_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, actorKey, key, requestHash, digest, actor.kind, actor.sessionId ?? null, actor.agentId ?? null,
        actor.workspaceId ?? null, reason, now, expiresAt, items.length,
      );
      const insertMember = this.#db.prepare('INSERT INTO proposal_batch_member VALUES (?, ?, ?)');
      for (const [index, item] of items.entries()) {
        this.#insertProposal(item, {
          actor, now, expiresAt, actorKey: 'batch:' + actorKey, key: hash([id, index]),
          digest: batchMemberDigest(digest, index, item.id),
        });
        insertMember.run(id, index, item.id);
      }
      return this.#batchView(this.#batchRow(id), now, true);
    });
  }

  proposal(id) {
    text(id, 'proposal.id', 512);
    const now = this.#stamp();
    this.#reapIfDue(now);
    return this.#snapshot(() => {
      const row = this.#proposalRow(id, true);
      return row ? this.#proposal(row, now, true) : null;
    });
  }

  proposals(options = {}) {
    const [limit, offset] = page(options);
    const state = oneOf(options.state === undefined ? 'pending' : options.state, 'state', ['pending', 'all']);
    const now = this.#stamp();
    this.#reapIfDue(now);
    return this.#snapshot(() => this.#db.prepare(PROPOSAL_SELECT + ' WHERE ' + STANDALONE +
      (state === 'pending' ? ' AND d.proposal_id IS NULL AND p.expires_at > ?' : '') +
      ' ORDER BY p.created_at DESC, p.id ASC LIMIT ? OFFSET ?')
      .all(...(state === 'pending' ? [now, limit, offset] : [limit, offset]))
      .map(row => this.#proposal(row, now, false)));
  }

  batch(id) {
    text(id, 'batch.id', 512);
    const now = this.#stamp();
    this.#reapIfDue(now);
    return this.#snapshot(() => {
      const row = this.#batchRow(id);
      return row ? this.#batchView(row, now, true) : null;
    });
  }

  batches(options = {}) {
    const [limit, offset] = page(options);
    const state = oneOf(options.state === undefined ? 'pending' : options.state, 'state', ['pending', 'all']);
    const now = this.#stamp();
    this.#reapIfDue(now);
    return this.#snapshot(() => this.#db.prepare(BATCH_SELECT +
      (state === 'pending' ? ' WHERE d.batch_id IS NULL AND b.expires_at > ?' : '') +
      ' ORDER BY b.created_at DESC, b.id ASC LIMIT ? OFFSET ?')
      .all(...(state === 'pending' ? [now, limit, offset] : [limit, offset]))
      .map(row => this.#batchView(row, now, false)));
  }

  #validateTransition(kind, current, draft) {
    if (!current) return;
    if (kind === 'update' && current.status !== draft.status) invalid('Use a state-change proposal to change status.');
    if (Object.hasOwn(STATE_CHANGES, kind)) {
      const { status: previousStatus, ...previous } = current;
      const { status: nextStatus, ...next } = draft;
      if ((previousStatus === 'archived' && nextStatus === 'invalid') || hash(previous) !== hash(next)) {
        invalid('A state-change proposal cannot modify content or invalidate an archived item.');
      }
    }
    if (this.#scope === 'global' && kind !== 'promote') {
      const content = item => [item.detail, item.evidence, item.relations, item.sources];
      if (hash(content(current)) !== hash(content(draft))) invalid('Only promotion can change global content and sources.');
    }
  }

  #planRevision(proposal, currentRow) {
    const current = currentRow && this.#draft('revision', currentRow, currentRow.entry_id, currentRow.revision);
    this.#validateTransition(proposal.kind, current, proposal.draft);
    if (current && hash(current) === hash(proposal.draft)) return { state: 'no_change', revision: currentRow.revision };
    return { state: 'applied', revision: integer((proposal.baseRevision ?? 0) + 1, 'next revision', 1) };
  }

  #writeHead(proposal, revision, now) {
    if (proposal.baseRevision === null) {
      this.#db.prepare('INSERT INTO entry (id, current_revision, created_at) VALUES (?, ?, ?)').run(proposal.targetId, revision, now);
      return true;
    }
    return this.#db.prepare('UPDATE entry SET current_revision = ? WHERE id = ? AND current_revision = ?')
      .run(revision, proposal.targetId, proposal.baseRevision).changes === 1;
  }

  #writeRevision(proposal, revision, now, maxHistory) {
    const { title, detail, confidence, status } = proposal.draft;
    insertStatement(this.#db, 'entry_revision', REVISION_COLUMNS).run(
      proposal.targetId, revision, title, detail, confidence, status, now, proposal.kind, proposal.actor.kind,
    );
    this.#writeLists('revision', proposal.targetId, revision, proposal.draft);
    this.#db.prepare('DELETE FROM entry_revision WHERE entry_id = ? AND revision < ?')
      .run(proposal.targetId, revision - maxHistory);
  }

  #verifyDecisionCheck(check, items, payload) {
    if (this.#scope === 'global' && items.some(item => ['promote', 'restore'].includes(item.kind)) && !check) {
      throw new StorageError('CHECK_REQUIRED', 'Verifying the sources is required before global publication.');
    }
    if (!check) return true;
    // Source validation cannot edit the digest-bound snapshots which will be applied.
    const valid = syncResult(check(structuredClone(payload)));
    if (typeof valid !== 'boolean') invalid('check must return a boolean.');
    return valid;
  }

  decide(input) {
    const { id, digest, decision, check } = object(input, 'decision');
    text(id, 'proposal.id', 512);
    text(digest, 'digest', 512);
    oneOf(decision, 'decision', ['approve', 'reject']);
    if (check !== undefined && typeof check !== 'function') invalid('check must be a synchronous boolean function.');
    return this.#write(() => {
      const row = this.#proposalRow(id, true);
      if (!row) throw new StorageError('NOT_FOUND', 'Proposal not found.');
      if (row.digest !== digest) throw new StorageError('DIGEST_MISMATCH', 'The decision does not match the proposal preview.');
      let now = this.#stamp();
      if (row.state) return this.#proposal(row, now, false);
      if (row.expires_at <= now) return this.#settle(id, 'expired', now);
      if (decision === 'reject') return this.#settle(id, 'rejected', now);
      const proposal = this.#proposal(row, now, true);
      const currentRow = this.#entryRow(proposal.targetId);
      if ((currentRow?.revision ?? null) !== proposal.baseRevision) return this.#settle(id, 'conflict', now);
      const plan = this.#planRevision(proposal, currentRow);
      const valid = this.#verifyDecisionCheck(check, [proposal], proposal);
      if (check) {
        now = this.#stamp();
        if (row.expires_at <= now) return this.#settle(id, 'expired', now);
        if (!valid) return this.#settle(id, 'conflict', now);
      }
      if (plan.state === 'applied') {
        if (!this.#writeHead(proposal, plan.revision, now)) return this.#settle(id, 'conflict', now);
        this.#writeRevision(proposal, plan.revision, now, this.#settings().maxHistory);
      }
      return this.#settle(id, plan.state, now, plan.revision);
    });
  }

  decideBatch(input) {
    const { id, digest, decision, check } = object(input, 'batch decision');
    text(id, 'batch.id', 512);
    text(digest, 'digest', 512);
    oneOf(decision, 'decision', ['approve', 'reject']);
    if (check !== undefined && typeof check !== 'function') invalid('check must be a synchronous boolean function.');
    return this.#write(() => {
      const row = this.#batchRow(id);
      if (!row) throw new StorageError('NOT_FOUND', 'Proposal batch not found.');
      if (row.digest !== digest) throw new StorageError('DIGEST_MISMATCH', 'The decision does not match the batch preview.');
      let now = this.#stamp();
      const batch = this.#batchView(row, now, true);
      if (row.state) return batch;
      if (row.expires_at <= now) return this.#settleBatch(batch, 'expired', now);
      if (decision === 'reject') return this.#settleBatch(batch, 'rejected', now);
      this.#verifyBatchSnapshot(row, batch);
      const { items } = batch;
      const currentRows = items.map(item => this.#entryRow(item.targetId));
      if (items.some((item, i) => (currentRows[i]?.revision ?? null) !== item.baseRevision)) {
        return this.#settleBatch(batch, 'conflict', now);
      }
      const plans = items.map((item, i) => this.#planRevision(item, currentRows[i]));
      const valid = this.#verifyDecisionCheck(check, items, batch);
      now = this.#stamp();
      if (row.expires_at <= now) return this.#settleBatch(batch, 'expired', now);
      if (!valid) return this.#settleBatch(batch, 'conflict', now);

      const changed = items.map((item, i) => ({ item, ...plans[i] })).filter(plan => plan.state === 'applied');
      const maxHistory = this.#settings().maxHistory;
      // Deferred head foreign keys let members relate to entries created later in the batch.
      // The savepoint also lets a late conflict or expiration settle without committing any heads.
      this.#db.exec('SAVEPOINT apply_batch');
      const updated = changed.every(({ item, revision }) => this.#writeHead(item, revision, now));
      if (updated) for (const { item, revision } of changed) this.#writeRevision(item, revision, now, maxHistory);
      const completedAt = this.#stamp();
      if (!updated || row.expires_at <= completedAt) {
        this.#db.exec('ROLLBACK TO apply_batch; RELEASE apply_batch');
        return this.#settleBatch(batch, row.expires_at <= completedAt ? 'expired' : 'conflict', completedAt);
      }
      this.#db.exec('RELEASE apply_batch');
      return this.#settleBatch(batch, changed.length ? 'applied' : 'no_change', completedAt, plans);
    });
  }

  #settings() {
    const row = this.#db.prepare('SELECT max_history, stale_after_days, revision FROM library_settings WHERE singleton = 1').get();
    return { maxHistory: row.max_history, staleAfterDays: row.stale_after_days, revision: row.revision };
  }

  settings() { return this.#snapshot(() => this.#settings()); }

  #settingsInput(input) {
    const { maxHistory, staleAfterDays, expectedRevision } = object(input, 'settings');
    return {
      maxHistory: integer(maxHistory, 'maxHistory', 1),
      staleAfterDays: integer(staleAfterDays, 'staleAfterDays', 1, Math.floor(Number.MAX_SAFE_INTEGER / DAY)),
      expectedRevision: integer(expectedRevision, 'expectedRevision', 1),
    };
  }

  #preview(current, input) {
    if (current.revision !== input.expectedRevision) {
      throw new StorageError('SETTINGS_CONFLICT', 'The settings revision changed; preview again.');
    }
    const digest = createHash('sha256').update(JSON.stringify([this.#libraryUuid, input]));
    let trimCount = 0;
    if (input.maxHistory < current.maxHistory) {
      for (const { entry_id, revision } of this.#db.prepare(
        'SELECT r.entry_id, r.revision ' + TRIMMABLE + ' ORDER BY r.entry_id, r.revision',
      ).iterate(input.maxHistory)) {
        digest.update(JSON.stringify([entry_id, revision]));
        trimCount++;
      }
    }
    return { trimCount, token: digest.digest('hex') };
  }

  previewSettings(input) {
    const options = this.#settingsInput(input);
    return this.#snapshot(() => this.#preview(this.#settings(), options));
  }

  saveSettings(input) {
    const options = this.#settingsInput(input);
    const previewToken = text(input.previewToken, 'previewToken', 512);
    return this.#write(() => {
      const current = this.#settings();
      const preview = this.#preview(current, options);
      if (preview.token !== previewToken) throw new StorageError('SETTINGS_CONFLICT', 'The trim preview changed; preview again.');
      if (current.maxHistory === options.maxHistory && current.staleAfterDays === options.staleAfterDays) return current;
      const revision = integer(current.revision + 1, 'settings revision', 1);
      const updated = this.#db.prepare(`UPDATE library_settings SET max_history = ?, stale_after_days = ?, revision = ?
        WHERE singleton = 1 AND revision = ?`).run(options.maxHistory, options.staleAfterDays, revision, options.expectedRevision);
      if (updated.changes !== 1) throw new StorageError('SETTINGS_CONFLICT', 'The settings revision changed; preview again.');
      if (preview.trimCount) {
        const trimmed = this.#db.prepare(`DELETE FROM entry_revision WHERE revision <
          (SELECT e.current_revision FROM entry AS e WHERE e.id = entry_revision.entry_id) - ?`).run(options.maxHistory);
        if (trimmed.changes !== preview.trimCount) throw new StorageError('SETTINGS_CONFLICT', 'The trim preview changed; preview again.');
      }
      this.#db.prepare('INSERT INTO settings_audit VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        revision, this.#stamp(), current.maxHistory, options.maxHistory,
        current.staleAfterDays, options.staleAfterDays, preview.trimCount,
      );
      return this.#settings();
    });
  }

  metrics() {
    const now = this.#stamp();
    this.#reapIfDue(now);
    return this.#snapshot(() => {
      const counts = { active: 0, invalid: 0, archived: 0 };
      for (const row of this.#db.prepare(`SELECT status, count(*) AS n ${ENTRY_SELECT}
        WHERE r.revision = e.current_revision GROUP BY status`).all()) counts[row.status] = row.n;
      const historyCount = this.#db.prepare(`SELECT count(*) AS n ${ENTRY_SELECT} WHERE r.revision < e.current_revision`).get().n;
      const pendingCount = this.#db.prepare(`SELECT
        (SELECT count(*) FROM proposal AS p WHERE p.expires_at > ? AND ${STANDALONE}
          AND NOT EXISTS (SELECT 1 FROM proposal_decision AS d WHERE d.proposal_id = p.id)) +
        (SELECT count(*) FROM proposal_batch AS b WHERE b.expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM proposal_batch_decision AS d WHERE d.batch_id = b.id)) AS n`).get(now, now).n;
      const decisions = Object.fromEntries(OUTCOMES.map(state => [state, 0]));
      for (const row of this.#db.prepare(`SELECT d.state, count(*) AS n FROM proposal_decision AS d
        JOIN proposal AS p ON p.id = d.proposal_id WHERE ${STANDALONE} GROUP BY d.state
        UNION ALL SELECT state, count(*) AS n FROM proposal_batch_decision GROUP BY state`).all()) {
        decisions[row.state] += row.n;
      }
      decisions.expired += this.#db.prepare('SELECT count(*) AS n ' + EXPIRABLE).get(now).n
        + this.#db.prepare('SELECT count(*) AS n ' + EXPIRABLE_BATCH).get(now).n;
      const fileBytes = this.#file === ':memory:' ? 0 : ['', '-wal', '-shm'].reduce((size, suffix) => size + fileSize(this.#file + suffix), 0);
      return { counts, historyCount, pendingCount, decisions, fileBytes };
    });
  }

  #copyExport(source, destination) {
    const tables = [
      ['library_meta', ['singleton', 'library_uuid', 'scope']],
      ['entry', ['id', 'current_revision', 'created_at']],
      ['entry_revision', REVISION_COLUMNS],
      ...PUBLIC_LISTS.map(key => ['revision_' + LISTS[key].table, ['entry_id', 'revision', ...LISTS[key].cols]]),
    ];
    destination.exec('BEGIN IMMEDIATE');
    try {
      destination.exec(contentSchema(false));
      for (const [table, columns] of tables) {
        const write = insertStatement(destination, table, columns);
        for (const row of source.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).iterate()) {
          write.run(...columns.map(column => row[column]));
        }
      }
      destination.exec(`PRAGMA application_id = ${EXPORT_APPLICATION_ID}; PRAGMA user_version = ${EXPORT_SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      try { destination.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  exportTo(targetFile) {
    this.#ensureIdle();
    text(targetFile, 'targetFile', 8192);
    if (targetFile === ':memory:') invalid('The export requires a real file path.');
    const target = resolve(targetFile);
    let staging;
    try {
      exportTargetFree(target);
      staging = mkdtempSync(join(dirname(target), '.dsh-library-export-'));
      const part = join(staging, 'snapshot.sqlite');
      privateFile(part);
      const destination = new DatabaseSync(part);
      try {
        destination.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
        if (this.#file === ':memory:') {
          this.#snapshot(() => this.#copyExport(this.#db, destination));
        } else {
          const source = new DatabaseSync(this.#file, { readOnly: true });
          try {
            source.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; BEGIN;`);
            this.#copyExport(source, destination);
            source.exec('COMMIT');
          } finally { source.close(); }
        }
      } finally { destination.close(); }
      const verify = new DatabaseSync(part, { readOnly: true });
      try {
        const health = verify.prepare('PRAGMA integrity_check').all();
        if (health.length !== 1 || health[0].integrity_check !== 'ok' || verify.prepare('PRAGMA foreign_key_check').get()) {
          throw new StorageError('EXPORT_ERROR', 'The independent SQLite snapshot did not pass integrity checks.');
        }
      } finally { verify.close(); }
      exportTargetFree(target);
      // A same-filesystem hard link publishes the completed file without ever overwriting a path.
      linkSync(part, target);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (error?.code === 'EEXIST') throw new StorageError('EXPORT_EXISTS', 'The export path already exists.', error);
      const mapped = sqlError(error);
      if (mapped instanceof StorageError && mapped.code === 'BUSY_RETRY') throw mapped;
      throw new StorageError('EXPORT_ERROR', 'Could not create the independent SQLite snapshot.', error);
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
    }
  }

  close() {
    if (this.#closed) return;
    this.#ensureIdle();
    this.#db.close();
    this.#closed = true;
  }
}
