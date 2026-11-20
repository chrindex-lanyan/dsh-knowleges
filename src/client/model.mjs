export const ENTRY_STATES = { active: '有效', invalid: '失效', archived: '归档' }
export const PROPOSAL_KINDS = { create: '新增', update: '编辑', invalidate: '标记失效', archive: '归档', restore: '恢复', promote: '提炼至全局' }
export const PROPOSAL_STATES = {
  pending: '待审核', applied: '已应用', approved: '已批准', rejected: '已拒绝',
  expired: '已过期', conflict: '版本冲突', no_change: '无实际变更', cancelled: '已取消',
}
export const EVIDENCE_KINDS = { text: '文字', url: '网址', file: '文件引用', session: '会话引用' }
export const RELATION_TYPES = { related: '相关', supersedes: '替代', duplicates: '重复' }
const STATE_AFTER = { invalidate: 'invalid', archive: 'archived', restore: 'active' }
const CHANGE_FIELDS = [
  ['status', '状态'], ['title', '标题'], ['detail', '详情'], ['tags', '标签'],
  ['confidence', '置信度'], ['evidence', '证据'], ['relations', '关联'],
]
const list = value => Array.isArray(value) ? value : []
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export function displayTime(value) {
  if (value == null || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : time.format(date)
}

export function displayBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  for (const [power, unit] of [[3, 'GiB'], [2, 'MiB'], [1, 'KiB']]) {
    const divisor = 1024 ** power
    if (value >= divisor) return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value / divisor) + ' ' + unit
  }
  return String(value) + ' B'
}

export function libraryLabel(library) {
  return library.scope === 'global' || library.key === 'global'
    ? '全局资料库'
    : '工作区 · ' + (library.title || library.workspaceId || '未命名')
}

export function selectedLibrary(libraries, key) {
  return libraries.find(library => library.key === key)
    ?? libraries.find(library => library.key === 'global') ?? libraries[0]
}

export function asEntryQuery(filters, offset, limit) {
  const q = filters.q.trim()
  const tag = filters.tag.trim()
  return { ...(q && { q }), ...(tag && { tag }), status: filters.status,
    ...(filters.staleOnly && filters.status !== 'candidates' && { staleOnly: true }), offset, limit }
}

export function initialEditor(entry) {
  return {
    title: entry?.title ?? '', detail: entry?.detail ?? '',
    confidence: entry?.confidence == null ? '' : String(entry.confidence),
    tags: [...list(entry?.tags)],
    evidence: list(entry?.evidence).map(item => ({ ...item, reference: item.reference ?? '' })),
    relations: list(entry?.relations).map(item => ({ ...item })),
  }
}

/** Only editable fields are projected. Never sends status, sources, or IDs in the draft. */
export function asEditorDraft(form, metadataOnly) {
  const title = form.title.trim()
  if (!title || Array.from(title).length > 200) throw new Error('标题须为 1–200 字。')
  const raw = form.confidence.trim()
  const confidence = raw === '' ? null : Number(raw)
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error('置信度须在 0–1 之间；留空表示未评估。')
  }
  const tags = form.tags.map(tag => tag.trim()).filter(Boolean)
  if (tags.length > 30) throw new Error('条目最多可有 30 个标签。')
  const metadata = { title, tags, confidence }
  if (metadataOnly) return metadata
  if (new TextEncoder().encode(form.detail).length > 64 * 1024) throw new Error('详情最多 64 KiB。')
  if (form.evidence.length > 50 || form.relations.length > 50) throw new Error('证据和关联各最多 50 项。')
  const evidence = form.evidence.map(({ kind, label, note, reference }) => ({
    kind, label: label.trim(), note, reference: kind === 'text' ? null : reference?.trim() || null,
  }))
  for (const item of evidence) {
    if (!Object.hasOwn(EVIDENCE_KINDS, item.kind) || !item.label || (item.kind !== 'text' && !item.reference)) {
      throw new Error('每条证据必须有名称；非文字证据还需提供引用。')
    }
  }
  const relations = form.relations.map(({ type, targetId }) => ({ type, targetId: targetId.trim() }))
  for (const item of relations) {
    if (!Object.hasOwn(RELATION_TYPES, item.type) || !item.targetId) throw new Error('请填写关联条目的 UUID，或移除空行。')
  }
  return { ...metadata, detail: form.detail, evidence, relations }
}

export function settingsInput(settings, form) {
  const parse = (value, label, max) => {
    const text = String(value).trim()
    const number = Number(text)
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1) throw new Error(label + '必须是正整数。')
    if (number > max) throw new Error(label + '不能超过 ' + max + '。')
    return number
  }
  return {
    maxHistory: parse(form.maxHistory, '历史上限', 1000),
    staleAfterDays: parse(form.staleAfterDays, '旧条目阈值', 3650),
    expectedRevision: settings.revision,
  }
}

function comparable(field, value) {
  if (field === 'tags') return [...list(value)].sort()
  if (field === 'evidence') return list(value).map(({ kind, label, note, reference }) => [kind, label, note, reference ?? null])
  if (field === 'relations') return list(value).map(({ type, targetId }) => [type, targetId])
  return value ?? null
}

function completeEntry(entry) {
  return record(entry) && Object.hasOwn(ENTRY_STATES, entry.status)
    && typeof entry.title === 'string' && typeof entry.detail === 'string'
    && (entry.confidence === null || (Number.isFinite(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 1))
    && Array.isArray(entry.tags) && entry.tags.every(tag => typeof tag === 'string')
    && Array.isArray(entry.evidence) && entry.evidence.every(item => record(item) && Object.hasOwn(EVIDENCE_KINDS, item.kind)
      && typeof item.label === 'string' && typeof item.note === 'string'
      && (item.reference === null || typeof item.reference === 'string'))
    && Array.isArray(entry.relations) && entry.relations.every(item => record(item) && Object.hasOwn(RELATION_TYPES, item.type)
      && typeof item.targetId === 'string' && item.targetId !== '')
}

export function sourceEntryQuery(source) {
  if (typeof source?.workspaceId !== 'string' || !source.workspaceId
    || typeof source?.entryId !== 'string' || !source.entryId
    || !Number.isSafeInteger(source.revision) || source.revision < 1) return null
  return { library: 'workspace:' + source.workspaceId, id: source.entryId, revision: source.revision }
}

/** Derive a read-only preview from the server's immutable draft and exact baseline. */
export function inspectProposal(proposal, before) {
  const kind = proposal.kind
  const draft = record(proposal.draft) ? proposal.draft : null
  const needsBefore = (kind !== 'create' && kind !== 'promote') || Number(proposal.baseRevision) > 0
  const hasBaseline = needsBefore
    ? completeEntry(before) && before.revision === proposal.baseRevision && before.id === proposal.targetId
    : before == null
  let after = null
  if (kind === 'create' || kind === 'promote' || kind === 'update') {
    if (draft) after = { ...(before ?? { status: 'active' }), ...draft }
  } else if (Object.hasOwn(STATE_AFTER, kind) && before) {
    after = { ...before, status: STATE_AFTER[kind], ...(draft ?? {}) }
  }
  const previousSources = list(before?.sources)
  const sources = list(draft?.sources ?? proposal.sources ?? before?.sources)
  const sourceKey = values => JSON.stringify(values.map(source => [source?.workspaceId, source?.entryId, source?.revision]))
  const sourceChanged = sourceKey(previousSources) !== sourceKey(sources)
  const hasSources = sources.length > 0 && sources.every(source => typeof source?.workspaceId === 'string' && source.workspaceId
    && typeof source.entryId === 'string' && source.entryId && Number.isSafeInteger(source.revision) && source.revision > 0)
  const complete = hasBaseline && completeEntry(after) && (kind !== 'promote' || hasSources)
  const changes = complete ? CHANGE_FIELDS.flatMap(([field, label]) => {
    const oldValue = before?.[field] ?? null
    const newValue = after[field] ?? null
    if (before && JSON.stringify(comparable(field, oldValue)) === JSON.stringify(comparable(field, newValue))) return []
    return [{ field, label, before: oldValue, after: newValue }]
  }) : []
  return { after, changes, sources, previousSources, sourceChanged, complete }
}
export const BATCH_LIMIT = 20
const BATCH_DRAFT_BYTES = 224 * 1024
export const BATCH_STATUS_KINDS = ['invalidate', 'archive', 'restore']

export function proposalReason(value, required) {
  const explanation = value.trim()
  if (required && !explanation) throw new Error('请填写整理理由，以供审核。')
  if (new TextEncoder().encode(explanation).length > 4000) throw new Error('变更理由超出 4000 字节。')
  return explanation
}

function isWorkspaceKey(key) {
  return typeof key === 'string' && key.startsWith('workspace:') && key.length > 'workspace:'.length
}

export function batchStatusAllowed(kind, entry) {
  if (!entry || !Object.hasOwn(ENTRY_STATES, entry.status)) return false
  switch (kind) {
    case 'invalidate': return entry.status === 'active'
    case 'archive': return entry.status !== 'archived'
    case 'restore': return entry.status !== 'active'
    default: return false
  }
}

export function batchStageInput(library, kind, rows, reason) {
  if (library !== 'global' && !isWorkspaceKey(library)) throw new Error('请选择一个有效的资料库。')
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > BATCH_LIMIT) {
    throw new Error('一组批量提案须包含 1–' + BATCH_LIMIT + ' 项。')
  }
  const explanation = proposalReason(reason, kind === 'invalidate' || kind === 'archive')
  const withReason = explanation ? { reason: explanation } : {}
  let items
  if (kind === 'create') {
    if (!isWorkspaceKey(library)) throw new Error('不能直接向全局资料库批量新增。')
    items = rows.map((form, i) => {
      try { return { kind, draft: asEditorDraft(form, false) } } catch (error) {
        throw new Error('草稿 ' + (i + 1) + '：' + error.message)
      }
    })
  } else {
    if (!BATCH_STATUS_KINDS.includes(kind)) throw new Error('不支持该批量整理操作。')
    const seen = new Set()
    items = rows.map(entry => {
      if (entry?.library !== library || typeof entry.id !== 'string' || !entry.id
        || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || seen.has(entry.id)) {
        throw new Error('批量整理须使用同库、不重复且带基准版本的条目。')
      }
      if (!batchStatusAllowed(kind, entry)) throw new Error('所选条目状态不一致，无法全部执行该操作。')
      seen.add(entry.id)
      return { kind, targetId: entry.id, baseRevision: entry.revision, ...withReason }
    })
  }
  if (new TextEncoder().encode(JSON.stringify(items)).length > BATCH_DRAFT_BYTES) {
    throw new Error('批量草稿总大小超过 224 KiB，请分批提交。')
  }
  return { library, ...withReason, items }
}

function isBatchMember(proposal, batchId, library) {
  return record(proposal) && typeof proposal.id === 'string' && proposal.id !== ''
    && typeof proposal.targetId === 'string' && proposal.targetId !== ''
    && Object.hasOwn(PROPOSAL_KINDS, proposal.kind)
    && (proposal.batchId == null || proposal.batchId === batchId)
    && (proposal.library == null || proposal.library === library)
    && (proposal.kind === 'create' || proposal.kind === 'promote' ? proposal.baseRevision == null
      || (proposal.kind === 'promote' && Number.isSafeInteger(proposal.baseRevision) && proposal.baseRevision > 0)
      : Number.isSafeInteger(proposal.baseRevision) && proposal.baseRevision > 0)
}

/** A batch can only be applied if there is one unambiguous preview per declared member. */
export function inspectBatch(review, library) {
  const batch = review?.batch
  const rows = list(review?.items)
  const previews = []
  const byId = new Map()
  const targets = new Set()
  let complete = typeof batch?.id === 'string' && batch.id !== ''
    && (batch.library == null || batch.library === library)
    && Number.isSafeInteger(batch.itemCount) && batch.itemCount >= 1 && batch.itemCount <= BATCH_LIMIT
    && rows.length === batch.itemCount
  for (const row of rows.slice(0, BATCH_LIMIT)) {
    const proposal = row?.proposal
    if (!isBatchMember(proposal, batch?.id, library)) {
      complete = false
      continue
    }
    if (byId.has(proposal.id) || targets.has(proposal.targetId)) complete = false
    byId.set(proposal.id, proposal)
    targets.add(proposal.targetId)
    const before = row.before
    const preview = inspectProposal(proposal, before)
    const draft = proposal.draft
    if (proposal.state !== 'pending' || !preview.complete || !completeEntry(draft)
      || !Object.hasOwn(row, 'before') || (proposal.baseRevision == null ? before !== null : !completeEntry(before))
      || (library === 'global' && (!Array.isArray(draft.sources)
        || !draft.sources.every(source => sourceEntryQuery(source) !== null)))) complete = false
    previews.push({ proposal, before, preview })
  }
  if (batch?.items !== undefined) {
    const memberIds = new Set()
    if (!Array.isArray(batch.items) || batch.items.length !== rows.length) complete = false
    for (const member of list(batch.items).slice(0, BATCH_LIMIT)) {
      const actual = byId.get(member?.id)
      if (!actual || memberIds.has(member?.id) || actual.targetId !== member.targetId || actual.kind !== member.kind
        || actual.baseRevision !== member.baseRevision || (member.digest != null && actual.digest !== member.digest)) complete = false
      memberIds.add(member?.id)
    }
  }
  return { complete, previews }
}

export function globalReadAccess(value) {
  const globalOnly = rows => list(rows).filter(item => item?.library === 'global')
  return { requests: globalOnly(value?.requests), grants: globalOnly(value?.grants) }
}

export function hasBatchIdentity(review, library) {
  const batch = review?.batch
  return (library === 'global' || isWorkspaceKey(library)) && batch?.state === 'pending'
    && typeof batch.id === 'string' && batch.id !== ''
    && (batch.library == null || batch.library === library)
    && typeof batch.digest === 'string' && batch.digest !== ''
}

export function batchDecisionInput(library, review, decision) {
  if (!hasBatchIdentity(review, library) || !['approve', 'reject'].includes(decision)) {
    throw new Error('批次缺少有效确认摘要或已处理。请刷新队列。')
  }
  if (decision === 'approve' && !inspectBatch(review, library).complete) {
    throw new Error('需核对全部成员的基准版本和草稿，才能应用整组变更。')
  }
  return { library, id: review.batch.id, digest: review.batch.digest, decision }
}
