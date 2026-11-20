import { useRef, useState } from 'react'
import { BATCH_LIMIT, batchStageInput, ENTRY_STATES, EVIDENCE_KINDS, initialEditor, libraryLabel, PROPOSAL_KINDS, RELATION_TYPES } from './model.mjs'
import { ErrorNotice, labelOf, Notice, useAction } from './shared.jsx'

const newEvidence = () => ({ kind: 'text', label: '', note: '', reference: '' })
const newRelation = () => ({ type: 'related', targetId: '' })

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

/** Reuse the same fields and wire shape for single and batch drafts. */
export function DraftFields({ form, onChange, metadataOnly = false }) {
  const set = (field, value) => onChange(previous => ({ ...previous, [field]: value }))
  const patchRow = (field, index, value) => onChange(previous => ({
    ...previous, [field]: previous[field].map((row, i) => i === index ? value : row),
  }))
  const removeRow = (field, index) => onChange(previous => ({
    ...previous, [field]: previous[field].filter((_, i) => i !== index),
  }))
  const appendRow = (field, value) => onChange(previous => ({ ...previous, [field]: [...previous[field], value] }))
  return <>
    <label className="kl-field">标题 <input className="kl-fill" required value={form.title} onChange={event => set('title', event.target.value)} /></label>
    <label className="kl-field">置信度（0–1；留空表示未评估） <input type="number" step="any" min="0" max="1" value={form.confidence} onChange={event => set('confidence', event.target.value)} /></label>
    <div className="kl-stack">
      <div className="kl-bar kl-bar--between"><h3>标签</h3><button type="button" disabled={form.tags.length >= 30} onClick={() => appendRow('tags', '')}>添加标签</button></div>
      {form.tags.map((tag, i) => <div className="kl-bar" key={i}>
        <label>标签 {i + 1} <input value={tag} onChange={event => patchRow('tags', i, event.target.value)} /></label>
        <button type="button" onClick={() => removeRow('tags', i)} aria-label={'移除标签 ' + (i + 1)}>移除</button>
      </div>)}
      {form.tags.length === 0 && <p className="kl-muted">无标签。</p>}
    </div>
    {!metadataOnly && <>
      <label className="kl-field">详情（纯文本） <textarea className="kl-fill" rows={5} value={form.detail} onChange={event => set('detail', event.target.value)} /></label>
      <div className="kl-stack">
        <div className="kl-bar kl-bar--between"><h3>证据</h3><button type="button" disabled={form.evidence.length >= 50} onClick={() => appendRow('evidence', newEvidence())}>添加证据</button></div>
        {form.evidence.map((item, i) => {
          const patch = (field, value) => patchRow('evidence', i, { ...item, [field]: value })
          return <fieldset className="kl-form-row" key={i}>
            <legend>证据 {i + 1}</legend>
            <label className="kl-field">类型 <select value={item.kind} onChange={event => patch('kind', event.target.value)}>
              {Object.entries(EVIDENCE_KINDS).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}
            </select></label>
            <label className="kl-field">名称 <input required value={item.label} onChange={event => patch('label', event.target.value)} /></label>
            {item.kind !== 'text' && <label className="kl-field">引用 <input required value={item.reference} onChange={event => patch('reference', event.target.value)} /></label>}
            <label className="kl-field">说明 <textarea rows={2} value={item.note} onChange={event => patch('note', event.target.value)} /></label>
            <div><button type="button" onClick={() => removeRow('evidence', i)} aria-label={'移除证据 ' + (i + 1)}>移除证据</button></div>
          </fieldset>
        })}
        {form.evidence.length === 0 && <p className="kl-muted">无证据。</p>}
      </div>
      <div className="kl-stack">
        <div className="kl-bar kl-bar--between"><h3>同库关联</h3><button type="button" disabled={form.relations.length >= 50} onClick={() => appendRow('relations', newRelation())}>添加关联</button></div>
        {form.relations.map((item, i) => <fieldset className="kl-form-row" key={i}>
          <legend>关联 {i + 1}</legend>
          <label className="kl-field">关系 <select value={item.type} onChange={event => patchRow('relations', i, { ...item, type: event.target.value })}>
            {Object.entries(RELATION_TYPES).map(([type, label]) => <option value={type} key={type}>{label}</option>)}
          </select></label>
          <label className="kl-field">目标条目 UUID <input required value={item.targetId} onChange={event => patchRow('relations', i, { ...item, targetId: event.target.value })} /></label>
          <div><button type="button" onClick={() => removeRow('relations', i)} aria-label={'移除关联 ' + (i + 1)}>移除关联</button></div>
        </fieldset>)}
        {form.relations.length === 0 && <p className="kl-muted">无关联。</p>}
      </div>
    </>}
  </>
}

/** Keep the idempotency key on an unchanged retry, including after a lost response. */
export function useProposalSubmission(api, operation, onStaged) {
  const [validation, setValidation] = useState(null)
  const action = useAction()
  const request = useRef(null)
  async function submit(buildInput) {
    setValidation(null)
    let fields, requestId
    try {
      fields = buildInput()
      const payload = JSON.stringify(fields)
      if (request.current?.payload !== payload) request.current = { payload, id: uuid() }
      requestId = request.current.id
      if (operation === 'stageBatch' && new TextEncoder().encode(JSON.stringify({ ...fields, requestId, op: operation })).length > 256 * 1024) {
        throw new Error('这一组数据超出请求大小限制，请分批提交。')
      }
    } catch (error) {
      setValidation(error)
      return
    }
    const result = await action.run(async signal => {
      const staged = await api.rpc(operation, { ...fields, requestId }, signal)
      const id = operation === 'stageBatch' ? staged?.batch?.id : staged?.proposal?.id
      if (typeof id !== 'string' || !id) throw new Error('宿主未返回有效的提案编号。请先查看审批队列。')
      return staged
    })
    if (result.ok) onStaged(result.value)
  }
  return { submit, pending: action.pending, error: validation ?? action.error }
}

export function BatchEditor({ api, library, kind, selection = [], onStaged, onCancel }) {
  const creating = kind === 'create'
  const [forms, setForms] = useState(() => [{ id: 'initial', form: initialEditor() }])
  const [reason, setReason] = useState('')
  const needsReason = kind === 'archive' || kind === 'invalidate'
  const number = creating ? forms.length : selection.length
  const action = useProposalSubmission(api, 'stageBatch', onStaged)
  function submit(event) {
    event.preventDefault()
    return action.submit(() => batchStageInput(library.key, kind, creating ? forms.map(row => row.form) : selection, reason))
  }
  return <form className="kl-card kl-stack" onSubmit={submit} aria-label="生成批量提案">
    <div className="kl-bar kl-bar--between"><h2>批量{labelOf(PROPOSAL_KINDS, kind)}</h2><span className="kl-pill">{libraryLabel(library)} · {number}/{BATCH_LIMIT} 项</span></div>
    <Notice>每批只能操作同一个资料库。生成提案不改动条目；人工核对后可整组应用或拒绝。</Notice>
    <fieldset className="kl-stack" disabled={action.pending}>
      {creating ? <>
        {forms.map(({ id, form }, index) => <fieldset className="kl-form-row" key={id}>
          <legend>新增草稿 {index + 1}</legend>
          <DraftFields form={form} onChange={change => setForms(rows => rows.map(row => row.id === id ? { ...row, form: change(row.form) } : row))} />
          {forms.length > 1 && <div><button type="button" onClick={() => setForms(rows => rows.filter(row => row.id !== id))}>
            移除草稿 {index + 1}
          </button></div>}
        </fieldset>)}
        <div><button type="button" disabled={number >= BATCH_LIMIT} onClick={() => {
          const row = { id: uuid(), form: initialEditor() }
          setForms(rows => rows.length < BATCH_LIMIT ? [...rows, row] : rows)
        }}>再添加一条</button></div>
      </> : <ol className="kl-sublist">
        {selection.map(entry => <li key={entry.id}><strong className="kl-text">{entry.title}</strong> · v{entry.revision} · {labelOf(ENTRY_STATES, entry.status)}</li>)}
      </ol>}
      <label className="kl-field">批量变更理由（{needsReason ? '必填' : '选填'}）
        <textarea className="kl-fill" required={needsReason} rows={2} maxLength={4000} value={reason} onChange={event => setReason(event.target.value)} />
      </label>
    </fieldset>
    <ErrorNotice error={action.error} />
    <div className="kl-bar">
      <button className="kl-primary" type="submit" disabled={action.pending}>{action.pending ? '正在生成…' : '生成整组差异提案'}</button>
      <button type="button" disabled={action.pending} onClick={onCancel}>取消</button>
    </div>
  </form>
}
