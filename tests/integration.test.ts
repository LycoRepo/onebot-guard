import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateConfig } from '../src/config/load.ts';
import { ACCOUNT, GROUP, config, connect, event, harness, mockServer, reply, send, sendAction, waitFor } from './helpers.ts';

test('1. two downstream callers with duplicate echo get only their own out-of-order responses', async t => {
  const h = await harness(t); const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  send(a.socket, { action: 'get_status', echo: 'same' }); send(b.socket, { action: 'get_status', echo: 'same' });
  const first = await up.next(); const second = await up.next();
  assert.notEqual(first.echo, second.echo);
  const p = [...h.gateway.echoes.entries.values()];
  const pa = p.find(p => p.route === 'routeA')!; const pb = p.find(p => p.route === 'routeB')!;
  send(up.socket, reply({ echo: pb.echo }, { data: 'result-B' }));
  send(up.socket, reply({ echo: pa.echo }, { data: 'result-A' }));
  assert.deepEqual(await a.next(), { status: 'ok', retcode: 0, data: 'result-A', echo: 'same' });
  assert.deepEqual(await b.next(), { status: 'ok', retcode: 0, data: 'result-B', echo: 'same' });
  for (const value of [undefined, null, 0, false, ['echo'], { nested: true }]) {
    const original = value === undefined ? {} : { echo: value };
    send(a.socket, { action: 'get_status', ...original }); const request = await up.next();
    send(up.socket, reply(request));
    assert.deepEqual(await a.next(), { status: 'ok', retcode: 0, data: null, ...original });
  }
  send(up.socket, event({ post_type: 'meta_event', meta_event_type: 'heartbeat', barrier: true }));
  assert.equal((await a.next()).barrier, true); assert.equal((await b.next()).barrier, true);
  assert.equal(a.packets.length, 0); assert.equal(b.packets.length, 0); assert.equal(h.gateway.echoes.entries.size, 0);
});

test('2. downstream and upstream reconnection reject late replies for both previous generations', async t => {
  const h = await harness(t); let up = await h.dial('up'); let a = await h.dial('downA');
  send(a.socket, { action: 'get_status', echo: 'reused' }); const oldDownRequest = await up.next();
  const oldDownGeneration = h.gateway.endpoints.get('downA')!.peer!.session.generation;
  a.socket.terminate(); await waitFor(() => !h.gateway.endpoints.get('downA')!.peer);
  assert.equal(h.gateway.echoes.entries.size, 0);
  a = await h.dial('downA'); assert.notEqual(h.gateway.endpoints.get('downA')!.peer!.session.generation, oldDownGeneration);
  send(a.socket, { action: 'get_status', echo: 'reused' }); const newDownRequest = await up.next();
  send(up.socket, reply(oldDownRequest, { data: 'OLD_DOWN' })); send(up.socket, reply(newDownRequest, { data: 'NEW_DOWN' }));
  assert.equal((await a.next()).data, 'NEW_DOWN');
  send(a.socket, { action: 'get_status', echo: 'reused' }); const oldUpRequest = await up.next();
  const oldUpGeneration = h.gateway.endpoints.get('up')!.peer!.session.generation;
  up.socket.terminate();
  const unknown = await a.next(); assert.equal(unknown.message, 'disconnected_result_unknown'); assert.equal(unknown.echo, 'reused');
  await waitFor(() => !h.gateway.endpoints.get('up')!.peer);
  up = await h.dial('up'); assert.notEqual(h.gateway.endpoints.get('up')!.peer!.session.generation, oldUpGeneration);
  send(a.socket, { action: 'get_status', echo: 'reused' }); const newUpRequest = await up.next();
  send(up.socket, reply(oldUpRequest, { data: 'OLD_UP' })); send(up.socket, reply(newUpRequest, { data: 'NEW_UP' }));
  assert.equal((await a.next()).data, 'NEW_UP');
  send(up.socket, event({ post_type: 'meta_event', meta_event_type: 'heartbeat', barrier: true }));
  assert.equal((await a.next()).barrier, true); assert.equal(a.packets.length, 0);
  assert.equal(h.observation.issues.get('unmatched_or_late_response'), 2);
});

test('3. generic targets, variants, message reads, references, identity overrides and media never reach upstream', async t => {
  const c = config();
  for (const name of ['send_group_msg_async', 'send_group_msg_rate_limited', 'get_msg', 'get_group_msg_history', 'send_group_forward_msg', 'extension_action']) c.policies.main!.actions.allow.push({ name });
  const h = await harness(t, c); const up = await h.dial('up'); const a = await h.dial('downA');
  const requests = [
    sendAction({ params: { group_id: 'GROUP_DENIED', message: 'hello' } }),
    { action: 'send_msg', params: { message_type: 'group', group_id: 'GROUP_DENIED', message: 'hello' } },
    ...['send_group_msg_async', 'send_group_msg_rate_limited', 'get_msg', 'get_group_msg_history', 'send_group_forward_msg', 'extension_action'].map(action => ({ action, params: { message_id: 'MESSAGE_OTHER_SCOPE' } })),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'reply', data: { id: 'MESSAGE_OTHER_SCOPE' } }] } }),
    sendAction({ params: { group_id: GROUP, message: '[CQ:reply,id=MESSAGE_OTHER_SCOPE]' } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'image', data: { file: 'https://media.example.invalid/item' } }] } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'image', data: { file: 'file:///placeholder' } }] } }),
    sendAction({ params: { group_id: GROUP, message: [{ type: 'forward', data: { id: 'OTHER_FORWARD' } }] } }),
    sendAction({ self_id: 'ACCOUNT_B' }),
  ];
  for (let i = 0; i < requests.length; i++) {
    send(a.socket, { ...requests[i], echo: i });
    const denied = await a.next(); assert.equal(denied.status, 'failed'); assert.notEqual(denied.retcode, 0); assert.equal(denied.echo, i);
  }
  send(a.socket, { action: 'get_status', echo: 'barrier' });
  const barrier = await up.next(); assert.equal(barrier.action, 'get_status'); assert.equal(up.packets.length, 0);
  send(up.socket, reply(barrier)); assert.equal((await a.next()).echo, 'barrier');
});

test('4. content filters and inbound quotas leave authorized heartbeat, lifecycle and action responses intact', async t => {
  const c = config(); c.policies.main!.limits.inbound_per_route_per_min = 1;
  const h = await harness(t, c); const up = await h.dial('up'); const a = await h.dial('downA');
  send(up.socket, event({ message: 'BLOCKED' }));
  send(up.socket, event({ message: 'allowed', marker: 1, unknown_field: { keep: true } }));
  const allowed = await a.next(); assert.equal(allowed.marker, 1); assert.deepEqual(allowed.unknown_field, { keep: true });
  send(up.socket, event({ marker: 2 }));
  for (const subtype of ['heartbeat', 'lifecycle']) {
    send(up.socket, event({ post_type: 'meta_event', meta_event_type: subtype, message: 'BLOCKED' }));
    assert.equal((await a.next()).meta_event_type, subtype);
  }
  send(a.socket, { action: 'get_status', echo: 'control' }); const request = await up.next();
  send(up.socket, reply(request, { data: 'BLOCKED' })); assert.equal((await a.next()).data, 'BLOCKED');
  assert.ok(h.observation.rules.get('event.keyword')); assert.ok(h.observation.rules.get('event.rate')); assert.equal(a.packets.length, 0);
});

for (const mode of ['drop_events', 'disconnect_connection'] as const) test(`5. real paused downstream hits bounded send buffer (${mode})`, async t => {
  const c = config(); delete c.endpoints.downB; c.routes.pop();
  c.runtime.max_message_bytes = 32768; c.runtime.max_buffer_bytes_per_connection = 65536; c.runtime.on_buffer_full = mode;
  c.policies.main!.events.deny.keywords = [];
  const h = await harness(t, c); const up = await h.dial('up'); const a = await h.dial('downA');
  a.socket.pause();
  const peer = h.gateway.endpoints.get('downA')!.peer!;
  const raw = JSON.stringify(event({ message: 'x'.repeat(16000) }));
  // Send through real WS/TCP, stopping at the first observed overflow. No mocked bufferedAmount.
  let sent = 0;
  while (sent < 4096 && !h.observation.issues.has(mode === 'drop_events' ? 'buffer_event_dropped' : 'buffer_connection_closed')) {
    for (let i = 0; i < 32; i++) {
      await new Promise<void>((resolve, reject) => up.socket.send(raw, error => error ? reject(error) : resolve())); sent++;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(sent < 4096, 'real consumer must trigger the configured buffer ceiling');
  assert.ok(peer.socket.bufferedAmount <= c.runtime.max_buffer_bytes_per_connection);
  assert.equal(h.gateway.echoes.entries.size, 0); assert.equal(h.gateway.dedupe.entries.size, 0);
  if (mode === 'drop_events') {
    assert.equal(peer.active, true); assert.ok(h.observation.issues.get('buffer_event_dropped'));
    let controlResult: string = 'sent'; let controls = 0;
    while (controlResult === 'sent' && controls++ < 4096) {
      controlResult = peer.send(event({ post_type: 'meta_event', meta_event_type: 'heartbeat', message: 'x'.repeat(16000) }), 'control');
      assert.ok(peer.socket.bufferedAmount <= c.runtime.max_buffer_bytes_per_connection);
    }
    assert.equal(controlResult, 'buffer_full');
    assert.equal(peer.active, false);
  } else assert.equal(peer.active, false);
  a.socket.resume();
});

test('5. payload, pending-request, timeout and state ceilings reject explicitly and clean memory', async t => {
  const c = config(); c.runtime.max_message_bytes = 2048; c.runtime.max_pending_requests = 2; c.runtime.request_timeout_ms = 80; c.runtime.max_state_entries = 2;
  c.policies.main!.events.allow.push({ post_type: 'message', message_type: 'group' });
  c.policies.main!.limits.inbound_per_group_per_min = 10;
  const h = await harness(t, c); const up = await h.dial('up'); const a = await h.dial('downA');
  for (let i = 0; i < 3; i++) send(a.socket, { action: 'get_status', echo: i });
  await up.next(); await up.next();
  const pendingDenied = await a.next(p => p.echo === 2); assert.equal(pendingDenied.message, 'pending_request_limit');
  assert.ok(h.gateway.echoes.entries.size <= 2);
  for (let i = 0; i < 2; i++) { const timeout = await a.next(); assert.equal(timeout.message, 'request_timeout_result_unknown'); }
  assert.equal(h.gateway.echoes.entries.size, 0);
  for (let i = 0; i < 4; i++) send(up.socket, event({ group_id: `GROUP_TEST_${i}`, message_id: `MESSAGE_${i}` }));
  send(up.socket, event({ post_type: 'meta_event', meta_event_type: 'heartbeat', barrier: true }));
  await a.next(p => p.barrier === true);
  assert.equal(h.gateway.dedupe.entries.size, 2); assert.equal(h.gateway.inbound.entries.size, 2);
  assert.ok(h.observation.rules.get('event.rate'));
  send(up.socket, event({ message: 'x'.repeat(4096) }));
  await waitFor(() => !h.gateway.endpoints.get('up')!.peer);
  assert.ok(h.observation.issues.get('socket_error_or_payload_limit'));
});

test('5. send buffer reserves WS frame overhead and disconnects instead of dropping control packets', async t => {
  const c = config(); c.runtime.max_buffer_bytes_per_connection = 50;
  const h = await harness(t, c); await h.dial('downA');
  const peer = h.gateway.endpoints.get('downA')!.peer!;
  const packet = { padding: 'x'.repeat(26) }; // 40-byte JSON plus frame header reservation exceeds 50.
  assert.equal(Buffer.byteLength(JSON.stringify(packet)), 40);
  assert.equal(peer.send(packet, 'event'), 'buffer_full'); assert.equal(peer.active, true);
  assert.equal(peer.socket.bufferedAmount, 0);
  assert.equal(peer.send(packet, 'control'), 'buffer_full'); assert.equal(peer.active, false);
});

test('6. invalid or structural reload keeps old policy; watcher handles atomic replace and tightening applies immediately', async t => {
  const c = config(); c.reload.policy_watch = true; c.policies.main!.limits.outbound_per_route_per_min = 10;
  const h = await harness(t, c); const up = await h.dial('up'); const a = await h.dial('downA');
  const original = h.gateway.config.policies;
  await writeFile(h.path, 'policies: [invalid');
  assert.equal(h.reloader.reload(), false); assert.equal(h.gateway.config.policies, original);
  send(a.socket, sendAction({ echo: 'still-allowed' })); const request = await up.next(); send(up.socket, reply(request));
  assert.equal((await a.next()).status, 'ok');
  const structural = structuredClone(c); structural.endpoints.up!.expected_self_id = 'ACCOUNT_B';
  await writeFile(h.path, JSON.stringify(structural)); assert.equal(h.reloader.reload(), false); assert.equal(h.gateway.config.policies, original);
  const next = structuredClone(c); next.policies.main!.actions.allow = [{ name: 'get_status' }]; next.policies.main!.events.allow = [{ post_type: 'meta_event' }]; next.policies.main!.limits.outbound_per_route_per_min = 1;
  const temporary = join(h.directory, 'replacement.yaml'); await writeFile(temporary, JSON.stringify(next)); await rename(temporary, h.path);
  await waitFor(() => h.gateway.config.policies.main!.actions.allow.length === 1);
  send(a.socket, sendAction({ echo: 'now-denied' })); assert.equal((await a.next()).message, 'action_not_authorized');
  send(up.socket, event()); send(up.socket, event({ post_type: 'meta_event', meta_event_type: 'heartbeat', barrier: true }));
  assert.equal((await a.next()).barrier, true); assert.equal(a.packets.length, 0);
  // Existing quota usage survives reload: tightening cannot be bypassed by resetting counters.
  send(a.socket, { action: 'get_status', echo: 'quota-tightened' }); assert.equal((await a.next()).message, 'outbound_quota_or_state_limit');
  assert.equal(up.packets.length, 0); assert.ok(h.logs.some(line => line.includes('必须重启')));
});

test('7. sent action becomes unknown on upstream disconnect and is never replayed by automatic reconnect', async t => {
  const mock = await mockServer(t); const c = config();
  c.endpoints.up = { side: 'upstream', connection: 'connect', protocol: 'onebot_v11', url: mock.url, token_env: 'TEST_TOKEN', expected_self_id: ACCOUNT, reconnect: true };
  const h = await harness(t, validateConfig(c)); const a = await h.dial('downA');
  await waitFor(() => mock.connections.length === 1);
  const first = mock.connections[0]!; const probe = await first.next(); assert.equal(probe.action, 'get_login_info');
  send(first.socket, reply(probe, { data: { user_id: ACCOUNT } })); await waitFor(() => !!h.gateway.endpoints.get('up')!.peer?.session.account);
  send(a.socket, sendAction({ echo: 'sent-once' })); const oldRequest = await first.next(); assert.equal(oldRequest.action, 'send_group_msg');
  first.socket.terminate(); const failure = await a.next(); assert.equal(failure.message, 'disconnected_result_unknown'); assert.equal(failure.echo, 'sent-once');
  await waitFor(() => mock.connections.length === 2);
  const second = mock.connections[1]!; const nextProbe = await second.next(); assert.equal(nextProbe.action, 'get_login_info');
  send(second.socket, reply(nextProbe, { data: { user_id: ACCOUNT } })); await waitFor(() => !!h.gateway.endpoints.get('up')!.peer?.session.account);
  send(a.socket, { action: 'get_status', echo: 'barrier' }); const barrier = await second.next(); assert.equal(barrier.action, 'get_status');
  send(second.socket, reply(oldRequest, { data: 'late' })); send(second.socket, reply(barrier)); assert.equal((await a.next()).echo, 'barrier');
  assert.equal(second.packets.length, 0); assert.equal(h.gateway.echoes.entries.size, 0);
});

test('health/stats are loopback, read-only and body/credential free; offline events are not replayed', async t => {
  const h = await harness(t);
  let health = await fetch(`${h.healthURL}/health`); assert.equal(health.status, 503);
  const up = await h.dial('up'); const a = await h.dial('downA'); const b = await h.dial('downB');
  health = await fetch(`${h.healthURL}/health`); assert.equal(health.status, 200);
  a.socket.terminate(); await waitFor(() => !h.gateway.endpoints.get('downA')!.peer);
  send(up.socket, event({ message: 'BODY_PRIVATE', message_id: 'OFFLINE_EVENT' })); assert.equal((await b.next()).message_id, 'OFFLINE_EVENT');
  const newA = await h.dial('downA');
  send(up.socket, event({ post_type: 'meta_event', meta_event_type: 'heartbeat', barrier: true }));
  assert.equal((await newA.next()).barrier, true); assert.equal(newA.packets.length, 0);
  const statsResponse = await fetch(`${h.healthURL}/stats`); const statsText = await statsResponse.text(); const stats = JSON.parse(statsText);
  assert.equal(statsResponse.status, 200); assert.doesNotMatch(statsText, /BODY_PRIVATE/); assert.ok(!statsText.includes(h.token));
  assert.equal(stats.queues.application_queue, 0); assert.equal(stats.hits_by_rule['event.delivery'], 1); assert.ok(stats.last_event_at);
  assert.equal((await fetch(`${h.healthURL}/stats`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${h.healthURL}/unknown`)).status, 404);
  h.gateway.closeRoute('routeA'); assert.equal((await fetch(`${h.healthURL}/health`)).status, 503);
});

test('upstream listener checks token, Universal role and identity; packet identity mismatch closes session', async t => {
  const h = await harness(t); const url = `ws://127.0.0.1:${h.gateway.endpoints.get('up')!.address()!.port}`;
  for (const [token, headers] of [
    [randomUUID(), { 'X-Self-ID': ACCOUNT, 'X-Client-Role': 'Universal' }],
    [h.token, { 'X-Self-ID': 'ACCOUNT_B', 'X-Client-Role': 'Universal' }],
    [h.token, { 'X-Self-ID': ACCOUNT, 'X-Client-Role': 'Event' }],
  ] as const) await assert.rejects(connect(url, token, headers), /Unexpected server response/);
  const up = await h.dial('up'); await h.dial('downA');
  send(up.socket, event({ self_id: 'ACCOUNT_B' })); await waitFor(() => !h.gateway.endpoints.get('up')!.peer);
  assert.ok(h.observation.rules.get('event.identity'));
});

test('upstream connect fails closed before identity verification and on wrong probe identity', async t => {
  const mock = await mockServer(t); const c = config();
  c.endpoints.up = { side: 'upstream', connection: 'connect', protocol: 'onebot_v11', url: mock.url, token_env: 'TEST_TOKEN', expected_self_id: ACCOUNT, reconnect: false };
  const h = await harness(t, validateConfig(c)); const a = await h.dial('downA');
  await waitFor(() => mock.connections.length === 1); const upstream = mock.connections[0]!; const probe = await upstream.next();
  send(upstream.socket, event()); send(a.socket, sendAction({ echo: 'unverified' }));
  assert.equal((await a.next()).message, 'upstream_unavailable');
  send(upstream.socket, reply(probe, { data: { user_id: 'ACCOUNT_B' } })); await waitFor(() => !h.gateway.endpoints.get('up')!.peer);
  assert.equal((await fetch(`${h.healthURL}/health`)).status, 503); assert.equal(upstream.packets.length, 0);
});

test('downstream connect supplies reverse WS identity headers and uses the same authorization and echo path', async t => {
  const mock = await mockServer(t); const c = config();
  let headers: Record<string, string | string[] | undefined> = {};
  mock.server.on('connection', (_socket, req) => { headers = req.headers; });
  c.endpoints.downA = { side: 'downstream', connection: 'connect', protocol: 'onebot_v11', url: mock.url, token_env: 'TEST_TOKEN', principal: 'APP_A', readonly: false, reconnect: true };
  const h = await harness(t, validateConfig(c)); const up = await h.dial('up');
  await waitFor(() => mock.connections.length === 1); const downstream = mock.connections[0]!;
  assert.equal(headers['x-client-role'], 'Universal'); assert.equal(headers['x-self-id'], ACCOUNT); assert.equal(headers.authorization, `Bearer ${h.token}`);
  send(downstream.socket, sendAction({ echo: { reverse: true } })); const request = await up.next(); send(up.socket, reply(request));
  assert.deepEqual((await downstream.next()).echo, { reverse: true });
  send(up.socket, event({ reverse_marker: true })); assert.equal((await downstream.next()).reverse_marker, true);
  const generation = h.gateway.endpoints.get('downA')!.peer!.session.generation;
  downstream.socket.terminate(); await waitFor(() => mock.connections.length === 2 && !!h.gateway.endpoints.get('downA')!.peer?.active && h.gateway.endpoints.get('downA')!.peer!.session.generation !== generation);
  assert.notEqual(h.gateway.endpoints.get('downA')!.peer!.session.generation, generation);
});

test('route closure clears pending requests; sent reads use the newest visibility policy on return', async t => {
  const c = config(); const h = await harness(t, c); const up = await h.dial('up'); const a = await h.dial('downA');
  send(a.socket, { action: 'get_group_list', echo: 'groups' }); const listRequest = await up.next();
  const next = structuredClone(c); next.policies.main!.events.allow = [{ post_type: 'meta_event' }];
  await writeFile(h.path, JSON.stringify(next)); assert.equal(h.reloader.reload(), true);
  send(up.socket, reply(listRequest, { data: [{ group_id: GROUP }, { group_id: 'GROUP_DENIED' }] }));
  assert.deepEqual((await a.next()).data, []);
  send(a.socket, { action: 'get_status', echo: 'pending' }); const old = await up.next();
  h.gateway.closeRoute('routeA'); assert.equal(h.gateway.echoes.entries.size, 0);
  const closed = await a.next(); assert.equal(closed.message, 'route_closed_result_unknown'); assert.equal(closed.echo, 'pending');
  send(up.socket, reply(old)); send(a.socket, { action: 'get_status', echo: 'closed' });
  assert.equal((await a.next()).message, 'route_closed');
  assert.ok(h.observation.issues.get('unmatched_or_late_response'));
});

test('CLI process handles real Unix SIGHUP and SIGTERM', { skip: process.platform === 'win32' ? 'SIGHUP is Unix-only; file-watch reload tested on Windows' : false }, async t => {
  const h = await harness(t);
  const child = spawn(process.execPath, ['src/index.ts'], { env: { ...process.env, GATEWAY_CONFIG: h.path, TEST_TOKEN: h.token }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  await waitFor(() => output.includes('gateway_started'));
  const next = config(); next.policies.main!.actions.allow = [];
  await writeFile(h.path, JSON.stringify(next)); child.kill('SIGHUP');
  await waitFor(() => output.includes('policy_reload_success'));
  child.kill('SIGTERM'); assert.equal(await exited, 0); assert.equal(errors, ''); assert.ok(output.includes('gateway_stopped'));
});
