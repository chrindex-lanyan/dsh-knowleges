import { useState } from 'react'
import { AccessPane } from './access.jsx'
import { EntriesPane } from './entries.jsx'
import { ProposalsPane } from './review.jsx'
import { KnowledgeSettings } from './settings.jsx'
import { ExportControl, Surface } from './shared.jsx'
import { createKnowledgeApi } from './transport.mjs'

export const PANEL_ID = 'knowledge-library'
export const inject = ['slots']

function KnowledgeIcon() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 5.5h4.8c1 0 2 .45 2.7 1.2.7-.75 1.7-1.2 2.7-1.2h4.8v13h-4.8c-1 0-2 .33-2.7 1-.7-.67-1.7-1-2.7-1H4.5z" />
    <path d="M12 6.7v12.8m3-10h2m-2 3h2M7 9.5h2m-2 3h2" />
  </svg>
}

const VIEWS = [['entries', '条目'], ['proposals', '待审核'], ['access', '全局读授权']]

function KnowledgeBody({ api, library, mode }) {
  const [view, setView] = useState('entries')
  return <div className="kl-stack">
    <div className="kl-bar kl-bar--between">
      <nav className="kl-bar" aria-label="资料库视图">{VIEWS.map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</nav>
      <ExportControl api={api} library={library} />
    </div>
    {view === 'entries' && <EntriesPane api={api} library={library} />}
    {view === 'proposals' && <ProposalsPane api={api} library={library} />}
    {view === 'access' && <AccessPane api={api} library={library} mode={mode} />}
  </div>
}

function KnowledgePanel({ api }) {
  return <Surface api={api}>{(library, mode) => <KnowledgeBody api={api} library={library} mode={mode} key={library.key} />}</Surface>
}

export function apply(ctx) {
  const api = createKnowledgeApi()
  const injectApi = () => ({ api })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: injectApi }, KnowledgePanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '资料库',
  }, KnowledgeIcon))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: PANEL_ID, order: 70, label: () => '资料库', inject: injectApi,
  }, KnowledgeSettings))
}
