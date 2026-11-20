import { createHash } from 'node:crypto';

export class KnowledgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new KnowledgeError(code, message);
}

const bad = message => fail('BAD_INPUT', message);
export function object(value, keys, label = '请求') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(label + '必须是对象。');
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad(label + '含有不支持的字段。');
  return value;
}

export function text(value, maxBytes, label, { optional = false, empty = false, trim = true } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    bad(label + '不是有效文本或长度超出限制。');
  }
  const result = trim ? value.trim() : value;
  if (!empty && result.trim() === '') bad(label + '不能为空。');
  return result;
}

export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(label + '不在允许的范围。');
  return value;
}

export function oneOf(value, choices, label) {
  if (!choices.includes(value)) bad(label + '不受支持。');
  return value;
}

export function uuid(value, label = '条目 UUID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    bad(label + '格式无效。');
  }
  return value.toLowerCase();
}

export function identity(value, label) {
  return text(value, 256, label, { trim: false });
}

export function revision(value) {
  return integer(value, 1, Number.MAX_SAFE_INTEGER, '版本');
}

function array(value, cap, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > cap) bad(label + '必须是符合数量限制的列表。');
  return value;
}

export const entryStatuses = ['active', 'invalid', 'archived'];
export const mutationKinds = ['create', 'update', 'invalidate', 'archive', 'restore', 'promote'];
export const activeScope = value => oneOf(value, ['global', 'workspace'], '库范围');

export function page(input = {}) {
  return {
    offset: input.offset === undefined ? 0 : integer(input.offset, 0, 100_000, '偏移量'),
    limit: input.limit === undefined ? 20 : integer(input.limit, 1, 100, '页大小'),
  };
}

export function listQuery(query = {}) {
  const q = object(query, ['q', 'tag', 'status', 'staleOnly', 'limit', 'offset'], '筛选条件');
  if (q.staleOnly !== undefined && typeof q.staleOnly !== 'boolean') bad('旧条目筛选值无效。');
  return {
    ...page(q),
    status: q.status === undefined ? 'active' : oneOf(q.status, [...entryStatuses, 'all', 'candidates'], '状态'),
    q: text(q.q, 500, '搜索关键词', { optional: true, empty: true }),
    tag: text(q.tag, 240, '标签', { optional: true, empty: true }),
    staleOnly: q.staleOnly === true,
  };
}

function normalizeTags(values) {
  const tags = new Map();
  for (const value of array(values, 30, '标签')) {
    const label = text(value, 240, '标签');
    const key = label.normalize('NFKC').toLowerCase();
    if (tags.has(key)) bad('资料包含重复标签。');
    tags.set(key, label);
  }
  return [...tags.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, label]) => label);
}

function normalizeEvidence(values) {
  return array(values, 50, '证据').map(value => {
    object(value, ['kind', 'label', 'note', 'reference'], '证据');
    const kind = oneOf(value.kind, ['text', 'url', 'file', 'session'], '证据类型');
    const label = text(value.label, 480, '证据标题');
    const note = text(value.note, 4096, '证据说明', { optional: true, empty: true });
    let reference = value.reference ?? null;
    if (kind === 'text') {
      if (reference !== null && reference !== '') bad('文本证据不能附加引用位置。');
      reference = null;
    } else {
      reference = text(reference, 2048, '证据引用');
      if (kind === 'url') {
        let url;
        try { url = new URL(reference); } catch { bad('证据网址格式无效。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) bad('证据只接受不含凭据的 HTTP(S) 网址。');
        reference = url.href;
        if (Buffer.byteLength(reference) > 2048) bad('证据网址超出长度限制。');
      }
      if (kind === 'file' && (/[\\:\x00-\x1f]/.test(reference)
        || reference.split('/').some(part => !part || part === '.' || part === '..'))) {
        bad('文件证据只能引用工作区内的相对路径。');
      }
    }
    return { kind, label, note, reference };
  });
}

function normalizeRelations(values, targetId) {
  const seen = new Set();
  return array(values, 50, '关联').map(value => {
    object(value, ['type', 'targetId'], '关联');
    const type = oneOf(value.type, ['related', 'supersedes', 'duplicates'], '关联类型');
    const id = uuid(value.targetId, '关联条目 UUID');
    const key = type + ':' + id;
    if (id === targetId || seen.has(key)) bad('不能自关联或重复添加相同关联。');
    seen.add(key);
    return { type, targetId: id };
  });
}

export function normalizeDraft(input, { targetId, status = 'active', sources = [] } = {}) {
  object(input, ['title', 'detail', 'confidence', 'tags', 'evidence', 'relations', 'status'], '条目草稿');
  if (input.status !== undefined && input.status !== status) bad('请通过专门的整理操作修改条目状态。');
  const title = text(input.title, 800, '标题');
  if ([...title].length > 200) bad('标题最多 200 字。');
  const detail = text(input.detail, 64 * 1024, '详情', { empty: true, trim: false });
  const confidence = input.confidence ?? null;
  if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    bad('置信度必须是 0–1 的数值，或留空。');
  }
  const draft = {
    title, detail, confidence, status,
    tags: normalizeTags(input.tags),
    evidence: normalizeEvidence(input.evidence),
    relations: normalizeRelations(input.relations, targetId),
    sources,
  };
  if (Buffer.byteLength(JSON.stringify(draft)) > 160 * 1024) bad('条目内容超出总大小限制。');
  return draft;
}

export function cloneDraft(entry, status = entry.status) {
  const { title, detail, confidence, tags, evidence, relations, sources } = entry;
  return { title, detail, confidence, tags, evidence, relations, sources, status };
}

export function sourceVersions(values) {
  const seen = new Set();
  const sources = array(values, 20, '来源').map(item => {
    object(item, ['entryId', 'revision'], '来源');
    const entryId = uuid(item.entryId, '来源条目 UUID');
    if (seen.has(entryId)) bad('来源不能重复。');
    seen.add(entryId);
    return { entryId, revision: revision(item.revision) };
  });
  if (sources.length === 0) bad('提炼必须注明至少一个已读的工作区来源。');
  return sources;
}

export function configuration(input) {
  return {
    maxHistory: integer(input.maxHistory, 1, 1000, '旧版本上限'),
    staleAfterDays: integer(input.staleAfterDays, 1, 3650, '旧条目天数'),
    expectedRevision: revision(input.expectedRevision),
  };
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}
