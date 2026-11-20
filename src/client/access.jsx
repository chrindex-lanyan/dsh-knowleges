import { useState } from 'react'
import { globalReadAccess } from './model.mjs'
import { DateValue, ErrorNotice, labelOf, Notice, QueryStatus, useAction, useQuery } from './shared.jsx'

const OPERATIONS = {
  search: '搜索资料', get: '查阅详情', entry: '查阅详情', get_many: '批量查阅条目', stale: '查找整理候选',
  candidates: '查找整理候选', stale_candidates: '查找整理候选',
  knowledge_search: '搜索资料', knowledge_get: '查阅详情', knowledge_get_many: '批量查阅条目', knowledge_stale_candidates: '查找整理候选',
}

function SessionReference({ item }) {
  return <div className="kl-meta kl-muted">
    会话 <code>{item.sessionId}</code> · 调用方 <code>{item.agentId}</code><br />
    {item.expiresAt != null ? <>到期：<DateValue value={item.expiresAt} /></> : '有效期随会话与宿主状态变化'}
  </div>
}

export function AccessPane({ api, library, mode }) {
  if (library.key !== 'global') return <section className="kl-stack" aria-label="工作区读取规则">
    <h2>工作区读取规则</h2>
    <Notice>会话工具开启后，经宿主验证真实绑定的会话可直接读取自己的工作区资料，不需要逐次或按会话批准；不能据此读取其他工作区。</Notice>
    <p className="kl-muted">工作区写入仍须人工审核。要查看和处理会话的全局读申请，请将当前库切换到「全局资料库」。</p>
    {mode === 'preview' && <p className="kl-muted">当前为人工预览；会话工具尚未开启。</p>}
  </section>
  return <GlobalAccess key={mode} api={api} mode={mode} />
}

function GlobalAccess({ api, mode }) {
  const query = useQuery(api, 'readRequests', { library: 'global' }, mode === 'trial')
  const action = useAction()
  const [message, setMessage] = useState('')
  async function decide(id, decision) {
    setMessage('')
    const result = await action.run(signal => api.rpc('decideRead', { id, decision }, signal))
    if (result.ok) {
      setMessage({ once: '已允许本次请求。', session: '已允许当前会话读取全局库。', reject: '已拒绝此次申请。' }[decision])
      query.reload()
    }
  }
  async function revoke(id) {
    setMessage('')
    const result = await action.run(signal => api.rpc('revokeRead', { id }, signal))
    if (result.ok) {
      setMessage('已撤销读授权。')
      query.reload()
    }
  }
  return <section className="kl-stack" aria-label="读授权管理">
    <div className="kl-bar kl-bar--between">
      <h2>全局读授权</h2>{mode === 'trial' && <button type="button" onClick={query.reload} disabled={query.status === 'loading' || action.pending}>刷新授权</button>}
    </div>
    <p className="kl-muted">全局库须单独授权指定会话和调用方；子代理不继承。撤销不影响会话已收到的内容。</p>
    {mode !== 'trial' && <Notice>当前为人工预览，未开启会话工具，不会产生全局读授权申请。</Notice>}
    {message && <Notice>{message}</Notice>}
    <ErrorNotice error={action.error} />
    <QueryStatus query={query}>{value => {
      const { requests, grants } = globalReadAccess(value)
      return <div className="kl-grid">
        <section className="kl-card kl-stack" aria-label="申请列表">
          <h3>待处理读申请</h3>
          {requests.length > 0 ? <ul className="kl-list">{requests.map(item => <li key={item.id} className="kl-form-row">
            <strong className="kl-text">{labelOf(OPERATIONS, item.operation)}</strong>
            <SessionReference item={item} />
            <div className="kl-bar">
              <button className="kl-primary" type="button" disabled={action.pending} onClick={() => { void decide(item.id, 'once') }}>仅允许本次</button>
              <button type="button" disabled={action.pending} onClick={() => { void decide(item.id, 'session') }}>允许当前会话</button>
              <button type="button" disabled={action.pending} onClick={() => { void decide(item.id, 'reject') }}>拒绝</button>
            </div>
          </li>)}</ul> : <p className="kl-muted">当前没有待处理的读申请。</p>}
        </section>
        <section className="kl-card kl-stack" aria-label="已授权列表">
          <h3>有效授权</h3>
          {grants.length > 0 ? <ul className="kl-list">{grants.map(item => <li key={item.id} className="kl-form-row">
            <SessionReference item={item} />
            <div><button type="button" className="kl-danger" disabled={action.pending} onClick={() => { void revoke(item.id) }}>撤销授权</button></div>
          </li>)}</ul> : <p className="kl-muted">当前没有有效授权。</p>}
        </section>
      </div>
    }}</QueryStatus>
  </section>
}
