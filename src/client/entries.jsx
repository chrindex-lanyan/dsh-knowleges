import { useState } from 'react'
import { BatchEditor, DraftFields, useProposalSubmission } from './editor.jsx'
import {
  asEditorDraft, asEntryQuery, BATCH_LIMIT, BATCH_STATUS_KINDS, batchStatusAllowed, ENTRY_STATES,
  initialEditor, libraryLabel, proposalReason, PROPOSAL_KINDS,
} from './model.mjs'
import { DateValue, ErrorNotice, labelOf, Notice, Pager, QueryStatus, Sources, useQuery } from './shared.jsx'
import { BatchReviewCard, EntryContent, ReviewCard } from './review.jsx'

const ENTRY_PAGE = 20
const HISTORY_PAGE = 12
const DEFAULT_FILTER = { q: '', tag: '', status: 'active', staleOnly: false }
function Editor({ api, library, kind, entry, onStaged, onCancel }) {
  const editingContent = kind === 'create' || kind === 'update'
  const metadataOnly = library.key === 'global'
  const needsReason = kind === 'invalidate' || kind === 'archive'
  const [form, setForm] = useState(() => initialEditor(entry))
  const [reason, setReason] = useState('')
  const action = useProposalSubmission(api, 'stage', onStaged)
  function submit(event) {
    event.preventDefault()
    return action.submit(() => {
      const explanation = proposalReason(reason, needsReason)
      return {
        library: library.key, kind,
        ...(entry && { targetId: entry.id, baseRevision: entry.revision }),
        ...(editingContent && { draft: asEditorDraft(form, metadataOnly) }),
        ...(explanation && { reason: explanation }),
      }
    })
  }
  return <form className="kl-card kl-stack" onSubmit={submit} aria-label="生成编辑提案">
    <div className="kl-bar kl-bar--between"><h2>{labelOf(PROPOSAL_KINDS, kind)}提案</h2><span className="kl-pill">{libraryLabel(library)}</span></div>
    {entry && <p className="kl-muted kl-text">基准：{entry.title} · v{entry.revision} · {labelOf(ENTRY_STATES, entry.status)}</p>}
    {metadataOnly && kind === 'update' && <Notice>全局条目只允许手动修订标题措辞、标签、置信度或状态；正文、证据和关联需由会话重新提炼。</Notice>}
    <fieldset className="kl-stack" disabled={action.pending}>
      {editingContent && <DraftFields form={form} onChange={setForm} metadataOnly={metadataOnly} />}
      <label className="kl-field">变更理由（{needsReason ? '必填' : '选填'}） <textarea className="kl-fill" rows={2} required={needsReason} maxLength={4000} value={reason} onChange={event => setReason(event.target.value)} /></label>
    </fieldset>
    <ErrorNotice error={action.error} />
    <div className="kl-bar">
      <button className="kl-primary" type="submit" disabled={action.pending}>{action.pending ? '正在生成…' : '生成差异提案'}</button>
      <button type="button" disabled={action.pending} onClick={onCancel}>取消</button>
    </div>
    <p className="kl-muted">生成提案不会改动正式条目，仍需阅读差异并确认应用。</p>
  </form>
}

function HistoryPane({ api, library, id, selected, select }) {
  const [offset, setOffset] = useState(0)
  const query = useQuery(api, 'history', { library: library.key, id, offset, limit: HISTORY_PAGE })
  return <section className="kl-card kl-stack" aria-label="历史版本">
    <h3>版本记录</h3>
    <QueryStatus query={query}>{value => <>
      {value?.items?.length ? <ul className="kl-list">{value.items.map(item => <li key={item.revision}>
        <button className="kl-list-button" aria-current={selected === item.revision} type="button" onClick={() => select(item.revision)}>
          <span>版本 v{item.revision}{item.status && ' · ' + labelOf(ENTRY_STATES, item.status)}</span>
          <span className="kl-muted"><DateValue value={item.updatedAt} /></span>
        </button>
      </li>)}</ul> : <p className="kl-muted">没有保留的历史版本。</p>}
      <Pager offset={offset} limit={HISTORY_PAGE} hasMore={value?.hasMore} onOffset={setOffset} name="版本记录分页" />
    </>}</QueryStatus>
  </section>
}

function EntryInspector({ api, library, id, onEdit, onRelation }) {
  const [revision, selectRevision] = useState(undefined)
  const [showHistory, setShowHistory] = useState(false)
  const query = useQuery(api, 'entry', { library: library.key, id, ...(revision !== undefined && { revision }) })
  return <section className="kl-card kl-stack" aria-label="资料条目详情">
    <div className="kl-bar kl-bar--between">
      <h2>{revision === undefined ? '条目详情' : '历史快照 v' + revision}</h2>
      <div className="kl-bar">
        {revision !== undefined && <button type="button" onClick={() => selectRevision(undefined)}>返回当前版</button>}
        <button type="button" aria-expanded={showHistory} onClick={() => setShowHistory(show => !show)}>{showHistory ? '隐藏历史' : '查阅历史'}</button>
      </div>
    </div>
    <QueryStatus query={query}>{entry => entry?.id === id ? <>
      <h3 className="kl-list-title">{entry.title}</h3>
      <div className="kl-meta kl-muted">UUID <code>{entry.id}</code> · v{entry.revision}<br />更新时间：<DateValue value={entry.updatedAt} /></div>
      <EntryContent entry={entry} onRelation={onRelation} />
      <Sources api={api} items={entry.sources} />
      {revision === undefined && <div className="kl-bar">
        {entry.status !== 'archived' && <button type="button" onClick={() => onEdit('update', entry)}>编辑</button>}
        {entry.status === 'active' && <button type="button" onClick={() => onEdit('invalidate', entry)}>标失效</button>}
        {entry.status !== 'archived' && <button type="button" onClick={() => onEdit('archive', entry)}>归档</button>}
        {entry.status !== 'active' && <button type="button" onClick={() => onEdit('restore', entry)}>恢复</button>}
      </div>}
    </> : <Notice warning>未能读取此条目或版本。</Notice>}</QueryStatus>
    {showHistory && <HistoryPane api={api} library={library} id={id} selected={revision} select={selectRevision} />}
  </section>
}

export function EntriesPane({ api, library }) {
  const [filter, setFilter] = useState(DEFAULT_FILTER)
  const [search, setSearch] = useState(DEFAULT_FILTER)
  const [offset, setOffset] = useState(0)
  const [selected, select] = useState(null)
  const [workflow, setWorkflow] = useState(null)
  const [organizing, setOrganizing] = useState(false)
  const [selection, setSelection] = useState([])
  const selectedIds = new Set(selection.map(entry => entry.id))
  const query = useQuery(api, 'entries', { library: library.key, query: asEntryQuery(search, offset, ENTRY_PAGE) })
  const set = (key, value) => setFilter(previous => ({ ...previous, [key]: value }))
  const edit = (kind, entry) => setWorkflow({ type: 'edit', kind, entry })
  const editBatch = kind => setWorkflow({ type: 'batch-edit', kind, selection })
  const clearWorkflow = () => setWorkflow(null)
  function toggleEntry(entry) {
    setSelection(rows => rows.some(row => row.id === entry.id)
      ? rows.filter(row => row.id !== entry.id)
      : rows.length < BATCH_LIMIT ? [...rows, { id: entry.id, revision: entry.revision, title: entry.title, status: entry.status, library: library.key }] : rows)
  }
  function resolveBatch() {
    setSelection([])
    query.reload()
  }
  function resolve(proposal) {
    if (proposal?.state === 'applied' && proposal.targetId) select(proposal.targetId)
    query.reload()
  }
  return <section className="kl-stack" aria-label="浏览资料库">
    <div className="kl-bar kl-bar--between">
      <h2>条目</h2>
      <div className="kl-bar">
        <button type="button" onClick={query.reload} disabled={query.status === 'loading'}>刷新条目</button>
        {library.key !== 'global' && <>
          <button type="button" className="kl-primary" onClick={() => edit('create')} disabled={!!workflow}>新增条目</button>
          <button type="button" onClick={() => editBatch('create')} disabled={!!workflow}>批量新增</button>
        </>}
        <button type="button" aria-pressed={organizing} onClick={() => {
          if (organizing) setSelection([])
          setOrganizing(value => !value)
        }} disabled={!!workflow}>{organizing ? '退出批量整理' : '批量整理'}</button>
      </div>
    </div>
    {library.key === 'global' && <p className="kl-muted">全局条目由会话从工作区提炼后发布，不能人工直接新增。</p>}
    <form className="kl-card kl-stack" onSubmit={event => { event.preventDefault(); setSearch(filter); setOffset(0); query.reload() }} aria-label="搜索资料">
      <div className="kl-grid">
        <label className="kl-field">标题或详情 <input type="search" value={filter.q} placeholder="输入关键词" onChange={event => set('q', event.target.value)} /></label>
        <label className="kl-field">标签 <input type="search" value={filter.tag} placeholder="按标签筛选" onChange={event => set('tag', event.target.value)} /></label>
      </div>
      <div className="kl-bar">
        <label>状态 <select value={filter.status} onChange={event => set('status', event.target.value)}>
          {Object.entries(ENTRY_STATES).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
          <option value="all">全部状态</option><option value="candidates">旧或失效候选</option>
        </select></label>
        <label><input type="checkbox" checked={filter.staleOnly && filter.status !== 'candidates'} disabled={filter.status === 'candidates'} onChange={event => set('staleOnly', event.target.checked)} /> 仅旧条目</label>
        <button className="kl-primary" type="submit">搜索</button>
        <button type="button" onClick={() => { setFilter(DEFAULT_FILTER); setSearch(DEFAULT_FILTER); setOffset(0); query.reload() }}>重置</button>
      </div>
    </form>
    {search.status === 'candidates' && <p className="kl-muted">显示已失效或距上次更新超过本库阈值的候选。候选不会自动删改。</p>}
    {organizing && <section className="kl-card kl-stack" aria-label="同库批量整理">
      <div className="kl-bar kl-bar--between"><h3>已选 {selection.length}/{BATCH_LIMIT} 项</h3>
        <button type="button" onClick={() => setSelection([])} disabled={!!workflow || !selection.length}>清空选择</button>
      </div>
      <p className="kl-muted">只对当前库操作；切换筛选或页码保留选择及当时的版本。只有全部条目都支持的操作才可生成提案。</p>
      {selection.length > 0 && <div className="kl-bar">{selection.map(entry => <button type="button" key={entry.id} disabled={!!workflow}
        onClick={() => toggleEntry(entry)} aria-label={'取消选择 ' + entry.title + ' v' + entry.revision}>
        <span className="kl-text">{entry.title} · v{entry.revision} ×</span>
      </button>)}</div>}
      <div className="kl-bar">{BATCH_STATUS_KINDS.map(kind => <button type="button" key={kind}
        disabled={!!workflow || selection.length === 0 || !selection.every(entry => batchStatusAllowed(kind, entry))}
        onClick={() => editBatch(kind)}>批量{labelOf(PROPOSAL_KINDS, kind)}</button>)}</div>
    </section>}
    <div className="kl-grid">
      <section className="kl-card kl-stack" aria-label="条目搜索结果">
        <QueryStatus query={query}>{value => <>
          {value?.items?.length > 0 ? <ul className="kl-list">{value.items.map(item => <li key={item.id} className={organizing ? 'kl-batch-result' : undefined}>
            {organizing && <input type="checkbox" checked={selectedIds.has(item.id)}
              disabled={!!workflow || (!selectedIds.has(item.id) && selection.length >= BATCH_LIMIT)}
              aria-label={'选择 ' + item.title + ' v' + item.revision} onChange={() => toggleEntry(item)} />}
            <button className="kl-list-button" type="button" disabled={!!workflow} aria-current={selected === item.id} onClick={() => select(item.id)}>
              <span className="kl-list-title">{item.title}</span>
              <span className="kl-muted kl-text">标签：{item.tags?.length ? item.tags.join('、') : '无标签'}</span>
              <span className="kl-muted">{labelOf(ENTRY_STATES, item.status)} · v{item.revision} · <DateValue value={item.updatedAt} /></span>
            </button>
          </li>)}</ul> : <p className="kl-muted">没有符合条件的条目。</p>}
          <Pager offset={offset} limit={ENTRY_PAGE} hasMore={value?.hasMore} onOffset={setOffset} name="条目搜索分页" />
        </>}</QueryStatus>
      </section>
      {workflow?.type === 'edit' && <Editor api={api} library={library} kind={workflow.kind} entry={workflow.entry}
        onStaged={review => setWorkflow({ type: 'review', review })} onCancel={clearWorkflow} />}
      {workflow?.type === 'review' && <ReviewCard api={api} library={library} review={workflow.review} onResolved={resolve} onClose={clearWorkflow} />}
      {workflow?.type === 'batch-edit' && <BatchEditor api={api} library={library} kind={workflow.kind} selection={workflow.selection}
        onStaged={review => setWorkflow({ type: 'batch-review', review })} onCancel={clearWorkflow} />}
      {workflow?.type === 'batch-review' && <BatchReviewCard api={api} library={library} review={workflow.review} onResolved={resolveBatch} onClose={clearWorkflow} />}
      {!workflow && (selected ? <EntryInspector api={api} library={library} id={selected} key={selected} onEdit={edit} onRelation={select} /> :
        <p className="kl-muted">从搜索结果打开一条资料，查看详情和历史。</p>)}
    </div>
  </section>
}
