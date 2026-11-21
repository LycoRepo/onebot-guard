import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig, validateConfig } from '../src/config/load.ts';
import { startGateway } from '../src/index.ts';
import { ACCOUNT, config, connect, event, send, sendAction } from './helpers.ts';
import type { Config } from '../src/config/types.ts';
import type { Inbox } from './helpers.ts';

async function fixture(t: TestContext, change: (c: Config) => void = () => {}) {
  const cfg = config();
  cfg.webui.enabled = true; cfg.webui.port = 0;
  cfg.webui.allow_policy_edit = true; cfg.webui.write_token_env = 'WRITE_TOKEN'; cfg.webui.read_token_env = 'READ_TOKEN';
  change(cfg);
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.switch-test-'));
  const path = join(directory, 'gateway.yaml');
  const env = { TEST_TOKEN: randomUUID(), READ_TOKEN: randomUUID(), WRITE_TOKEN: randomUUID() };
  const logs: string[] = [];
  await writeFile(path, stringify(cfg));
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
  const url = `http://127.0.0.1:${app.webui.address()!.port}`;
  const dial = async (name: string): Promise<Inbox> => {
    const client = await connect(`ws://127.0.0.1:${app.gateway.endpoints.get(name)!.address()!.port}`, env.TEST_TOKEN,
      name === 'up' ? { 'X-Self-ID': ACCOUNT, 'X-Client-Role': 'Universal' } : {});
    clients.push(client); return client;
  };
  const toggle = (route: string, enabled: boolean, token: string | null = env.WRITE_TOKEN) => fetch(`${url}/api/routes/enabled`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ route, enabled }),
  });
  const login = async (): Promise<string> => {
    const response = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: env.READ_TOKEN }) });
    assert.equal(response.status, 204);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const putConfig = (body: unknown, cookie?: string) => fetch(`${url}/api/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  return { ...app, cfg, path, directory, env, logs, url, dial, toggle, login, putConfig };
}
const pause = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const fileText = (path: string): Promise<string> => readFile(path, 'utf8');

test('routes default to enabled, accept a boolean switch and reject other types', () => {
  const ok = validateConfig(config());
  assert.deepEqual(ok.routes.map(route => route.enabled), [true, true]);
  const missing = config(); delete (missing.routes[0] as Partial<Config['routes'][number]>).enabled;
  assert.equal(validateConfig(missing).routes[0]!.enabled, true);
  const bad = config(); bad.routes[0]!.enabled = 'yes' as unknown as boolean;
  assert.throws(() => validateConfig(bad), /routes\[0\]\.enabled/);
  assert.throws(() => validateConfig({ ...config(), routes: [{ ...config().routes[0]!, extra: true }] }), /未知配置项/);
});

test('routes run in parallel: both enabled backends get the event, alone only itself', async t => {
  const h = await fixture(t);
  const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  send(up.socket, event({ marker: 'both' }));
  assert.equal((await a.next()).marker, 'both', 'main backend receives');
  assert.equal((await b.next()).marker, 'both', 'second backend receives too — they coexist');
  // 只留一条：暂停 routeB，routeA 完全不受影响。
  assert.equal((await h.toggle('routeB', false)).status, 200);
  send(up.socket, event({ marker: 'only-a' }));
  assert.equal((await a.next()).marker, 'only-a');
  await pause(); assert.equal(b.packets.length, 0);
  // 再打开就恢复并存。
  assert.equal((await h.toggle('routeB', true)).status, 200);
  send(up.socket, event({ marker: 'both-again' }));
  assert.equal((await a.next()).marker, 'both-again');
  assert.equal((await b.next()).marker, 'both-again');
});

test('a route disabled in the file starts paused and can be enabled without reconnecting', async t => {
  const h = await fixture(t, c => { c.routes[1]!.enabled = false; });
  const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  send(up.socket, event({ marker: 'only-a' }));
  assert.equal((await a.next()).marker, 'only-a');
  await pause();
  assert.equal(b.packets.length, 0);
  const snapshot = h.gateway.snapshot().routes as { id: string; enabled: boolean; ready: boolean }[];
  assert.deepEqual(snapshot.map(route => [route.id, route.enabled, route.ready]), [['routeA', true, true], ['routeB', false, false]]);
  h.gateway.setRouteEnabled('routeB', true);
  send(up.socket, event({ marker: 'now-b' }));
  assert.equal((await b.next()).marker, 'now-b');
});

test('a disabled route receives nothing, refuses actions and keeps its session', async t => {
  const h = await fixture(t);
  const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  h.gateway.setRouteEnabled('routeB', false);
  send(up.socket, event({ marker: 'to-a' }));
  assert.equal((await a.next()).marker, 'to-a');
  await pause();
  assert.equal(b.packets.length, 0);
  // 停用路由的下游请求得到明确失败，而不是静默丢弃。
  send(b.socket, sendAction({ echo: 'disabled' }));
  const refused = await b.next();
  assert.equal(refused.message, 'route_disabled'); assert.equal(refused.retcode, 1503); assert.equal(refused.echo, 'disabled');
  assert.ok(h.gateway.endpoints.get('downB')!.peer?.active, 'paused routes keep their session');
  assert.ok(h.gateway.endpoints.get('downA')!.peer?.active);
});

test('WebUI toggle writes one flag at a time, applies it at once and leaves other routes alone', async t => {
  const h = await fixture(t);
  const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  const before = await fileText(h.path);
  const response = await h.toggle('routeB', false);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; routes: { id: string; enabled: boolean }[]; message: string };
  assert.equal(body.ok, true);
  assert.deepEqual(body.routes.map(route => [route.id, route.enabled]), [['routeA', true], ['routeB', false]]);
  assert.match(body.message, /暂停/);
  assert.deepEqual(loadConfig(h.path).routes.map(route => [route.id, route.enabled]), [['routeA', true], ['routeB', false]]);
  // 只写目标路由的键：routes 之外字节不变。
  const after = await fileText(h.path);
  assert.match(after, /enabled: false/);
  assert.equal(after.split('routes:')[0], before.split('routes:')[0], 'everything before routes keeps its bytes');
  // 运行时立刻生效；routeA 仍然在收。
  send(up.socket, event({ marker: 'only-a' }));
  assert.equal((await a.next()).marker, 'only-a');
  await pause(); assert.equal(b.packets.length, 0);
  // 再打开 routeB，两条并存。
  assert.equal((await h.toggle('routeB', true)).status, 200);
  send(up.socket, event({ marker: 'both' }));
  assert.equal((await a.next()).marker, 'both');
  assert.equal((await b.next()).marker, 'both');
});

test('toggle endpoint requires write auth, POST and a known route', async t => {
  const h = await fixture(t);
  for (const token of [null, h.env.READ_TOKEN] as const) {
    const response = await h.toggle('routeB', false, token); assert.equal(response.status, 401); await response.text();
  }
  assert.equal((await h.toggle('routeB', false)).status, 200);
  assert.equal((await h.toggle('routeB', false)).status, 200, 'toggle is idempotent');
  const get = await fetch(h.url + '/api/routes/enabled');
  assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST'); await get.text();
  const unknown = await h.toggle('absent_route', true);
  assert.equal(unknown.status, 400); assert.match((await unknown.json() as { error: string }).error, /未找到该路由/);
  const post = (body: unknown, type = 'application/json') => fetch(h.url + '/api/routes/enabled', {
    method: 'POST', headers: { 'Content-Type': type, Authorization: `Bearer ${h.env.WRITE_TOKEN}` }, body: JSON.stringify(body),
  });
  for (const body of [{ route: 'routeA' }, { route: 'routeA', enabled: 'yes' }, { route: 'routeA', enabled: true, extra: 1 }]) {
    const response = await post(body); assert.equal(response.status, 400); await response.text();
  }
  const plain = await post({ route: 'routeA', enabled: true }, 'text/plain'); assert.equal(plain.status, 415); await plain.text();
});

test('toggle is closed when config editing is disabled', async t => {
  const h = await fixture(t, c => { c.webui.allow_policy_edit = false; });
  const response = await h.toggle('routeB', false, h.env.WRITE_TOKEN);
  assert.equal(response.status, 404); await response.text();
});

test('saving endpoints and routes without an enabled field keeps the on-disk switch', async t => {
  const h = await fixture(t);
  assert.equal((await h.toggle('routeB', false)).status, 200);
  const routes = h.cfg.routes.map(({ enabled: _enabled, ...route }) => route);
  const cookie = await h.login();
  const response = await h.putConfig({ endpoints: structuredClone(h.cfg.endpoints), routes, restart: false }, cookie);
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(loadConfig(h.path).routes.map(route => [route.id, route.enabled]), [['routeA', true], ['routeB', false]]);
});

test('policy hot reload ignores switch-only differences and keeps the running state', async t => {
  const h = await fixture(t);
  const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  assert.equal((await h.toggle('routeB', false)).status, 200);
  const onDisk = loadConfig(h.path);
  // 外部把文件里的 enabled 改回 true（模拟手工编辑），不应被当成「必须重启」。
  await writeFile(h.path, stringify({ ...onDisk, routes: onDisk.routes.map(route => ({ ...route, enabled: true })) }));
  assert.equal(h.reloader.reload(), true);
  send(up.socket, event({ marker: 'still-b-paused' }));
  assert.equal((await a.next()).marker, 'still-b-paused');
  await pause(); assert.equal(b.packets.length, 0);
});

test('pausing a route closes only its own in-flight request as a known failure', async t => {
  const h = await fixture(t);
  const up = await h.dial('up'); const b = await h.dial('downB');
  send(b.socket, { action: 'get_status', echo: 'inflight' });
  const request = await up.next();
  assert.equal(typeof request.echo, 'string', 'upstream sees the gateway-owned echo');
  assert.equal((await h.toggle('routeB', false)).status, 200);
  const failed = await b.next();
  assert.equal(failed.echo, 'inflight'); assert.equal(failed.retcode, 1504); assert.equal(failed.message, 'route_disabled_result_unknown');
  // 迟到的上游回包被丢弃，不会误投给其它路由。
  send(up.socket, { status: 'ok', retcode: 0, data: {}, echo: request.echo });
  await pause(); assert.equal(b.packets.length, 0);
});

test('health counts only enabled routes and goes red when all are paused', async t => {
  const h = await fixture(t);
  const health = `http://127.0.0.1:${h.observation.address()!.port}`;
  await h.dial('up'); await h.dial('downA'); await h.dial('downB');
  assert.equal((await fetch(`${health}/health`)).status, 200);
  h.gateway.setRouteEnabled('routeA', false);
  assert.equal((await fetch(`${health}/health`)).status, 200, 'routeB is still enabled and ready');
  h.gateway.setRouteEnabled('routeB', false);
  assert.equal((await fetch(`${health}/health`)).status, 503, 'no enabled route means unhealthy');
});
