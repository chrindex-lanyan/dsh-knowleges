import { useState } from 'react'
import { AccessPane } from './access.jsx'
import { displayBytes, PROPOSAL_STATES, settingsInput } from './model.mjs'
import { DateValue, ErrorNotice, ExportControl, labelOf, Notice, QueryStatus, Surface, useAction, useQuery } from './shared.jsx'

function SessionToolsControl({ api, mode }) {
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState('')
  const action = useAction()
  const enabled = mode === 'trial'
  const modeKnown = enabled || mode === 'preview'
  async function switchMode() {
    setMessage('')
    const result = await action.run(signal => api.setSessionTools(!enabled, confirmed, signal))
    if (result.ok) {
      setConfirmed(false)
      setMessage(result.value.mode === 'trial' ? '会话工具试用已开启。' : '会话工具已关闭；没有改动正式条目。')
    }
  }
  return <section className="kl-card kl-stack kl-session-tools" aria-label="会话工具试用">
    <div className="kl-bar kl-bar--between">
      <h2>会话工具试用</h2><span className="kl-pill">{enabled ? '已开启' : modeKnown ? '已关闭 · 人工预览' : '状态未知'}</span>
    </div>
    <p>此开关影响当前 DSH 宿主的所有资料库，不随所选库变化；宿主重启后恢复安装时的默认状态。</p>
    <Notice warning>试用使用此宿主当前的同一份资料，不会创建副本。开启后，真实绑定的会话无需审批即可读取自己的工作区资料；不能跨工作区读取。全局读取仍单独授权，所有写入仍须人工审核。</Notice>
    {!enabled && modeKnown && <label className="kl-checkbox-line">
      <input type="checkbox" checked={confirmed} disabled={action.pending} onChange={event => setConfirmed(event.target.checked)} />
      我确认当前资料库实例只含合成测试资料，不包含真实、私密或敏感内容。
    </label>}
    {enabled && <p className="kl-muted">关闭会撤销活动读授权，不会删除已有资料或待审提案；仍可人工使用资料库。</p>}
    {!modeKnown && <p className="kl-muted">无法确认宿主状态，请先刷新库列表。</p>}
    {message && <Notice>{message}</Notice>}
    <ErrorNotice error={action.error} />
    <div><button type="button" className={enabled ? 'kl-danger' : 'kl-primary'} disabled={!modeKnown || action.pending || (!enabled && !confirmed)}
      onClick={() => { void switchMode() }}>{action.pending ? '正在切换…' : enabled ? '关闭会话工具' : '开启会话工具试用'}</button></div>
  </section>
}

function SettingsForm({ api, library, settings, onSaved }) {
  const [form, setForm] = useState(() => ({ maxHistory: String(settings.maxHistory), staleAfterDays: String(settings.staleAfterDays) }))
  const [preview, setPreview] = useState(null)
  const [validation, setValidation] = useState(null)
  const action = useAction()
  const update = (key, value) => {
    setForm(previous => ({ ...previous, [key]: value }))
    setPreview(null)
    setValidation(null)
  }
  async function verify(event) {
    event.preventDefault()
    setPreview(null)
    setValidation(null)
    let parameters
    try {
      parameters = { library: library.key, ...settingsInput(settings, form) }
    } catch (error) {
      setValidation(error)
      return
    }
    const result = await action.run(async signal => {
      const value = await api.rpc('previewSettings', parameters, signal)
      if (typeof value?.token !== 'string' || !value.token || !Number.isSafeInteger(value.trimCount) || value.trimCount < 0) {
        throw new Error('宿主未返回有效的设置预览。')
      }
      return value
    })
    if (result.ok) setPreview({ parameters, ...result.value })
  }
  async function confirm() {
    if (!preview) return
    const result = await action.run(signal => api.rpc('saveSettings', { ...preview.parameters, previewToken: preview.token }, signal))
    if (result.ok) {
      const trimmed = preview.trimCount
      setPreview(null)
      onSaved(trimmed)
    }
  }
  const unchanged = String(settings.maxHistory) === form.maxHistory && String(settings.staleAfterDays) === form.staleAfterDays
  return <form className="kl-card kl-stack" aria-label="历史保留和旧条目规则" onSubmit={verify}>
    <h2>保留与整理规则</h2>
    <fieldset className="kl-grid" disabled={action.pending}>
      <label className="kl-field">旧版本保留上限（N）
        <input type="number" min="1" max="1000" step="1" required value={form.maxHistory} onChange={event => update('maxHistory', event.target.value)} />
        <span className="kl-muted">每条资料的旧版本数，不含当前版。</span>
      </label>
      <label className="kl-field">旧条目阈值（天）
        <input type="number" min="1" max="3650" step="1" required value={form.staleAfterDays} onChange={event => update('staleAfterDays', event.target.value)} />
        <span className="kl-muted">从最后一次实际变更起算，不会自动删改。</span>
      </label>
    </fieldset>
    <div className="kl-bar">
      <button type="submit" disabled={action.pending || unchanged} className="kl-primary">{action.pending && !preview ? '正在计算…' : '预览设置影响'}</button>
    </div>
    {preview && <section className="kl-card kl-stack" aria-label="设置影响预览">
      <Notice warning={preview.trimCount > 0}>
        {preview.trimCount > 0
          ? '应用后将裁剪 ' + preview.trimCount + ' 条历史版本，不可恢复；当前版本不会删除。'
          : '应用后不会裁剪历史版本。'}
      </Notice>
      <div className="kl-bar">
        <button type="button" className="kl-primary" disabled={action.pending} onClick={confirm}>{action.pending ? '正在保存…' : preview.trimCount > 0 ? '确认设置并裁剪' : '确认保存设置'}</button>
        <button type="button" disabled={action.pending} onClick={() => setPreview(null)}>取消预览</button>
      </div>
    </section>}
    <ErrorNotice error={validation ?? action.error} />
  </form>
}

function Metrics({ metrics, library }) {
  const counts = metrics?.counts
  const items = [
    ['有效条目', counts?.active], ['失效条目', counts?.invalid], ['归档条目', counts?.archived],
    ['旧版本', metrics?.historyCount], ['待审核', metrics?.pendingCount], ['存储大小', displayBytes(metrics?.fileBytes)],
    ...(library.key === 'global' ? [['全局读请求未获授权（本次启动）', metrics?.deniedReads]] : []),
  ]
  const decisions = Object.entries(metrics?.decisions ?? {}).filter(([, value]) => Number.isFinite(value))
  const last = metrics?.lastExport
  const exportStates = { success: '成功', succeeded: '成功', downloaded: '成功', ok: '成功', failed: '失败', error: '失败', cancelled: '已取消' }
  return <section className="kl-card kl-stack" aria-label="资料库指标">
    <h2>观测指标</h2>
    <div className="kl-grid kl-grid--metrics">{items.map(([title, value]) => <section className="kl-card" key={title}>
      <span className="kl-muted">{title}</span><strong className="kl-count">{value ?? '—'}</strong>
    </section>)}</div>
    <div className="kl-stack">
      <h3>审批结果</h3>
      {decisions.length ? <div className="kl-bar">{decisions.map(([state, value]) => <span className="kl-pill" key={state}>{labelOf(PROPOSAL_STATES, state)} {value}</span>)}</div> :
        <p className="kl-muted">暂无审批结果计数。</p>}
      <p className="kl-muted">最近导出：{last ? <>
        {labelOf(exportStates, last.status)} · <DateValue value={last.at} />{last.size != null && ' · ' + displayBytes(last.size)}
      </> : '暂无'}</p>
    </div>
  </section>
}

function SettingsBody({ api, library, mode }) {
  const query = useQuery(api, 'settings', { library: library.key })
  const [saved, setSaved] = useState('')
  const [showAccess, setAccess] = useState(false)
  return <div className="kl-stack">
    <div className="kl-bar kl-bar--between">
      <ExportControl api={api} library={library} onExport={query.reload} />
      <button type="button" disabled={query.status === 'loading'} onClick={query.reload}>刷新设置和指标</button>
    </div>
    {saved && <Notice>{saved}</Notice>}
    <QueryStatus query={query}>{value => value?.settings ? <>
      <SettingsForm api={api} library={library} settings={value.settings} key={value.settings.revision} onSaved={trimmed => {
        setSaved(trimmed > 0 ? '设置已保存，已裁剪 ' + trimmed + ' 条历史。' : '设置已保存。')
        query.reload()
      }} />
      <Metrics metrics={value.metrics} library={library} />
    </> : <Notice warning>未能读取此资料库的设置。</Notice>}</QueryStatus>
    {library.key === 'global' ? <div>
      <button type="button" aria-expanded={showAccess} onClick={() => setAccess(shown => !shown)}>{showAccess ? '收起读授权' : '管理全局读授权'}</button>
    </div> : <p className="kl-muted">会话工具开启后，已验证绑定的会话读取自己的工作区库无需审批。将当前库切换到全局，可管理全局读授权。</p>}
    {library.key === 'global' && showAccess && <AccessPane api={api} library={library} mode={mode} />}
  </div>
}

export function KnowledgeSettings({ api }) {
  return <Surface api={api} settings>{(library, mode) => <>
    <SessionToolsControl api={api} mode={mode} />
    <SettingsBody api={api} library={library} mode={mode} key={library.key} />
  </>}</Surface>
}
