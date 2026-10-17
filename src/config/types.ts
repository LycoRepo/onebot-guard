export interface Endpoint {
  side: 'upstream' | 'downstream';
  connection: 'connect' | 'listen';
  protocol: 'onebot_v11';
  token_env: string;
  url?: string;
  host?: string;
  port?: number;
  expected_self_id?: string;
  principal?: string;
  readonly?: boolean;
  reconnect: boolean;
  tls?: { cert_env: string; key_env: string };
}
export interface EventScope {
  post_type: string;
  message_type?: string;
  meta_event_type?: string;
  notice_type?: string;
  request_type?: string;
  group_ids?: string[];
  user_ids?: string[];
}
export interface ActionRule {
  name: string;
  group_ids?: string[];
  user_ids?: string[];
  segment_types?: string[];
  allow_remote_media?: boolean;
  allow_local_files?: boolean;
  allow_at_all?: boolean;
}
export interface Policy {
  events: {
    default: 'deny';
    allow: EventScope[];
    deny: {
      scopes: EventScope[];
      keywords: string[];
      keywords_regex: string[];
      segment_types: string[];
      drop_self: boolean;
      drop_bots: string[];
      drop_message_ids_dup_within_ms: number;
    };
  };
  actions: { default: 'deny'; allow: ActionRule[]; deny: { name: string }[] };
  limits: {
    inbound_per_group_per_min: number;
    inbound_per_user_per_min: number;
    inbound_per_route_per_min: number;
    outbound_per_route_per_min: number;
    outbound_per_principal_per_min: number;
    outbound_per_account_per_min: number;
    outbound_per_target_per_min: number;
  };
  on_error: 'deny' | 'skip';
}
export interface Route { id: string; upstream: string; downstream: string; policy: string }
export interface Config {
  schema_version: 1;
  log: { level: 'debug' | 'info' | 'warn' | 'error'; format: 'pretty' | 'json'; message_preview_chars: number };
  observability: { host: string; port: number; expose_message_preview: boolean };
  webui: { enabled: boolean; host: string; port: number; read_token_env: string | null; allow_policy_edit: boolean; write_token_env: string | null; log_ring_size: number; session_ttl_minutes?: number; max_sessions?: number; login_attempts_per_min?: number; trust_proxy_header?: string; trust_proxy_token_env?: string };
  runtime: {
    max_connections: number;
    max_buffer_bytes_per_connection: number;
    on_buffer_full: 'drop_events' | 'disconnect_connection';
    max_message_bytes: number;
    max_pending_requests: number;
    request_timeout_ms: number;
    max_regex_input_chars: number;
    max_state_entries: number;
    ping_interval_ms: number;
    handshake_timeout_ms: number;
    reconnect: { initial_ms: number; max_ms: number; jitter: boolean };
  };
  reload: { policy_watch: boolean; debounce_ms: number; signal: 'SIGHUP'; on_invalid: 'keep_last' };
  endpoints: Record<string, Endpoint>;
  routes: Route[];
  policies: Record<string, Policy>;
  extensions: { coordination: { enabled: false } };
}
