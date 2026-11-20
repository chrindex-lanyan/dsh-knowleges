// Opt-in smoke test against the published same-version DSH SDK in a disposable
// npm prefix. It does not start a server or interact with the user's profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function smokeDsh(profileDir, { sdkAnchor, tempRoot = tmpdir() } = {}) {
  const profile = resolve(profileDir);
  const anchor = join(profile, 'package.json');
  const require = createRequire(anchor);
  const sdkRequire = createRequire(sdkAnchor ?? anchor);
  const from = name => import(pathToFileURL(sdkRequire.resolve(name)).href);
  async function optionalExecutor(name) {
    let file;
    try { file = sdkRequire.resolve(name); }
    catch (error) {
      // The installation ships these executors, but not every SDK package is published.
      if (!sdkAnchor && error.code === 'MODULE_NOT_FOUND') return;
      throw error;
    }
    return import(pathToFileURL(file).href);
  }
  const { Context } = await from('@deepseek-ai/cordis');
  const { HostConnectionService } = await from('@deepseek-ai/dsh-client-connection');
  const { ToolsService, projectToolSchema } = await from('@deepseek-ai/dsh-tools');
  const nativeExecutor = await optionalExecutor('@deepseek-ai/dsh-tool-executor-native');
  const ptcExecutor = await optionalExecutor('@deepseek-ai/dsh-tool-executor-ptc');
  const pipeline = nativeExecutor ? undefined : await from('@deepseek-ai/dsh-tools/pipeline');
  const { SystemPrompt, renderPrompt } = await from('@deepseek-ai/dsh-system-prompt');
  const { composeEntries, loadProfileDirectory } = await from('@deepseek-ai/dsh-app-boot');
  const plugin = await import(pathToFileURL(require.resolve('dsh-knowledge-library')).href);

  const loaded = loadProfileDirectory('knowledge-smoke', profile, anchor, { userLayer: false });
  assert.deepEqual(loaded.skippedBundles, []);
  assert.deepEqual(loaded.layers.map(row => row.packageName), ['dsh-knowledge-library']);
  const rows = composeEntries(loaded.layers.map(row => row.patches));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'dsh-knowledge-library');
  assert.equal(rows[0].config.mode, 'preview');

  const testHome = mkdtempSync(join(tempRoot, 'dsh-k-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = testHome;
  const app = new Context();
  const workspace = { id: 'workspace-fixture', title: 'SDK fixture', path: join(testHome, 'fixture'), sessionIds: ['fixture-session'] };
  const registry = { list: () => [workspace], archivedSessionIds: [] };
  const ptcEvents = [];
  const actor = {
    id: 'fixture-session', status: 'running', ctx: app,
    session: { id: 'fixture-session', append: kind => { ptcEvents.push(kind); } },
  };
  const fixtures = {
    name: 'knowledge-sdk-fixtures',
    apply(ctx) {
      ctx.provide('workspaceRegistry', registry);
      ctx.provide('agents', { get: id => id === actor.id ? actor : undefined });
      ctx.provide('workingDirectory', { ensure: async () => testHome });
      ctx.provide('webServer', { host: '127.0.0.1', protocol: 'http:' });
      ctx.provide('ptcRuntime', {
        language: 'typescript', programFormat: 'function-body',
        resolve: request => ({ ...request, timeoutMs: null }),
        release() {},
        async run({ bindings }) {
          // Exercise the real nested SDK binding; never evaluate the program or start a subprocess.
          const search = bindings.find(namespace => namespace.global === 'tools').functions.knowledge_search;
          return { logs: [], value: search ? await search({ scope: 'workspace' }) : null };
        },
      });
    },
  };
  try {
    await app.plugin(fixtures).await();
    const promptFiber = app.plugin(SystemPrompt, {});
    await promptFiber.await();
    let connection;
    let tools;
    let prompt;
    const sdk = app.plugin({
      name: 'knowledge-sdk-services', inject: ['systemPrompt'],
      apply(ctx) {
        connection = new HostConnectionService(ctx, [], {
          isAuthenticated: request => request.headers.get('x-sdk-fixture') === 'browser',
          authenticateApi: () => undefined,
        });
        tools = new ToolsService(ctx);
        prompt = ctx.systemPrompt;
      },
    });
    await sdk.await();
    const native = app.plugin(nativeExecutor ?? {
      name: 'knowledge-smoke-native-dispatch', inject: ['tools'],
      apply(ctx) {
        const dispatcher = new pipeline.ToolExecutionPipeline(ctx);
        ctx.tools.setExecutor({
          describe: definitions => ({ schemas: definitions.map(def => projectToolSchema(def, false)) }),
          execute: input => pipeline.executeToolBatch(input, dispatcher, () => 1),
        });
      },
    });
    await native.await();
    const installed = app.plugin(plugin, rows[0].config);
    await installed.await();
    const handler = connection.createSharedFetchHandler('/api');
    const headers = { host: '127.0.0.1:8123', origin: 'http://127.0.0.1:8123', 'content-type': 'application/json' };
    const request = (body, browser = true) => new Request('http://127.0.0.1:8123/api/knowledge-library', {
      method: 'POST', headers: { ...headers, ...(browser ? { 'x-sdk-fixture': 'browser' } : {}) }, body: JSON.stringify(body),
    });
    const program = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
    assert.equal((await handler.fetch(request({ op: 'libraries' }, false), program)).status, 403);
    const read = async body => {
      const response = await handler.fetch(request(body), connection.browserPeer);
      const data = await response.json();
      assert.equal(data.ok, true, JSON.stringify(data));
      return data.value;
    };
    const signal = new AbortController().signal;
    const step = () => tools.resolve({ agent: actor, modelSelection: { provider: 'fixture', model: 'fixture' }, signal });
    const assembled = toolSet => prompt.assemble({ agent: actor, scope: actor, signal, toolSet });
    const caps = assembly => assembly.tools.map(tool => tool.name).filter(name => name.startsWith('knowledge_'));
    function invoke(operation, toolSet, args) {
      const name = 'knowledge_' + operation;
      assert.ok(tools.executable(name, actor, toolSet), 'tool unavailable in actual DSH step: ' + operation);
      return dispatch(name, toolSet, args);
    }
    async function dispatch(name, toolSet, args) {
      const { results: [{ result }] } = await tools.execute({
        calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }],
        agent: actor, signal, toolSet,
      });
      assert.equal(result.isError, false, JSON.stringify(result.error));
      return result.value;
    }
    const list = await read({ op: 'libraries' });
    assert.equal(list.mode, 'preview');
    assert.equal(list.libraries[1].title, 'SDK fixture');
    assert.deepEqual(tools.definitions(), []);
    const preview = await step();
    assert.deepEqual(caps(await assembled(preview)), []);
    assert.doesNotMatch(renderPrompt(await assembled(preview)), /DSH knowledge library/);
    const library = list.libraries[1].key;
    const { proposal } = await read({ op: 'stage', library, kind: 'create', draft: { title: 'SDK check', detail: 'private synthetic fixture' } });
    assert.deepEqual((await read({ op: 'entries', library })).items, []);
    assert.equal((await read({ op: 'decide', library, id: proposal.id, digest: proposal.digest, decision: 'approve' })).state, 'applied');
    const known = (await read({ op: 'entries', library })).items[0];
    assert.equal(known.title, 'SDK check');

    const enable = { op: 'setSessionTools', enabled: true, confirmTrial: true };
    assert.equal((await handler.fetch(request(enable, false), program)).status, 403);
    assert.equal((await handler.fetch(request({ ...enable, confirmTrial: false }), connection.browserPeer)).status, 400);
    assert.deepEqual(await read(enable), { mode: 'trial' });
    assert.equal(tools.definitions().length, 7);
    assert.deepEqual(caps(await assembled(preview)), []);
    const trial = await step();
    const requested = await assembled(trial);
    assert.equal(caps(requested).length, 7);
    assert.ok(caps(requested).includes('knowledge_propose_batch'));
    const rendered = renderPrompt(requested);
    assert.match(rendered, /DSH knowledge library/);
    assert.match(rendered, /global reads require independent authorization/);
    assert.match(rendered, /Every write needs separate human confirmation/);
    assert.doesNotMatch(rendered, /private synthetic fixture|fixture-session|workspace-fixture/);
    assert.doesNotMatch(renderPrompt(await prompt.assemble({ scope: actor, signal, toolSet: trial })), /DSH knowledge library/);
    assert.equal(tools.executable('knowledge_search', actor), undefined);
    assert.equal(tools.executable('knowledge_search', { ...actor }, trial), undefined);
    assert.equal((await invoke('search', trial, { scope: 'workspace' })).value.items[0].id, known.id);
    const batchRead = await invoke('get_many', trial, { scope: 'workspace', ids: [known.id] });
    assert.deepEqual(batchRead.value.items.map(item => item.id), [known.id]);
    assert.equal(Object.hasOwn(batchRead.value.items[0], 'sources'), false);
    assert.equal((await invoke('search', trial, { scope: 'global' })).error.code, 'READ_APPROVAL_REQUIRED');
    const batchWrite = await invoke('propose_batch', trial, { scope: 'workspace', items: [
      { kind: 'create', draft: { title: 'fixture batch A', detail: 'synthetic' } },
      { kind: 'create', draft: { title: 'fixture batch B', detail: 'synthetic' } },
    ] });
    assert.equal(batchWrite.value.state, 'pending');
    assert.equal(batchWrite.value.itemCount, 2);
    assert.equal((await read({ op: 'entries', library })).items.length, 1);
    const { batch } = await read({ op: 'batchProposal', library, id: batchWrite.value.id });
    assert.equal((await read({ op: 'decideBatch', library, id: batch.id, digest: batch.digest, decision: 'approve' })).state, 'applied');
    assert.equal((await read({ op: 'entries', library })).items.length, 3);
    assert.deepEqual((await invoke('proposal_status', trial, { scope: 'workspace', id: batch.id, batch: true })).value,
      { id: batch.id, state: 'applied', itemCount: 2 });
    actor.status = 'idle';
    assert.doesNotMatch(renderPrompt(await assembled(trial)), /DSH knowledge library/);
    assert.deepEqual(caps(await assembled(await step())), []);
    actor.status = 'running';
    const held = tools.executable('knowledge_search', actor, trial);
    assert.deepEqual(await read({ op:'setSessionTools', enabled:false }),{ mode:'preview' });
    assert.deepEqual(tools.definitions(), []);
    assert.deepEqual(caps(await assembled(trial)), []);
    assert.equal((await held.execute({scope:'workspace'}, {agent:actor,signal,toolSet:trial,callId:randomUUID()})).error.code,'MODEL_DISABLED');
    assert.deepEqual(await read(enable), { mode: 'trial' });
    assert.deepEqual(caps(await assembled(trial)), []);
    assert.equal((await held.execute({scope:'workspace'}, {agent:actor,signal,toolSet:trial,callId:randomUUID()})).error.code,'MODEL_DISABLED');
    preview.dispose();
    trial.dispose();
    await installed.dispose();
    assert.deepEqual(tools.definitions(), []);
    assert.equal((await handler.fetch(request({ op: 'libraries' }), connection.browserPeer)).status, 404);
    const restarted = app.plugin(plugin, rows[0].config);
    await restarted.await();
    assert.equal((await read({ op:'libraries' })).mode,'preview');
    assert.equal((await read({ op:'entries', library })).items.length,3);
    assert.deepEqual(caps(await assembled(await step())), []);
    await restarted.dispose();
    const explicit = app.plugin(plugin, { mode:'trial' });
    await explicit.await();
    assert.equal(caps(await assembled(await step())).length,7);
    await native.dispose();
    if (ptcExecutor) {
      const ptc = app.plugin(ptcExecutor);
      await ptc.await();
      const ptcStep = await step();
      const codeMode = await assembled(ptcStep);
      assert.deepEqual(codeMode.tools.map(tool => tool.name), ['run_code']);
      assert.match(renderPrompt(codeMode), /DSH knowledge library/);
      assert.match(renderPrompt(codeMode), /knowledge_propose_batch/);
      const runCode = () => dispatch('run_code', ptcStep, { code: 'return null', description: 'Verify the SDK fixture binding' });
      assert.equal((await runCode()).result.value.items.length, 0);
      assert.deepEqual(ptcEvents, ['tool/ptc-dispatch-start', 'tool/ptc-dispatch']);
      assert.deepEqual(await read({ op:'setSessionTools', enabled:false }), { mode:'preview' });
      assert.doesNotMatch(renderPrompt(await assembled(ptcStep)), /DSH knowledge library|knowledge_propose_batch/);
      assert.equal((await runCode()).result, null);
      assert.equal(ptcEvents.length, 2);
      ptcStep.dispose();
      await ptc.dispose();
    }
    await explicit.dispose();
    assert.deepEqual(tools.definitions(), []);
    await program.dispose();
    await sdk.dispose();
    await promptFiber.dispose();
    console.log('PASS: actual DSH profile, Native dispatch' + (ptcExecutor ? ' and PTC nested dispatch' : '')
      + ', step guidance, owner-only toggle, grants, batch approval and disposal');
  } finally {
    await app.fiber.dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(testHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await smokeDsh(process.argv[2]);
}
