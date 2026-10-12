import type { EventScope, Policy } from '../../config/types.ts';
import { allow, deny, classify, id, segments } from '../../protocol/onebot11/index.ts';
import type { Decision, Packet } from '../../protocol/onebot11/index.ts';
export function matchesScope(event: Packet, scope: EventScope): boolean {
  if (event.post_type !== scope.post_type) return false;
  for (const k of ['message_type', 'meta_event_type', 'notice_type', 'request_type'] as const) if (scope[k] !== undefined && event[k] !== scope[k]) return false;
  if (scope.group_ids && !scope.group_ids.includes(id(event.group_id) ?? '')) return false;
  if (scope.user_ids && !scope.user_ids.includes(id(event.user_id) ?? '')) return false;
  return true;
}
export function visibility(event: Packet, policy: Policy): Decision {
  if (policy.events.deny.scopes.some(s => matchesScope(event, s))) return deny('event.scope.deny', 'event_scope_denied');
  return policy.events.allow.some(s => matchesScope(event, s)) ? allow('event.scope.allow') : deny('event.scope.default', 'event_not_authorized');
}
export function checkEvent(event: Packet, policy: Policy, account: string, maxInput: number): Decision {
  const visible = visibility(event, policy);
  if (!visible.allowed) return visible;
  if (classify(event) !== 'message') return visible;
  const rules = policy.events.deny;
  if (rules.drop_self && id(event.user_id) === account) return deny('event.self', 'self_message');
  if (rules.drop_bots.includes(id(event.user_id) ?? '')) return deny('event.bot', 'explicit_bot_deny');
  try {
    const parts = segments(event.message, true);
    if (parts.some(p => rules.segment_types.includes(p.type))) return deny('event.segment', 'segment_type_denied');
    // CQ strings are not interpreted: content rules must not miss encoded segments.
    if (typeof event.message === 'string' && event.message.includes('[CQ:') && rules.segment_types.length) return deny('event.segment', 'cq_string_requires_segments');
    const text = parts.filter(s => s.type === 'text').map(s => {
      if (typeof s.data.text !== 'string') throw new Error('text segment invalid');
      return s.data.text;
    }).join('');
    if (text.length > maxInput && (rules.keywords.length || rules.keywords_regex.length)) throw new Error('content input limit');
    if (rules.keywords.some(k => text.includes(k))) return deny('event.keyword', 'keyword_denied');
    if (rules.keywords_regex.some(r => new RegExp(r, 'u').test(text))) return deny('event.regex', 'regex_denied');
    return visible;
  } catch {
    return policy.on_error === 'skip' ? allow('event.content.error.skip') : deny('event.content.error', 'content_filter_error_or_input_limit');
  }
}
export function visibleGroup(group: string, policy: Policy): boolean {
  // Group enumeration can only reveal groups explicitly allowed without sender restrictions.
  const event: Packet = { post_type: 'message', message_type: 'group', group_id: group };
  if (policy.events.deny.scopes.some(s => s.post_type === 'message' && (!s.message_type || s.message_type === 'group') && (!s.group_ids || s.group_ids.includes(group)))) return false;
  return visibility(event, policy).allowed;
}
