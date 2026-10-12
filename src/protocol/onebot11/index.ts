export type Packet = Record<string, unknown>;
export interface Action extends Packet { action: string; params: Packet }
export interface Segment { type: string; data: Packet }
export type Decision = { allowed: boolean; rule: string; reason: string };
export const allow = (rule = 'allow'): Decision => ({ allowed: true, rule, reason: 'allowed' });
export const deny = (rule: string, reason: string): Decision => ({ allowed: false, rule, reason });
export function isObject(v: unknown): v is Packet { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function id(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length && v.length <= 512) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  return undefined;
}
export function parsePacket(raw: string): Packet {
  const v: unknown = JSON.parse(raw);
  if (!isObject(v)) throw new Error('报文必须是 JSON 对象');
  return v;
}
export function classify(p: Packet): 'response' | 'message' | 'notice' | 'request' | 'heartbeat' | 'lifecycle' | 'unknown' {
  if (typeof p.status === 'string' && typeof p.retcode === 'number') return 'response';
  if (p.post_type === 'meta_event' && p.meta_event_type === 'heartbeat') return 'heartbeat';
  if (p.post_type === 'meta_event' && p.meta_event_type === 'lifecycle') return 'lifecycle';
  if (p.post_type === 'message' || p.post_type === 'notice' || p.post_type === 'request') return p.post_type;
  return 'unknown';
}
export function parseAction(p: Packet): Action {
  if (typeof p.action !== 'string' || !p.action.length || p.action.length > 128 || (p.params !== undefined && !isObject(p.params))) throw new Error('Action 名称或 params 无效');
  return { ...p, action: p.action, params: (p.params ?? {}) as Packet };
}
export function segments(v: unknown, autoEscape = false): Segment[] {
  if (typeof v === 'string') {
    if (!autoEscape && v.includes('[CQ:')) throw new Error('第一批不解析 CQ 码，请使用消息段数组或 auto_escape=true');
    return [{ type: 'text', data: { text: v } }];
  }
  if (!Array.isArray(v) || !v.length) throw new Error('message 必须是文本或非空消息段数组');
  return v.map((s: unknown) => {
    if (!isObject(s) || typeof s.type !== 'string' || !isObject(s.data) || Object.keys(s).some(k => !['type', 'data'].includes(k))) throw new Error('消息段结构无效');
    return { type: s.type, data: s.data };
  });
}
export function failure(request: Packet, reason: string, retcode = 1403): Packet {
  const result: Packet = { status: 'failed', retcode, data: null, message: reason, wording: reason };
  if (Object.hasOwn(request, 'echo')) result.echo = request.echo;
  return result;
}
export function scopeKey(p: Packet): string { return p.group_id !== undefined ? `group:${id(p.group_id) ?? 'invalid'}` : `private:${id(p.user_id) ?? 'unknown'}`; }
export function oneBotTerm(side: string, connection: string): string {
  return (side === 'upstream' && connection === 'connect') || (side === 'downstream' && connection === 'listen') ? '正向 WebSocket' : '反向 WebSocket';
}
