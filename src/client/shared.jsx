import { useEffect, useId, useReducer, useRef, useState } from 'react'
import { styles } from './style.mjs'
import { downloadSQLite } from './transport.mjs'
import { displayTime, EVIDENCE_KINDS, libraryLabel, RELATION_TYPES, selectedLibrary, sourceEntryQuery } from './model.mjs'

export function labelOf(labels, value) {
  return Object.hasOwn(labels, value) ? labels[value] : String(value ?? '—')
}

export function useQuery(api, op, parameters = {}, enabled = true) {
  const json = JSON.stringify(parameters)
  const [attempt, reload] = useReducer(n => n + 1, 0)
  const key = JSON.stringify([op, json, attempt])
  const [settled, setSettled] = useState(null)
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    void Promise.resolve().then(() => api.rpc(op, JSON.parse(json), abort.signal)).then(value => {
      if (!abort.signal.aborted) setSettled({ key, api, value, status: 'ready' })
    }, error => {
      if (!abort.signal.aborted) setSettled({ key, api, error, status: 'error' })
    })
    return () => abort.abort()
  }, [api, op, key, json, enabled])
  const result = enabled && settled?.key === key && settled.api === api
    ? settled : { status: enabled ? 'loading' : 'idle' }
  return { ...result, reload }
}

export function useAction() {
  const active = useRef(null)
  const [state, setState] = useState({ pending: false, error: null })
  useEffect(() => () => active.current?.abort(), [])
  async function run(task) {
    if (active.current) return { ok: false }
    const abort = new AbortController()
    active.current = abort
    setState({ pending: true, error: null })
    let error = null
    try {
      const value = await task(abort.signal)
      abort.signal.throwIfAborted()
      return { ok: true, value }
    } catch (reason) {
      error = reason
      return { ok: false }
    } finally {
      active.current = null
      if (!abort.signal.aborted) setState({ pending: false, error })
    }
  }
  return { ...state, run }
}

export function Notice({ children, warning = false }) {
  return <div className={'kl-notice' + (warning ? ' kl-notice--warning' : '')} role="status">{children}</div>
}

const ERROR_HINTS = {
  ACCESS_DENIED: '当前界面没有资料库访问权限。',
  PROPOSAL_CONFLICT: '版本已变更。请读取当前版本，重新生成差异后确认。',
  SETTINGS_CONFLICT: '设置或待裁剪的历史已变更。请刷新并重新预览。',
  WORKSPACE_UNAVAILABLE: '宿主未能核验工作区归属。',
  BUSY_RETRY: '资料库正在处理其他请求，请稍后重试。',
}
export function ErrorNotice({ error }) {
  if (!error) return null
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' ? error.message : String(error)
  const hint = Object.hasOwn(ERROR_HINTS, code) ? ERROR_HINTS[code] : ''
  return <div role="alert" className="kl-notice kl-notice--error kl-text">
    {hint && hint !== message ? <strong>{hint} </strong> : null}
    {message}{code && <> <code>{code}</code></>}
  </div>
}

export function QueryStatus({ query, children, loading = '正在读取…' }) {
  if (query.status === 'ready') return children(query.value)
  if (query.status === 'loading') return <p className="kl-muted" role="status">{loading}</p>
  if (query.status === 'error') return <div className="kl-bar">
    <ErrorNotice error={query.error} /><button type="button" onClick={query.reload}>重试</button>
  </div>
  return null
}

export function Pager({ offset, limit, hasMore, onOffset, name }) {
  if (offset === 0 && !hasMore) return null
  return <nav className="kl-bar kl-pager" aria-label={name}>
    <button type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>上一页</button>
    <span className="kl-muted">第 {Math.floor(offset / limit) + 1} 页</span>
    <button type="button" disabled={!hasMore} onClick={() => onOffset(offset + limit)}>下一页</button>
  </nav>
}

/** A root slot view independent from the selected DSH conversation. */
export function Surface({ api, settings = false, children }) {
  const uid = useId()
  const query = useQuery(api, 'libraries')
  const [selected, select] = useState('global')
  const [announcedMode, setAnnouncedMode] = useState(null)
  useEffect(() => api.subscribeSessionMode(setAnnouncedMode), [api])
  const libraries = Array.isArray(query.value?.libraries) ? query.value.libraries : []
  const library = selectedLibrary(libraries, selected)
  const mode = announcedMode ?? query.value?.mode
  function reload() {
    setAnnouncedMode(null)
    query.reload()
  }
  return <section className={'dsh-kl' + (!settings ? ' dsh-kl--main' : '')} aria-labelledby={uid}>
    <style>{styles}</style>
    <div className="kl-wrap">
      <header className="kl-header kl-stack">
        <div className="kl-bar kl-bar--between">
          <h1 id={uid}>{settings ? '资料库设置' : '资料库'}</h1>
          {mode === 'preview' && <span className="kl-pill">人工预览</span>}
          {mode === 'trial' && <span className="kl-pill">会话工具试用已开启</span>}
        </div>
        <p className="kl-muted">{settings ? '管理会话工具试用、全局读授权与各库的历史和整理规则。' : '选择资料库，查阅和审核经人工确认的知识。'}</p>
        {(mode === 'preview' || mode === 'trial') && <Notice warning>仅用于验证资料库接入，请勿录入真实或敏感资料。</Notice>}
        <div className="kl-bar">
          {library && <label>当前库 <select value={library.key} onChange={event => select(event.target.value)}>
            {libraries.map(item => <option key={item.key} value={item.key}>{libraryLabel(item)}</option>)}
          </select></label>}
          <button type="button" disabled={query.status === 'loading'} onClick={reload}>刷新库列表</button>
        </div>
      </header>
      <QueryStatus query={query} loading="正在读取可用资料库…">{() => library
        ? children(library, mode)
        : <Notice>没有可用的资料库。</Notice>}</QueryStatus>
    </div>
  </section>
}

export function PlainText({ value, scroll = false }) {
  return <div className={'kl-text' + (scroll ? ' kl-scroll-text' : '')}>{value == null || value === '' ? '—' : String(value)}</div>
}

export function TagList({ items }) {
  return Array.isArray(items) && items.length > 0
    ? <ul className="kl-bar kl-tags" role="list">{items.map((tag, index) => <li className="kl-pill kl-text" key={index}>{tag}</li>)}</ul>
    : <p className="kl-muted">无标签</p>
}

export function TagSection({ items }) {
  return <section className="kl-stack"><h3>标签</h3><TagList items={items} /></section>
}

export function EvidenceList({ items }) {
  return Array.isArray(items) && items.length > 0
    ? <ol className="kl-sublist">{items.map((item, index) => <li key={index}>
      <span className="kl-pill">{labelOf(EVIDENCE_KINDS, item.kind)}</span> <strong className="kl-text">{item.label || '未命名证据'}</strong>
      {item.reference && <PlainText value={item.reference} />}
      {item.note && <PlainText value={item.note} />}
    </li>)}</ol> : <p className="kl-muted">无</p>
}

export function RelationList({ items, onOpen }) {
  return Array.isArray(items) && items.length > 0
    ? <ul className="kl-sublist">{items.map((item, index) => <li key={index}>
      {labelOf(RELATION_TYPES, item.type)} · {onOpen
        ? <button type="button" onClick={() => onOpen(item.targetId)}><code>{item.targetId}</code></button>
        : <code>{item.targetId}</code>}
    </li>)}</ul> : <p className="kl-muted">无</p>
}

function SourceRow({ item, api }) {
  const [open, setOpen] = useState(false)
  const request = sourceEntryQuery(item)
  const source = useQuery(api, 'entry', request ?? {}, Boolean(api && request && open))
  return <li className="kl-stack">
    <div>工作区 <code>{item?.workspaceId}</code> · 条目 <code>{item?.entryId}</code> · 版本 {item?.revision}</div>
    {api && request && <div><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起工作区原文' : '核对工作区原版本'}</button></div>}
    {open && <QueryStatus query={source}>{entry => entry?.id === request?.id && entry.revision === request?.revision
      ? <div className="kl-card kl-stack">
        <strong className="kl-text">{entry.title}</strong>
        <span className="kl-muted">v{entry.revision} · <DateValue value={entry.updatedAt} /></span>
        <TagSection items={entry.tags} />
        <PlainText value={entry.detail} scroll />
        <EvidenceList items={entry.evidence} />
      </div>
      : <Notice warning>未能读取对应的来源版本。</Notice>}</QueryStatus>}
  </li>
}

export function Sources({ items, title = '来源摘要', api }) {
  if (!Array.isArray(items) || items.length === 0) return null
  return <section className="kl-source kl-stack" aria-label="仅人工核对的来源">
    <h3>{title} <span className="kl-pill">仅人工核对</span></h3>
    <p className="kl-muted">下方内容仅供核对，不会写入全局正文。已裁剪或已无法访问的来源不会用其他版本替代。</p>
    <ul className="kl-sublist">{items.map((item, index) => <SourceRow key={index + ':' + item?.entryId + ':' + item?.revision} item={item} api={api} />)}</ul>
  </section>
}

export function DateValue({ value }) {
  return <>{displayTime(value)}</>
}

export function ExportControl({ api, library, onExport }) {
  const [confirm, setConfirm] = useState(false)
  const action = useAction()
  const [message, setMessage] = useState('')
  async function start() {
    setMessage('')
    const result = await action.run(async signal => {
      const ticket = await api.rpc('prepareExport', { library: library.key }, signal)
      if (typeof ticket?.ticket !== 'string' || !ticket.ticket) throw new Error('资料库未返回有效的导出凭证。')
      const blob = await api.exportDatabase(ticket.ticket, signal)
      signal.throwIfAborted()
      downloadSQLite(blob, ticket.fileName)
    })
    if (result.ok) {
      setConfirm(false)
      setMessage('已发起 SQLite 文件下载。')
      onExport?.()
    }
  }
  return <section className="kl-stack" aria-label="SQLite 导出">
    {!confirm ? <div className="kl-bar">
      <button type="button" onClick={() => { setConfirm(true); setMessage('') }}>导出此库为 SQLite</button>
      {message && <span className="kl-muted" role="status">{message}</span>}
    </div> : <div className="kl-card kl-stack">
      <Notice warning>将导出「{libraryLabel(library)}」的正式条目（含归档）及保留历史，可能含敏感内容。文件下载后不能撤回。</Notice>
      <div className="kl-bar">
        <button type="button" className="kl-primary" onClick={start} disabled={action.pending}>{action.pending ? '正在生成…' : '确认下载'}</button>
        <button type="button" onClick={() => setConfirm(false)} disabled={action.pending}>取消</button>
      </div>
      <ErrorNotice error={action.error} />
    </div>}
  </section>
}
