export const styles = `
.dsh-kl {
  --kl-text: var(--dsw-alias-label-primary, light-dark(#172033,#eff3fb));
  --kl-muted: var(--dsw-alias-label-secondary, light-dark(#586279,#a6afc3));
  --kl-surface: var(--dsw-specific-sidebar-fill, light-dark(#f6f8fb,#212632));
  --kl-border: color-mix(in srgb, var(--kl-muted) 25%, transparent);
  --kl-accent: var(--dsw-alias-label-link, light-dark(#2358bc,#9dc1ff));
  box-sizing: border-box;
  color: var(--kl-text);
  line-height: 1.55;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: clamp(12px, 3%, 30px);
  width: 100%;
}
.dsh-kl, .dsh-kl *, .dsh-kl *::before, .dsh-kl *::after { box-sizing: border-box; }
.dsh-kl--main {
  height: 100%;
  padding-inline-start: max(clamp(12px, 3%, 30px), var(--dsh-frame-leading-clearance, 0px));
}
.dsh-kl .kl-wrap { margin: 0 auto; max-width: 1040px; }
.dsh-kl .kl-stack { display: grid; gap: 12px; min-width: 0; }
.dsh-kl .kl-header { border-bottom: 1px solid var(--kl-border); margin-bottom: 16px; padding-bottom: 16px; }
.dsh-kl .kl-bar { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-kl .kl-bar--between { justify-content: space-between; }
.dsh-kl .kl-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); align-items: start; min-width: 0; }
.dsh-kl .kl-grid--metrics { grid-template-columns: repeat(auto-fit, minmax(min(100%, 115px), 1fr)); }
.dsh-kl .kl-card { border: 1px solid var(--kl-border); border-radius: 12px; min-width: 0; padding: 12px; }
.dsh-kl .kl-session-tools { border-color: var(--kl-accent); margin-bottom: 12px; }
.dsh-kl .kl-checkbox-line { align-items: start; display: grid; gap: 8px; grid-template-columns: max-content minmax(0, 1fr); }
.dsh-kl .kl-checkbox-line input { margin-block-start: .36em; }
.dsh-kl .kl-muted { color: var(--kl-muted); font-size: .875em; }
.dsh-kl .kl-count { display: block; font-size: 1.35em; font-variant-numeric: tabular-nums; margin-top: 4px; }
.dsh-kl h1,.dsh-kl h2,.dsh-kl h3,.dsh-kl h4,.dsh-kl p,.dsh-kl ul,.dsh-kl ol { margin: 0; }
.dsh-kl h1 { font-size: 1.55rem; font-weight: 660; }
.dsh-kl h2 { font-size: 1.1rem; font-weight: 640; }
.dsh-kl :is(h3,h4) { font-size: 1rem; font-weight: 620; }
.dsh-kl ul,.dsh-kl ol { padding-inline-start: 1.5rem; }
.dsh-kl :where(button,input,textarea,select) { font: inherit; }
.dsh-kl button,.dsh-kl select,.dsh-kl input:not([type='checkbox']),.dsh-kl textarea {
  background: transparent; border: 1px solid var(--kl-border); border-radius: 7px;
  color: var(--kl-text); max-width: 100%; min-width: 0; padding: .35rem .58rem;
}
.dsh-kl button { cursor: pointer; min-height: 2.16rem; }
.dsh-kl button:hover:not(:disabled),.dsh-kl button[aria-current='true'],.dsh-kl button[aria-pressed='true'] { background: var(--kl-surface); }
.dsh-kl button:disabled { cursor: not-allowed; opacity: .56; }
.dsh-kl :where(button,input,textarea,select,summary):focus-visible { outline: 2px solid var(--kl-accent); outline-offset: 2px; }
.dsh-kl button.kl-primary { border-color: var(--kl-accent); color: var(--kl-accent); font-weight: 620; }
.dsh-kl button.kl-danger { color: var(--dsw-alias-label-danger, light-dark(#9c1d30,#f89ca8)); }
.dsh-kl label.kl-field { display: grid; gap: 5px; min-width: 0; }
.dsh-kl :is(input:not([type='checkbox']),textarea).kl-fill { width: 100%; }
.dsh-kl textarea { min-height: 3.5rem; resize: vertical; }
.dsh-kl :where(form > fieldset) { border: 0; margin: 0; min-inline-size: 0; padding: 0; }
.dsh-kl select option { background: var(--kl-surface); color: var(--kl-text); }
.dsh-kl .kl-pager { justify-content: center; }
.dsh-kl .kl-pill { background: var(--kl-surface); border-radius: 999px; display: inline-block; font-size: .8em; padding: .15rem .53rem; }
.dsh-kl .kl-tags { list-style: none; padding: 0; }
.dsh-kl .kl-tags > li { max-width: 100%; }
.dsh-kl .kl-list { display: grid; gap: 6px; list-style: none; padding: 0; }
.dsh-kl .kl-list > li { min-width: 0; }
.dsh-kl .kl-batch-result { align-items: center; display: grid; gap: 8px; grid-template-columns: max-content minmax(0, 1fr); }
.dsh-kl .kl-list-button { display: grid; gap: 4px; text-align: start; width: 100%; }
.dsh-kl .kl-list-title { font-weight: 630; overflow-wrap: anywhere; }
.dsh-kl .kl-text { overflow-wrap: anywhere; white-space: pre-wrap; }
.dsh-kl .kl-sublist { min-width: 0; }
.dsh-kl .kl-sublist > li + li { margin-top: 6px; }
.dsh-kl .kl-scroll-text { max-height: 18rem; overflow: auto; }
.dsh-kl .kl-notice { border-inline-start: 3px solid var(--kl-accent); padding: 6px 9px; }
.dsh-kl .kl-notice--warning { border-inline-start-color: light-dark(#ac6600,#f6b35b); }
.dsh-kl .kl-notice--error { border-inline-start-color: light-dark(#a52438,#ee9aa7); }
.dsh-kl .kl-form-row { border: 1px solid var(--kl-border); border-radius: 8px; display: grid; gap: 8px; padding: 8px; }
.dsh-kl .kl-source { border-inline-start: 2px solid var(--kl-border); padding-inline-start: 10px; }
.dsh-kl :is(.kl-meta,code) { overflow-wrap: anywhere; }
.dsh-kl summary { cursor: pointer; }
`
