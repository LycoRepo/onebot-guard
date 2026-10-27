import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const script = (await readFile(new URL('../src/webui/static/app.js', import.meta.url), 'utf8')).replace(/connect\(\);\s*$/, '');

function panel(fetch?: typeof globalThis.fetch) {
  class Node {
    children: Node[] = [];
    text = ''; className = ''; title = ''; value = ''; type = ''; hidden = false; disabled = false;
    dataset: Record<string, string> = {};
    listeners: Record<string, (...args: any[]) => any> = {};
    classList = { add() {}, remove() {}, toggle() {} };
    tag: string;
    constructor(tag: string) { this.tag = tag; }
    set textContent(value: string) { this.text = String(value); this.children = []; }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
    get firstChild() { return this.children[0]!; }
    get lastChild() { return this.children.at(-1)!; }
    append(...children: Node[]) { this.children.push(...children); }
    replaceChildren(...children: Node[]) { this.text = ''; this.children = children; }
    addEventListener(name: string, handler: (...args: any[]) => any) { this.listeners[name] = handler; }
    setAttribute(name: string, value: string) { if (name.startsWith('data-')) this.dataset[name.slice(5)] = value; }
  }
  const nodes = new Map<string, Node>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node('div')); return nodes.get(id)!; };
  const events: Record<string, (...args: any[]) => any> = {};
  const context = createContext({
    document: { getElementById: get, createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => Object.assign(new Node('text'), { text }), querySelectorAll: () => [], body: { dataset: {} } },
    window: { addEventListener(name: string, handler: (...args: any[]) => any) { events[name] = handler; }, confirm: () => true }, sessionStorage: { removeItem() {} }, location: { hash: '#/overview' }, fetch,
  });
  runInContext(script, context);
  return { get, events, run: (code: string) => runInContext(code, context) };
}

test('Connection and readiness stay distinct for every combination of runtime states', () => {
  const { run } = panel();
  for (const isConnected of [false, true]) for (const isReady of [false, true]) {
    const row = run(`runtimeOnlyRow('UPSTREAM', { side: 'upstream', onebot: 'onebot_v11', connection: 'listen', connected: ${isConnected}, ready: ${isReady}, buffered_bytes: 0, reconnect_attempts: 0 })`);
    assert.ok(row.textContent.includes(`${isConnected ? '已连接' : '未连接'} · ${isReady ? '已就绪' : '未就绪'}`));
  }
});

test('Deleting the last route is dirty and protects against leaving; discard restores the saved draft', () => {
  const { get, run, events } = panel();
  run(`savedConfig = { endpoints: {}, routes: [{id: 'last', upstream: 'up', downstream: 'down', policy: 'main'}], policies: ['main'] }; configDraft = clone(savedConfig); configDraft.routes = []`);
  assert.equal(run('configIsDirty()'), true);
  let prevented = false;
  events.beforeunload!({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  run('renderDraftSummary()');
  assert.match(get('config-draft').textContent, /路由改动：有/);
  run('discardConfig()');
  assert.equal(run('configIsDirty()'), false);
  assert.equal(run('configDraft.routes.length'), 1);
  assert.equal(get('route-runtime').hidden, false);
});

test('Rule and YAML drafts are also protected when leaving', () => {
  for (const flag of ['rulesDirty', 'policyDirty']) {
    const { run, events } = panel();
    run(`${flag} = true`);
    let prevented = false;
    events.beforeunload!({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, flag);
  }
});

test('Readonly and in-flight endpoint fields cannot be edited', () => {
  const { run } = panel();
  for (const setup of ['allowEdit = false; configBusy = false', 'allowEdit = true; configBusy = true']) {
    run(setup);
    assert.equal(run(`fieldRow('up', 'url', 'ws://localhost', () => {}).children[1].children[0].disabled`), true);
    assert.equal(run(`fieldRow('up', 'connection', 'listen', () => {}, {choices: CONNECTION_CHOICES}).children[1].children[0].disabled`), true);
  }
});

test('A pending restart confirmation is invalidated when the draft changes', () => {
  const { get, run } = panel();
  get('config-restart').dataset.confirm = 'yes';
  run('touchDraft()');
  assert.equal(get('config-restart').dataset.confirm, 'no');
  assert.equal(get('config-restart').textContent, '保存并重启');
});

test('Log search combines event type and route text without removing buffered rows', () => {
  const { get, run } = panel();
  run(`$('logs').append(logRow({event:'allowed', route:'routeA', rule:'action.send'}), logRow({event:'denied', route:'routeB', rule:'event.keyword'}))`);
  get('log-filter').value = 'denied'; get('log-search').value = 'routeB';
  run('filterLogs()');
  assert.equal(get('logs').children[0]!.hidden, true);
  assert.equal(get('logs').children[1]!.hidden, false);
  assert.match(get('log-count').textContent, /^1 \/ 2/);
  get('log-search').value = 'missing'; run('filterLogs()');
  assert.match(get('log-count').textContent, /无匹配/);
  assert.equal(get('logs').children.length, 2);
});

test('Policy selection loads its rules and failed switches preserve the prior draft', async () => {
  const calls: string[] = [];
  const { get, run } = panel(async path => {
    calls.push(String(path));
    if (String(path).includes('other')) return new Response(JSON.stringify({error: 'offline'}), {status: 503});
    return new Response(JSON.stringify({policy:'main', policies:['main','other'], rules:{receive:{group_ids:['A'], user_ids:[], keywords:[], keywords_regex:[], blocked_segments:[]}, send:{group_ids:[], user_ids:[], segments:['text']}}}));
  });
  await run('allowEdit = true; loadRules(generation)');
  assert.equal(get('rules-policy-select').children.length, 2);
  assert.equal(get('rules-save').disabled, false);
  get('rules-groups').value = 'UNSAVED'; run('rulesDirty = true');
  get('rules-policy-select').value = 'other';
  await get('rules-policy-select').listeners.change!();
  assert.equal(get('rules-policy-select').value, 'main');
  assert.equal(get('rules-groups').value, 'UNSAVED');
  assert.equal(run('rulesDirty'), true);
  assert.ok(calls.includes('/api/rules?policy=other'));
});

test('Saving an endpoint deletion removes it from both saved baseline and future payloads', async () => {
  const { run } = panel(async () => new Response(JSON.stringify({ok:true})));
  run(`allowEdit = true; configLoaded = true;
    configDraft = { endpoints: { up: {side:'upstream'}, down: {side:'downstream'}, removed: {side:'downstream'} }, routes: [{id:'r', upstream:'up', downstream:'down', policy:'main'}], policies:['main'] };
    savedConfig = clone(configDraft); pendingDelete.set('removed', {side:'downstream'});`);
  await run('saveConfig(false)');
  assert.equal(run(`'removed' in configDraft.endpoints`), false);
  assert.equal(run(`'removed' in savedConfig.endpoints`), false);
  assert.equal(run('configIsDirty()'), false);
  assert.equal(run('pendingRestart'), true);
});

test('Overview and runtime route table use the same readiness and decision words', () => {
  const { get, run } = panel();
  run(`render({ healthy: false, started_at: '2026-01-01T00:00:00Z', last_event_at: null, totals: { allowed: 7, denied: 3 }, endpoints: {}, routes: [{ id: 'ROUTE_ALLOWED', upstream_ready: true, downstream_ready: false, ready: false, pending_requests: 0 }], queues: {}, hits_by_rule: {}, transport_issues: {}, allow_policy_edit: false, log_ring_size: 200, reload: null })`);
  assert.match(get('overview').textContent, /网关状态未就绪.*累计放行（次，非送达数）7累计拦下（次）3/);
  const date = get('overview').children[1]!.lastChild;
  assert.equal(date.title, date.textContent, 'a shortened date must retain its full value');
  assert.deepEqual(get('routes').children[0]!.children.slice(1, 4).map(n => n.textContent), ['已就绪', '未就绪', '未就绪']);
});

test('Overview distinguishes connected sessions from ready routes and shows empty runtime routes', () => {
  const { get, run } = panel();
  run(`render({ healthy: false, started_at: null, last_event_at: null, totals: { allowed: 0, denied: 0 }, endpoints: { a: { side: 'upstream', connected: true, ready: false }, b: { side: 'downstream', connected: false, ready: false } }, routes: [{ id: 'r', ready: false, upstream_ready: false, downstream_ready: false, pending_requests: 0 }], policies: ['p', 'q'], queues: {}, hits_by_rule: {}, transport_issues: {}, allow_policy_edit: false, log_ring_size: 200, reload: null })`);
  assert.equal(get('session-summary').textContent, '上游会话（已连接 / 总端点）1 / 1下游会话（已连接 / 总端点）0 / 1路由（已就绪 / 总数）0 / 1');
  assert.equal(get('policy-summary').textContent, '已加载策略（份，至少 1）2编辑权限只读模式策略加载状态尚无重新加载记录');
  assert.equal(get('overview').firstChild.lastChild.className, 'warn');
  run(`render({ healthy: true, started_at: null, last_event_at: null, totals: { allowed: 0, denied: 0 }, endpoints: {}, routes: [], policies: [], queues: {}, hits_by_rule: {}, transport_issues: {}, allow_policy_edit: true, log_ring_size: 200, reload: { ok: false } })`);
  assert.match(get('routes').textContent, /暂无运行路由/);
  assert.match(get('policy-summary').textContent, /已加载策略（份，至少 1）0编辑权限可编辑策略加载状态策略加载失败/);
  assert.equal(get('overview').firstChild.lastChild.className, 'ok');
});

test('Field labels put Chinese first and keep keys and credential guidance separate', () => {
  const { get, run } = panel();
  run(`configField($('fields'), 'token_env', 'ENDPOINT_TOKEN', () => {})`);
  const label = get('fields').children[0]!;
  assert.equal(label.text, '凭据环境变量');
  assert.equal(label.children[0]!.className, 'field-key');
  assert.equal(label.children[0]!.textContent, 'token_env');
  assert.match(label.children[1]!.textContent, /环境变量名.*不要填写凭据值/);
  assert.equal(label.lastChild.value, 'ENDPOINT_TOKEN');
  assert.equal(run(`human('fields', 'upstream')`), '上游端点');
  assert.equal(run(`human('fields', 'downstream')`), '下游端点');
});

test('Log sources use the shared glossary while backend reasons and unknown codes remain verbatim', () => {
  const { get, run } = panel();
  const row = run(`logRow({ event: 'allowed', direction: 'response', rule: 'response.correlated', time: '2026-01-01T00:00:00Z' })`);
  assert.equal(row.children[1].textContent, '放行');
  assert.equal(row.children[2].textContent, '上游响应');
  assert.match(row.children[3].textContent, /响应转发放行/);
  assert.equal(run(`human('sources', 'NEW_SOURCE')`), 'NEW_SOURCE');
  assert.equal(run(`human('rules', 'NEW_RULE')`), 'NEW_RULE');
  assert.equal(run(`human('rules', 'NEW_RULE', 'FALLBACK')`), 'FALLBACK');
  run(`reload({ time: null, ok: false, reason: 'BACKEND_REASON_UNCHANGED' })`);
  assert.match(get('reload-status').textContent, /BACKEND_REASON_UNCHANGED$/);
  assert.match(run(`logRow({ event: 'reload', ok: false, reason: 'BACKEND_REASON_UNCHANGED' }).textContent`), /BACKEND_REASON_UNCHANGED$/);
});

test('Loaded YAML status shows only editability in both editable and read-only modes', async () => {
  for (const editable of [true, false]) {
    const { get, run } = panel(async () => new Response(JSON.stringify({ yaml: 'POLICY_ALLOWED: {}', allow_policy_edit: editable, reload: null })));
    await run('loadPolicies(generation)');
    assert.equal(get('policy-result').textContent, editable ? '可编辑' : '只读模式');
    assert.equal(get('edit-controls').hidden, !editable);
    assert.equal(get('policy-yaml').value, 'POLICY_ALLOWED: {}');
  }
});
