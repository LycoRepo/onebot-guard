import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import fs from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseDocument, stringify } from 'yaml';
import { config, waitFor } from './helpers.ts';
import { PolicyReloader } from '../src/config/reload.ts';
import { Observability } from '../src/observability/index.ts';
import { Gateway } from '../src/route/index.ts';
import { WebUI } from '../src/webui/index.ts';
import { loadConfig } from '../src/config/load.ts';

async function fixture(t: TestContext, edit = true, hook = true, flow = false) {
  const cfg = config();
  cfg.webui = { ...cfg.webui, enabled: true, port: 0, read_token_env: 'READ_TOKEN', write_token_env: 'WRITE_TOKEN', allow_policy_edit: edit };
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.webui-config-'));
  const path = join(directory, 'gateway.yaml');
  const raw = '# header preserved\r\n' + stringify(cfg, { indent: 4, ...(flow ? { collectionStyle: 'flow' as const } : {}) }).replace(/\n/g, '\r\n').replace('\r\nroutes:', '\r\n# between sections preserved\r\nroutes:').replace('\r\npolicies:', '\r\n# policy comment preserved\r\npolicies:') + '# footer preserved\r\n';
  await writeFile(path, raw);
  const env = { TEST_TOKEN: 'ENDPOINT_TOKEN_PLACEHOLDER', READ_TOKEN: 'READ_TOKEN_PLACEHOLDER', WRITE_TOKEN: 'WRITE_TOKEN_PLACEHOLDER' };
  const observation = new Observability(cfg, () => {});
  const gateway = new Gateway(cfg, observation, env);
  let applied = 0; let restarts = 0; let responseReceived = false;
  const reloader = new PolicyReloader(path, cfg, () => { applied++; }, () => {});
  const webui = new WebUI(cfg, () => gateway.snapshot(), observation, reloader, path, env, Date.now, hook ? () => {
    assert.equal(responseReceived, true, 'response must arrive before restart');
    assert.equal(loadConfig(path).endpoints.downA!.port, 42002, 'file must be saved before restart');
    restarts++;
  } : undefined);
  t.after(async () => { await webui.stop(); await rm(directory, { recursive: true, force: true }); });
  await webui.start();
  const url = `http://127.0.0.1:${webui.address()!.port}`;
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: env.READ_TOKEN }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = (headers: Record<string, string> = { Cookie: cookie }) => fetch(url + '/api/config?view=editor', { headers });
  const put = (body: unknown, headers: Record<string, string> = {}, session = true) => fetch(url + '/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body),
  });
  const body = () => ({ endpoints: structuredClone(cfg.endpoints), routes: structuredClone(cfg.routes), restart: false });
  return { cfg, path, directory, raw, env, url, cookie, get, put, body, webui, reloader,
    counts: () => ({ restarts, applied }), received: () => { responseReceived = true; } };
}

test('PUT config rejects all invalid shapes, values and references without changing a single file byte', async t => {
  const h = await fixture(t); const original = await readFile(h.path);
  const cases: [string, (b: any) => unknown][] = [
    ['missing endpoints', b => { delete b.endpoints; return b; }],
    ['missing routes', b => { delete b.routes; return b; }],
    ['missing restart', b => { delete b.restart; return b; }],
    ['wrong restart type', b => ({ ...b, restart: 'false' })],
    ['unknown body key', b => ({ ...b, unknown: true })],
    ['endpoints array', b => ({ ...b, endpoints: [] })],
    ['routes object', b => ({ ...b, routes: {} })],
    ['endpoint missing field', b => { delete b.endpoints.up.expected_self_id; return b; }],
    ['endpoint unknown key', b => { b.endpoints.up.token = 'FORBIDDEN_TOKEN_PLACEHOLDER'; return b; }],
    ['endpoint wrong type', b => { b.endpoints.up.reconnect = 'true'; return b; }],
    ['port outside bounds', b => { b.endpoints.up.port = 65536; return b; }],
    ['invalid endpoint ID', b => { b.endpoints['1invalid'] = b.endpoints.up; delete b.endpoints.up; return b; }],
    ['missing endpoint reference', b => { b.routes[0].upstream = 'absent'; return b; }],
    ['missing policy reference', b => { b.routes[0].policy = 'absent'; return b; }],
    ['upstream principal', b => { b.endpoints.up.principal = 'APP_A'; return b; }],
    ['upstream readonly', b => { b.endpoints.up.readonly = true; return b; }],
    ['downstream self ID', b => { b.endpoints.downA.expected_self_id = 'ACCOUNT_A'; return b; }],
    ['connect host and port', b => { Object.assign(b.endpoints.up, { connection: 'connect', url: 'ws://example.invalid' }); return b; }],
    ['URL credential', b => { b.endpoints.up = { side: 'upstream', connection: 'connect', protocol: 'onebot_v11', token_env: 'TEST_TOKEN', expected_self_id: 'ACCOUNT_A', url: 'ws://user:password@example.invalid' }; return b; }],
    ['empty routes', b => ({ ...b, routes: [] })],
    ['duplicate downstream', b => { b.routes[1].downstream = 'downA'; return b; }],
    ['unused endpoint', b => { b.endpoints.unused = b.endpoints.up; return b; }],
    ['unknown route key', b => { b.routes[0].unknown = true; return b; }],
    ['missing route id', b => { delete b.routes[0].id; return b; }],
  ];
  for (const [name, change] of cases) {
    const response = await h.put(change(h.body()));
    assert.equal(response.status, 400, name); assert.equal((await response.json() as { ok: boolean }).ok, false);
    assert.deepEqual(await readFile(h.path), original, `${name}: rejected write must preserve all bytes`);
    assert.deepEqual(await readdir(h.directory), ['gateway.yaml']);
  }
  assert.deepEqual(h.counts(), { restarts: 0, applied: 0 });
});

function outsideNodes(raw: string): string[] {
  const doc = parseDocument(raw);
  const ranges = ['endpoints', 'routes'].map(k => (doc.get(k, true) as { range: [number, number, number] }).range).sort((a, b) => a[0] - b[0]);
  return [raw.slice(0, ranges[0]![0]), raw.slice(ranges[0]![1], ranges[1]![0]), raw.slice(ranges[1]![1])];
}

for (const flow of [false, true]) test(`Saving config replaces only endpoints and routes, preserves all outside bytes (flow=${flow}), never hot reloads`, async t => {
  const h = await fixture(t, true, true, flow); const body = h.body();
  body.endpoints.downA!.port = 42001; body.routes[0]!.id = 'updated_route';
  const response = await h.put(body); assert.equal(response.status, 200);
  assert.match((await response.json() as { message: string }).message, /重启后生效/);
  const updated = await readFile(h.path, 'utf8'); assert.notEqual(updated, h.raw);
  assert.deepEqual(outsideNodes(updated).map(s => Buffer.from(s)), outsideNodes(h.raw).map(s => Buffer.from(s)));
  assert.equal(loadConfig(h.path).endpoints.downA!.port, 42001); assert.equal(loadConfig(h.path).routes[0]!.id, 'updated_route');
  assert.equal(h.webui.config.endpoints.downA!.port, 0); assert.equal(h.reloader.current.routes[0]!.id, 'routeA');
  await new Promise(resolve => setTimeout(resolve, 250)); assert.deepEqual(h.counts(), { restarts: 0, applied: 0 });
  assert.deepEqual(await readdir(h.directory), ['gateway.yaml']);
});

test('Restart hook is injected, called exactly once after persistence and client response, and repeated restart is rejected unchanged', async t => {
  const h = await fixture(t); const body = h.body(); body.restart = true; body.endpoints.downA!.port = 42002;
  const response = await h.put(body); assert.equal(response.status, 202);
  assert.equal((await response.json() as { restart: boolean }).restart, true); h.received();
  assert.equal(h.counts().restarts, 0);
  const saved = await readFile(h.path);
  const repeat = await h.put(body); assert.equal(repeat.status, 400); await repeat.text();
  assert.deepEqual(await readFile(h.path), saved);
  await waitFor(() => h.counts().restarts === 1); await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(h.counts(), { restarts: 1, applied: 0 });
});

test('Missing restart hook rejects restart request before writing; ordinary save still works', async t => {
  const h = await fixture(t, true, false); const original = await readFile(h.path);
  const body = h.body(); body.restart = true;
  assert.equal((await h.put(body)).status, 400); assert.deepEqual(await readFile(h.path), original);
  body.restart = false; assert.equal((await h.put(body)).status, 200);
});

test('Config API requires sessions, respects edit flag, rejects origins, non-JSON, oversized bodies and methods with unchanged file', async t => {
  const h = await fixture(t); const original = await readFile(h.path);
  assert.equal((await h.get({})).status, 401);
  assert.equal((await h.get({ Authorization: `Bearer ${h.env.READ_TOKEN}` })).status, 401);
  assert.equal((await h.put(h.body(), {}, false)).status, 401);
  assert.equal((await h.put(h.body(), { Authorization: `Bearer ${h.env.WRITE_TOKEN}` }, false)).status, 401);
  for (const Origin of ['http://cross-origin.invalid', 'null']) {
    assert.equal((await h.get({ Cookie: h.cookie, Origin })).status, 403);
    assert.equal((await h.put(h.body(), { Origin })).status, 403);
  }
  assert.equal((await h.put(h.body(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await h.put({ padding: 'X'.repeat(1048576) })).status, 400);
  const malformed = await fetch(h.url + '/api/config', { method: 'PUT', headers: { Cookie: h.cookie, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  for (const method of ['POST', 'DELETE', 'PATCH']) {
    const response = await fetch(h.url + '/api/config', { method, headers: { Cookie: h.cookie } });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, PUT');
  }
  assert.deepEqual(await readFile(h.path), original);
  const disabled = await fixture(t, false); const before = await readFile(disabled.path);
  assert.equal((await disabled.put(disabled.body())).status, 404);
  assert.equal((await disabled.put(disabled.body(), {}, false)).status, 404);
  assert.deepEqual(await readFile(disabled.path), before);
  assert.equal((await disabled.get()).status, 200);
});

test('GET config projects only endpoint definitions, route definitions and policy names without secrets, paths or other sections', async t => {
  const h = await fixture(t); const response = await h.get(); assert.equal(response.status, 200);
  const text = await response.text();
  for (const secret of [...Object.values(h.env), h.path, 'write_token_env', 'runtime', 'extensions', 'yaml']) assert.equal(text.includes(secret), false, secret);
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['endpoints', 'policies', 'routes']);
  assert.deepEqual(body.policies, ['main']); assert.deepEqual(body.routes, h.cfg.routes);
  assert.deepEqual(body.endpoints.up, { id: 'up', side: 'upstream', connection: 'listen', protocol: 'onebot_v11', token_env: 'TEST_TOKEN', reconnect: true, host: '127.0.0.1', port: 0, expected_self_id: 'ACCOUNT_A', used: true });
  assert.equal(body.endpoints.downA.principal, 'APP_A'); assert.equal(body.endpoints.downA.readonly, false);
  // Never expose forbidden credential fields added by an external edit.
  const invalid = structuredClone(h.cfg) as any; invalid.endpoints.up.token = h.env.TEST_TOKEN;
  await writeFile(h.path, stringify(invalid));
  const denied = await h.get(); assert.equal(denied.status, 400); assert.equal((await denied.text()).includes(h.env.TEST_TOKEN), false);
});

test('Atomic rename failure leaves config bytes untouched and removes temporary file', async t => {
  const h = await fixture(t); const original = await readFile(h.path); const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('FILESYSTEM_FAILURE_PLACEHOLDER'); };
    const response = await h.put(h.body()); assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /FILESYSTEM_FAILURE_PLACEHOLDER/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(await readFile(h.path), original); assert.deepEqual(await readdir(h.directory), ['gateway.yaml']);
});

test('TLS is excluded from GET and unsupported additions or silent removal are rejected unchanged', async t => {
  const h = await fixture(t); const body = h.body(); const original = await readFile(h.path);
  body.endpoints.up!.tls = { cert_env: 'CERT_ENV', key_env: 'KEY_ENV' };
  assert.equal((await h.put(body)).status, 400); assert.deepEqual(await readFile(h.path), original);
  await writeFile(h.path, stringify({ ...h.cfg, endpoints: body.endpoints }));
  const existing = await readFile(h.path);
  const response = await h.get(); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /CERT_ENV|KEY_ENV|tls/);
  assert.equal((await h.put(h.body())).status, 400); assert.deepEqual(await readFile(h.path), existing);
});

test('Native panel forms submit shared drafts and keep restart notice readable for at least 1.5 seconds before login navigation', async t => {
  const h = await fixture(t); const fresh = await fixture(t);
  const nodes = new Map<string, any>(); const destinations: string[] = []; const requests: any[] = [];
  let navigatedAt = 0;
  class Node {
    children: any[] = []; listeners: Record<string, (...args: any[]) => any> = {};
    value = ''; checked = false; disabled = false; hidden = false; className = ''; type = ''; tag: string; text = '';
    classList = { add() {}, remove() {}, toggle() {} };
    constructor(tag: string) { this.tag = tag; }
    set id(id: string) { nodes.set(id, this); }
    set textContent(text: string) { this.text = String(text); }
    get textContent() { return this.text; }
    append(...children: any[]) { this.children.push(...children); }
    replaceChildren(...children: any[]) { this.children = children; }
    addEventListener(event: string, handler: (...args: any[]) => any) { this.listeners[event] = handler; }
  }
  const getNode = (id: string): any => { if (!nodes.has(id)) nodes.set(id, new Node('div')); return nodes.get(id); };
  const context = createContext({
    document: { getElementById: getNode, createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => ({ text }), querySelectorAll: () => [], body: { dataset: {} } },
    window: { addEventListener() {} }, sessionStorage: { removeItem() {} }, location: { hash: '#/endpoints', replace: (url: string) => { navigatedAt = performance.now(); destinations.push(url); } },
    // Real timers: accelerating this wait would hide an unreadably short notice.
    setTimeout, clearTimeout, AbortController, AbortSignal,
    fetch: async (path: string, options: RequestInit = {}) => {
      requests.push({ path, options });
      const base = path === '/api/state' && h.counts().restarts ? fresh.url : h.url;
      const response = await fetch(base + path, { ...options, headers: { ...options.headers, Cookie: h.cookie } });
      if (path === '/api/config' && options.method === 'PUT') { await response.clone().text(); h.received(); }
      return response;
    },
  });
  const script = (await readFile(new URL('../src/webui/static/app.js', import.meta.url), 'utf8')).replace(/connect\(\);\s*$/, '');
  runInContext(script, context);
  await runInContext('allowEdit = true; loadConfig(generation)', context);
  assert.equal(getNode('config-controls').hidden, false); assert.equal(getNode('config-save').disabled, false);
  const fields = () => getNode('endpoints-upstream').children[0].children[2];
  const fieldNames = () => fields().children.map((n: any) => n.text);
  assert.ok(fieldNames().includes('监听地址')); assert.ok(!fieldNames().includes('连接地址')); assert.ok(!fieldNames().includes('下游主体'));
  let connection = fields().children[0].children.at(-1); connection.value = 'connect'; connection.listeners.change();
  assert.ok(fieldNames().includes('连接地址')); assert.ok(!fieldNames().includes('监听地址')); assert.ok(!fieldNames().includes('监听端口'));
  connection = fields().children[0].children.at(-1); connection.value = 'listen'; connection.listeners.change();
  await runInContext("configDraft.endpoints.up.expected_self_id = ''; saveConfig(false)", context);
  assert.match(getNode('config-result').textContent, /endpoints.up.expected_self_id/); assert.equal(getNode('config-save').disabled, false);
  const saving = runInContext("configDraft.endpoints.up.expected_self_id = 'ACCOUNT_A'; configDraft.endpoints.downA.port = 42001; saveConfig(false)", context);
  assert.equal(getNode('config-save').disabled, true); assert.equal(getNode('config-restart').disabled, true);
  await saving; assert.match(getNode('config-result').textContent, /重启后生效/); assert.equal(h.counts().restarts, 0);
  const savedRequest = requests.filter(r => r.options.method === 'PUT').at(-1); const payload = JSON.parse(savedRequest.options.body);
  assert.equal(payload.restart, false); assert.equal(payload.endpoints.downA.port, 42001); assert.equal('id' in payload.endpoints.up, false); assert.equal('used' in payload.endpoints.up, false);
  assert.equal('host' in payload.endpoints.up, true); assert.equal('url' in payload.endpoints.up, false);
  getNode('route-add').listeners.click(); assert.equal(getNode('route-editor').children.length, 3);
  getNode('route-editor').children[2].children.at(-1).listeners.click(); assert.equal(getNode('route-editor').children.length, 2);
  await runInContext('configDraft.endpoints.downA.port = 42002; saveConfig(true)', context);
  assert.deepEqual(destinations, []); assert.match(getNode('connection').textContent, /正在重启/);
  const notice = '网关已重启，请重新登录';
  await waitFor(() => getNode('connection').textContent === notice, 4000);
  const visibleSince = performance.now();
  const assertReadableBeforeNavigation = () => {
    assert.deepEqual(destinations, [], 'the panel must stay open while the notice is readable');
    assert.equal(getNode('connection').textContent, notice);
    assert.equal(getNode('connection').hidden, false);
    assert.equal(getNode('config-result').textContent, notice);
    assert.equal(getNode('config-result').hidden, false);
    assert.equal(getNode('config-controls').hidden, false);
  };
  while (performance.now() - visibleSince < 1500) {
    assertReadableBeforeNavigation();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assertReadableBeforeNavigation();
  await waitFor(() => destinations.length === 1);
  assert.ok(navigatedAt - visibleSince >= 1500, 'notice must remain readable for at least 1.5 seconds');
  assert.deepEqual(destinations, ['/']); assert.equal(h.counts().restarts, 1);
});
