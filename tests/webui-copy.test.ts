import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const script = (await readFile(new URL('../src/webui/static/app.js', import.meta.url), 'utf8')).replace(/connect\(\);\s*$/, '');

function panel() {
  class Node {
    children: Node[] = [];
    text = ''; className = ''; title = ''; value = ''; type = ''; hidden = false;
    classList = { add() {}, remove() {}, toggle() {} };
    tag: string;
    constructor(tag: string) { this.tag = tag; }
    set textContent(value: string) { this.text = String(value); this.children = []; }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
    get firstChild() { return this.children[0]!; }
    get lastChild() { return this.children.at(-1)!; }
    append(...children: Node[]) { this.children.push(...children); }
    replaceChildren(...children: Node[]) { this.text = ''; this.children = children; }
    addEventListener() {}
  }
  const nodes = new Map<string, Node>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node('div')); return nodes.get(id)!; };
  const context = createContext({
    document: { getElementById: get, createElement: (tag: string) => new Node(tag), querySelectorAll: () => [], body: { dataset: {} } },
    window: { addEventListener() {} }, sessionStorage: { removeItem() {} }, location: { hash: '#/overview' },
  });
  runInContext(script, context);
  return { get, run: (code: string) => runInContext(code, context) };
}

test('Connection and readiness stay distinct for every combination of runtime states', () => {
  const { run } = panel();
  for (const isConnected of [false, true]) for (const isReady of [false, true]) {
    const row = run(`endpointCard('UPSTREAM', { side: 'upstream', onebot: 'onebot_v11', connection: 'listen', connected: ${isConnected}, ready: ${isReady}, buffered_bytes: 0, reconnect_attempts: 0 })`);
    assert.ok(row.textContent.includes(`${isConnected ? '已连接' : '未连接'} · ${isReady ? '已就绪' : '未就绪'}`));
  }
});

test('Overview and runtime route table use the same readiness and decision words', () => {
  const { get, run } = panel();
  run(`render({ healthy: false, started_at: '2026-01-01T00:00:00Z', last_event_at: null, totals: { allowed: 7, denied: 3 }, endpoints: {}, routes: [{ id: 'ROUTE_ALLOWED', upstream_ready: true, downstream_ready: false, ready: false, pending_requests: 0 }], queues: {}, hits_by_rule: {}, transport_issues: {}, allow_policy_edit: false, log_ring_size: 200, reload: null })`);
  assert.match(get('overview').textContent, /网关状态未就绪.*放行7拦下3/);
  const date = get('overview').children[1]!.lastChild;
  assert.equal(date.title, date.textContent, 'a shortened date must retain its full value');
  assert.deepEqual(get('routes').children[0]!.children.slice(1, 4).map(n => n.textContent), ['已就绪', '未就绪', '未就绪']);
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
  assert.equal(row.children[2].textContent, '上游回包');
  assert.match(row.children[3].textContent, /回包已送回/);
  assert.equal(run(`human('sources', 'NEW_SOURCE')`), 'NEW_SOURCE');
  assert.equal(run(`human('rules', 'NEW_RULE')`), 'NEW_RULE');
  assert.equal(run(`human('rules', 'NEW_RULE', 'FALLBACK')`), 'FALLBACK');
  run(`reload({ time: null, ok: false, reason: 'BACKEND_REASON_UNCHANGED' })`);
  assert.match(get('reload-status').textContent, /BACKEND_REASON_UNCHANGED$/);
  assert.match(run(`logRow({ event: 'reload', ok: false, reason: 'BACKEND_REASON_UNCHANGED' }).textContent`), /BACKEND_REASON_UNCHANGED$/);
});
