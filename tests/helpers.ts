import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { validateConfig } from '../src/config/load.ts';
import type { Config } from '../src/config/types.ts';
import { startGateway } from '../src/index.ts';
import type { Packet } from '../src/protocol/onebot11/index.ts';

export const ACCOUNT = 'ACCOUNT_A';
export const GROUP = 'GROUP_ALLOWED';
export const USER = 'USER_ALLOWED';
export function config(): Config {
  return validateConfig({
    schema_version: 1,
    log: { format: 'json' }, observability: { port: 0 },
    runtime: { request_timeout_ms: 2000, handshake_timeout_ms: 1000, ping_interval_ms: 10000, reconnect: { initial_ms: 20, max_ms: 40, jitter: false } },
    reload: { policy_watch: false, debounce_ms: 20 },
    endpoints: {
      up: { side: 'upstream', connection: 'listen', protocol: 'onebot_v11', port: 0, token_env: 'TEST_TOKEN', expected_self_id: ACCOUNT },
      downA: { side: 'downstream', connection: 'listen', protocol: 'onebot_v11', port: 0, token_env: 'TEST_TOKEN', principal: 'APP_A' },
      downB: { side: 'downstream', connection: 'listen', protocol: 'onebot_v11', port: 0, token_env: 'TEST_TOKEN', principal: 'APP_B' },
    },
    routes: [{ id: 'routeA', upstream: 'up', downstream: 'downA', policy: 'main' }, { id: 'routeB', upstream: 'up', downstream: 'downB', policy: 'main' }],
    policies: { main: {
      events: { allow: [{ post_type: 'message', message_type: 'group', group_ids: [GROUP] }, { post_type: 'message', message_type: 'private', user_ids: [USER] }, { post_type: 'meta_event' }], deny: { keywords: ['BLOCKED'], drop_self: true } },
      actions: { allow: [{ name: 'get_status' }, { name: 'get_login_info' }, { name: 'get_group_list' }, ...['send_msg', 'send_group_msg', 'send_private_msg'].map(name => ({ name, group_ids: [GROUP], user_ids: [USER], segment_types: ['text', 'at', 'reply', 'image', 'record', 'video', 'forward'] }))] },
    } },
  });
}
export function event(fields: Packet = {}): Packet {
  return { self_id: ACCOUNT, post_type: 'message', message_type: 'group', group_id: GROUP, user_id: USER, message: 'hello', ...fields };
}
export function sendAction(fields: Packet = {}): Packet { return { action: 'send_group_msg', params: { group_id: GROUP, message: 'hello' }, ...fields }; }
export function reply(request: Packet, fields: Packet = {}): Packet { return { status: 'ok', retcode: 0, data: null, echo: request.echo, ...fields }; }
export function send(socket: WebSocket, packet: Packet): void { socket.send(JSON.stringify(packet)); }
export async function waitFor(condition: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() >= deadline) assert.fail('condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
export class Inbox {
  socket: WebSocket;
  packets: Packet[] = [];
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', raw => { this.packets.push(JSON.parse(raw.toString()) as Packet); });
    socket.on('error', () => {});
  }
  async next(predicate: (p: Packet) => boolean = () => true): Promise<Packet> {
    await waitFor(() => this.packets.some(predicate));
    const index = this.packets.findIndex(predicate);
    return this.packets.splice(index, 1)[0]!;
  }
}
export async function connect(url: string, token: string, extra: Record<string, string> = {}): Promise<Inbox> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, ...extra }, perMessageDeflate: false });
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return inbox;
}
export async function mockServer(t: TestContext): Promise<{ server: WebSocketServer; url: string; connections: Inbox[] }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  const connections: Inbox[] = [];
  server.on('connection', socket => connections.push(new Inbox(socket)));
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, connections };
}
export async function harness(t: TestContext, cfg = config()) {
  const directory = await mkdtemp(join(tmpdir(), 'onebot-guard-test-'));
  const path = join(directory, 'gateway.yaml');
  const logs: string[] = [];
  const token = randomUUID();
  await writeFile(path, JSON.stringify(cfg));
  let app: Awaited<ReturnType<typeof startGateway>>;
  try { app = await startGateway(path, { TEST_TOKEN: token }, line => logs.push(line)); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const clients: Inbox[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await app.stop();
    // directory comes directly from mkdtemp inside the system temp directory.
    await rm(directory, { recursive: true, force: true });
  });
  const dial = async (name: string): Promise<Inbox> => {
    const transport = app.gateway.endpoints.get(name)!;
    const client = await connect(`ws://127.0.0.1:${transport.address()!.port}`, token, name === 'up' ? { 'X-Self-ID': ACCOUNT, 'X-Client-Role': 'Universal' } : {});
    clients.push(client); return client;
  };
  const healthURL = `http://127.0.0.1:${app.observation.address()!.port}`;
  return { ...app, path, directory, logs, token, dial, healthURL };
}
