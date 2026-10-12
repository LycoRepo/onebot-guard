import type { ActionRule, Policy } from '../../config/types.ts';
import type { Action, Decision, Packet } from '../../protocol/onebot11/index.ts';
import { allow, deny, id, segments } from '../../protocol/onebot11/index.ts';

const readActions = new Set(['get_login_info', 'get_version_info', 'get_status', 'get_group_list']);
const sendActions = new Set(['send_msg', 'send_group_msg', 'send_private_msg']);
export function targetOf(action: Action): string {
  return action.params.group_id !== undefined ? `group:${id(action.params.group_id) ?? 'invalid'}` : action.params.user_id !== undefined ? `private:${id(action.params.user_id) ?? 'invalid'}` : 'account';
}
function checkSegments(action: Action, rule: ActionRule): Decision {
  if (action.params.auto_escape !== undefined && typeof action.params.auto_escape !== 'boolean') return deny('action.params', 'invalid_auto_escape');
  let parts;
  try { parts = segments(action.params.message, action.params.auto_escape === true); } catch { return deny('action.segment', 'invalid_message_or_cq_string'); }
  for (const part of parts) {
    if (!rule.segment_types?.includes(part.type)) return deny('action.segment', 'segment_not_authorized');
    const data = part.data;
    if (part.type === 'text') {
      if (Object.keys(data).some(k => k !== 'text') || typeof data.text !== 'string') return deny('action.params', 'invalid_text_segment');
    } else if (part.type === 'at') {
      if (Object.keys(data).some(k => k !== 'qq') || !id(data.qq)) return deny('action.params', 'invalid_at_segment');
      if (data.qq === 'all' ? !rule.allow_at_all : !rule.user_ids?.includes(id(data.qq)!)) return deny('action.resource', 'at_target_not_authorized');
    } else if (part.type === 'reply') {
      return deny('action.reference', 'message_ownership_unknown');
    } else if (['image', 'record', 'video'].includes(part.type)) {
      if (Object.keys(data).some(k => k !== 'file') || typeof data.file !== 'string') return deny('action.params', 'media_only_accepts_file');
      if (!data.file.length || data.file !== data.file.trim()) return deny('action.media', 'invalid_media_file');
      if (/^https?:/i.test(data.file)) {
        if (!rule.allow_remote_media) return deny('action.media', 'remote_media_disabled');
        try { const url = new URL(data.file); if (url.username || url.password) return deny('action.media', 'media_url_credentials_denied'); } catch { return deny('action.media', 'invalid_media_url'); }
      } else {
        if (/^file:/i.test(data.file)) {
          try {
            const url = new URL(data.file);
            if (url.hostname || url.search || url.hash) return deny('action.media', 'network_file_or_file_url_options_denied');
          } catch { return deny('action.media', 'invalid_media_file'); }
        } else if (/^[a-z][a-z\d+.-]*:/i.test(data.file) && !/^[a-z]:[\\/]/i.test(data.file)) return deny('action.media', 'unsupported_media_scheme');
        if (/^(?:\/\/|\\\\)/.test(data.file)) return deny('action.media', 'network_file_denied');
        if (!rule.allow_local_files) return deny('action.media', 'local_media_disabled');
      }
    } else return deny('action.segment', 'unsupported_segment_or_merged_forward');
  }
  return allow('action.segment');
}
export function checkAction(action: Action, policy: Policy, context: { authenticated: boolean; accountBound: boolean; readonly: boolean }): Decision {
  if (!context.authenticated || !context.accountBound) return deny('action.identity', 'untrusted_identity');
  if (Object.keys(action).some(k => !['action', 'params', 'echo'].includes(k))) return deny('action.identity', 'unexpected_action_fields_or_account_override');
  if (policy.actions.deny.some(r => r.name === action.action)) return deny('action.name.deny', 'action_explicitly_denied');
  const candidates = policy.actions.allow.filter(r => r.name === action.action);
  if (!candidates.length) return deny('action.name.default', 'action_not_authorized');
  if (!readActions.has(action.action) && !sendActions.has(action.action)) return deny('action.unsupported', 'unsupported_action_variant_extension_or_message_read');
  if (readActions.has(action.action)) return Object.keys(action.params).length ? deny('action.params', 'read_action_accepts_no_parameters') : allow('action.read');
  if (context.readonly) return deny('action.readonly', 'readonly_endpoint');
  const p = action.params;
  const allowedKeys = ['message', 'auto_escape', ...(action.action === 'send_msg' ? ['message_type', 'group_id', 'user_id'] : action.action === 'send_group_msg' ? ['group_id'] : ['user_id'])];
  if (Object.keys(p).some(k => !allowedKeys.includes(k))) return deny('action.params', 'unsupported_parameter_or_identity_override');
  let kind: 'group' | 'private';
  if (action.action === 'send_group_msg') kind = 'group';
  else if (action.action === 'send_private_msg') kind = 'private';
  else if (p.message_type === 'group' || p.message_type === 'private') kind = p.message_type;
  else return deny('action.target', 'send_msg_requires_explicit_message_type');
  if ((kind === 'group' && p.user_id !== undefined) || (kind === 'private' && p.group_id !== undefined)) return deny('action.target', 'conflicting_target');
  const target = id(kind === 'group' ? p.group_id : p.user_id);
  if (!target) return deny('action.target', 'missing_or_invalid_target');
  let last: Decision = deny('action.resource', 'target_not_authorized');
  for (const rule of candidates) {
    if (!(kind === 'group' ? rule.group_ids : rule.user_ids)?.includes(target)) continue;
    last = checkSegments(action, rule);
    if (last.allowed) return allow('action.send');
  }
  return last;
}
export function sanitizeResponse(response: Packet, action: string, policy: Policy): Packet {
  if (action === 'get_group_list' && response.status === 'ok') {
    if (!Array.isArray(response.data)) throw new Error('invalid_group_list_response');
    return { ...response, data: response.data.filter((g: unknown) => {
      if (!g || typeof g !== 'object') return false;
      const group = id((g as Packet).group_id);
      return !!group && visibleGroup(group, policy);
    }) };
  }
  return response;
}
import { visibleGroup } from '../event/index.ts';
