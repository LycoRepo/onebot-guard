import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { Config, Endpoint } from '../config/types.ts';
import { authenticated, credential, newSession } from '../identity/index.ts';
import type { Session } from '../identity/index.ts';
import type { Packet } from '../protocol/onebot11/index.ts';
import { oneBotTerm } from '../protocol/onebot11/index.ts';

export type SendKind = 'event' | 'control';
export type SendResult = 'sent' | 'offline' | 'buffer_full' | 'too_large' | 'send_error';
export interface TransportHooks {
  open(peer: Peer): void;
  packet(peer: Peer, raw: string): void;
  close(peer: Peer): void;
  issue(endpoint: string, reason: string): void;
}
// A hard cap before ws.send: no application queue, no offline replay.
export function bufferDecision(buffered: number, bytes: number, limit: number, mode: Config['runtime']['on_buffer_full'], kind: SendKind): 'send' | 'drop' | 'disconnect' {
  if (buffered + bytes <= limit) return 'send';
  return mode === 'drop_events' && kind === 'event' ? 'drop' : 'disconnect';
}
export class Peer {
  socket: WebSocket;
  session: Session;
  alive = true;
  active = true;
  runtime: Config['runtime'];
  issue: (reason: string) => void;
  constructor(socket: WebSocket, session: Session, runtime: Config['runtime'], issue: (reason: string) => void) {
    this.socket = socket; this.session = session; this.runtime = runtime; this.issue = issue;
  }
  send(packet: Packet, kind: SendKind = 'control'): SendResult {
    if (!this.active || this.socket.readyState !== WebSocket.OPEN) return 'offline';
    const raw = JSON.stringify(packet); const bytes = Buffer.byteLength(raw);
    if (bytes > this.runtime.max_message_bytes) { this.issue('outgoing_message_too_large'); this.disconnect(); return 'too_large'; }
    // Reserve the largest WS frame header (including client masking).
    const decision = bufferDecision(this.socket.bufferedAmount, bytes + 14, this.runtime.max_buffer_bytes_per_connection, this.runtime.on_buffer_full, kind);
    if (decision !== 'send') {
      this.issue(decision === 'drop' ? 'buffer_event_dropped' : 'buffer_connection_closed');
      if (decision === 'disconnect') this.disconnect();
      return 'buffer_full';
    }
    try {
      this.socket.send(raw, { compress: false }, err => { if (err && this.active) { this.issue('send_error_result_unknown'); this.disconnect(); } });
      return 'sent';
    } catch { this.issue('send_error_result_unknown'); this.disconnect(); return 'send_error'; }
  }
  disconnect(): void { this.active = false; this.socket.terminate(); }
}

export class EndpointTransport {
  id: string; endpoint: Endpoint; runtime: Config['runtime']; hooks: TransportHooks; token: string;
  account: string; env: NodeJS.ProcessEnv;
  peer: Peer | undefined; server: Server | undefined; wsServer: WebSocketServer | undefined;
  dialing: WebSocket | undefined; reconnectTimer: NodeJS.Timeout | undefined; pingTimer: NodeJS.Timeout | undefined;
  stopped = true; attempts = 0; reserved = false;
  constructor(id: string, endpoint: Endpoint, runtime: Config['runtime'], account: string, env: NodeJS.ProcessEnv, hooks: TransportHooks) {
    this.id = id; this.endpoint = endpoint; this.runtime = runtime; this.account = account; this.env = env; this.hooks = hooks;
    this.token = credential(env, endpoint.token_env);
  }
  async start(): Promise<void> {
    this.stopped = false;
    this.pingTimer = setInterval(() => {
      const peer = this.peer;
      if (!peer?.active) return;
      if (!peer.alive) { this.hooks.issue(this.id, 'ping_timeout'); peer.disconnect(); return; }
      peer.alive = false;
      if (peer.socket.bufferedAmount + 6 > this.runtime.max_buffer_bytes_per_connection) { this.hooks.issue(this.id, 'buffer_connection_closed'); peer.disconnect(); return; }
      try { peer.socket.ping(); } catch { peer.disconnect(); }
    }, this.runtime.ping_interval_ms);
    if (this.endpoint.connection === 'connect') { this.dial(); return; }
    const tls = this.endpoint.tls;
    const server = tls ? createSecureServer({ cert: credential(this.env, tls.cert_env), key: credential(this.env, tls.key_env) }) : createServer();
    this.server = server;
    server.maxConnections = 1;
    server.headersTimeout = this.runtime.handshake_timeout_ms;
    server.requestTimeout = this.runtime.handshake_timeout_ms;
    server.on('connection', socket => socket.setTimeout(this.runtime.handshake_timeout_ms, () => socket.destroy()));
    server.on('request', (_req, res) => { res.writeHead(404, { Connection: 'close' }); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.runtime.max_message_bytes, perMessageDeflate: false });
    this.wsServer = wss;
    server.on('upgrade', (req, socket, head) => {
      const reject = (code: number, reason: string): void => {
        this.hooks.issue(this.id, reason);
        socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (this.stopped || this.reserved || this.peer) { reject(409, 'endpoint_session_limit'); return; }
      const authorization = req.headers.authorization;
      if (!authenticated(authorization, this.token)) { reject(401, 'authentication_denied'); return; }
      if (this.endpoint.side === 'upstream' && (req.headers['x-client-role'] !== 'Universal' || req.headers['x-self-id'] !== this.account)) {
        reject(403, 'upstream_role_or_account_mismatch'); return;
      }
      this.reserved = true;
      if (socket instanceof Socket) socket.setTimeout(0);
      socket.once('close', () => { this.reserved = false; });
      try { wss.handleUpgrade(req, socket, head, ws => { this.reserved = false; this.accept(ws); }); }
      catch { this.reserved = false; socket.destroy(); this.hooks.issue(this.id, 'upgrade_failed'); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.endpoint.port, this.endpoint.host, () => { server.off('error', reject); resolve(); }); });
    server.on('error', () => this.hooks.issue(this.id, 'listener_error'));
  }
  private dial(): void {
    if (this.stopped) return;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (this.endpoint.side === 'downstream') { headers['X-Self-ID'] = this.account; headers['X-Client-Role'] = 'Universal'; }
    const socket = new WebSocket(this.endpoint.url!, { headers, handshakeTimeout: this.runtime.handshake_timeout_ms, maxPayload: this.runtime.max_message_bytes, perMessageDeflate: false, followRedirects: false });
    this.dialing = socket;
    socket.once('open', () => { this.dialing = undefined; if (this.stopped) socket.terminate(); else this.accept(socket); });
    socket.on('error', () => this.hooks.issue(this.id, 'dial_or_socket_error'));
    socket.once('close', () => { if (this.dialing === socket) { this.dialing = undefined; this.scheduleReconnect(); } });
  }
  private scheduleReconnect(): void {
    if (this.stopped || !this.endpoint.reconnect || this.reconnectTimer) return;
    const r = this.runtime.reconnect;
    const base = Math.min(r.max_ms, r.initial_ms * 2 ** Math.min(this.attempts++, 30));
    const delay = r.jitter ? Math.max(1, Math.floor(base * (0.5 + Math.random() * 0.5))) : base;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.dial(); }, delay);
  }
  private accept(socket: WebSocket): void {
    if (this.stopped || this.peer) { socket.terminate(); return; }
    const session = newSession(this.id);
    if (this.endpoint.side === 'downstream') session.principal = this.endpoint.principal!;
    else if (this.endpoint.connection === 'listen') session.account = this.account;
    const peer = new Peer(socket, session, this.runtime, reason => this.hooks.issue(this.id, reason));
    this.peer = peer;
    socket.on('pong', () => { peer.alive = true; });
    socket.on('error', () => { this.hooks.issue(this.id, 'socket_error_or_payload_limit'); peer.disconnect(); });
    socket.on('message', (data, binary) => {
      if (!peer.active || this.peer !== peer) return;
      if (binary) { this.hooks.issue(this.id, 'binary_packet_denied'); peer.disconnect(); return; }
      this.hooks.packet(peer, data.toString());
    });
    socket.once('close', () => {
      peer.active = false;
      if (this.peer === peer) this.peer = undefined;
      this.hooks.close(peer);
      if (this.endpoint.connection === 'connect') this.scheduleReconnect();
    });
    this.hooks.open(peer);
  }
  markReady(): void { this.attempts = 0; }
  address(): AddressInfo | undefined { const value = this.server?.address(); return value && typeof value !== 'string' ? value : undefined; }
  snapshot(): Record<string, unknown> {
    return { side: this.endpoint.side, connection: this.endpoint.connection, onebot: oneBotTerm(this.endpoint.side, this.endpoint.connection), connected: !!this.peer?.active, ready: !!this.peer?.active && !!(this.peer.session.account || this.peer.session.principal), buffered_bytes: this.peer?.socket.bufferedAmount ?? 0, reconnect_attempts: this.attempts };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer);
    const peer = this.peer;
    const closed = peer ? new Promise<void>(resolve => peer.socket.once('close', () => resolve())) : Promise.resolve();
    this.dialing?.terminate(); peer?.disconnect();
    this.wsServer?.close();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); }
    await closed;
  }
}
