import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { loadConfig, validateConfig, validateRegex } from '../src/config/load.ts';
import { reloadPolicies } from '../src/config/reload.ts';
import { authenticated, boundAccount, newSession } from '../src/identity/index.ts';
import { checkAction, sanitizeResponse } from '../src/policy/action/index.ts';
import { checkEvent, visibleGroup } from '../src/policy/event/index.ts';
import { classify, failure, parseAction, parsePacket } from '../src/protocol/onebot11/index.ts';
import type { Packet } from '../src/protocol/onebot11/index.ts';
import { Dedupe, EchoMap, RateLimiter } from '../src/runtime/index.ts';
import { bufferDecision } from '../src/transport/index.ts';
import { Observability } from '../src/observability/index.ts';
import { ACCOUNT, GROUP, USER, config, event, harness, sendAction } from './helpers.ts';

test('example config loads; defaults and readable validation reject unsafe inputs', () => {
  const sample = loadConfig('config/gateway.example.yaml');
  assert.equal(sample.runtime.max_connections, 64);
  assert.equal(sample.runtime.max_state_entries, 4096);
  assert.equal(sample.extensions.coordination.enabled, false);
  const cases: [string, (c: Record<string, any>) => void, RegExp][] = [
    ['public observability', c => { c.observability.host = '0.0.0.0'; }, /只读接口只能绑定回环/],
    ['unknown config', c => { c.typo = true; }, /未知配置项/],
    ['numeric identity', c => { c.endpoints.up.expected_self_id = 42; }, /账号及资源 ID 请加引号/],
    ['connection cap', c => { c.runtime.max_connections = 1; }, /不得小于配置中的端点数/],
    ['coordination enabled', c => { c.extensions.coordination.enabled = true; }, /必须关闭/],
    ['missing policy', c => { c.routes[0].policy = 'absent'; }, /已有策略/],
    ['duplicate downstream', c => { c.routes[1].downstream = 'downA'; }, /只能绑定一条 route/],
    ['credentials in URL', c => { c.endpoints.up.connection = 'connect'; delete c.endpoints.up.port; delete c.endpoints.up.host; c.endpoints.up.url = 'ws://name:placeholder@localhost'; }, /无凭据/],
    ['deny defaults', c => { c.policies.main.actions.default = 'allow'; }, /必须是 deny/],
  ];
  for (const [name, mutate, reason] of cases) { const c = structuredClone(config()); mutate(c); assert.throws(() => validateConfig(c), reason, name); }
  for (const pattern of ['(a+)+', 'a|b', 'a+a+', '(a)\\1', 'a?', String.raw`a\\+b+`]) assert.throws(() => validateRegex(pattern, 'regex'), /安全子集/);
  validateRegex('^a{1,4}$', 'regex');
  validateRegex(String.raw`^[+?()|]+$`, 'regex');
  assert.throws(() => loadConfig('config/does-not-exist.yaml'), /配置文件无法读取/);
});

test('event scope, content, bot, unknown fields and control boundaries', () => {
  const p = config().policies.main!;
  const decide = (packet: Packet, max = 4096) => checkEvent(packet, p, ACCOUNT, max);
  assert.equal(decide(event({ extra: { retained: true } })).allowed, true);
  assert.equal(decide(event({ group_id: 'GROUP_DENIED' })).rule, 'event.scope.default');
  assert.equal(decide(event({ message: 'BLOCKED' })).rule, 'event.keyword');
  assert.equal(decide(event({ user_id: ACCOUNT })).rule, 'event.self');
  assert.equal(decide(event({ user_id: 'BOT_OTHER' })).allowed, true);
  p.events.deny.drop_bots = ['BOT_OTHER'];
  assert.equal(decide(event({ user_id: 'BOT_OTHER' })).rule, 'event.bot');
  p.events.deny.scopes = [{ post_type: 'message', group_ids: [GROUP], user_ids: [USER] }];
  assert.equal(decide(event()).rule, 'event.scope.deny');
  p.events.deny.scopes = [];
  p.events.deny.segment_types = ['image'];
  assert.equal(decide(event({ message: [{ type: 'image', data: { file: 'opaque' } }] })).rule, 'event.segment');
  assert.equal(decide(event({ message: '[CQ:image,file=opaque]' })).allowed, false);
  assert.equal(decide(event({ message: 'long' }), 3).rule, 'event.content.error');
  p.on_error = 'skip';
  assert.equal(decide(event({ message: 'long' }), 3).allowed, true);
  assert.equal(decide(event({ group_id: 'GROUP_DENIED', message: null })).allowed, false);
  for (const subtype of ['heartbeat', 'lifecycle']) assert.equal(decide(event({ post_type: 'meta_event', meta_event_type: subtype, message: 'BLOCKED' })).allowed, true);
  assert.equal(decide(event({ post_type: 'extension' })).allowed, false);
  p.events.allow.push({ post_type: 'extension' });
  assert.equal(decide(event({ post_type: 'extension' })).allowed, true);
  p.events.deny.keywords_regex = ['^test$']; p.events.deny.keywords = [];
  assert.equal(decide(event({ message: 'test' })).rule, 'event.regex');
});

test('YAML duplicate keys, aliases and file size limits fail with diagnostics', async t => {
  const h = await harness(t);
  await writeFile(h.path, 'schema_version: 1\nschema_version: 1\n');
  assert.throws(() => loadConfig(h.path), /YAML 配置语法无效或键重复/);
  await writeFile(h.path, 'schema_version: 1\na: &anchor { value: 1 }\nb: *anchor\n');
  assert.throws(() => loadConfig(h.path), /alias/i);
  await writeFile(h.path, 'x'.repeat(1048577));
  assert.throws(() => loadConfig(h.path), /1 MiB 上限/);
});

test('action authorization rejects generic, variants, references and media bypasses even explicitly allowed', () => {
  const p = config().policies.main!;
  const context = { authenticated: true, accountBound: true, readonly: false };
  const check = (packet: Packet) => checkAction(parseAction(packet), p, context);
  for (const name of ['get_msg', 'get_group_msg_history', 'send_group_msg_async', 'send_group_msg_rate_limited', 'send_group_forward_msg', 'extension_action']) p.actions.allow.push({ name });
  assert.equal(check(sendAction()).allowed, true);
  assert.equal(check(sendAction({ action: 'send_msg', params: { message_type: 'group', group_id: GROUP, message: 'hello' } })).allowed, true);
  assert.equal(check(sendAction({ action: 'send_private_msg', params: { user_id: USER, message: 'hello' } })).allowed, true);
  const denied: Packet[] = [
    sendAction({ params: { group_id: 'GROUP_DENIED', message: 'hello' } }),
    sendAction({ action: 'send_msg', params: { message_type: 'group', group_id: 'GROUP_DENIED', message: 'hello' } }),
    sendAction({ action: 'send_msg', params: { group_id: GROUP, message: 'hello' } }),
    sendAction({ action: 'send_msg', params: { message_type: 'group', group_id: GROUP, user_id: USER, message: 'hello' } }),
    ...['get_msg', 'get_group_msg_history', 'send_group_msg_async', 'send_group_msg_rate_limited', 'send_group_forward_msg', 'extension_action'].map(action => ({ action, params: {} })),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'reply', data: { id: 'MESSAGE_OTHER_SCOPE' } }] } }),
    sendAction({ params: { group_id: GROUP, message: '[CQ:reply,id=MESSAGE_OTHER_SCOPE]' } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'image', data: { file: 'https://media.example.invalid/item' } }] } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'record', data: { file: 'file:///placeholder' } }] } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'forward', data: { id: 'FORWARD_OTHER_SCOPE' } }] } }),
    sendAction({ self_id: 'ACCOUNT_B' }),
    sendAction({ params: { group_id: GROUP, message: 'hello', self_id: 'ACCOUNT_B' } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'at', data: { qq: 'all' } }] } }),
  ];
  for (const packet of denied) assert.equal(check(packet).allowed, false, JSON.stringify(packet));
  assert.equal(checkAction(parseAction(sendAction()), p, { ...context, readonly: true }).allowed, false);
  assert.equal(checkAction(parseAction(sendAction()), p, { ...context, authenticated: false }).allowed, false);
  assert.equal(checkAction(parseAction(sendAction()), p, { ...context, accountBound: false }).allowed, false);
  p.actions.deny.push({ name: 'send_group_msg' });
  assert.equal(check(sendAction()).rule, 'action.name.deny');
});

test('group enumeration cannot reveal sender-restricted or denied groups', () => {
  const p = config().policies.main!;
  assert.equal(visibleGroup(GROUP, p), true);
  const response = { status: 'ok', retcode: 0, data: [{ group_id: GROUP }, { group_id: 'GROUP_DENIED' }] };
  assert.deepEqual(sanitizeResponse(response, 'get_group_list', p).data, [{ group_id: GROUP }]);
  p.events.allow[0]!.user_ids = [USER]; assert.equal(visibleGroup(GROUP, p), false);
  delete p.events.allow[0]!.user_ids;
  p.events.deny.scopes.push({ post_type: 'message', group_ids: [GROUP], user_ids: [USER] });
  assert.equal(visibleGroup(GROUP, p), false);
  assert.throws(() => sanitizeResponse({ status: 'ok', data: {} }, 'get_group_list', p), /invalid_group_list/);
});

test('local and remote media switches remain independent across URL spellings', () => {
  const p = config().policies.main!;
  const rule = p.actions.allow.find(r => r.name === 'send_group_msg')!;
  const check = (file: string) => checkAction(parseAction(sendAction({ params: { group_id: GROUP, message: [{ type: 'image', data: { file } }] } })), p, { authenticated: true, accountBound: true, readonly: false });
  rule.allow_local_files = true;
  assert.equal(check('file:///placeholder').allowed, true);
  assert.equal(check('placeholder-image.png').allowed, true);
  for (const file of ['https://media.example.invalid/item', 'https:media.example.invalid/item', ' https://media.example.invalid/item', 'file://media.example.invalid/item', '//media.example.invalid/item', 'base64://placeholder', 'ftp://media.example.invalid/item']) assert.equal(check(file).allowed, false, file);
  rule.allow_local_files = false; rule.allow_remote_media = true;
  assert.equal(check('https://media.example.invalid/item').allowed, true);
  assert.equal(check('file:///placeholder').allowed, false);
  assert.equal(check('https://name:placeholder@media.example.invalid/item').allowed, false);
});

test('echo restores every JSON type and absence, isolates generations, bounds and expires', () => {
  const map = new EchoMap(2, 1000);
  for (const value of [undefined, null, false, 0, 'same', ['value'], { nested: { value: 1 } }]) {
    const original = value === undefined ? {} : { echo: value };
    const pending = map.add(original, 'route', 'down-1', 'up-1', 'get_status')!;
    assert.equal(pending.originalEcho.present, value !== undefined);
    assert.equal(pending.originalEcho.type, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
    assert.equal(map.take(pending.echo, 'up-2'), undefined);
    assert.deepEqual(map.restore({ echo: pending.echo, data: 'result' }, pending), { ...original, data: 'result' });
    assert.equal(map.take(pending.echo, 'up-1'), pending);
    assert.equal(map.take(pending.echo, 'up-1'), undefined);
  }
  const original = { echo: { mutable: true } }; const p = map.add(original, 'route', 'down-1', 'up-1', 'get_status')!;
  original.echo.mutable = false; assert.deepEqual(p.originalEcho.value, { mutable: true });
  map.add({}, 'route', 'down-1', 'up-1', 'get_status');
  assert.equal(map.add({}, 'route', 'down-1', 'up-1', 'get_status'), undefined);
  assert.equal(map.take(p.echo, 'up-1', p.expires), undefined);
  assert.equal(map.remove(x => x.downstreamGeneration === 'down-1').length, 2);
  assert.equal(map.entries.size, 0);
});

test('state and quota limits, expiry, atomic consumption and buffer policies', () => {
  const rate = new RateLimiter(2);
  assert.equal(rate.consume([{ key: 'a', limit: 1 }, { key: 'b', limit: 2 }], 0), true);
  assert.equal(rate.consume([{ key: 'a', limit: 1 }, { key: 'b', limit: 2 }], 1), false);
  assert.equal(rate.entries.get('b')!.count, 1);
  assert.equal(rate.consume([{ key: 'c', limit: 1 }], 1), false);
  assert.equal(rate.consume([{ key: 'off', limit: 0 }], 1), true);
  assert.equal(rate.consume([{ key: 'c', limit: 1 }], 60000), true);
  const dedupe = new Dedupe(2);
  assert.equal(dedupe.seen('ACCOUNT_A:group-a:id', 10, 0), false);
  assert.equal(dedupe.seen('ACCOUNT_A:group-a:id', 10, 1), true);
  assert.equal(dedupe.seen('ACCOUNT_B:group-a:id', 10, 1), false);
  assert.equal(dedupe.seen('ACCOUNT_A:group-b:id', 10, 1), false);
  assert.equal(dedupe.entries.size, 2);
  assert.equal(dedupe.seen('ACCOUNT_A:group-a:id', 10, 11), false);
  assert.equal(bufferDecision(5, 5, 10, 'drop_events', 'event'), 'send');
  assert.equal(bufferDecision(5, 6, 10, 'drop_events', 'event'), 'drop');
  assert.equal(bufferDecision(5, 6, 10, 'drop_events', 'control'), 'disconnect');
  assert.equal(bufferDecision(5, 6, 10, 'disconnect_connection', 'event'), 'disconnect');
});

test('policy reload rejects structural changes and keeps the original object untouched', () => {
  const c = config(); const next = structuredClone(c); next.policies.main!.actions.allow = [];
  assert.equal(reloadPolicies(c, next).policies.main!.actions.allow.length, 0);
  assert.ok(c.policies.main!.actions.allow.length > 0);
  next.endpoints.up!.expected_self_id = 'ACCOUNT_B';
  assert.throws(() => reloadPolicies(c, next), /必须重启/);
});

test('protocol and identity malformed packets, echo failures and connection generations', () => {
  assert.throws(() => parsePacket('[]'), /JSON 对象/);
  assert.throws(() => parseAction({ action: 'send_msg', params: [] }), /params 无效/);
  assert.deepEqual(failure({}, 'denied'), { status: 'failed', retcode: 1403, data: null, message: 'denied', wording: 'denied' });
  assert.equal(failure({ echo: false }, 'denied').echo, false);
  assert.equal(classify({ status: 'ok', retcode: 0 }), 'response');
  assert.equal(boundAccount({ self_id: 'ACCOUNT_B' }, ACCOUNT), false);
  assert.equal(authenticated('Bearer placeholder', 'placeholder'), true);
  assert.equal(authenticated('Bearer wrong', 'placeholder'), false);
  assert.notEqual(newSession('endpoint').generation, newSession('endpoint').generation);
});

test('structured denial logs omit body and credentials by default; previews are explicit', () => {
  const c = config(); const lines: string[] = []; const o = new Observability(c, line => lines.push(line));
  o.decision('routeA', 'event', { allowed: false, rule: 'event.keyword', reason: 'keyword_denied' }, 'generation', event({ message: 'BODY_PRIVATE', credentials: 'CREDENTIAL_PRIVATE' }));
  assert.equal(lines.length, 1); assert.doesNotMatch(lines[0]!, /BODY_PRIVATE|CREDENTIAL_PRIVATE/);
  assert.equal(JSON.parse(lines[0]!).scope, `group:${GROUP}`);
  c.log.message_preview_chars = 4;
  o.decision('routeA', 'event', { allowed: false, rule: 'event.keyword', reason: 'keyword_denied' }, 'generation', event({ message: 'BODY_PRIVATE\nsecond line' }));
  assert.equal(JSON.parse(lines[1]!).preview, 'BODY');
  assert.equal(lines[1]!.trim().split('\n').length, 1);
});
