import { readFileSync, statSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { Config, Endpoint, EventScope, ActionRule, Policy } from './types.ts';

type Obj = Record<string, unknown>;
function fail(path: string, expected: string): never { throw new Error(`${path}: ${expected}`); }
function object(v: unknown, p: string, keys?: string[]): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(p, '必须是对象');
  const o = v as Obj;
  if (keys) for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${p}.${k}`, '未知配置项，不会被静默忽略');
  return o;
}
function str(v: unknown, p: string): string {
  if (typeof v !== 'string' || !v.length || v.length > 512) fail(p, '必须是 1–512 字符的字符串（账号及资源 ID 请加引号）');
  return v;
}
function num(v: unknown, p: string, fallback: number, min = 0, max = 1_000_000_000): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(p, `必须是 ${min}–${max} 的整数`);
  return v;
}
function bool(v: unknown, p: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') fail(p, '必须是 true 或 false');
  return v;
}
function choice<T extends string>(v: unknown, p: string, choices: readonly T[], fallback?: T): T {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !choices.includes(v as T)) fail(p, `必须是 ${choices.join(' / ')}`);
  return v as T;
}
function list(v: unknown, p: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 1024) fail(p, '必须是数组，最多 1024 项');
  return v;
}
function strings(v: unknown, p: string): string[] { return list(v, p).map((x, i) => str(x, `${p}[${i}]`)); }
function envName(v: unknown, p: string): string {
  const s = str(v, p);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(s)) fail(p, '必须是环境变量名，凭据不能直接写在配置中');
  return s;
}
function scope(v: unknown, p: string): EventScope {
  const o = object(v, p, ['post_type', 'message_type', 'meta_event_type', 'notice_type', 'request_type', 'group_ids', 'user_ids']);
  const result: EventScope = { post_type: str(o.post_type, `${p}.post_type`) };
  for (const k of ['message_type', 'meta_event_type', 'notice_type', 'request_type'] as const) if (o[k] !== undefined) result[k] = str(o[k], `${p}.${k}`);
  for (const k of ['group_ids', 'user_ids'] as const) if (o[k] !== undefined) result[k] = strings(o[k], `${p}.${k}`);
  return result;
}
function action(v: unknown, p: string, deny = false): ActionRule {
  const o = object(v, p, deny ? ['name'] : ['name', 'group_ids', 'user_ids', 'segment_types', 'allow_remote_media', 'allow_local_files', 'allow_at_all']);
  const result: ActionRule = { name: str(o.name, `${p}.name`) };
  for (const k of ['group_ids', 'user_ids', 'segment_types'] as const) if (o[k] !== undefined) result[k] = strings(o[k], `${p}.${k}`);
  for (const k of ['allow_remote_media', 'allow_local_files', 'allow_at_all'] as const) if (o[k] !== undefined) result[k] = bool(o[k], `${p}.${k}`, false);
  return result;
}
export function validateRegex(s: string, p: string): void {
  // Deliberately small subset: no groups, alternation, backrefs or multiple repetitions.
  // This avoids catastrophic backtracking without a third-party policy engine.
  let repetitions = 0; let inClass = false; let unsafe = false;
  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (char === '\\') { if (/[1-9kpP]/.test(s[++i] ?? '')) unsafe = true; continue; }
    if (char === '[' && !inClass) { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(' || char === ')' || char === '|' || char === '?') unsafe = true;
    if (char === '*' || char === '+' || char === '{') repetitions++;
  }
  if (unsafe || repetitions > 1) fail(p, '正则仅支持无分组、无分支、无反向引用且最多一个重复量词的安全子集');
  try { new RegExp(s, 'u'); } catch { fail(p, '正则语法无效'); }
}
function policy(v: unknown, p: string): Policy {
  const o = object(v, p, ['events', 'actions', 'limits', 'on_error']);
  const e = object(o.events, `${p}.events`, ['default', 'allow', 'deny']);
  const d = object(e.deny ?? {}, `${p}.events.deny`, ['scopes', 'keywords', 'keywords_regex', 'segment_types', 'drop_self', 'drop_bots', 'drop_message_ids_dup_within_ms']);
  const a = object(o.actions, `${p}.actions`, ['default', 'allow', 'deny']);
  const limitKeys = ['inbound_per_group_per_min', 'inbound_per_user_per_min', 'inbound_per_route_per_min', 'outbound_per_route_per_min', 'outbound_per_principal_per_min', 'outbound_per_account_per_min', 'outbound_per_target_per_min'] as const;
  const l = object(o.limits ?? {}, `${p}.limits`, [...limitKeys]);
  const limits = Object.fromEntries(limitKeys.map(k => [k, num(l[k], `${p}.limits.${k}`, 0)])) as Policy['limits'];
  const regex = strings(d.keywords_regex, `${p}.events.deny.keywords_regex`);
  regex.forEach((s, i) => validateRegex(s, `${p}.events.deny.keywords_regex[${i}]`));
  return {
    events: { default: choice(e.default, `${p}.events.default`, ['deny'], 'deny'), allow: list(e.allow, `${p}.events.allow`).map((v, i) => scope(v, `${p}.events.allow[${i}]`)),
      deny: { scopes: list(d.scopes, `${p}.events.deny.scopes`).map((v, i) => scope(v, `${p}.events.deny.scopes[${i}]`)), keywords: strings(d.keywords, `${p}.events.deny.keywords`), keywords_regex: regex, segment_types: strings(d.segment_types, `${p}.events.deny.segment_types`), drop_self: bool(d.drop_self, `${p}.events.deny.drop_self`, false), drop_bots: strings(d.drop_bots, `${p}.events.deny.drop_bots`), drop_message_ids_dup_within_ms: num(d.drop_message_ids_dup_within_ms, `${p}.events.deny.drop_message_ids_dup_within_ms`, 3000) } },
    actions: { default: choice(a.default, `${p}.actions.default`, ['deny'], 'deny'), allow: list(a.allow, `${p}.actions.allow`).map((v, i) => action(v, `${p}.actions.allow[${i}]`)), deny: list(a.deny, `${p}.actions.deny`).map((v, i) => action(v, `${p}.actions.deny[${i}]`, true)) },
    limits, on_error: choice(o.on_error, `${p}.on_error`, ['deny', 'skip'], 'deny'),
  };
}
export function validateConfig(v: unknown): Config {
  const o = object(v, 'config', ['schema_version', 'log', 'observability', 'runtime', 'reload', 'endpoints', 'routes', 'policies', 'extensions']);
  if (o.schema_version !== 1) fail('schema_version', '仅支持版本 1');
  const log = object(o.log ?? {}, 'log', ['level', 'format', 'message_preview_chars']);
  const obs = object(o.observability ?? {}, 'observability', ['host', 'port', 'expose_message_preview']);
  const host = str(obs.host ?? '127.0.0.1', 'observability.host');
  if (!['127.0.0.1', '::1'].includes(host)) fail('observability.host', '只读接口只能绑定回环地址 127.0.0.1 或 ::1');
  const r = object(o.runtime ?? {}, 'runtime', ['max_connections', 'max_buffer_bytes_per_connection', 'on_buffer_full', 'max_message_bytes', 'max_pending_requests', 'request_timeout_ms', 'max_regex_input_chars', 'max_state_entries', 'ping_interval_ms', 'handshake_timeout_ms', 'reconnect']);
  const rc = object(r.reconnect ?? {}, 'runtime.reconnect', ['initial_ms', 'max_ms', 'jitter']);
  const reload = object(o.reload ?? {}, 'reload', ['policy_watch', 'debounce_ms', 'signal', 'on_invalid']);
  const endpoints: Record<string, Endpoint> = Object.create(null) as Record<string, Endpoint>;
  for (const [id, value] of Object.entries(object(o.endpoints, 'endpoints'))) {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(id)) fail('endpoints', 'ID 必须是以字母开头的短标识符');
    const p = `endpoints.${id}`;
    const e = object(value, p, ['side', 'connection', 'protocol', 'url', 'host', 'port', 'token_env', 'expected_self_id', 'principal', 'readonly', 'reconnect', 'tls']);
    const endpoint: Endpoint = { side: choice(e.side, `${p}.side`, ['upstream', 'downstream']), connection: choice(e.connection, `${p}.connection`, ['connect', 'listen']), protocol: choice(e.protocol, `${p}.protocol`, ['onebot_v11']), token_env: envName(e.token_env, `${p}.token_env`), reconnect: bool(e.reconnect, `${p}.reconnect`, true) };
    if (endpoint.side === 'upstream') {
      endpoint.expected_self_id = str(e.expected_self_id, `${p}.expected_self_id`);
      if (e.principal !== undefined || e.readonly !== undefined) fail(p, '上游不能声明下游主体或 readonly');
    } else {
      endpoint.principal = str(e.principal, `${p}.principal`);
      endpoint.readonly = bool(e.readonly, `${p}.readonly`, false);
      if (e.expected_self_id !== undefined) fail(p, '下游账号由 route 绑定，不能声明 expected_self_id');
    }
    if (endpoint.connection === 'connect') {
      endpoint.url = str(e.url, `${p}.url`);
      let u: URL;
      try { u = new URL(endpoint.url); } catch { fail(`${p}.url`, '必须是有效的 ws:// 或 wss:// 地址'); }
      if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail(`${p}.url`, '只允许无凭据、无查询参数的 ws:// 或 wss:// 地址');
      if (e.host !== undefined || e.port !== undefined || e.tls !== undefined) fail(p, 'connect 使用 url；不能同时声明 host / port / tls');
    } else {
      endpoint.host = str(e.host ?? '127.0.0.1', `${p}.host`);
      endpoint.port = num(e.port, `${p}.port`, 3010, 0, 65535);
      if (e.url !== undefined) fail(p, 'listen 使用 host / port，不能声明 url');
      if (e.tls !== undefined) {
        const t = object(e.tls, `${p}.tls`, ['cert_env', 'key_env']);
        endpoint.tls = { cert_env: envName(t.cert_env, `${p}.tls.cert_env`), key_env: envName(t.key_env, `${p}.tls.key_env`) };
      }
    }
    endpoints[id] = endpoint;
  }
  const policies: Record<string, Policy> = Object.create(null) as Record<string, Policy>;
  for (const [id, value] of Object.entries(object(o.policies, 'policies'))) policies[id] = policy(value, `policies.${id}`);
  const seen = new Set<string>(); const downstreams = new Set<string>();
  const routes = list(o.routes, 'routes').map((v, i) => {
    const p = `routes[${i}]`; const a = object(v, p, ['id', 'upstream', 'downstream', 'policy']);
    const route = { id: str(a.id, `${p}.id`), upstream: str(a.upstream, `${p}.upstream`), downstream: str(a.downstream, `${p}.downstream`), policy: str(a.policy, `${p}.policy`) };
    if (seen.has(route.id)) fail(`${p}.id`, 'route ID 重复'); seen.add(route.id);
    if (endpoints[route.upstream]?.side !== 'upstream') fail(`${p}.upstream`, '必须引用已有上游端点');
    if (endpoints[route.downstream]?.side !== 'downstream') fail(`${p}.downstream`, '必须引用已有下游端点');
    if (!policies[route.policy]) fail(`${p}.policy`, '必须引用已有策略');
    if (downstreams.has(route.downstream)) fail(`${p}.downstream`, '每个下游端点只能绑定一条 route；多账号请用独立端点'); downstreams.add(route.downstream);
    return route;
  });
  if (!routes.length) fail('routes', '至少声明一条 route');
  for (const id of Object.keys(endpoints)) if (!routes.some(r => r.upstream === id || r.downstream === id)) fail(`endpoints.${id}`, '端点未被任何 route 使用');
  const ex = object(o.extensions ?? {}, 'extensions', ['coordination']);
  const co = object(ex.coordination ?? {}, 'extensions.coordination', ['enabled']);
  if (bool(co.enabled, 'extensions.coordination.enabled', false)) fail('extensions.coordination.enabled', '第一批未实现调度，必须关闭');
  const initial = num(rc.initial_ms, 'runtime.reconnect.initial_ms', 1000, 1);
  const maximum = num(rc.max_ms, 'runtime.reconnect.max_ms', 30000, initial);
  const maxConnections = num(r.max_connections, 'runtime.max_connections', 64, 1, 4096);
  if (Object.keys(endpoints).length > maxConnections) fail('runtime.max_connections', '不得小于配置中的端点数');
  return {
    schema_version: 1,
    log: { level: choice(log.level, 'log.level', ['debug', 'info', 'warn', 'error'], 'info'), format: choice(log.format, 'log.format', ['pretty', 'json'], 'json'), message_preview_chars: num(log.message_preview_chars, 'log.message_preview_chars', 0, 0, 4096) },
    observability: { host, port: num(obs.port, 'observability.port', 3011, 0, 65535), expose_message_preview: bool(obs.expose_message_preview, 'observability.expose_message_preview', false) },
    runtime: { max_connections: maxConnections, max_buffer_bytes_per_connection: num(r.max_buffer_bytes_per_connection, 'runtime.max_buffer_bytes_per_connection', 1048576, 1), on_buffer_full: choice(r.on_buffer_full, 'runtime.on_buffer_full', ['drop_events', 'disconnect_connection'], 'drop_events'), max_message_bytes: num(r.max_message_bytes, 'runtime.max_message_bytes', 262144, 1), max_pending_requests: num(r.max_pending_requests, 'runtime.max_pending_requests', 64, 1), request_timeout_ms: num(r.request_timeout_ms, 'runtime.request_timeout_ms', 30000, 1), max_regex_input_chars: num(r.max_regex_input_chars, 'runtime.max_regex_input_chars', 4096, 1, 65536), max_state_entries: num(r.max_state_entries, 'runtime.max_state_entries', 4096, 1), ping_interval_ms: num(r.ping_interval_ms, 'runtime.ping_interval_ms', 30000, 10), handshake_timeout_ms: num(r.handshake_timeout_ms, 'runtime.handshake_timeout_ms', 10000, 1), reconnect: { initial_ms: initial, max_ms: maximum, jitter: bool(rc.jitter, 'runtime.reconnect.jitter', true) } },
    reload: { policy_watch: bool(reload.policy_watch, 'reload.policy_watch', true), debounce_ms: num(reload.debounce_ms, 'reload.debounce_ms', 500, 1), signal: choice(reload.signal, 'reload.signal', ['SIGHUP'], 'SIGHUP'), on_invalid: choice(reload.on_invalid, 'reload.on_invalid', ['keep_last'], 'keep_last') },
    endpoints, routes, policies, extensions: { coordination: { enabled: false } },
  };
}
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    if (statSync(path).size > 1048576) throw new Error('配置文件超过 1 MiB 上限');
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message === '配置文件超过 1 MiB 上限') throw error;
    throw new Error('配置文件无法读取，请检查文件是否存在及读取权限');
  }
  if (Buffer.byteLength(raw) > 1048576) throw new Error('配置文件超过 1 MiB 上限');
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('YAML 配置语法无效或键重复，请检查缩进与键名');
  return validateConfig(doc.toJS({ maxAliasCount: 0 }));
}
