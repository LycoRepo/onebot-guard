import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { stringify } from 'yaml';
import { config, waitFor } from './helpers.ts';
import type { Config } from '../src/config/types.ts';
import { validateConfig } from '../src/config/load.ts';
import { PolicyReloader } from '../src/config/reload.ts';
import { Observability } from '../src/observability/index.ts';
import { Gateway } from '../src/route/index.ts';
import { WebUI } from '../src/webui/index.ts';
import { sessionCookie, sessionOptions, Sessions } from '../src/webui/sessions.ts';

async function fixture(t: TestContext, options: Partial<Config['webui']> = {}) {
  const cfg = config();
  cfg.webui = { ...cfg.webui, enabled: true, port: 0, read_token_env: 'READ_TOKEN', allow_policy_edit: true, write_token_env: 'WRITE_TOKEN', ...options };
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.webui-login-'));
  const path = join(directory, 'gateway.yaml');
  await writeFile(path, stringify(cfg));
  const env = { TEST_TOKEN: randomUUID(), READ_TOKEN: randomUUID(), WRITE_TOKEN: randomUUID() };
  const audit: string[] = [];
  const observation = new Observability(cfg, line => audit.push(line));
  const gateway = new Gateway(cfg, observation, env);
  const reloader = new PolicyReloader(path, cfg, next => gateway.replacePolicies(next.policies), () => {});
  let now = 0;
  const webui = new WebUI(cfg, () => gateway.snapshot(), observation, reloader, path, env, () => now);
  t.after(async () => {
    await webui.stop();
    // The temporary directory was created inside this repository's tests directory.
    await rm(directory, { recursive: true, force: true });
  });
  await webui.start();
  const url = `http://127.0.0.1:${webui.address()!.port}`;
  const post = (route: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const login = (token: string = env.READ_TOKEN) => post('/api/login', { token });
  const loggedIn = async () => {
    const response = await login(); assert.equal(response.status, 204);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const get = (route: string, cookie?: string, headers: Record<string, string> = {}) => fetch(url + route, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const put = (cookie?: string, token?: string, headers: Record<string, string> = {}) => fetch(url + '/api/policies', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ policies: stringify(cfg.policies) }),
  });
  return { cfg, path, env, audit, observation, url, post, login, loggedIn, get, put, advance: (ms: number) => { now += ms; } };
}

const protectedPaths = ['/assets/app.js', '/assets/style.css', '/api/state', '/api/policies', '/api/logs'];

test('Login CSP hashes the served script and style exactly, with no panel resources or broad inline allowance', async t => {
  const h = await fixture(t); const response = await h.get('/'); const html = await response.text();
  assert.equal(html.includes('\r'), false);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(scripts.length, 1); assert.equal(styles.length, 1);
  const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
  assert.equal(response.headers.get('content-security-policy'), `default-src 'none'; script-src ${hash(scripts[0]![1]!)}; style-src ${hash(styles[0]![1]!)}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  assert.doesNotMatch(html, /<script\s|\/assets\/|<(?:section|table|dl)\b/);
  assert.doesNotMatch(response.headers.get('content-security-policy')!, /unsafe-inline|unsafe-eval/);
});

test('Served login script submits JSON, displays failure safely, handles network errors and navigates after real login', async t => {
  const h = await fixture(t);
  const html = await (await h.get('/')).text(); const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const attributes = new Map<string, string>(); let focused = false;
  const input = { value: 'WRONG_TOKEN_PLACEHOLDER', setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key), focus: () => { focused = true; } };
  const error = { textContent: '' }; const button = { disabled: false, textContent: '登录' }; const status = { textContent: '' };
  const destinations: string[] = []; let cookie = ''; let offline = false; let prevented = 0;
  const requests: { path: string; options: RequestInit }[] = [];
  runInNewContext(script, {
    document: { getElementById: (id: string) => {
      if (id === 'login-token') return input;
      if (id === 'login-error') return error;
      if (id === 'login-submit') return button;
      if (id === 'login-status') return status;
      assert.equal(id, 'login-form');
      return { addEventListener: (event: string, handler: typeof submit) => { assert.equal(event, 'submit'); submit = handler; } };
    } },
    location: { replace: (path: string) => destinations.push(path) },
    fetch: async (path: string, options: RequestInit) => {
      requests.push({ path, options });
      if (offline) throw new Error('NETWORK_ERROR_PLACEHOLDER');
      const response = await fetch(h.url + path, { ...options, headers: { ...options.headers, Origin: h.url } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
      return response;
    },
  });
  assert.ok(submit);
  const event = { preventDefault: () => { prevented++; } };
  await submit(event); assert.equal(error.textContent, '认证失败'); assert.deepEqual(destinations, []);
  assert.equal(attributes.get('aria-invalid'), 'true'); assert.equal(focused, true);
  assert.equal(button.disabled, false); assert.equal(button.textContent, '登录');
  assert.equal(error.textContent.includes(input.value), false);
  offline = true; await submit(event); assert.equal(error.textContent, '无法连接，请稍后重试'); assert.deepEqual(destinations, []);
  offline = false; input.value = h.env.READ_TOKEN; await submit(event);
  assert.equal(error.textContent, ''); assert.deepEqual(destinations, ['/']); assert.equal(prevented, 3);
  assert.equal(attributes.has('aria-invalid'), false); assert.match(status.textContent, /登录成功/);
  for (const request of requests) {
    assert.equal(request.path, '/api/login'); assert.equal(request.options.method, 'POST');
    assert.equal(new Headers(request.options.headers).get('content-type'), 'application/json');
  }
  assert.deepEqual(JSON.parse(requests.at(-1)!.options.body as string), { token: h.env.READ_TOKEN });
  assert.match(await (await h.get('/', cookie)).text(), /id="overview"/);
});

test('Login config validates all new bounds strictly and supplies effective defaults without changing legacy shape', () => {
  const cfg = config();
  assert.deepEqual(sessionOptions(cfg.webui), { ttlSeconds: 43200, capacity: 64, attempts: 10 });
  for (const [key, min, max] of [['session_ttl_minutes', 5, 43200], ['max_sessions', 1, 1024], ['login_attempts_per_min', 0, 1000]] as const) {
    for (const value of [min, max]) assert.equal(validateConfig({ ...cfg, webui: { ...cfg.webui, [key]: value } }).webui[key], value);
    for (const value of [min - 1, max + 1, 1.5, '10', null, false]) assert.throws(() => validateConfig({ ...cfg, webui: { ...cfg.webui, [key]: value } }), new RegExp(`webui.${key}`));
  }
  assert.throws(() => validateConfig({ ...cfg, webui: { ...cfg.webui, session_typo: true } }), /未知/);
});

test('Unauthenticated root contains only login UI; every panel asset and read API rejects absent or forged cookies', async t => {
  const h = await fixture(t);
  const response = await h.get('/'); assert.equal(response.status, 200);
  const html = await response.text(); assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /<(?:section|table|dl)\b|\/assets\//);
  for (const value of ['overview', 'endpoints', 'routes', 'queues', 'rules', 'issues', 'logs', 'policy-yaml']) assert.equal(html.includes(`id="${value}"`), false);
  for (const value of ['ACCOUNT_A', 'GROUP_ALLOWED', 'routeA', 'TEST_TOKEN', ...Object.values(h.env)]) assert.equal(html.includes(value), false);
  for (const path of protectedPaths) {
    for (const cookie of [undefined, 'guard_session=forged', `guard_session=${'a'.repeat(64)}`]) {
      const denied = await h.get(path, cookie); assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await denied.text(), /ACCOUNT_A|GROUP_ALLOWED|routeA/);
    }
  }
});

test('Login failure is uniform and secret-free; session cookie unlocks panel, state, policies and SSE', async t => {
  const h = await fixture(t, { session_ttl_minutes: 5 });
  const wrong = randomUUID(); const failure = await h.login(wrong); assert.equal(failure.status, 401);
  const error = await failure.text(); assert.equal(error.includes(wrong), false);
  const missing = await h.post('/api/login'); assert.equal(missing.status, 401); assert.equal(await missing.text(), error);
  const write = await h.login(h.env.WRITE_TOKEN); assert.equal(write.status, 401); assert.equal(await write.text(), error);
  const success = await h.login(); assert.equal(success.status, 204);
  const header = success.headers.get('set-cookie')!;
  assert.match(header, /^guard_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=300$/);
  assert.doesNotMatch(header, /Secure/i);
  const cookie = header.split(';')[0]!;
  const root = await h.get('/', cookie); assert.match(await root.text(), /id="overview"/);
  assert.equal(root.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  for (const path of protectedPaths.filter(path => path !== '/api/logs')) { const response = await h.get(path, cookie); assert.equal(response.status, 200); await response.text(); }
  const stream = await h.get('/api/logs', cookie); assert.equal(stream.status, 200);
  const reader = stream.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/);
  const logout = await h.post('/api/logout', {}, { Cookie: cookie, Origin: h.url });
  assert.equal(logout.status, 204); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  await waitFor(() => h.observation.events.subscriberCount === 0); await reader.cancel().catch(() => {});
  assert.match(await (await h.get('/', cookie)).text(), /type="password"/);
  assert.equal((await h.get('/api/state', cookie)).status, 401);
  assert.equal((await h.post('/api/logout', {}, { Origin: h.url })).status, 204);
  assert.equal((await h.post('/api/logout')).status, 204);
  for (const value of [...Object.values(h.env), wrong, cookie.slice('guard_session='.length)]) assert.equal(h.audit.join('').includes(value), false);
});

test('Sessions evict by creation age, expire at TTL, rotate on login and authorize policy writes', async t => {
  const h = await fixture(t, { max_sessions: 2, session_ttl_minutes: 5 });
  const first = await h.loggedIn(); const second = await h.loggedIn();
  assert.equal((await h.get('/api/state', first)).status, 200);
  const third = await h.loggedIn();
  assert.equal((await h.get('/api/state', first)).status, 401);
  assert.equal((await h.get('/api/state', second)).status, 200);
  assert.equal((await h.get('/api/state', third)).status, 200);
  // 登录会话即可保存策略；写凭据只是给脚本的可选通道，两者都没有才拒绝且不动文件。
  assert.equal((await h.put(third)).status, 200);
  assert.equal((await h.put(third, h.env.READ_TOKEN)).status, 200);
  assert.equal((await h.put(undefined, h.env.WRITE_TOKEN)).status, 200);
  const before = await readFile(h.path);
  assert.equal((await h.put(undefined)).status, 401); assert.deepEqual(await readFile(h.path), before);
  const rotated = await h.post('/api/login', { token: h.env.READ_TOKEN }, { Cookie: third }); assert.equal(rotated.status, 204);
  assert.notEqual(rotated.headers.get('set-cookie')!.split(';')[0], third);
  assert.equal((await h.get('/api/state', third)).status, 401);
  h.advance(300000);
  for (const path of protectedPaths) assert.equal((await h.get(path, second)).status, 401);
  assert.equal((await h.get('/api/state', rotated.headers.get('set-cookie')!.split(';')[0])).status, 401);
  const disabled = await fixture(t, { allow_policy_edit: false });
  assert.equal((await disabled.put(await disabled.loggedIn(), disabled.env.WRITE_TOKEN, { Origin: 'http://cross-origin.invalid' })).status, 404);
});

test('Session IDs use independent random bytes and cookie parser rejects ambiguous and malformed values', () => {
  const sessions = new Sessions(config().webui);
  const ids = Array.from({ length: 100 }, () => sessions.create());
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[a-f0-9]{64}$/);
  const id = ids.at(-1)!;
  assert.equal(sessionCookie(`other=value; guard_session=${id}; extra=value`), id);
  for (const header of [undefined, 'guard_session=', 'guard_session=%00', `guard_session=${id}; guard_session=${id}`, `guard_session="${id}"`]) assert.equal(sessionCookie(header), undefined);
});

test('Issued IDs are neither the token nor its digest, and process restart discards sessions', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn(); const id = cookie.slice('guard_session='.length);
  assert.notEqual(id, h.env.READ_TOKEN); assert.notEqual(id, createHash('sha256').update(h.env.READ_TOKEN).digest('hex'));
  const other = await fixture(t); assert.equal((await other.get('/api/state', cookie)).status, 401);
});

test('Failure rate limits use socket IP, expire after a minute, cover concurrent attempts, and can be disabled', async t => {
  const h = await fixture(t, { login_attempts_per_min: 2 });
  const attempts = await Promise.all(Array.from({ length: 5 }, () => h.post('/api/login', { token: 'WRONG_TOKEN_PLACEHOLDER' }, { 'X-Forwarded-For': randomUUID() })));
  assert.deepEqual(attempts.map(r => r.status).sort(), [401, 401, 429, 429, 429]);
  assert.equal((await h.login()).status, 429);
  h.advance(60000); assert.equal((await h.login()).status, 204);
  const disabled = await fixture(t, { login_attempts_per_min: 0 });
  for (let i = 0; i < 12; i++) assert.equal((await disabled.login('WRONG_TOKEN_PLACEHOLDER')).status, 401);
  assert.equal((await disabled.login()).status, 204);
});

test('Failure state is bounded per IP with oldest eviction and fixed windows', () => {
  let now = 0; const sessions = new Sessions({ ...config().webui, login_attempts_per_min: 1 }, () => now);
  for (let i = 0; i < 1025; i++) sessions.failed(`SOURCE_${i}`);
  assert.equal(sessions.limited('SOURCE_0'), false); assert.equal(sessions.limited('SOURCE_1'), true);
  assert.equal(sessions.limited('OTHER_SOURCE'), false);
  now = 60000; assert.equal(sessions.limited('SOURCE_1'), false);
});

test('Side-effect routes reject cross-origin and non-JSON requests; absent Origin retains credential checks', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn(); const original = await readFile(h.path);
  for (const Origin of ['http://cross-origin.invalid', 'null', h.url.replace('http:', 'https:')]) {
    assert.equal((await h.post('/api/login', { token: h.env.READ_TOKEN }, { Origin })).status, 403);
    assert.equal((await h.post('/api/logout', {}, { Origin, Cookie: cookie })).status, 403);
    assert.equal((await h.put(cookie, h.env.WRITE_TOKEN, { Origin })).status, 403);
  }
  assert.deepEqual(await readFile(h.path), original); assert.equal((await h.get('/api/state', cookie)).status, 200);
  for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded']) {
    assert.equal((await h.post('/api/login', { token: h.env.READ_TOKEN }, { 'Content-Type': type })).status, 415);
    assert.equal((await h.post('/api/logout', {}, { 'Content-Type': type })).status, 415);
    assert.equal((await h.put(cookie, h.env.WRITE_TOKEN, { 'Content-Type': type })).status, 415);
  }
  assert.equal((await h.post('/api/login', { token: h.env.READ_TOKEN }, { Origin: h.url, 'Content-Type': 'application/json; charset=utf-8' })).status, 204);
  assert.equal((await h.put(undefined, h.env.WRITE_TOKEN, { Origin: h.url })).status, 200);
  assert.equal((await h.put()).status, 401);
});

test('Bearer reads remain compatible and session is checked first; missing read configuration retains loopback mode', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn();
  for (const path of ['/', ...protectedPaths]) {
    for (const [session, token] of [[undefined, h.env.READ_TOKEN], [`guard_session=${'b'.repeat(64)}`, h.env.READ_TOKEN], [cookie, 'WRONG_TOKEN_PLACEHOLDER']] as const) {
      const response = await h.get(path, session, { Authorization: `Bearer ${token}` }); assert.equal(response.status, 200);
      if (path === '/api/logs') await response.body!.cancel(); else await response.text();
    }
  }
  const loopback = await fixture(t, { read_token_env: null });
  assert.equal((await loopback.login()).status, 404);
  assert.match(await (await loopback.get('/')).text(), /id="overview"/);
  assert.equal((await loopback.get('/api/state')).status, 200);
});

test('Expired sessions stop delivering SSE metadata and evicted sessions lose existing subscriptions', async t => {
  const h = await fixture(t, { session_ttl_minutes: 5, max_sessions: 1 });
  for (const expire of [false, true]) {
    const cookie = await h.loggedIn(); const response = await h.get('/api/logs', cookie);
    const reader = response.body!.getReader(); await reader.read();
    assert.equal(h.observation.events.subscriberCount, 1);
    if (expire) { h.advance(300000); h.observation.events.publish({ time: 'TIME_PLACEHOLDER', event: 'transport_issue' }); }
    else await h.loggedIn();
    await waitFor(() => h.observation.events.subscriberCount === 0);
    await reader.cancel().catch(() => {});
  }
});
