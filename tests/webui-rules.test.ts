import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { config } from './helpers.ts';
import type { Config, Policy } from '../src/config/types.ts';
import { PolicyReloader } from '../src/config/reload.ts';
import { Observability } from '../src/observability/index.ts';
import { Gateway } from '../src/route/index.ts';
import { WebUI } from '../src/webui/index.ts';
import { parseRules, readRules, writeRules } from '../src/webui/rules.ts';

async function fixture(t: TestContext, options: Partial<Config['webui']> = {}) {
  const cfg = config();
  cfg.webui = { ...cfg.webui, enabled: true, host: '127.0.0.1', port: 0, read_token_env: 'READ_TOKEN', allow_policy_edit: true, write_token_env: 'WRITE_TOKEN', ...options };
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.webui-rules-'));
  const path = join(directory, 'gateway.yaml');
  await writeFile(path, stringify(cfg));
  const env = { TEST_TOKEN: randomUUID(), READ_TOKEN: randomUUID(), WRITE_TOKEN: randomUUID() };
  const observation = new Observability(cfg, () => {});
  const gateway = new Gateway(cfg, observation, env);
  const reloads: string[] = [];
  const reloader = new PolicyReloader(path, cfg, next => gateway.replacePolicies(next.policies), (_ok, reason) => { reloads.push(reason); });
  const webui = new WebUI(cfg, () => gateway.snapshot(), observation, reloader, path, env);
  t.after(async () => { await webui.stop(); await rm(directory, { recursive: true, force: true }); });
  await webui.start();
  const url = `http://127.0.0.1:${webui.address()!.port}`;
  const loggedIn = async () => {
    const response = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: env.READ_TOKEN }) });
    assert.equal(response.status, 204);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const get = (route: string, cookie?: string) => fetch(url + route, { headers: cookie ? { Cookie: cookie } : {} });
  const put = (body: unknown, cookie?: string, headers: Record<string, string> = {}) => fetch(url + '/api/rules', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body),
  });
  const stored = async (): Promise<{ policies: Record<string, Policy>; text: string }> => {
    const text = await readFile(path, 'utf8');
    return { policies: (parse(text) as { policies: Record<string, Policy> }).policies, text };
  };
  const form = { receive: { group_ids: ['GROUP_ALLOWED'], user_ids: ['USER_ALLOWED'], keywords: ['SPAM'], keywords_regex: [], blocked_segments: ['image'] }, send: { group_ids: ['GROUP_ALLOWED'], user_ids: ['USER_ALLOWED'], segments: ['text'] } };
  return { cfg, path, env, url, get, put, loggedIn, stored, form, reloads };
}

test('规则接口把策略读成表单，并原样回读', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn();
  const response = await h.get('/api/rules', cookie); assert.equal(response.status, 200);
  const body = await response.json() as { policies: string[]; policy: string; rules: ReturnType<typeof readRules> };
  assert.deepEqual(body.policies, ['main']); assert.equal(body.policy, 'main');
  assert.deepEqual(body.rules.receive.group_ids, ['GROUP_ALLOWED']);
  assert.deepEqual(body.rules.receive.user_ids, ['USER_ALLOWED']);
  assert.deepEqual(body.rules.receive.keywords, ['BLOCKED']);
  assert.deepEqual(body.rules.receive.blocked_segments, []);
  assert.deepEqual(body.rules.send.group_ids, ['GROUP_ALLOWED']);
  assert.deepEqual(body.rules.send.user_ids, ['USER_ALLOWED']);
  assert.deepEqual(body.rules.send.segments, ['text', 'at', 'reply', 'image', 'record', 'video', 'forward']);
  // 带查询串的路径必须照常命中接口，不能被当成未知路径。
  const named = await h.get('/api/rules?policy=main', cookie); assert.equal(named.status, 200);
  assert.equal((await named.json() as { policy: string }).policy, 'main');
  const missing = await h.get('/api/rules?policy=absent', cookie); assert.equal(missing.status, 400);
  assert.equal(await missing.text(), JSON.stringify({ ok: false, error: '策略 absent 不存在' }));
  assert.equal((await h.get('/api/rules')).status, 401);
});

test('写规则会落盘、热重载，且不动策略里其它字段', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn();
  const response = await h.put({ policy: 'main', rules: h.form }, cookie); assert.equal(response.status, 200);
  const result = await response.json() as { ok: boolean; reload: { ok: boolean; reason: string; time: string } };
  assert.equal(result.ok, true); assert.equal(result.reload.ok, true); assert.equal(result.reload.reason, 'policies_reloaded');
  assert.equal(Number.isNaN(Date.parse(result.reload.time)), false);
  assert.deepEqual(h.reloads, ['policies_reloaded']);
  const { policies, text } = await h.stored();
  const main = policies.main!;
  assert.deepEqual(main.events.deny.keywords, ['SPAM']);
  assert.deepEqual(main.events.deny.segment_types, ['image']);
  assert.equal(main.events.deny.drop_self, true);
  assert.deepEqual(main.events.allow.find(scope => scope.post_type === 'meta_event'), { post_type: 'meta_event' });
  assert.deepEqual(main.events.allow.filter(scope => scope.post_type === 'message'), [
    { post_type: 'message', message_type: 'group', group_ids: ['GROUP_ALLOWED'] },
    { post_type: 'message', message_type: 'private', user_ids: ['USER_ALLOWED'] },
  ]);
  const actions = main.actions.allow;
  for (const name of ['get_status', 'get_login_info', 'get_group_list']) assert.equal(actions.some(rule => rule.name === name), true);
  assert.deepEqual(actions.filter(rule => rule.name === 'send_group_msg'), [{ name: 'send_group_msg', group_ids: ['GROUP_ALLOWED'], segment_types: ['text'] }]);
  assert.deepEqual(actions.filter(rule => rule.name === 'send_private_msg'), [{ name: 'send_private_msg', user_ids: ['USER_ALLOWED'], segment_types: ['text'] }]);
  // 共享数组必须序列化成重复内容而不是 YAML 锚点/别名，否则配置校验会拒收自己的产物。
  assert.equal(text.includes('&'), false); assert.equal(text.includes('*'), false);
  assert.equal(/\balias\b/i.test(text), false);
  const again = await h.get('/api/rules?policy=main', cookie);
  assert.deepEqual((await again.json() as { rules: unknown }).rules, { receive: { group_ids: ['GROUP_ALLOWED'], user_ids: ['USER_ALLOWED'], keywords: ['SPAM'], keywords_regex: [], blocked_segments: ['image'] }, send: { group_ids: ['GROUP_ALLOWED'], user_ids: ['USER_ALLOWED'], segments: ['text'] } });
});

test('空名单表示收不限制、发不给任何目标', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn();
  const rules = { receive: { group_ids: [], user_ids: [], keywords: [], keywords_regex: [], blocked_segments: [] }, send: { group_ids: [], user_ids: [], segments: ['text'] } };
  assert.equal((await h.put({ policy: 'main', rules }, cookie)).status, 200);
  const { policies } = await h.stored();
  const main = policies.main!;
  assert.deepEqual(main.events.allow.filter(scope => scope.post_type === 'message'), [
    { post_type: 'message', message_type: 'group' },
    { post_type: 'message', message_type: 'private' },
  ]);
  assert.equal(main.actions.allow.some(rule => rule.name.startsWith('send_')), false);
  assert.deepEqual(readRules(main).send, { group_ids: [], user_ids: [], segments: ['text'] });
});

test('坏输入不改文件，未登录与关闭编辑分别返回 401 与 404', async t => {
  const h = await fixture(t); const cookie = await h.loggedIn();
  const original = await readFile(h.path);
  const rejects: [unknown, number][] = [
    [{ policy: 'main', rules: { receive: { group_ids: 'GROUP_ALLOWED' } } }, 400],
    [{ policy: 'main', rules: { receive: { group_ids: [1] } } }, 400],
    [{ policy: 'main', rules: { receive: { keywords: [''] } } }, 400],
    [{ policy: 'main', rules: { receive: { typo: [] } } }, 400],
    [{ policy: 'main', rules: { send: 'nope' } }, 400],
    [{ policy: 'absent', rules: h.form }, 400],
    [{ rules: h.form }, 400],
    [{ policy: 'main' }, 400],
    [[1, 2], 400],
  ];
  for (const [body, status] of rejects) assert.equal((await h.put(body, cookie)).status, status);
  assert.deepEqual(await readFile(h.path), original);
  assert.equal((await h.put({ policy: 'main', rules: h.form })).status, 401);
  assert.deepEqual(await readFile(h.path), original);
  assert.equal((await h.put({ policy: 'main', rules: h.form }, undefined, { Authorization: `Bearer ${h.env.WRITE_TOKEN}` })).status, 200);
  assert.notDeepEqual(await readFile(h.path), original);
  const readOnly = await fixture(t, { allow_policy_edit: false });
  const readOnlyCookie = await readOnly.loggedIn();
  assert.equal((await readOnly.put({ policy: 'main', rules: readOnly.form }, readOnlyCookie)).status, 404);
  assert.equal((await readOnly.get('/api/rules', readOnlyCookie)).status, 200);
});

test('表单与策略之间的转换是纯函数且可往返', () => {
  const policy = config().policies.main!;
  const rules = readRules(policy);
  assert.deepEqual(readRules(writeRules(policy, rules)), rules);
  const sorted = writeRules(policy, { receive: { group_ids: ['B', 'A', 'A'], user_ids: [], keywords: ['x'], keywords_regex: ['^y'], blocked_segments: [] }, send: { group_ids: [], user_ids: ['U'], segments: [] } });
  assert.deepEqual(sorted.events.allow.find(scope => scope.post_type === 'message' && scope.message_type === 'group'), { post_type: 'message', message_type: 'group', group_ids: ['B', 'A', 'A'] });
  assert.deepEqual(sorted.actions.allow.filter(rule => rule.name === 'send_private_msg'), [{ name: 'send_private_msg', user_ids: ['U'], segment_types: ['text'] }]);
  for (const bad of ['nope', null, [], { receive: [] }, { receive: { group_ids: {} } }, { send: 'nope' }]) assert.throws(() => parseRules(bad));
  assert.deepEqual(parseRules({}), { receive: { group_ids: [], user_ids: [], keywords: [], keywords_regex: [], blocked_segments: [] }, send: { group_ids: [], user_ids: [], segments: [] } });
  assert.deepEqual(parseRules({ receive: { group_ids: ['A', 'A'] } }).receive.group_ids, ['A']);
  assert.deepEqual(readRules(policy).receive.keywords_regex, []);
});
