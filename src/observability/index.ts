import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config/types.ts';
import type { Decision, Packet } from '../protocol/onebot11/index.ts';
import { scopeKey } from '../protocol/onebot11/index.ts';

type Level = Config['log']['level'];
const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export function preview(packet: Packet, chars: number): string | undefined {
  if (!chars) return undefined;
  if (typeof packet.message === 'string') return packet.message.slice(0, chars);
  if (!Array.isArray(packet.message)) return undefined;
  let text = '';
  for (const part of packet.message) {
    if (part?.type === 'text' && typeof part.data?.text === 'string') text += part.data.text.slice(0, chars - text.length);
    if (text.length >= chars) break;
  }
  return text;
}
export class Observability {
  config: Config;
  write: (line: string) => void;
  server: Server | undefined;
  startedAt = new Date().toISOString();
  lastEventAt: string | null = null;
  lastPreview: string | undefined;
  totals = { allowed: 0, denied: 0 };
  routes = new Map<string, { allowed: number; denied: number }>();
  rules = new Map<string, number>();
  issues = new Map<string, number>();
  constructor(config: Config, write = (line: string): void => { process.stdout.write(line); }) {
    this.config = config; this.write = write;
    for (const route of config.routes) this.routes.set(route.id, { allowed: 0, denied: 0 });
  }
  log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
    if (levels[level] < levels[this.config.log.level]) return;
    const entry = { time: new Date().toISOString(), level, event, ...fields };
    // Even pretty mode keeps one escaped record per line.
    this.write((this.config.log.format === 'pretty' ? `${entry.time} ${level.toUpperCase()} ${event} ` : '') + JSON.stringify(entry) + '\n');
  }
  decision(route: string, direction: 'event' | 'action' | 'response', decision: Decision, generation: string, packet: Packet = {}): void {
    const key = decision.allowed ? 'allowed' : 'denied';
    this.totals[key]++;
    const counters = this.routes.get(route); if (counters) counters[key]++;
    this.rules.set(decision.rule, (this.rules.get(decision.rule) ?? 0) + 1);
    // Rejections are audit records, even when the general log level is error.
    if (!decision.allowed) {
      const entry = { time: new Date().toISOString(), level: 'warn', event: 'denied', route, direction, rule: decision.rule, reason: decision.reason, generation, scope: scopeKey(packet), preview: preview(packet, this.config.log.message_preview_chars) };
      this.write(JSON.stringify(entry) + '\n');
    }
  }
  issue(endpoint: string, reason: string): void {
    this.issues.set(reason, (this.issues.get(reason) ?? 0) + 1);
    this.log('warn', 'transport_issue', { endpoint, reason });
  }
  event(packet: Packet): void {
    this.lastEventAt = new Date().toISOString();
    if (this.config.observability.expose_message_preview) this.lastPreview = preview(packet, this.config.log.message_preview_chars);
  }
  async start(snapshot: () => { healthy: boolean; endpoints: unknown; routes: unknown; queues: unknown }): Promise<void> {
    const server = createServer((req, res) => {
      const path = req.url;
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
      if (path !== '/health' && path !== '/stats') { res.writeHead(404); res.end(); return; }
      const state = snapshot();
      const body = path === '/health' ? { healthy: state.healthy, endpoints: state.endpoints, routes: state.routes } : {
        ...state, started_at: this.startedAt, last_event_at: this.lastEventAt,
        totals: this.totals, counts_by_route: Object.fromEntries(this.routes), hits_by_rule: Object.fromEntries(this.rules),
        transport_issues: Object.fromEntries(this.issues), ...(this.config.observability.expose_message_preview && this.lastPreview !== undefined ? { message_preview: this.lastPreview } : {}),
      };
      res.writeHead(path === '/health' && !state.healthy ? 503 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    });
    this.server = server;
    server.maxConnections = 16;
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.config.observability.port, this.config.observability.host, () => { server.off('error', reject); resolve(); }); });
    server.on('error', () => this.log('error', 'observability_listener_error'));
  }
  address(): AddressInfo | undefined { const a = this.server?.address(); return a && typeof a !== 'string' ? a : undefined; }
  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
