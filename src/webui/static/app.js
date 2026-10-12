'use strict';
const $ = id => document.getElementById(id);
try { sessionStorage.removeItem('guard-read-token'); sessionStorage.removeItem('guard-write-token'); } catch { /* Session storage may be disabled. */ }
let streamController;
let pollTimer;
let logLimit = 200;
let allowEdit = false;
let rulesPolicy = null;
let rulesRegex = [];
let generation = 0;
const yes = value => value ? '是' : '否';
const time = value => value ? new Date(value).toLocaleString() : '暂无';
function element(tag, text) { const node = document.createElement(tag); node.textContent = String(text); return node; }
function pairs(target, entries, group) {
  target.replaceChildren(...entries.map(([key, value]) => {
    const row = document.createElement('div');
    const dt = element('dt', group ? human(group, key) : key);
    const w = group ? word(group, key) : null;
    dt.title = w ? `${key}${w[1] ? ` — ${w[1]}` : ''}` : String(key);
    row.append(dt, element('dd', value)); return row;
  }));
}
function span(cls, text) { const node = document.createElement('span'); node.className = cls; node.textContent = String(text ?? ''); return node; }

// ── 把内部代号翻成人话（找不到就原样显示）──
const WORDS = {
  queues: {
    application_queue: ['应用队列', '等待送到下游的消息条数，正常一直是 0'],
    pending_requests: ['待回包请求', '已发给上游、还在等它回答的请求'],
    identity_probes: ['账号验证中', '正在向上游确认机器人身份'],
    dedupe_entries: ['去重记录', '用来丢弃重复消息的条目数'],
    inbound_rate_entries: ['入站限流计数', '正在按群/人统计的条数'],
    outbound_rate_entries: ['出站限流计数', '正在按目标统计的条数'],
  },
  rules: {
    'event.scope.allow': ['收到并放行', '来源在允许范围内，消息已转给下游'],
    'event.scope.deny': ['来源被拒', '发送者落在拒绝范围里'],
    'event.scope.default': ['来源未授权', '这条消息没匹配任何放行规则，默认丢掉'],
    'event.self': ['自己发的消息', '机器人自己发的不再回灌'],
    'event.bot': ['指定机器人', '该账号在拒绝名单里'],
    'event.keyword': ['命中关键词', '消息含黑名单词，整条丢弃'],
    'event.regex': ['命中正则', '消息匹配黑名单规则，整条丢弃'],
    'event.segment': ['消息类型被屏蔽', '这种消息段不允许进入'],
    'event.duplicate': ['重复消息', '同一个消息 ID 被投递了两次'],
    'event.rate': ['超出限额', '入站频率超过配置上限'],
    'event.identity': ['账号不符', '事件里的账号和绑定账号对不上'],
    'event.delivery': ['投递失败', '下游没接上，或发送缓冲满了'],
    'event.route': ['路由已关闭', '这条路由被主动关掉了'],
    'action.send': ['发送放行', '下游要求发的消息已通过'],
    'action.read': ['读取放行', '下游的只读查询已通过'],
    'action.name.default': ['接口未授权', '下游调了这个接口，但允许名单里没有它'],
    'action.name.deny': ['接口被禁', '这个接口在拒绝名单里'],
    'action.resource': ['目标不在名单', '想发到的群/人不在允许范围'],
    'action.segment': ['发送类型不允许', '想发的消息类型没被允许'],
    'action.media': ['媒体被限制', '图片/语音等媒体按配置拦下了'],
    'action.target': ['目标参数有误', '群号或 QQ 号缺失/冲突'],
    'action.params': ['参数不合格', ''],
    'action.readonly': ['只读下游', '这个下游被标成只读，不能发消息'],
    'action.unsupported': ['接口不支持', '这个接口不在网关支持的白名单里'],
    'action.identity': ['身份不可信', '连接身份没通过校验'],
    'action.reference': ['引用消息被拒', '不能引用消息（没有可信归属）'],
    'action.rate': ['超出限额', '发送频率超过配置上限'],
    'action.upstream': ['上游不可用', '上游没连上，发不出去'],
    'action.delivery': ['发送失败', '写出过程中出错，结果未知'],
    'action.pending': ['待回包已满', '同时在等的请求太多'],
    'action.route': ['路由已关闭', '这条路由被主动关掉了'],
    'response.correlated': ['回包已送回', '上游的答复已交给发起方'],
    'response.delivery': ['回包投递失败', '发起方已经断开'],
    'response.failure': ['回包失败', ''],
  },
  issues: {
    unverified_upstream_packet: ['握手前的报文', '账号还没验证完，先丢弃，属正常现象'],
    ping_timeout: ['心跳超时', '上游没回 pong，已断开等待重连'],
    account_probe_failed: ['账号验证失败', '上游报的账号和配置不一致'],
    account_probe_timeout: ['账号验证超时', '上游没在时限内回答'],
    dial_or_socket_error: ['连接出错', '拨号或套接字异常'],
    listener_error: ['监听出错', '端口被占用或绑定失败'],
    invalid_json_packet: ['报文不是 JSON', '收到无法解析的内容，已断开'],
    binary_packet_denied: ['二进制帧被拒', '只接受文本 JSON'],
    outgoing_message_too_large: ['发出的报文过大', '超过上限，已断开'],
    buffer_event_dropped: ['缓冲满，丢弃事件', '下游读得太慢'],
    buffer_connection_closed: ['缓冲满，断开连接', '控制报文不能丢，只能断开'],
    send_error_result_unknown: ['发送出错', '结果未知，不会重发'],
    authorization_denied: ['连接认证失败', 'token 不对'],
    upstream_role_or_account_mismatch: ['身份头不符', '角色或账号和配置不一致'],
    endpoint_session_limit: ['连接数已满', '这个端点同时只允许一个连接'],
    unverified_upstream_response: ['未验证的回包', ''],
    upgrade_failed: ['升级握手失败', ''],
  },
};
const word = (group, key) => (WORDS[group] && WORDS[group][key]) || null;
const human = (group, key, fallback) => { const w = word(group, key); return w ? (w[1] ? `${w[0]} · ${w[1]}` : w[0]) : (fallback ?? key); };

const SEGMENT_CHOICES = [['image', '图片'], ['record', '语音'], ['video', '视频'], ['file', '文件'], ['forward', '合并转发'], ['json', '卡片/JSON'], ['xml', 'XML'], ['face', '表情']];
const SEND_TYPE_CHOICES = [['text', '文字'], ['at', '艾特'], ['image', '图片'], ['face', '表情'], ['reply', '引用回复']];
const rulesText = new Map([['rules-groups', '群白名单'], ['rules-users', '私聊白名单'], ['rules-keywords', '关键词'], ['rules-send-groups', '允许发送的群'], ['rules-send-users', '允许发送的人']]);
const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
const checkedValues = id => [...$(id).querySelectorAll('input:checked')].map(input => input.value);
function checks(id, choices, selected) {
  const extra = selected.filter(v => !choices.some(([value]) => value === v)).map(v => [v, v]);
  $(id).replaceChildren(...[...choices, ...extra].map(([value, label]) => {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = value; input.checked = selected.includes(value);
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }));
}
function timeOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleTimeString('zh-CN', { hour12: false });
}
function pair(label, value, cls) { const cell = document.createElement('span'); const strong = span('', value); if (cls) strong.className = cls; cell.append(element('i', label), strong); return cell; }
function endpointCard(name, endpoint) {
  const row = document.createElement('div'); row.className = 'ep';
  const who = document.createElement('div'); who.className = 'who';
  who.append(element('div', name), element('div', `${endpoint.side === 'upstream' ? '上游' : '下游'} · ${endpoint.onebot}`));
  who.lastChild.className = 'role'; who.firstChild.className = 'name';
  const tag = span('tag', endpoint.connection === 'connect' ? '网关拨出' : '等待连入');
  const meta = span('meta', '');
  meta.append(
    pair('状态', `${yes(endpoint.connected)} / ${yes(endpoint.ready)}`, endpoint.ready ? 'ok' : ''),
    pair('缓冲', `${endpoint.buffered_bytes} B`),
    pair('重连', endpoint.reconnect_attempts),
  );
  row.append(who, tag, meta); return row;
}
function logRow(event) {
  const kind = String(event.event ?? '');
  const row = document.createElement('li');
  if (kind === 'denied') row.className = String(event.rule ?? '').startsWith('action.') ? 'rejected' : 'denied';
  else if (kind === 'allowed') row.className = 'allowed';
  const level = { denied: '拦下', allowed: '放行', session_open: '连接', session_close: '断开', transport_issue: '传输', reload: '重载' }[kind] ?? kind;
  const bucket = kind === 'denied' || kind === 'allowed' ? String(event.direction ?? '')
    : kind.startsWith('session') ? String(event.side ?? '') : '';
  const detail = kind === 'denied' || kind === 'allowed'
    ? `${human('rules', String(event.rule ?? ''))}${event.scope && event.scope !== 'private:unknown' ? ` · ${event.scope}` : ''}`
    : kind === 'transport_issue' ? human('issues', String(event.reason ?? ''))
    : kind === 'reload' ? `${event.ok ? '重载成功' : '重载失败'}${event.reason ? ` · ${event.reason}` : ''}`
    : `${event.endpoint ?? ''}${event.side ? ` · ${event.side === 'upstream' ? '上游' : '下游'}` : ''}`;
  row.append(span('tm', timeOf(event.time)), span('lv', level), span('rt', bucket), span('msg', detail));
  return row;
}
function headers(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }
function checkSession(response) {
  if (response.status === 401) { generation++; clearTimeout(pollTimer); streamController?.abort(); location.replace('/'); throw new Error('请重新登录'); }
}
async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options });
  checkSession(response);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function reload(result) { $('reload-status').textContent = result ? `${time(result.time)} · ${result.ok ? '重载成功' : '重载失败'} · ${result.reason}` : '尚未重载'; }
function render(state) {
  $('connection').className = 'pill'; $('connection').textContent = '面板已连接';
  pairs($('overview'), [['网关健康', state.healthy ? '健康' : '等待端点就绪'], ['启动时间', time(state.started_at)], ['最后事件', time(state.last_event_at)], ['允许', state.totals.allowed], ['拒绝', state.totals.denied]]);
  const sides = { upstream: [], downstream: [] };
  for (const [name, endpoint] of Object.entries(state.endpoints)) sides[endpoint.side === 'upstream' ? 'upstream' : 'downstream'].push([name, endpoint]);
  for (const [side, target] of [['upstream', 'endpoints-upstream'], ['downstream', 'endpoints-downstream']]) {
    const rows = sides[side].map(([name, endpoint]) => endpointCard(name, endpoint));
    $(target).replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), { className: 'muted empty', textContent: '这一侧没有配置端点' })]));
  }
  $('routes').replaceChildren(...state.routes.map(route => {
    const cell = (text, cls) => { const td = element('td', text); if (cls) td.className = cls; return td; };
    const row = document.createElement('tr');
    row.append(cell(route.id, 'mono'), cell(yes(route.upstream_ready), route.upstream_ready ? 'ok' : ''), cell(yes(route.downstream_ready), route.downstream_ready ? 'ok' : ''), cell(yes(route.ready), route.ready ? 'ok' : ''), cell(route.pending_requests));
    return row;
  }));
  pairs($('queues'), Object.entries(state.queues), 'queues');
  pairs($('rules'), Object.entries(state.hits_by_rule), 'rules'); pairs($('issues'), Object.entries(state.transport_issues), 'issues');
  if (!Object.keys(state.hits_by_rule).length) pairs($('rules'), [['还没有命中任何规则', '—']]);
  if (!Object.keys(state.transport_issues).length) pairs($('issues'), [['没有传输问题', '—']]);
  allowEdit = state.allow_policy_edit === true;
  logLimit = state.log_ring_size; reload(state.reload);
}
async function poll(epoch) {
  try { const state = await api('/api/state'); if (epoch !== generation) return; render(state); $('error').textContent = ''; }
  catch (error) { if (epoch !== generation) return; $('connection').className = 'pill bad'; $('connection').textContent = '面板连接中断'; $('error').textContent = error.message; }
  if (epoch === generation) pollTimer = setTimeout(() => poll(epoch), 3000);
}
async function loadPolicies(epoch) {
  try {
    const data = await api('/api/policies'); if (epoch !== generation) return;
    $('policy-yaml').value = data.yaml; $('policy-yaml').readOnly = !data.allow_policy_edit;
    $('edit-controls').hidden = !data.allow_policy_edit;
    $('policy-result').textContent = data.allow_policy_edit ? '可编辑；保存后立即重载策略。' : '只读模式';
    reload(data.reload);
  } catch (error) { if (epoch === generation) $('policy-result').textContent = error.message; }
}
async function logs(signal) {
  while (!signal.aborted) {
    try {
      const response = await fetch('/api/logs', { credentials: 'same-origin', cache: 'no-store', signal });
      checkSession(response);
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      $('stream-status').textContent = '实时流已连接';
      // A reconnect starts a fresh replay. Keep the DOM bounded without duplicating history.
      $('logs').replaceChildren();
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 1048576) throw new Error('日志帧超过上限');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            $('logs').append(logRow(event));
            while ($('logs').children.length > logLimit) $('logs').firstElementChild.remove();
            if ($('follow').checked) $('logs').scrollTop = $('logs').scrollHeight;
          }
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      if (!signal.aborted) $('stream-status').textContent = '流已断开，稍后重连';
    } catch (error) { if (signal.aborted) return; $('stream-status').textContent = error.message; }
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 3000); signal.addEventListener('abort', finish, { once: true });
    });
  }
}
function connect() {
  generation++; clearTimeout(pollTimer); streamController?.abort();
  streamController = new AbortController(); void poll(generation); void loadPolicies(generation); void loadRules(generation); void logs(streamController.signal);
}
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('登出失败，请重试');
    try { sessionStorage.removeItem('guard-write-token'); } catch { /* Already absent. */ }
    location.replace('/');
  } catch (error) { $('error').textContent = error.message; }
});
$('policy-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('edit-controls').hidden) return;
  $('save').disabled = true; $('policy-result').textContent = '正在校验并保存…'; $('policy-result').classList.remove('failed');
  try {
    const result = await api('/api/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policies: $('policy-yaml').value }) });
    $('policy-result').textContent = `保存成功 · ${result.reload.reason}`; reload(result.reload);
  } catch (error) { $('policy-result').textContent = error.message; $('policy-result').classList.add('failed'); }
  finally { $('save').disabled = false; }
});
async function loadRules(epoch) {
  try {
    const data = await api('/api/rules' + (rulesPolicy ? `?policy=${encodeURIComponent(rulesPolicy)}` : ''));
    if (epoch !== generation) return;
    rulesPolicy = data.policy;
    rulesRegex = data.rules.receive.keywords_regex;
    $('rules-policy').textContent = `策略「${data.policy}」` + (rulesRegex.length ? ` · 另有 ${rulesRegex.length} 条正则规则只在 YAML 里` : '');
    $('rules-groups').value = data.rules.receive.group_ids.join('\n');
    $('rules-users').value = data.rules.receive.user_ids.join('\n');
    $('rules-keywords').value = data.rules.receive.keywords.join('\n');
    $('rules-send-groups').value = data.rules.send.group_ids.join('\n');
    $('rules-send-users').value = data.rules.send.user_ids.join('\n');
    checks('rules-blocked', SEGMENT_CHOICES, data.rules.receive.blocked_segments);
    checks('rules-send-types', SEND_TYPE_CHOICES, data.rules.send.segments);
  } catch (error) { $('rules-result').textContent = error.message; $('rules-result').classList.add('failed'); }
}
$('rules-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!allowEdit) { $('rules-result').textContent = '策略编辑没开（配置里 allow_policy_edit: false）'; return; }
  $('rules-save').disabled = true; $('rules-result').textContent = '正在校验并保存…'; $('rules-result').classList.remove('failed');
  try {
    const rules = {
      receive: { group_ids: lines('rules-groups'), user_ids: lines('rules-users'), keywords: lines('rules-keywords'), keywords_regex: rulesRegex, blocked_segments: checkedValues('rules-blocked') },
      send: { group_ids: lines('rules-send-groups'), user_ids: lines('rules-send-users'), segments: checkedValues('rules-send-types') },
    };
    const result = await api('/api/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: rulesPolicy, rules }) });
    await loadRules(generation);
    $('rules-result').textContent = result.reload && result.reload.ok ? '已保存，策略已重载生效' : `已保存，但重载失败：${result.reload ? result.reload.reason : '未知'}`;
    $('rules-result').classList.toggle('failed', !(result.reload && result.reload.ok));
  } catch (error) { $('rules-result').textContent = error.message; $('rules-result').classList.add('failed'); }
  finally { $('rules-save').disabled = false; }
});
window.addEventListener('pagehide', () => { generation++; clearTimeout(pollTimer); streamController?.abort(); });
const PAGES = ['overview', 'endpoints', 'routes', 'rules', 'logs', 'policies'];
function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'overview').toLowerCase();
  const page = PAGES.includes(name) ? name : 'overview';
  document.body.dataset.page = page;
  for (const link of document.querySelectorAll('nav a')) link.classList.toggle('active', link.dataset.page === page);
}
window.addEventListener('hashchange', route);
route();
connect();
