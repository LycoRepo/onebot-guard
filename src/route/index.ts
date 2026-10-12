import { randomUUID } from 'node:crypto';
import type { Config, Route, Policy } from '../config/types.ts';
import { boundAccount } from '../identity/index.ts';
import { Observability } from '../observability/index.ts';
import { checkAction, sanitizeResponse, targetOf } from '../policy/action/index.ts';
import { checkEvent } from '../policy/event/index.ts';
import { allow, deny, classify, failure, id, isObject, oneBotTerm, parseAction, parsePacket, scopeKey } from '../protocol/onebot11/index.ts';
import type { Decision, Packet } from '../protocol/onebot11/index.ts';
import { Dedupe, EchoMap, RateLimiter } from '../runtime/index.ts';
import type { Pending } from '../runtime/index.ts';
import { EndpointTransport } from '../transport/index.ts';
import type { Peer } from '../transport/index.ts';

export class Gateway {
  config: Config; observation: Observability;
  endpoints = new Map<string, EndpointTransport>();
  closedRoutes = new Set<string>();
  echoes: EchoMap; dedupe: Dedupe; inbound: RateLimiter; outbound: RateLimiter;
  probes = new Map<string, { echo: string; peer: Peer; expires: number }>();
  timer: NodeJS.Timeout | undefined;
  stopped = true;
  constructor(config: Config, observation: Observability, env: NodeJS.ProcessEnv = process.env) {
    this.config = config; this.observation = observation;
    this.echoes = new EchoMap(config.runtime.max_pending_requests, config.runtime.request_timeout_ms);
    this.dedupe = new Dedupe(config.runtime.max_state_entries);
    this.inbound = new RateLimiter(config.runtime.max_state_entries); this.outbound = new RateLimiter(config.runtime.max_state_entries);
    for (const [name, endpoint] of Object.entries(config.endpoints)) {
      const route = config.routes.find(r => r.upstream === name || r.downstream === name)!;
      const account = config.endpoints[route.upstream]!.expected_self_id!;
      this.endpoints.set(name, new EndpointTransport(name, endpoint, config.runtime, account, env, {
        open: peer => this.open(peer), packet: (peer, raw) => this.packet(peer, raw), close: peer => this.close(peer), issue: (endpoint, reason) => observation.issue(endpoint, reason),
      }));
    }
  }
  async start(): Promise<void> {
    this.stopped = false;
    this.timer = setInterval(() => this.sweep(), Math.max(1, Math.min(1000, this.config.runtime.request_timeout_ms, this.config.runtime.handshake_timeout_ms)));
    try { for (const transport of this.endpoints.values()) await transport.start(); }
    catch (error) { await this.stop(); throw error; }
  }
  private open(peer: Peer): void {
    const endpoint = this.endpoints.get(peer.session.endpoint)!;
    this.observation.log('info', 'session_open', { endpoint: endpoint.id, side: endpoint.endpoint.side, connection: endpoint.endpoint.connection, onebot: oneBotTerm(endpoint.endpoint.side, endpoint.endpoint.connection), generation: peer.session.generation });
    if (endpoint.endpoint.side === 'upstream' && endpoint.endpoint.connection === 'connect') {
      const probe = { echo: randomUUID(), peer, expires: Date.now() + this.config.runtime.handshake_timeout_ms };
      this.probes.set(endpoint.id, probe);
      if (peer.send({ action: 'get_login_info', params: {}, echo: probe.echo }) !== 'sent') peer.disconnect();
    } else endpoint.markReady();
  }
  private packet(peer: Peer, raw: string): void {
    if (this.stopped || !peer.active || this.endpoints.get(peer.session.endpoint)?.peer !== peer) return;
    let packet: Packet;
    try { packet = parsePacket(raw); }
    catch { this.observation.issue(peer.session.endpoint, 'invalid_json_packet'); peer.disconnect(); return; }
    const endpoint = this.endpoints.get(peer.session.endpoint)!;
    if (endpoint.endpoint.side === 'downstream') { this.action(peer, packet); return; }
    const probe = this.probes.get(endpoint.id);
    if (probe && packet.echo === probe.echo && classify(packet) === 'response') {
      this.probes.delete(endpoint.id);
      if (probe.peer !== peer || probe.expires <= Date.now() || packet.status !== 'ok' || packet.retcode !== 0 || !isObject(packet.data) || id(packet.data.user_id) !== endpoint.account) {
        this.observation.issue(endpoint.id, 'account_probe_failed'); peer.disconnect(); return;
      }
      peer.session.account = endpoint.account; endpoint.markReady();
      this.observation.log('info', 'account_verified', { endpoint: endpoint.id, generation: peer.session.generation }); return;
    }
    if (!peer.session.account) { this.observation.issue(endpoint.id, 'unverified_upstream_packet'); return; }
    if (classify(packet) === 'response') { this.response(peer, packet); return; }
    this.observation.event(packet);
    if (!boundAccount(packet, endpoint.account)) {
      for (const route of this.config.routes.filter(r => r.upstream === endpoint.id)) this.record(route, peer, packet, 'event', deny('event.identity', 'account_binding_mismatch'));
      peer.disconnect(); return;
    }
    for (const route of this.config.routes.filter(r => r.upstream === endpoint.id)) this.event(route, peer, packet);
  }
  private policy(route: Route): Policy { return this.config.policies[route.policy]!; }
  private record(route: Route, peer: Peer, packet: Packet, direction: 'event' | 'action' | 'response', decision: Decision): void {
    this.observation.decision(route.id, direction, decision, peer.session.generation, packet);
  }
  private event(route: Route, upstream: Peer, packet: Packet): void {
    if (this.closedRoutes.has(route.id)) { this.record(route, upstream, packet, 'event', deny('event.route', 'route_closed')); return; }
    const policy = this.policy(route); let decision: Decision;
    try { decision = checkEvent(packet, policy, upstream.session.account!, this.config.runtime.max_regex_input_chars); }
    catch { decision = deny('event.authorization.error', 'event_authorization_error'); }
    if (!decision.allowed) { this.record(route, upstream, packet, 'event', decision); return; }
    const kind = classify(packet);
    // Control events bypass content rules, dedupe and message quotas; visibility still applies.
    if (kind !== 'heartbeat' && kind !== 'lifecycle') {
      const messageId = kind === 'message' ? id(packet.message_id) : undefined;
      if (messageId && this.dedupe.seen(JSON.stringify([route.id, upstream.session.account, upstream.session.generation, scopeKey(packet), messageId]), policy.events.deny.drop_message_ids_dup_within_ms)) {
        this.record(route, upstream, packet, 'event', deny('event.duplicate', 'duplicate_message_id')); return;
      }
      const l = policy.limits;
      if (!this.inbound.consume([
        { key: JSON.stringify(['route', route.id]), limit: l.inbound_per_route_per_min },
        { key: JSON.stringify(['group', route.id, upstream.session.account, id(packet.group_id)]), limit: packet.group_id === undefined ? 0 : l.inbound_per_group_per_min },
        { key: JSON.stringify(['user', route.id, upstream.session.account, id(packet.user_id)]), limit: packet.user_id === undefined ? 0 : l.inbound_per_user_per_min },
      ])) { this.record(route, upstream, packet, 'event', deny('event.rate', 'inbound_quota_or_state_limit')); return; }
    }
    const downstream = this.endpoints.get(route.downstream)!.peer;
    const result = downstream?.send(packet, kind === 'heartbeat' || kind === 'lifecycle' ? 'control' : 'event') ?? 'offline';
    this.record(route, upstream, packet, 'event', result === 'sent' ? decision : deny('event.delivery', `downstream_${result}`));
  }
  private action(peer: Peer, packet: Packet): void {
    const route = this.config.routes.find(r => r.downstream === peer.session.endpoint)!;
    const reject = (decision: Decision, retcode = 1403): void => { this.record(route, peer, packet, 'action', decision); peer.send(failure(packet, decision.reason, retcode)); };
    if (this.closedRoutes.has(route.id)) { reject(deny('action.route', 'route_closed')); return; }
    let action;
    try { action = parseAction(packet); } catch { reject(deny('action.protocol', 'invalid_action_packet'), 1400); return; }
    const upstream = this.endpoints.get(route.upstream)!.peer;
    const account = this.config.endpoints[route.upstream]!.expected_self_id!;
    let decision: Decision;
    try { decision = checkAction(action, this.policy(route), { authenticated: peer.session.principal === this.config.endpoints[route.downstream]!.principal, accountBound: !!upstream?.active && upstream.session.account === account, readonly: this.config.endpoints[route.downstream]!.readonly === true }); }
    catch { reject(deny('action.authorization.error', 'action_authorization_error')); return; }
    if (!upstream?.active || upstream.session.account !== account) { reject(deny('action.upstream', 'upstream_unavailable'), 1503); return; }
    if (!decision.allowed) { reject(decision); return; }
    if ([...this.echoes.entries.values()].filter(p => p.route === route.id).length >= this.config.runtime.max_pending_requests) { reject(deny('action.pending', 'pending_request_limit'), 1429); return; }
    const l = this.policy(route).limits;
    if (!this.outbound.consume([
      { key: JSON.stringify(['route', route.id]), limit: l.outbound_per_route_per_min },
      { key: JSON.stringify(['principal', peer.session.principal]), limit: l.outbound_per_principal_per_min },
      { key: JSON.stringify(['account', account]), limit: l.outbound_per_account_per_min },
      { key: JSON.stringify(['target', account, targetOf(action)]), limit: l.outbound_per_target_per_min },
    ])) { reject(deny('action.rate', 'outbound_quota_or_state_limit'), 1429); return; }
    const pending = this.echoes.add(packet, route.id, peer.session.generation, upstream.session.generation, action.action)!;
    const result = upstream.send({ ...action, echo: pending.echo });
    if (result !== 'sent') {
      this.echoes.remove(p => p.echo === pending.echo);
      reject(deny('action.delivery', result === 'send_error' ? 'send_error_result_unknown' : `upstream_${result}`), 1503); return;
    }
    this.record(route, peer, packet, 'action', decision);
  }
  private response(peer: Peer, response: Packet): void {
    const pending = this.echoes.take(response.echo, peer.session.generation);
    if (!pending) { this.observation.issue(peer.session.endpoint, 'unmatched_or_late_response'); return; }
    const route = this.config.routes.find(r => r.id === pending.route)!;
    const downstream = this.endpoints.get(route.downstream)!.peer;
    if (this.closedRoutes.has(route.id) || !downstream?.active || downstream.session.generation !== pending.downstreamGeneration) return;
    let result: Packet;
    try { result = this.echoes.restore(sanitizeResponse(response, pending.action, this.policy(route)), pending); }
    catch { this.finish(pending, 'response_visibility_check_failed', 1502); return; }
    const sent = downstream.send(result);
    this.record(route, downstream, {}, 'response', sent === 'sent' ? allow('response.correlated') : deny('response.delivery', `downstream_${sent}`));
  }
  private finish(pending: Pending, reason: string, retcode: number): void {
    const route = this.config.routes.find(r => r.id === pending.route)!;
    const downstream = this.endpoints.get(route.downstream)!.peer;
    this.observation.decision(route.id, 'response', deny('response.failure', reason), pending.downstreamGeneration);
    if (downstream?.active && downstream.session.generation === pending.downstreamGeneration) downstream.send(failure(pending.original, reason, retcode));
  }
  private close(peer: Peer): void {
    const generation = peer.session.generation;
    if (this.probes.get(peer.session.endpoint)?.peer === peer) this.probes.delete(peer.session.endpoint);
    for (const pending of this.echoes.remove(p => p.upstreamGeneration === generation || p.downstreamGeneration === generation)) this.finish(pending, 'disconnected_result_unknown', 1504);
    this.observation.log('info', 'session_close', { endpoint: peer.session.endpoint, generation });
  }
  sweep(now = Date.now()): void {
    for (const pending of this.echoes.remove(p => p.expires <= now)) this.finish(pending, 'request_timeout_result_unknown', 1504);
    for (const [endpoint, probe] of this.probes) if (probe.expires <= now) { this.probes.delete(endpoint); this.observation.issue(endpoint, 'account_probe_timeout'); probe.peer.disconnect(); }
  }
  closeRoute(id: string): void {
    if (!this.config.routes.some(r => r.id === id)) throw new Error('unknown_route');
    this.closedRoutes.add(id);
    for (const pending of this.echoes.remove(p => p.route === id)) this.finish(pending, 'route_closed_result_unknown', 1504);
  }
  replacePolicies(policies: Config['policies']): void { this.config = { ...this.config, policies }; }
  snapshot(): { healthy: boolean; endpoints: unknown; routes: unknown; queues: unknown } {
    const endpoints = Object.fromEntries([...this.endpoints].map(([name, transport]) => [name, transport.snapshot()]));
    const routes = this.config.routes.map(route => ({ id: route.id, ready: !this.stopped && !this.closedRoutes.has(route.id) && !!this.endpoints.get(route.upstream)!.peer?.active && !!this.endpoints.get(route.upstream)!.peer?.session.account && !!this.endpoints.get(route.downstream)!.peer?.active,
      pending_requests: [...this.echoes.entries.values()].filter(p => p.route === route.id).length }));
    return { healthy: !this.stopped && routes.every(r => r.ready), endpoints, routes, queues: { application_queue: 0, pending_requests: this.echoes.entries.size, identity_probes: this.probes.size, dedupe_entries: this.dedupe.entries.size, inbound_rate_entries: this.inbound.entries.size, outbound_rate_entries: this.outbound.entries.size } };
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    for (const pending of this.echoes.remove(() => true)) this.finish(pending, 'shutdown_result_unknown', 1504);
    this.probes.clear();
    await Promise.all([...this.endpoints.values()].map(transport => transport.stop()));
    this.dedupe.clear(); this.inbound.clear(); this.outbound.clear();
  }
}
