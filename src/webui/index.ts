import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Config } from '../config/types.ts';
import type { PolicyReloader } from '../config/reload.ts';
import type { Observability } from '../observability/index.ts';
import type { Gateway } from '../route/index.ts';
import { credential } from '../identity/index.ts';
import { authorized, redactor } from './security.ts';
import { PolicyError, PolicyFile } from './policies.ts';
import { cookie, sessionCookie, Sessions } from './sessions.ts';

const MAX_BODY = 1048576;
const MAX_STREAM_BUFFER = 65536;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export class WebUI {
  config: Config;
  observation: Observability;
  reloader: PolicyReloader;
  snapshot: Gateway['snapshot'];
  policies: PolicyFile;
  server: Server | undefined;
  private readToken: string | undefined;
  private writeToken: string | undefined;
  private redact: (text: string) => string;
  private streams = new Set<ServerResponse>();
  private sessionStreams = new Map<ServerResponse, string>();
  private sessions: Sessions;
  constructor(config: Config, snapshot: Gateway['snapshot'], observation: Observability, reloader: PolicyReloader, path: string, env: NodeJS.ProcessEnv, now = Date.now) {
    this.config = config; this.snapshot = snapshot; this.observation = observation; this.reloader = reloader;
    this.policies = new PolicyFile(path, reloader); this.redact = redactor(config, env);
    this.sessions = new Sessions(config.webui, now);
    if (config.webui.enabled) {
      if (config.webui.read_token_env) this.readToken = credential(env, config.webui.read_token_env);
      if (config.webui.allow_policy_edit && config.webui.write_token_env) this.writeToken = credential(env, config.webui.write_token_env);
    }
  }
  state() {
    const o = this.observation;
    const snapshot = this.snapshot();
    const endpoints = snapshot.endpoints as Record<string, { ready: boolean }>;
    const routes = (snapshot.routes as { id: string }[]).map(route => {
      const definition = this.config.routes.find(r => r.id === route.id)!;
      return { ...route, upstream_ready: endpoints[definition.upstream]!.ready, downstream_ready: endpoints[definition.downstream]!.ready };
    });
    return { ...snapshot, routes, started_at: o.startedAt, last_event_at: o.lastEventAt,
      totals: o.totals, counts_by_route: Object.fromEntries(o.routes), hits_by_rule: Object.fromEntries(o.rules), transport_issues: Object.fromEntries(o.issues),
      policies: Object.keys(this.reloader.current.policies), reload: this.reloader.lastResult,
      allow_policy_edit: this.config.webui.allow_policy_edit, log_ring_size: this.config.webui.log_ring_size,
      ...(this.config.observability.expose_message_preview && o.lastPreview !== undefined ? { message_preview: o.lastPreview } : {}) };
  }
  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(this.redact(JSON.stringify(body)));
  }
  private loginPage(res: ServerResponse): void {
    // Match the browser's HTML newline normalization before hashing and serving.
    const html = readFileSync(new URL('./static/login.html', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
    const hash = (tag: string): string => {
      const text = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
      if (text === undefined) throw new Error('登录页资源不完整');
      return `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
    };
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${hash('script')}; style-src ${hash('style')}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  private async body(req: IncomingMessage): Promise<string> {
    if (Number(req.headers['content-length']) > MAX_BODY) throw new PolicyError('请求体超过 1 MiB 上限');
    const chunks: Buffer[] = []; let bytes = 0;
    // Do not destroy the request via async-iterator early return: the client must receive the 4xx.
    return await new Promise<string>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { chunks.length = 0; reject(new PolicyError('请求体超过 1 MiB 上限')); }
        else chunks.push(chunk);
      });
      req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.once('error', () => reject(new PolicyError('请求体读取失败')));
      req.once('aborted', () => reject(new PolicyError('请求已断开')));
    });
  }
  private closeInvalidStreams(): void {
    for (const [res, id] of this.sessionStreams) if (!this.sessions.valid(id)) res.destroy();
  }
  private stream(res: ServerResponse, session?: string): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.socket?.setTimeout(0);
    this.streams.add(res);
    if (session !== undefined) this.sessionStreams.set(res, session);
    let unsubscribe = (): void => {};
    const send = (frame: string): void => {
      if (session !== undefined && !this.sessions.valid(session)) { res.destroy(); return; }
      if (res.destroyed) return;
      if (res.writableLength + Buffer.byteLength(frame) > MAX_STREAM_BUFFER || !res.write(frame)) res.destroy();
    };
    const heartbeat = setInterval(() => send(': keepalive\n\n'), 15000);
    res.once('close', () => { clearInterval(heartbeat); unsubscribe(); this.streams.delete(res); this.sessionStreams.delete(res); });
    send(': connected\n\n');
    const frame = (event: ReturnType<Observability['events']['recent']>[number]): string => `event: ${event.event}\ndata: ${this.redact(JSON.stringify(event))}\n\n`;
    // Replay a recent suffix that fits the socket budget, even with a 10,000-entry ring.
    // Do not mistake a large synchronous replay for a slow live consumer.
    const recent = this.observation.events.recent(50);
    let count = 0; let bytes = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(frame(recent[i]!));
      if (count && bytes + size > MAX_STREAM_BUFFER / 2) break;
      bytes += size; count++;
    }
    unsubscribe = this.observation.events.subscribe(event => send(frame(event)), count);
    if (res.destroyed) unsubscribe();
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const path = req.url ?? '';
    const writing = req.method === 'PUT' && path === '/api/policies';
    const login = req.method === 'POST' && path === '/api/login';
    const logout = req.method === 'POST' && path === '/api/logout';
    if (writing && !this.config.webui.allow_policy_edit) { this.json(res, 404, { ok: false, error: '写接口未启用' }); return; }
    if (login && !this.config.webui.read_token_env) { this.json(res, 404, { ok: false, error: '登录未启用' }); return; }
    if ((['/api/login', '/api/logout'].includes(path) && req.method !== 'POST') || (req.method !== 'GET' && !writing && !login && !logout)) {
      res.setHeader('Allow', ['/api/login', '/api/logout'].includes(path) ? 'POST' : path === '/api/policies' && this.config.webui.allow_policy_edit ? 'GET, PUT' : 'GET');
      this.json(res, 405, { ok: false, error: '不支持此方法' }); return;
    }
    const asset = assets.get(path);
    if (!asset && !login && !logout && !['/api/state', '/api/policies', '/api/logs'].includes(path)) { this.json(res, 404, { ok: false, error: '接口不存在' }); return; }
    const session = sessionCookie(req.headers.cookie);
    const hasSession = this.sessions.valid(session);
    const canRead = hasSession || this.readToken === undefined || authorized(req.headers.authorization, this.readToken);
    // 策略编辑：登录会话即可写；另外保留了可选写凭据，供脚本/命令行调 API。
    if (writing && !hasSession && !(this.writeToken && authorized(req.headers.authorization, this.writeToken))) {
      this.json(res, 401, { ok: false, error: '认证失败，请先登录' }); return;
    }
    if (!writing && !login && !logout && !canRead && path !== '/') {
      this.json(res, 401, { ok: false, error: '认证失败，请先登录' }); return;
    }
    if (writing || login || logout) {
      // Compare the browser origin to the HTTP authority; never trust forwarded headers.
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) {
        this.json(res, 403, { ok: false, error: '不允许跨源请求' }); return;
      }
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        this.json(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' }); return;
      }
    }
    try {
      if (path === '/' && !canRead) { this.loginPage(res); return; }
      if (logout) {
        this.sessions.remove(session); this.closeInvalidStreams();
        res.writeHead(204, { 'Set-Cookie': cookie('', 0) }); res.end(); return;
      }
      if (login) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (this.sessions.limited(ip)) { this.json(res, 429, { ok: false, error: '登录失败次数过多，请稍后重试' }); return; }
        const raw = await this.body(req);
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = null; }
        // Recheck after reading: concurrent requests must not bypass the failure budget.
        if (this.sessions.limited(ip)) { this.json(res, 429, { ok: false, error: '登录失败次数过多，请稍后重试' }); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('token' in body) || typeof body.token !== 'string' || !this.readToken || !authorized(`Bearer ${body.token}`, this.readToken)) {
          this.sessions.failed(ip); this.json(res, 401, { ok: false, error: '认证失败' }); return;
        }
        this.sessions.remove(session);
        const id = this.sessions.create(); this.closeInvalidStreams();
        res.writeHead(204, { 'Set-Cookie': cookie(id, this.sessions.options.ttlSeconds) }); res.end(); return;
      }
      if (asset) {
        const body = readFileSync(new URL(`./static/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1]! }); res.end(body); return;
      }
      if (path === '/api/state') { this.json(res, 200, this.state()); return; }
      if (path === '/api/logs') { this.stream(res, hasSession ? session : undefined); return; }
      if (!writing) { this.json(res, 200, { ...this.policies.get(), reload: this.reloader.lastResult, allow_policy_edit: this.config.webui.allow_policy_edit }); return; }
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        this.json(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' }); return;
      }
      const raw = await this.body(req);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new PolicyError('请求体必须是有效 JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('policies' in body) || typeof body.policies !== 'string') {
        throw new PolicyError('请求体仅允许 policies 字符串字段');
      }
      this.json(res, 200, this.policies.save(body.policies));
    } catch (error) {
      res.setHeader('Connection', 'close');
      this.json(res, error instanceof PolicyError ? 400 : 500, { ok: false, error: error instanceof PolicyError ? error.message : 'WebUI 请求处理失败' });
    }
  }
  async start(): Promise<void> {
    if (!this.config.webui.enabled) return;
    const server = createServer({ highWaterMark: MAX_STREAM_BUFFER }, (req, res) => { void this.handle(req, res); }); this.server = server;
    server.maxConnections = 16;
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.webui.port, this.config.webui.host, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => this.observation.log('error', 'webui_listener_error'));
  }
  address(): AddressInfo | undefined { const a = this.server?.address(); return a && typeof a !== 'string' ? a : undefined; }
  async stop(): Promise<void> {
    this.sessions.clear();
    for (const stream of this.streams) stream.destroy();
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
