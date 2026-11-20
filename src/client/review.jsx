import { useState } from 'react'
import {
  batchDecisionInput, ENTRY_STATES, hasBatchIdentity, inspectBatch, inspectProposal, libraryLabel, PROPOSAL_KINDS, PROPOSAL_STATES,
} from './model.mjs'
import {
  DateValue, ErrorNotice, EvidenceList, labelOf, Notice, Pager, PlainText, QueryStatus,
  RelationList, Sources, TagList, TagSection, useAction, useQuery,
} from './shared.jsx'

const PAGE = 15

function Value({ field, value, onRelation }) {
  if (field === 'evidence') return <EvidenceList items={value} />
  if (field === 'relations') return <RelationList items={value} onOpen={onRelation} />
  if (field === 'confidence') return <>{value == null ? '未评估' : String(value)}</>
  if (field === 'status') return <>{labelOf(ENTRY_STATES, value)}</>
  if (field === 'tags') return <TagList items={value} />
  return <PlainText value={value} scroll={field === 'detail'} />
}

export function EntryContent({ entry, onRelation }) {
  return <div className="kl-stack">
    <div className="kl-bar">
      <span className="kl-pill">{labelOf(ENTRY_STATES, entry.status)}</span>
      <span className="kl-muted">置信度：<Value field="confidence" value={entry.confidence} /></span>
    </div>
    <TagSection items={entry.tags} />
    <section className="kl-stack"><h3>详情</h3><Value field="detail" value={entry.detail} /></section>
    <section className="kl-stack"><h3>证据</h3><Value field="evidence" value={entry.evidence} /></section>
    <section className="kl-stack"><h3>关联</h3><Value field="relations" value={entry.relations} onRelation={onRelation} /></section>
  </div>
}

function Actor({ actor }) {
  return <span className="kl-text">
    {actor?.kind === 'human' ? '人工' : actor?.kind === 'session' || actor?.kind === 'model' ? '模型会话' : String(actor?.kind ?? '未知')}
    {actor?.sessionId && <> · 会话 <code>{actor.sessionId}</code></>}
    {actor?.agentId && <> · 调用方 <code>{actor.agentId}</code></>}
    {actor?.workspaceId && <> · 工作区 <code>{actor.workspaceId}</code></>}
  </span>
}

function ProposalPreview({ api, library, proposal, before, preview, expandPublic = false }) {
  const PublicFields = expandPublic ? 'section' : 'details'
  const PublicTitle = expandPublic ? 'h3' : 'summary'
  return <>
    <section className="kl-stack"><h3>变更理由</h3><PlainText value={proposal.reason} /></section>
    {preview.complete && <section className="kl-stack" aria-label="变更前后">
      <h3>变更前后</h3>
      {preview.changes.length === 0 ? <p className="kl-muted">{preview.sourceChanged ? '公开字段未变，仅变更来源。' : '没有实际字段变化。'}</p> : preview.changes.map(change => <div key={change.field} className="kl-stack">
        <h4>{change.label}</h4>
        <div className="kl-grid">
          <div className="kl-card kl-stack"><span className="kl-muted">变更前</span>{before ? <Value field={change.field} value={change.before} /> : '—'}</div>
          <div className="kl-card kl-stack"><span className="kl-muted">变更后</span><Value field={change.field} value={change.after} /></div>
        </div>
      </div>)}
    </section>}
    {library.key !== 'global' && preview.complete && !preview.changes.some(change => change.field === 'tags') &&
      <TagSection items={preview.after.tags} />}
    {library.key === 'global' && preview.complete && <PublicFields className="kl-card kl-stack" {...(!expandPublic && proposal.kind === 'promote' && { open: true })}>
      <PublicTitle>全局库将保存的完整内容（不包括私有来源）</PublicTitle>
      <h3 className="kl-text">{preview.after.title}</h3>
      <EntryContent entry={preview.after} />
    </PublicFields>}
    {preview.sourceChanged && before && <Sources api={api} items={preview.previousSources} title="变更前来源" />}
    <Sources api={api} items={preview.sources} title={preview.sourceChanged && before ? '拟使用来源' : undefined} />
  </>
}

export function ReviewCard({ api, library, review, onResolved, onClose }) {
  const { proposal, before } = review
  const preview = inspectProposal(proposal, before)
  const [receipt, setReceipt] = useState(null)
  const action = useAction()
  const state = receipt?.state ?? proposal.state
  const hasDigest = typeof proposal.digest === 'string' && proposal.digest.length > 0
  const batchMember = proposal.batchId != null
  const pending = state === 'pending' && hasDigest && !receipt && !batchMember
  async function decide(decision) {
    if (!pending || (decision === 'approve' && !preview.complete)) return
    const result = await action.run(signal => api.rpc('decide', {
      library: library.key, id: proposal.id, digest: proposal.digest, decision,
    }, signal))
    if (result.ok) {
      setReceipt(result.value ?? { state: 'unknown' })
      onResolved?.(result.value)
    }
  }
  return <article className="kl-card kl-stack" aria-label="提案差异审核">
    <div className="kl-bar kl-bar--between">
      <h2>审核提案 · {labelOf(PROPOSAL_KINDS, proposal.kind)}</h2>
      <span className="kl-pill">{labelOf(PROPOSAL_STATES, state)}</span>
    </div>
    <div className="kl-meta kl-muted">
      <div>目标：{libraryLabel(library)}{proposal.targetId && <> · <code>{proposal.targetId}</code></>}</div>
      <div>提案：<code>{proposal.id}</code> · 基准：{proposal.baseRevision > 0 ? 'v' + proposal.baseRevision : '新条目'}</div>
      <div>发起：<Actor actor={proposal.actor} /></div>
      <div>提交：<DateValue value={proposal.createdAt} /> · 到期：<DateValue value={proposal.expiresAt} /></div>
    </div>
    <ProposalPreview api={api} library={library} proposal={proposal} before={before} preview={preview} />
    {batchMember && <Notice warning>此项属于批量提案，请在批量队列中整组处理。</Notice>}
    {state === 'pending' && !batchMember && (!preview.complete || !hasDigest) && <Notice warning>
      缺少匹配的基准、草稿、来源或确认摘要，不能批准。请刷新后重新生成差异。
    </Notice>}
    {state === 'conflict' && <Notice warning>条目或提炼来源已变更，请从当前版本重新生成提案。</Notice>}
    {receipt && <Notice>
      处理结果：{labelOf(PROPOSAL_STATES, state)}{receipt.resultRevision != null && ' · 结果版本 v' + receipt.resultRevision}。
    </Notice>}
    <ErrorNotice error={action.error} />
    <div className="kl-bar">
      {pending && <>
        <button type="button" className="kl-primary" disabled={!preview.complete || action.pending} onClick={() => { void decide('approve') }}>确认应用</button>
        <button type="button" className="kl-danger" disabled={action.pending} onClick={() => { void decide('reject') }}>拒绝提案</button>
      </>}
      {!!onClose && <button type="button" disabled={action.pending} onClick={onClose}>{pending ? '稍后处理' : '返回资料'}</button>}
    </div>
  </article>
}

export function BatchReviewCard({ api, library, review, onResolved, onClose }) {
  const { batch } = review
  const { complete, previews } = inspectBatch(review, library.key)
  const [reviewed, setReviewed] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const action = useAction()
  const state = receipt?.state ?? batch.state
  const pending = !receipt && hasBatchIdentity(review, library.key)
  const reviewKey = batch.id + ':' + batch.digest
  const confirmed = reviewed === reviewKey
  async function decide(decision) {
    if (!pending || (decision === 'approve' && (!complete || !confirmed))) return
    const result = await action.run(async signal => {
      const parameters = batchDecisionInput(library.key, review, decision)
      const value = await api.rpc('decideBatch', parameters, signal)
      if (value?.id !== batch.id || !Object.hasOwn(PROPOSAL_STATES, value.state) || value.state === 'pending') {
        throw new Error('无法确认批次处理结果。请刷新审批队列。')
      }
      return value
    })
    if (result.ok) {
      setReceipt(result.value)
      onResolved?.(result.value)
    }
  }
  return <article className="kl-card kl-stack" aria-label="批量差异审核">
    <div className="kl-bar kl-bar--between">
      <h2>审核批次</h2><span className="kl-pill">{labelOf(PROPOSAL_STATES, state)} · {batch.itemCount} 项</span>
    </div>
    <div className="kl-meta kl-muted">
      <div>目标：{libraryLabel(library)} · 批次 <code>{batch.id}</code></div>
      <div>发起：<Actor actor={batch.actor} /></div>
      <div>提交：<DateValue value={batch.createdAt} /> · 到期：<DateValue value={batch.expiresAt} /></div>
    </div>
    {batch.reason && <section className="kl-stack"><h3>批量变更理由</h3><PlainText value={batch.reason} /></section>}
    <Notice>请核对每一项的确切基准、变更和来源。这里只接受整组确认或拒绝；任意一项失败时不会部分应用。</Notice>
    {previews.map(({ proposal, before, preview }, index) => <section className="kl-card kl-stack" key={index + ':' + proposal.id} aria-label={'批次第 ' + (index + 1) + ' 项'}>
      <h3 className="kl-text">{index + 1}. {labelOf(PROPOSAL_KINDS, proposal.kind)}{(preview.after?.title || before?.title) && ' · ' + (preview.after?.title || before?.title)}</h3>
      <div className="kl-meta kl-muted">目标条目 <code>{proposal.targetId}</code> · 基准：{proposal.baseRevision > 0 ? 'v' + proposal.baseRevision : '新条目'}{proposal.state !== 'pending' && ' · ' + labelOf(PROPOSAL_STATES, proposal.state)}</div>
      {before?.id === proposal.targetId && before.revision === proposal.baseRevision && <details className="kl-card kl-stack">
        <summary>查看确切基准 v{before.revision} · {before.title}</summary>
        <EntryContent entry={before} />
      </details>}
      <ProposalPreview api={api} library={library} proposal={proposal} before={before} preview={preview} expandPublic />
      {state === 'pending' && !preview.complete && <Notice warning>此项缺少匹配的基准、草稿或来源。</Notice>}
    </section>)}
    {state === 'pending' && (!complete || !pending) && <Notice warning>批次详情不完整，不能应用整组变更。请刷新，或在摘要有效时整组拒绝。</Notice>}
    {state === 'conflict' && <Notice warning>至少一项内容或来源已变更，整组均未应用。请按当前版本重新生成提案。</Notice>}
    {receipt && <Notice>处理结果：{labelOf(PROPOSAL_STATES, state)}。</Notice>}
    <ErrorNotice error={action.error} />
    {pending && complete && <label className="kl-checkbox-line">
      <input type="checkbox" checked={confirmed} disabled={action.pending} onChange={event => setReviewed(event.target.checked ? reviewKey : null)} />
      我已核对本批全部 {batch.itemCount} 项的基准版本、变更与来源，确认没有混入不应公开的内容。
    </label>}
    <div className="kl-bar">
      {pending && <>
        <button type="button" className="kl-primary" disabled={!complete || !confirmed || action.pending} onClick={() => { void decide('approve') }}>确认应用整组</button>
        <button type="button" className="kl-danger" disabled={action.pending} onClick={() => { void decide('reject') }}>拒绝整组</button>
      </>}
      {!!onClose && <button type="button" disabled={action.pending} onClick={onClose}>{state === 'pending' ? '稍后处理' : '返回资料'}</button>}
    </div>
  </article>
}

function ProposalInspector({ api, library, id, batch, onResolved }) {
  const query = useQuery(api, batch ? 'batchProposal' : 'proposal', { library: library.key, id })
  return <QueryStatus query={query}>{review => batch
    ? review?.batch?.id === id
      ? <BatchReviewCard api={api} library={library} review={review} onResolved={onResolved} />
      : <Notice warning>未能读取该批次的详情。</Notice>
    : review?.proposal?.id === id
      ? <ReviewCard api={api} library={library} review={review} onResolved={onResolved} />
      : <Notice warning>未能读取该提案的详情。</Notice>}</QueryStatus>
}

export function ProposalsPane({ api, library }) {
  const [selected, select] = useState(null)
  const [batch, setBatch] = useState(false)
  const [filter, setFilter] = useState('pending')
  const [offset, setOffset] = useState(0)
  const query = useQuery(api, batch ? 'batchProposals' : 'proposals', { library: library.key, state: filter, offset, limit: PAGE })
  const [detailsGeneration, refreshDetails] = useState(0)
  function chooseType(value) {
    setBatch(value)
    setOffset(0)
    select(null)
  }
  return <section className="kl-stack" aria-label="待审核提案">
    <div className="kl-bar kl-bar--between">
      <h2>审批队列</h2>
      <div className="kl-bar">
        <label>范围 <select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); select(null) }}>
          <option value="pending">待审核</option><option value="all">全部提案</option>
        </select></label>
        <button type="button" onClick={() => { query.reload(); refreshDetails(n => n + 1) }} disabled={query.status === 'loading'}>刷新队列</button>
      </div>
    </div>
    <nav className="kl-bar" aria-label="提案类型">
      <button type="button" aria-pressed={!batch} onClick={() => chooseType(false)}>单条提案</button>
      <button type="button" aria-pressed={batch} onClick={() => chooseType(true)}>批量提案</button>
    </nav>
    <p className="kl-muted">打开提案核对差异；确认前不会改动正式资料。批量提案须整组处理。</p>
    <div className="kl-grid">
      <section className="kl-card kl-stack" aria-label={batch ? '批量提案清单' : '单条提案清单'}>
        <QueryStatus query={query}>{value => {
          const items = Array.isArray(value?.items) ? value.items.filter(item => batch || item?.batchId == null) : []
          return <>
            {items.length > 0 ? <ul className="kl-list">{items.map(item => <li key={item.id}>
              <button type="button" className="kl-list-button" aria-current={selected === item.id} onClick={() => select(item.id)}>
                <span className="kl-list-title">{batch ? '批量 · ' + item.itemCount + ' 项' : item.draft?.title || labelOf(PROPOSAL_KINDS, item.kind)}</span>
                <span className="kl-muted">{labelOf(PROPOSAL_STATES, item.state)} · <DateValue value={item.createdAt} /></span>
                {batch && item.reason && <span className="kl-muted kl-text">{item.reason}</span>}
              </button>
            </li>)}</ul> : <p className="kl-muted">当前没有{filter === 'pending' ? '待审核的' : ''}{batch ? '批量提案' : '单条提案'}。</p>}
            <Pager offset={offset} limit={PAGE} hasMore={value?.hasMore} onOffset={next => { setOffset(next); select(null) }} name="提案分页" />
          </>
        }}</QueryStatus>
      </section>
      {selected ? <ProposalInspector key={String(batch) + ':' + selected + ':' + detailsGeneration} api={api} library={library} id={selected} batch={batch} onResolved={query.reload} /> :
        <p className="kl-muted">选择{batch ? '一组批次' : '一条提案'}查看详情。</p>}
    </div>
  </section>
}
