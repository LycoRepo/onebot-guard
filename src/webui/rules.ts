import type { ActionRule, EventScope, Policy } from '../config/types.ts';

/**
 * 「人话表单」和策略之间的双向转换。
 *
 * 表单只管理策略里最常改的那部分：能收谁的消息、屏蔽什么、能发给谁。
 * 其余字段（meta_event 可见性、限额、on_error、drop_self、deny.scopes 等）
 * 在写回时原样保留，不会被表单覆盖。
 */

export const SEND_ACTION_NAMES = ['send_msg', 'send_group_msg', 'send_private_msg'] as const;
const SEND_ACTIONS: readonly string[] = SEND_ACTION_NAMES;

export interface Rules {
  receive: {
    /** 允许接收的群；空数组表示不限制（所有群）。 */
    group_ids: string[];
    /** 允许接收的私聊对象；空数组表示不限制。 */
    user_ids: string[];
    /** 命中即丢弃的关键词。 */
    keywords: string[];
    /** 命中即丢弃的正则（安全子集）。 */
    keywords_regex: string[];
    /** 命中即丢弃的消息段类型，例如 image / record / forward。 */
    blocked_segments: string[];
  };
  send: {
    /** 允许主动发消息到的群；空数组表示不允许发到任何群。 */
    group_ids: string[];
    /** 允许主动发消息到的人；空数组表示不允许发给任何人。 */
    user_ids: string[];
    /** 允许发送的消息段类型，例如 text / at。 */
    segments: string[];
  };
}

export function emptyRules(): Rules {
  return {
    receive: { group_ids: [], user_ids: [], keywords: [], keywords_regex: [], blocked_segments: [] },
    send: { group_ids: [], user_ids: [], segments: ['text'] },
  };
}

function messageScope(allow: EventScope[], type: 'group' | 'private'): EventScope | undefined {
  return allow.find(s => s.post_type === 'message' && s.message_type === type);
}

function sendRules(policy: Policy): ActionRule[] {
  return policy.actions.allow.filter(rule => SEND_ACTIONS.includes(rule.name));
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.length || v.length > 512)) {
    throw new Error(`${field} 必须是非空字符串数组`);
  }
  return [...new Set(value as string[])];
}

function section(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${field}.${key} 不是可识别的字段`);
}

/** 校验并规范化来自表单的 rules 对象。正则的合法性交给 validateConfig 判断。 */
export function parseRules(value: unknown): Rules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rules 必须是对象');
  const outer = value as Record<string, unknown>;
  rejectUnknown(outer, ['receive', 'send'], 'rules');
  const receive = section(outer.receive, 'rules.receive');
  const send = section(outer.send, 'rules.send');
  rejectUnknown(receive, ['group_ids', 'user_ids', 'keywords', 'keywords_regex', 'blocked_segments'], 'rules.receive');
  rejectUnknown(send, ['group_ids', 'user_ids', 'segments'], 'rules.send');
  return {
    receive: {
      group_ids: stringList(receive.group_ids, '群白名单'),
      user_ids: stringList(receive.user_ids, '私聊白名单'),
      keywords: stringList(receive.keywords, '关键词'),
      keywords_regex: stringList(receive.keywords_regex, '关键词正则'),
      blocked_segments: stringList(receive.blocked_segments, '屏蔽的消息类型'),
    },
    send: {
      group_ids: stringList(send.group_ids, '允许发送的群'),
      user_ids: stringList(send.user_ids, '允许发送的人'),
      segments: stringList(send.segments, '允许发送的消息类型'),
    },
  };
}

/** 从当前生效的策略里读出表单值。 */
export function readRules(policy: Policy): Rules {
  const group = messageScope(policy.events.allow, 'group');
  const priv = messageScope(policy.events.allow, 'private');
  const send = sendRules(policy);
  const uniq = (values: (string[] | undefined)[]): string[] => [...new Set(values.flatMap(v => v ?? []))];
  return {
    receive: {
      group_ids: [...(group?.group_ids ?? [])],
      user_ids: [...(priv?.user_ids ?? [])],
      keywords: [...policy.events.deny.keywords],
      keywords_regex: [...policy.events.deny.keywords_regex],
      blocked_segments: [...policy.events.deny.segment_types],
    },
    send: {
      group_ids: uniq(send.map(r => r.group_ids)),
      user_ids: uniq(send.map(r => r.user_ids)),
      segments: send.length ? uniq(send.map(r => r.segment_types)) : ['text'],
    },
  };
}

/**
 * 把表单值写回策略。只重建 events.allow 里的 message 范围、events.deny 的内容规则
 * 和 actions.allow 里的三个发送 Action；其它一切保持原样。
 */
export function writeRules(policy: Policy, rules: Rules): Policy {
  const keepScopes = policy.events.allow.filter(scope => scope.post_type !== 'message');
  const allow: EventScope[] = [...keepScopes];
  // 空列表 = 不限制（不写 group_ids / user_ids），与 matchesScope 的语义一致。
  allow.push(rules.receive.group_ids.length
    ? { post_type: 'message', message_type: 'group', group_ids: [...rules.receive.group_ids] }
    : { post_type: 'message', message_type: 'group' });
  allow.push(rules.receive.user_ids.length
    ? { post_type: 'message', message_type: 'private', user_ids: [...rules.receive.user_ids] }
    : { post_type: 'message', message_type: 'private' });

  const sendActions: ActionRule[] = [];
  const segments = rules.send.segments.length ? [...rules.send.segments] : ['text'];
  if (rules.send.group_ids.length) {
    sendActions.push({ name: 'send_msg', group_ids: [...rules.send.group_ids], segment_types: segments });
    sendActions.push({ name: 'send_group_msg', group_ids: [...rules.send.group_ids], segment_types: segments });
  }
  if (rules.send.user_ids.length) {
    sendActions.push({ name: 'send_msg', user_ids: [...rules.send.user_ids], segment_types: segments });
    sendActions.push({ name: 'send_private_msg', user_ids: [...rules.send.user_ids], segment_types: segments });
  }
  const keepActions = policy.actions.allow.filter(rule => !SEND_ACTIONS.includes(rule.name));

  return {
    ...policy,
    events: {
      ...policy.events,
      allow,
      deny: {
        ...policy.events.deny,
        keywords: [...rules.receive.keywords],
        keywords_regex: [...rules.receive.keywords_regex],
        segment_types: [...rules.receive.blocked_segments],
      },
    },
    actions: { ...policy.actions, allow: [...keepActions, ...sendActions] },
  };
}
