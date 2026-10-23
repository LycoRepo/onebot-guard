import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { isMap, parseDocument, stringify } from 'yaml';
import { validateConfig, loadConfig } from '../src/config/load.ts';
import { startGateway } from '../src/index.ts';
import { EventRing } from '../src/observability/events.ts';
import { ACCOUNT, config, connect, event, send, waitFor } from './helpers.ts';
import type { Config } from '../src/config/types.ts';
import type { Inbox } from './helpers.ts';

interface ApiState {
  [key: string]: unknown;
  healthy: boolean;
  endpoints: Record<string, { connected: boolean }>;
  routes: { id: string; upstream_ready: boolean; downstream_ready: boolean }[];
  policies: string[];
  reload: unknown;
}
type ApiResult = { error: string; ok: boolean; reload: { ok: boolean }; parsed: unknown };
async function result(response: Response): Promise<ApiResult> { return await response.json() as ApiResult; }

async function fixture(t: TestContext, change: (c: Config) => void = () => {}, raw?: (c: Config) => string) {
  const cfg = config(); cfg.webui.enabled = true; cfg.webui.port = 0; change(cfg);
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.webui-test-'));
  const path = join(directory, 'gateway.yaml');
  const env = { TEST_TOKEN: randomUUID(), READ_TOKEN: randomUUID(), WRITE_TOKEN: randomUUID(), PROXY_TOKEN: randomUUID() };
  const logs: string[] = [];
  await writeFile(path, raw ? raw(cfg) : stringify(cfg));
  let app: Awaited<ReturnType<typeof startGateway>>;
  try { app = await startGateway(path, env, line => logs.push(line)); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const clients: Inbox[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await app.stop();
    // mkdtemp was explicitly rooted in this repository's tests directory.
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.webui.address()?.port ?? cfg.webui.port}`;
  const health = `http://127.0.0.1:${app.observation.address()!.port}`;
  const dial = async (name: string) => {
    const client = await connect(`ws://127.0.0.1:${app.gateway.endpoints.get(name)!.address()!.port}`, env.TEST_TOKEN,
      name === 'up' ? { 'X-Self-ID': ACCOUNT, 'X-Client-Role': 'Universal' } : {});
    clients.push(client); return client;
  };
  const put = (policies: string, token: string | undefined = env.WRITE_TOKEN) => fetch(`${url}/api/policies`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ policies }),
  });
  return { ...app, cfg, directory, path, env, logs, url, health, dial, put };
}
const editable = (c: Config): void => { c.webui.allow_policy_edit = true; c.webui.write_token_env = 'WRITE_TOKEN'; };

test('WebUI config: defaults, binding, credentials, unknown keys, bounds and example contract', () => {
  const { webui: _webui, ...old } = config();
  assert.deepEqual(validateConfig(old).webui, { enabled: false, host: '127.0.0.1', port: 3012, read_token_env: null, allow_policy_edit: false, write_token_env: null, log_ring_size: 200 });
  for (const [webui, pattern] of [
    [{ host: '0.0.0.0' }, /webui.read_token_env/],
    // 策略编辑改由登录会话授权：allow_policy_edit 不再强制要求写凭据环境变量。
    [{ allow_policy_edit: true, write_token_env: 'not-an-env' }, /webui.write_token_env/],
    [{ token: 'TOKEN_PLACEHOLDER' }, /webui.token.*未知/],
    [{ read_token_env: 'not-an-env' }, /webui.read_token_env/],
    [{ write_token_env: 'not-an-env' }, /webui.write_token_env/],
    [{ log_ring_size: 0 }, /webui.log_ring_size/],
    [{ log_ring_size: 10001 }, /webui.log_ring_size/],
    [{ port: 65536 }, /webui.port/],
    [{ enabled: 'yes' }, /webui.enabled/],
  ] as const) assert.throws(() => validateConfig({ ...old, webui }), pattern);
  assert.equal(validateConfig({ ...old, webui: { host: '::1' } }).webui.host, '::1');
  assert.equal(validateConfig({ ...old, webui: { host: '0.0.0.0', read_token_env: 'READ_TOKEN' } }).webui.host, '0.0.0.0');
  assert.throws(() => validateConfig({ ...old, observability: { host: '0.0.0.0' } }), /observability.host/);
  const example = loadConfig('config/gateway.example.yaml'); assert.equal(example.webui.enabled, false);
  assert.match(fs.readFileSync('config/gateway.example.yaml', 'utf8'), /webui:[\s\S]*enabled: false/);
});

test('WebUI read auth protects every API; write token is independent and disabled PUT is 404', async t => {
  const h = await fixture(t, c => { editable(c); c.webui.read_token_env = 'READ_TOKEN'; });
  for (const path of ['/api/state', '/api/policies', '/api/logs']) {
    for (const token of [undefined, 'WRONG_TOKEN_PLACEHOLDER', h.env.WRITE_TOKEN]) {
      const response = await fetch(h.url + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.text();
    }
  }
  for (const path of ['/api/state', '/api/policies']) {
    const response = await fetch(h.url + path, { headers: { Authorization: `Bearer ${h.env.READ_TOKEN}` } }); assert.equal(response.status, 200); await response.text();
  }
  for (const token of ['', 'WRONG_TOKEN_PLACEHOLDER', h.env.READ_TOKEN]) {
    const response = await h.put(stringify(h.cfg.policies), token); assert.equal(response.status, 401); await response.text();
  }
  assert.equal((await h.put(stringify(h.cfg.policies))).status, 200);
  const disabled = await fixture(t);
  assert.equal((await disabled.put('{}')).status, 404);
});

test('WebUI trusted proxy header stands in for a login; a wrong or missing header still requires one', async t => {
  const h = await fixture(t, c => {
    editable(c);
    c.webui.read_token_env = 'READ_TOKEN';
    c.webui.trust_proxy_header = 'X-Test-Proxy';
    c.webui.trust_proxy_token_env = 'PROXY_TOKEN';
  });
  const trusted = await fetch(h.url + '/api/state', { headers: { 'X-Test-Proxy': h.env.PROXY_TOKEN } });
  assert.equal(trusted.status, 200); await trusted.text();
  // 读接口开了，写接口也应随之可用（否则编辑页在门户里点了没反应）
  assert.equal((await h.put(stringify(h.cfg.policies))).status, 200);
  const wrong = await fetch(h.url + '/api/state', { headers: { 'X-Test-Proxy': 'WRONG_TOKEN_PLACEHOLDER' } });
  assert.equal(wrong.status, 401); await wrong.text();
  const none = await fetch(h.url + '/api/state');
  assert.equal(none.status, 401); await none.text();
  // 首页在没有匹配头时仍然是登录页
  const home = await fetch(h.url + '/');
  assert.match(await home.text(), /登录|token|密码/i);
});

test('WebUI credentials never appear in responses, validation errors, reload events or logs', async t => {
  const h = await fixture(t, c => { editable(c); c.webui.read_token_env = 'READ_TOKEN'; });
  const malformed = { ...h.cfg.policies.main, [h.env.WRITE_TOKEN]: true };
  const response = await h.put(stringify({ main: malformed })); assert.equal(response.status, 400);
  const error = await response.text(); assert.match(error, /REDACTED/);
  const invalid = { ...h.cfg, [h.env.READ_TOKEN]: true };
  await writeFile(h.path, stringify(invalid)); assert.equal(h.reloader.reload(), false);
  const state = await (await fetch(h.url + '/api/state', { headers: { Authorization: `Bearer ${h.env.READ_TOKEN}` } })).text();
  for (const token of Object.values(h.env)) {
    for (const output of [error, state, h.logs.join(''), JSON.stringify(h.observation.events.recent())]) assert.equal(output.includes(token), false);
  }
  const forbiddenValue = randomUUID();
  await writeFile(h.path, stringify({ ...h.cfg, policies: { main: { ...h.cfg.policies.main, token: forbiddenValue } } }));
  const invalidRead = await fetch(h.url + '/api/policies', { headers: { Authorization: `Bearer ${h.env.READ_TOKEN}` } });
  assert.equal(invalidRead.status, 400); assert.equal((await invalidRead.text()).includes(forbiddenValue), false);
});

test('WebUI rejects invalid YAML, unknown policy keys, missing route policy and unsafe rules without changing bytes or memory', async t => {
  const h = await fixture(t, editable); const original = await readFile(h.path); const policies = h.gateway.config.policies;
  const cases = [
    ['main: [', /YAML/],
    [stringify({ main: { ...h.cfg.policies.main, typo: true } }), /policies.main.typo/],
    [stringify({ other: h.cfg.policies.main }), /routes\[0\].policy/],
    [stringify({ main: { ...h.cfg.policies.main, events: { default: 'allow' } } }), /policies.main.events.default/],
    [stringify({ main: { ...h.cfg.policies.main, events: { deny: { keywords_regex: ['(a+)+'] } } } }), /keywords_regex/],
    ['main: &alias {}\nother: *alias', /alias/],
    ['main: {}\nmain: {}', /YAML/],
    ['[]', /映射/],
  ] as const;
  for (const [yaml, reason] of cases) {
    const response = await h.put(yaml); assert.equal(response.status, 400); assert.match((await result(response)).error, reason);
    assert.deepEqual(await readFile(h.path), original); assert.equal(h.gateway.config.policies, policies);
  }
  assert.deepEqual(await readdir(h.directory), ['gateway.yaml']);
});

test('WebUI validates the whole on-disk config and refuses non-policy drift before writing', async t => {
  const h = await fixture(t, editable);
  for (const raw of [stringify({ ...h.cfg, runtime: { ...h.cfg.runtime, unknown: true } }), stringify({ ...h.cfg, runtime: { ...h.cfg.runtime, max_pending_requests: 99 } })]) {
    await writeFile(h.path, raw); const original = await readFile(h.path);
    const response = await h.put(stringify(h.cfg.policies)); assert.equal(response.status, 400);
    assert.match((await result(response)).error, /runtime.unknown|必须重启/); assert.deepEqual(await readFile(h.path), original);
  }
});

test('WebUI atomically replaces only policies, preserves other bytes/comments, reloads and enforces new rules', async t => {
  const h = await fixture(t, editable, c => '# HEADER_COMMENT\n' + stringify(c).replace('runtime:\n', 'runtime: # RUNTIME_COMMENT\n').replace('endpoints:\n', '# ENDPOINT_COMMENT\nendpoints:\n') + '# TAIL_COMMENT\n');
  const up = await h.dial('up'); const down = await h.dial('downA');
  send(up.socket, event({ marker: 'before' })); assert.equal((await down.next()).marker, 'before');
  const original = await readFile(h.path, 'utf8');
  const beforeNode = parseDocument(original).get('policies', true)!;
  assert.ok(isMap(beforeNode) && beforeNode.range);
  const next = structuredClone(h.cfg.policies); next.main!.events.allow = [{ post_type: 'meta_event' }];
  let renames = 0; const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    assert.equal(target, h.path); assert.equal(join(h.directory, String(source).split(/[\\/]/).at(-1)!), source);
    assert.deepEqual(fs.readFileSync(h.path), Buffer.from(original)); renames++; return rename(source, target);
  });
  const response = await h.put(stringify(next)); assert.equal(response.status, 200);
  const saved = await result(response); assert.equal(saved.ok, true); assert.equal(saved.reload.ok, true); assert.equal(renames, 1);
  t.mock.restoreAll();
  const updated = await readFile(h.path, 'utf8'); const afterNode = parseDocument(updated).get('policies', true)!;
  assert.ok(isMap(afterNode) && afterNode.range);
  assert.equal(updated.slice(0, afterNode.range[0]), original.slice(0, beforeNode.range[0]));
  assert.equal(updated.slice(afterNode.range[1]), original.slice(beforeNode.range[1]));
  const { policies: _old, ...before } = loadConfig(h.path); const { policies: _new, ...expected } = h.cfg; assert.deepEqual(before, expected);
  assert.deepEqual(h.gateway.config.policies.main!.events.allow, [{ post_type: 'meta_event' }]);
  send(up.socket, event({ marker: 'blocked' })); send(up.socket, event({ post_type: 'meta_event', meta_event_type: 'heartbeat', marker: 'barrier' }));
  assert.equal((await down.next()).marker, 'barrier'); assert.equal(down.packets.length, 0);
  const current = await result(await fetch(h.url + '/api/policies')); assert.deepEqual(current.parsed, next); assert.equal(current.reload.ok, true);
  assert.ok(h.observation.events.recent().some(event => event.event === 'reload' && event.ok === true));
});

test('WebUI policy transaction supports JSON/flow documents and cleans temporary files on rename failure', async t => {
  const h = await fixture(t, editable, JSON.stringify);
  assert.equal((await h.put(stringify(h.cfg.policies))).status, 200);
  const original = await readFile(h.path);
  t.mock.method(fs, 'renameSync', () => { throw new Error('FILESYSTEM_FAILURE_PLACEHOLDER'); });
  const response = await h.put(stringify(h.cfg.policies)); assert.equal(response.status, 400); assert.match((await result(response)).error, /写入失败/);
  assert.deepEqual(await readFile(h.path), original); assert.deepEqual(await readdir(h.directory), ['gateway.yaml']);
});

test('WebUI rolls back the original bytes if the post-rename reload fails', async t => {
  const h = await fixture(t, editable); const original = await readFile(h.path); const current = h.gateway.config.policies;
  t.mock.method(h.reloader, 'reload', () => false);
  const next = structuredClone(h.cfg.policies); next.main!.actions.allow = [];
  assert.equal((await h.put(stringify(next))).status, 400);
  assert.deepEqual(await readFile(h.path), original); assert.equal(h.gateway.config.policies, current);
  assert.deepEqual(await readdir(h.directory), ['gateway.yaml']);
});

test('WebUI serves offline native assets with no-store and 404/405 semantics while upstream is disconnected', async t => {
  const h = await fixture(t);
  for (const [path, content, type] of [['/', /id="overview"[\s\S]*id="endpoints"[\s\S]*id="routes"[\s\S]*id="logs"[\s\S]*id="policy-yaml"/, 'text/html'], ['/assets/app.js', /fetch\('\/api\/logs'/, 'text/javascript'], ['/assets/style.css', /color-scheme:\s*light/, 'text/css']] as const) {
    const response = await fetch(h.url + path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-type')?.startsWith(type)); assert.match(await response.text(), content);
  }
  for (const [path, method, status] of [['/missing', 'GET', 404], ['/assets/../index.ts', 'GET', 404], ['/missing', 'POST', 405], ['/api/state', 'POST', 405]] as const) {
    const response = await fetch(h.url + path, { method }); assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.text();
  }
  const state = await (await fetch(h.url + '/api/state')).json() as ApiState; assert.equal(state.healthy, false); assert.equal(state.endpoints.up!.connected, false);
  assert.equal(state.routes[0]!.upstream_ready, false); assert.equal(state.routes[0]!.downstream_ready, false);
});

test('WebUI state counters and snapshots agree with health/stats and contain no endpoint config', async t => {
  const h = await fixture(t); const up = await h.dial('up'); await h.dial('downA');
  send(up.socket, event({ message: 'BLOCKED' })); await waitFor(() => h.observation.totals.denied > 0);
  const state = await (await fetch(h.url + '/api/state')).json() as ApiState;
  const health = await (await fetch(h.health + '/health')).json() as ApiState; const stats = await (await fetch(h.health + '/stats')).json() as ApiState;
  assert.deepEqual(state.endpoints, health.endpoints);
  assert.deepEqual(state.routes.map(({ upstream_ready: _up, downstream_ready: _down, ...r }) => r), health.routes);
  for (const key of ['healthy', 'started_at', 'last_event_at', 'queues', 'totals', 'counts_by_route', 'hits_by_rule', 'transport_issues']) assert.deepEqual(state[key], stats[key]);
  assert.deepEqual(state.policies, ['main']); assert.equal(state.reload, null);
  assert.equal(JSON.stringify(state).includes('token_env'), false); assert.equal(JSON.stringify(state).includes('expected_self_id'), false);
});

test('WebUI SSE sends an initial frame, replays metadata, delivers a real denial and cleans subscriptions', async t => {
  const h = await fixture(t, c => { c.log.level = 'error'; c.log.message_preview_chars = 64; });
  const up = await h.dial('up'); await h.dial('downA');
  const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 5000);
  t.after(() => { clearTimeout(deadline); controller.abort(); });
  const response = await fetch(h.url + '/api/logs', { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body!.getReader(); let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /: connected/);
  while (!text.includes('session_open')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /generation/);
  send(up.socket, event({ message: 'BLOCKED PRIVATE_BODY_PLACEHOLDER' }));
  while (!text.includes('event: denied')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event.keyword/); assert.equal(text.includes('PRIVATE_BODY_PLACEHOLDER'), false);
  assert.equal(h.observation.events.subscriberCount, 1);
  controller.abort(); await reader.cancel().catch(() => {}); await waitFor(() => h.observation.events.subscriberCount === 0);
  assert.ok(h.logs.some(line => line.includes('PRIVATE_BODY_PLACEHOLDER')), 'existing audit preview behavior remains unchanged');
});

test('WebUI ring evicts oldest, replays last N, unsubscribes and disables retention', () => {
  const ring = new EventRing(2);
  for (let i = 0; i < 4; i++) ring.publish({ time: String(i), event: 'transport_issue' });
  assert.deepEqual(ring.recent().map(e => e.time), ['2', '3']); assert.deepEqual(ring.recent(0), []);
  const seen: string[] = []; const stop = ring.subscribe(e => seen.push(e.time), 1);
  ring.publish({ time: '4', event: 'session_close' }); stop(); ring.publish({ time: '5', event: 'reload' });
  assert.deepEqual(seen, ['3', '4']); assert.equal(ring.subscriberCount, 0);
  const disabled = new EventRing(0); disabled.publish({ time: '0', event: 'denied' }); assert.deepEqual(disabled.recent(), []);
});

test('WebUI preview is opt-in and stop closes active SSE clients', { timeout: 10000 }, async t => {
  const h = await fixture(t, c => { c.observability.expose_message_preview = true; c.log.message_preview_chars = 64; });
  h.observation.decision('routeA', 'event', { allowed: false, rule: 'test', reason: 'denied' }, 'GENERATION_PLACEHOLDER', event({ message: 'PREVIEW_PLACEHOLDER' }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(h.url + '/api/logs', { signal: controller.signal }); const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('PREVIEW_PLACEHOLDER')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /PREVIEW_PLACEHOLDER/);
  await h.stop(); await waitFor(() => h.observation.events.subscriberCount === 0); await reader.cancel().catch(() => {});
});

test('WebUI large rings replay a bounded recent suffix and disconnect overloaded SSE subscribers', { timeout: 10000 }, async t => {
  const h = await fixture(t, c => { c.webui.log_ring_size = 10000; });
  for (let i = 0; i < 10000; i++) h.observation.events.publish({ time: String(i), event: 'transport_issue', reason: 'x'.repeat(512) });
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(h.url + '/api/logs', { signal: controller.signal }); const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('"time":"9999"')) text += new TextDecoder().decode((await reader.read()).value);
  assert.equal(text.includes('"time":"0"'), false);
  assert.ok((text.match(/event: transport_issue/g) ?? []).length <= 50);
  assert.equal(h.observation.events.subscriberCount, 1);
  // No consumer read: a synchronous burst must never build an unbounded response queue.
  for (let i = 0; i < 1000; i++) h.observation.events.publish({ time: String(i), event: 'transport_issue', reason: 'y'.repeat(512) });
  await waitFor(() => h.observation.events.subscriberCount === 0);
  await reader.cancel().catch(() => {});
});

test('WebUI event metadata is bounded and excludes arbitrary packet fields', () => {
  const ring = new EventRing(1);
  ring.publish({ time: 'TIME_PLACEHOLDER', event: 'denied', scope: 'x'.repeat(10000), preview: 'y'.repeat(10000), message: 'BODY_PLACEHOLDER', params: { message: 'BODY_PLACEHOLDER' } });
  const entry = ring.recent()[0]!;
  assert.equal((entry.scope as string).length, 512); assert.equal((entry.preview as string).length, 4096);
  assert.equal('message' in entry, false); assert.equal('params' in entry, false);
});

test('WebUI absent/default-disabled does not listen and health/stats remain available', async t => {
  // Occupy a known test port: disabled startup must succeed without trying to bind it.
  const sentinel = createServer(); await new Promise<void>(resolve => sentinel.listen(0, '127.0.0.1', resolve));
  const address = sentinel.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => sentinel.close(() => resolve())));
  const h = await fixture(t, c => { c.webui.enabled = false; c.webui.port = address.port; });
  assert.equal(h.webui.server, undefined); assert.equal(h.webui.address(), undefined); assert.equal(h.observation.events.capacity, 0);
  assert.equal((await fetch(h.health + '/health')).status, 503); assert.equal((await fetch(h.health + '/stats')).status, 200);
  const omitted = await fixture(t, () => {}, c => { const { webui: _w, ...old } = c; return stringify(old); });
  assert.equal(omitted.webui.server, undefined); assert.equal((await fetch(omitted.health + '/stats')).status, 200);
});

test('WebUI rejects malformed or oversized bodies without file changes', async t => {
  const h = await fixture(t, editable); const original = await readFile(h.path);
  for (const [body, type, status] of [['{}', 'text/plain', 415], ['{', 'application/json', 400], ['{"policies":{},"extra":true}', 'application/json', 400], [JSON.stringify({ policies: 'x'.repeat(1048576) }), 'application/json', 400]] as const) {
    const response = await fetch(h.url + '/api/policies', { method: 'PUT', headers: { Authorization: `Bearer ${h.env.WRITE_TOKEN}`, 'Content-Type': type }, body });
    assert.equal(response.status, status); await response.text(); assert.deepEqual(await readFile(h.path), original);
  }
});

test('WebUI configured but missing environment credential fails closed before listeners start', async t => {
  await assert.rejects(fixture(t, c => { c.webui.read_token_env = 'MISSING_READ_TOKEN'; }), /MISSING_READ_TOKEN/);
  await assert.rejects(fixture(t, c => { editable(c); c.webui.write_token_env = 'MISSING_WRITE_TOKEN'; }), /MISSING_WRITE_TOKEN/);
});
