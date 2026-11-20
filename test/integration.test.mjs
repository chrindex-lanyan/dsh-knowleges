import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('built bundle is a single DSH factory and registers only the declared navigation and settings contributions', () => {
  const registrations = [];
  runInNewContext(read(manifest.exports['./client']), {
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, manifest.name);
  const externals = new Set();
  const client = registrations[0].factory(name => {
    assert.ok(manifest.dsh.client.external.includes(name), 'unexpected require ' + name);
    externals.add(name);
    return name === 'react' ? { useState: undefined } : { jsx() {}, jsxs() {} };
  });
  assert.deepEqual([...externals].sort(), [...manifest.dsh.client.external].sort());
  assert.deepEqual([...client.inject], ['slots']);
  const slots = new Map();
  const warnings = [];
  client.apply({ slots: {
    inject(slot, callback) { callback(); if (!slots.has(slot)) warnings.push(slot); },
    register(options, render) { assert.equal(typeof render, 'function'); slots.set(options.name, options); },
  }});
  assert.deepEqual(warnings, []);
  assert.deepEqual([...slots.keys()].sort(), ['main', 'settings.section', 'sidebar.panellist']);
  assert.equal(slots.get('main').key, slots.get('sidebar.panellist').id);
  assert.equal(slots.get('settings.section').label(), '资料库');
});

test('entry details and proposal previews label tag lists, including empty and unchanged tags', async () => {
  const bundle = await build({
    stdin: { contents: "export { EntryContent, ReviewCard } from './src/client/review.jsx';", resolveDir: fileURLToPath(root) },
    bundle: true, format: 'cjs', jsx: 'automatic', external: manifest.dsh.client.external, write: false,
  });
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') };
    if (name === 'react') return { useState: value => [value, () => {}], useRef: current => ({ current }), useEffect() {} };
    assert.fail('Unexpected external: ' + name);
  }});
  function* nodes(node) {
    if (Array.isArray(node)) { for (const child of node) yield* nodes(child); }
    else if (typeof node?.type === 'function') yield* nodes(node.type(node.props));
    else if (node?.props) { yield node; yield* nodes(node.props.children); }
  }
  const { EntryContent, ReviewCard } = module.exports;
  const entry = { id: 'target', revision: 2, title: '测试条目', detail: '测试详情', status: 'active',
    confidence: null, tags: ['历史', '试用'], evidence: [], relations: [] };
  const listRows = tree => [...nodes(tree)].filter(node => node.type === 'li').map(node => node.props.children);
  const detail = EntryContent({ entry });
  assert.deepEqual([...nodes(detail)].filter(node => node.type === 'h3').map(node => node.props.children), ['标签', '详情', '证据', '关联']);
  assert.deepEqual(listRows(detail), entry.tags);
  const empty = [...nodes(EntryContent({ entry: { ...entry, tags: [] } }))];
  assert.ok(empty.some(node => node.type === 'h3' && node.props.children === '标签'));
  assert.ok(empty.some(node => node.type === 'p' && node.props.children === '无标签'));
  const review = draft => ReviewCard({ library: { key: 'workspace:tests', title: '测试库' }, review: {
    before: entry, proposal: { id: 'pending', targetId: entry.id, baseRevision: entry.revision,
      kind: 'update', state: 'pending', digest: 'digest', draft },
  }});
  const unchanged = review({ ...entry, title: '只改标题' });
  assert.ok([...nodes(unchanged)].some(node => node.type === 'h3' && node.props.children === '标签'));
  assert.deepEqual(listRows(unchanged), entry.tags);
  const changed = review({ ...entry, tags: ['新标签'] });
  assert.ok([...nodes(changed)].some(node => node.type === 'h4' && node.props.children === '标签'));
  assert.deepEqual(listRows(changed), [...entry.tags, '新标签']);
});

test('distribution includes a preview-only host patch and no dependency install hooks', async () => {
  assert.equal(manifest.dsh.bundle.listedByDefault, false);
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./cordis.patch.yml'], manifest.dsh.bundle.patch);
  assert.match(read(manifest.dsh.bundle.patch), /- insert:\n\s+- id: knowledge-library\n\s+name: dsh-knowledge-library\n\s+config:\n\s+mode: preview\s*$/);
  for (const key of ['install', 'preinstall', 'postinstall', 'prepare']) assert.equal(manifest.scripts[key], undefined);
  assert.equal(manifest.dependencies, undefined);
  const host = await import(new URL(manifest.exports['.'], root));
  assert.equal(typeof host.apply, 'function');
  for (const injected of ['connection', 'workspaceRegistry', 'tools', 'systemPrompt']) {
    assert.ok(host.inject.includes(injected), `missing DSH injection: ${injected}`);
  }
  for (const guide of ['docs/trial.md', 'docs/requirements.md', 'docs/design.md']) {
    assert.ok(manifest.files.includes(guide), `guide not included: ${guide}`);
  }
  assert.equal(host.RPC_PATH, '/api/knowledge-library');
});
