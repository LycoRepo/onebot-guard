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
let configDraft = null;
let configBusy = false;
let restarting = false;
let configLoaded = false;
let savedConfig = null;
let runtimeState = null;
let pendingRestart = false;
let endpointSearch = '';
let draftError = '';
const endpointOpen = new Set();
const newEndpointIds = new Set();
const newForms = { upstream: false, downstream: false };
const pendingDelete = new Map();
const draft = {
  id: '', connection: 'connect', url: '', host: '127.0.0.1', port: '', token_env: '',
  expected_self_id: '', principal: '', readonly: false, reconnect: true,
  route: { id: '', upstream: '', downstream: '', policy: '' },
};
function resetDraft(side) {
  draftError = '';
  draft.id = '';
  draft.connection = side === 'upstream' ? 'connect' : 'listen';
  draft.url = ''; draft.host = '127.0.0.1'; draft.port = ''; draft.token_env = '';
  draft.expected_self_id = ''; draft.principal = ''; draft.readonly = false; draft.reconnect = true;
  const freeDownstream = sideIds('downstream').filter(id => !draftRoutes().some(route => route.downstream === id));
  draft.route = {
    id: '', upstream: sideIds('upstream')[0] ?? '', downstream: freeDownstream[0] ?? '',
    policy: (configDraft ? configDraft.policies : [])[0] ?? '',
  };
}
const ready = value => value ? '已就绪' : '未就绪';
const connected = value => value ? '已连接' : '未连接';
const time = value => value ? new Date(value).toLocaleString() : '暂无';
function element(tag, text) { const node = document.createElement(tag); node.textContent = String(text); return node; }
function pairs(target, entries, group) {
  target.replaceChildren(...entries.map(([key, value]) => {
    const row = document.createElement('div');
    const dt = element('dt', group ? human(group, key) : key);
    const w = group ? word(group, key) : null;
    dt.title = w ? `${key}${w[1] ? ` — ${w[1]}` : ''}` : String(key);
    const dd = element('dd', value); dd.title = String(value);
    row.append(dt, dd); return row;
  }));
}
function span(cls, text) { const node = document.createElement('span'); node.className = cls; node.textContent = String(text ?? ''); return node; }

// ── 把配置键翻成中文标签（找不到就原样显示）──
const WORDS = {
  fields: {
    connection: ['连接方式', ''], url: ['连接地址', ''], host: ['监听地址', ''], port: ['监听端口', ''],
    token_env: ['凭据环境变量', '填写环境变量名，不要填写凭据值。'],
    expected_self_id: ['上游账号', ''], reconnect: ['自动重连', ''],
    principal: ['下游主体', ''], readonly: ['只读模式', ''],
    upstream: ['上游端点', ''], downstream: ['下游端点', ''], policy: ['策略', ''],
    '路由 ID': ['路由名称', ''],
  },
  sources: {
    event: ['上游事件', ''], action: ['下游请求', ''], response: ['上游回包', ''],
    upstream: ['上游', ''], downstream: ['下游', ''],
  },
  queues: {
    application_queue: ['应用队列', '等待送到下游的消息条数，正常一直是 0'],
    pending_requests: ['待回包请求', '已发给上游、还在等它回答的请求'],
    identity_probes: ['账号验证中', '正在向上游确认账号身份'],
    dedupe_entries: ['去重记录', '用来丢弃重复消息的条目数'],
    inbound_rate_entries: ['入站限流计数', '正在按群/人统计的条数'],
    outbound_rate_entries: ['出站限流计数', '正在按目标统计的条数'],
  },
  rules: {
    'event.scope.allow': ['收到并放行', '来源在白名单内，消息已转给下游'],
    'event.scope.deny': ['来源被拦下', '发送者在拦下名单里'],
    'event.scope.default': ['来源未授权', '这条消息没匹配任何放行规则，默认丢掉'],
    'event.self': ['自己发的消息', '上游账号自己发的不再回灌'],
    'event.bot': ['指定账号', '该账号在拦下名单里'],
    'event.keyword': ['命中关键词', '消息含黑名单词，整条丢弃'],
    'event.regex': ['命中正则', '消息匹配黑名单规则，整条丢弃'],
    'event.segment': ['消息类型被拦下', '这种消息段不在白名单里'],
    'event.duplicate': ['重复消息', '同一个消息 ID 被投递了两次'],
    'event.rate': ['超出限额', '入站频率超过配置上限'],
    'event.identity': ['账号不符', '事件里的账号和绑定账号对不上'],
    'event.delivery': ['投递失败', '下游没接上，或发送缓冲满了'],
    'event.route': ['路由已关闭', '这条路由被主动关掉了'],
    'action.send': ['发送放行', '下游要求发的消息已通过'],
    'action.read': ['读取放行', '下游的只读查询已通过'],
    'action.name.default': ['接口未授权', '下游调了这个接口，但白名单里没有它'],
    'action.name.deny': ['接口被拦下', '这个接口在拦下名单里'],
    'action.resource': ['目标不在名单', '想发到的群/人不在白名单里'],
    'action.segment': ['发送类型被拦下', '想发的消息类型不在白名单里'],
    'action.media': ['媒体被限制', '图片/语音等媒体按配置拦下了'],
    'action.target': ['目标参数有误', '群号或 QQ 号缺失/冲突'],
    'action.params': ['参数不合格', ''],
    'action.readonly': ['只读下游', '这个下游被标成只读，不能发消息'],
    'action.unsupported': ['接口不支持', '这个接口不在网关支持的白名单里'],
    'action.identity': ['身份不可信', '连接身份没通过校验'],
    'action.reference': ['引用消息被拦下', '不能引用消息（没有可信归属）'],
    'action.rate': ['超出限额', '发送频率超过配置上限'],
    'action.upstream': ['上游未就绪', '上游没连上，发不出去'],
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
    binary_packet_denied: ['二进制帧被拦下', '只接受文本 JSON'],
    outgoing_message_too_large: ['发出的报文过大', '超过上限，已断开'],
    buffer_event_dropped: ['缓冲满，丢弃事件', '下游读得太慢'],
    buffer_connection_closed: ['缓冲满，断开连接', '控制报文不能丢，只能断开'],
    send_error_result_unknown: ['发送出错', '结果未知，不会重发'],
    authorization_denied: ['连接认证失败', '凭据不对'],
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
const rulesText = new Map([['rules-groups', '接收群白名单'], ['rules-users', '接收私聊白名单'], ['rules-keywords', '关键词黑名单'], ['rules-send-groups', '发送群白名单'], ['rules-send-users', '发送私聊白名单']]);
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
function runtimeOnlyRow(name, endpoint) {
  const row = document.createElement('article'); row.className = 'endpoint-card';
  const summary = document.createElement('div'); summary.className = 'endpoint-summary';
  const who = document.createElement('div'); who.className = 'who';
  who.append(element('div', name), element('div', `${endpoint.side === 'upstream' ? '上游' : '下游'} · ${endpoint.onebot}`));
  who.lastChild.className = 'role'; who.firstChild.className = 'name';
  const tag = span('tag', endpoint.connection === 'connect' ? '网关拨出' : '等待连入');
  const meta = span('meta', ''); meta.id = `endpoint-state-${name}`;
  meta.append(
    pair('状态', `${connected(endpoint.connected)} · ${ready(endpoint.ready)}`, endpoint.ready ? 'ok' : ''),
    pair('缓冲', `${endpoint.buffered_bytes} B`),
    pair('重连', endpoint.reconnect_attempts),
  );
  summary.append(who, tag, meta);
  const hint = element('p', '这里只显示运行状态：配置尚未读取或不可编辑。'); hint.className = 'muted';
  row.append(summary, hint);
  return row;
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
  row.append(span('tm', timeOf(event.time)), span('lv', level), span('rt', human('sources', bucket)), span('msg', detail));
  return row;
}
function headers(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }
function checkSession(response) {
  if (response.status === 401 && !restarting) { generation++; clearTimeout(pollTimer); streamController?.abort(); location.replace('/'); throw new Error('请重新登录'); }
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
  runtimeState = state;
  $('connection').className = 'pill'; $('connection').textContent = '面板已连接';
  pairs($('overview'), [['网关状态', ready(state.healthy)], ['启动时间', time(state.started_at)], ['最后事件', time(state.last_event_at)], ['放行', state.totals.allowed], ['拦下', state.totals.denied]]);
  $('routes').replaceChildren(...state.routes.map(route => {
    const cell = (text, cls) => { const td = element('td', text); if (cls) td.className = cls; return td; };
    const row = document.createElement('tr');
    row.append(cell(route.id, 'mono'), cell(ready(route.upstream_ready), route.upstream_ready ? 'ok' : ''), cell(ready(route.downstream_ready), route.downstream_ready ? 'ok' : ''), cell(ready(route.ready), route.ready ? 'ok' : ''), cell(route.pending_requests));
    return row;
  }));
  if (!configDraft) {
    const sides = { upstream: [], downstream: [] };
    for (const [name, endpoint] of Object.entries(state.endpoints)) sides[endpoint.side === 'upstream' ? 'upstream' : 'downstream'].push([name, endpoint]);
    for (const [side, target] of [['upstream', 'endpoints-upstream'], ['downstream', 'endpoints-downstream']]) {
      const rows = sides[side].map(([name, endpoint]) => runtimeOnlyRow(name, endpoint));
      $(target).replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), { className: 'muted empty', textContent: '这一侧没有配置端点' })]));
      const count = $(`endpoint-count-${side}`); if (count) count.textContent = sides[side].length;
      const zone = $(`zone-count-${side}`); if (zone) zone.textContent = `${sides[side].length} 个`;
    }
  } else {
    for (const id of Object.keys(draftEndpoints())) {
      const target = document.getElementById(`endpoint-state-${id}`); if (!target) continue;
      const live = state.endpoints[id];
      if (live) target.textContent = `当前运行：${connected(live.connected)} · ${ready(live.ready)} · 发送缓冲 ${live.buffered_bytes} B · 重连 ${live.reconnect_attempts}（改动重启后才生效）`;
      else if (newEndpointIds.has(id)) target.textContent = '尚未运行：保存并重启后才会创建这个连接。';
      else target.textContent = '当前实例里没有这个端点：可能刚被移除，或改动重启后才生效。';
    }
  }
  pairs($('queues'), Object.entries(state.queues), 'queues');
  pairs($('rules'), Object.entries(state.hits_by_rule), 'rules'); pairs($('issues'), Object.entries(state.transport_issues), 'issues');
  if (!Object.keys(state.hits_by_rule).length) pairs($('rules'), [['还没有命中任何规则', '—']]);
  if (!Object.keys(state.transport_issues).length) pairs($('issues'), [['没有传输问题', '—']]);
  const previousEdit = allowEdit;
  allowEdit = state.allow_policy_edit === true;
  if (configDraft && previousEdit !== allowEdit) renderConfig();
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
    $('policy-result').textContent = data.allow_policy_edit ? '可编辑' : '只读模式';
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
  streamController = new AbortController(); void poll(generation); void loadPolicies(generation); void loadRules(generation); void loadConfig(generation); void logs(streamController.signal);
}
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('退出登录失败，请重试');
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
    $('rules-policy').textContent = `策略「${data.policy}」` + (rulesRegex.length ? ` · 另有 ${rulesRegex.length} 条正则规则，请到高级 YAML 编辑` : '');
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
  if (!allowEdit) { $('rules-result').textContent = '当前为只读模式；请先在配置中开启策略编辑。'; return; }
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
function configField(parent, label, value, change, choices, type = 'text') {
  const field = word('fields', label);
  const wrap = element('label', field ? field[0] : label);
  if (type === 'checkbox') wrap.className = 'config-check';
  wrap.append(span('field-key', label === '路由 ID' ? 'id' : label));
  if (field && field[1]) wrap.append(span('hint', field[1]));
  const input = document.createElement(choices ? 'select' : 'input');
  if (choices) for (const [key, text] of choices) { const option = element('option', text); option.value = key; input.append(option); }
  else input.type = type;
  if (type === 'checkbox') input.checked = value === true;
  else input.value = value ?? '';
  input.addEventListener('change', () => change(type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value));
  wrap.append(input); parent.append(wrap); return wrap;
}
// ── 端点页：草稿模型、行式字段、增删端点 ──
const FIELD_LABELS = {
  connection: ['连接方式', 'connection'], url: ['连接地址', 'url'], host: ['监听地址', 'host'],
  port: ['监听端口', 'port'], token_env: ['凭据环境变量', 'token_env'], expected_self_id: ['上游账号', 'expected_self_id'],
  principal: ['下游主体', 'principal'], readonly: ['只读模式', 'readonly'], reconnect: ['自动重连', 'reconnect'],
};
const FIELD_HELP = {
  url: 'WebSocket 地址（ws:// 或 wss://）；不要带用户名、密码、查询串或片段。',
  host: '本机监听的地址，默认 127.0.0.1。',
  port: '0–65535 的整数；填 0 表示由系统自动分配端口。',
  token_env: '填写环境变量名，不要填写凭据值。请先在部署环境设置此变量；保存只校验名称，不验证变量值是否存在。',
  expected_self_id: '上游账号；与协议端实际上报不一致时会被断开。',
  principal: '下游应用的身份名；不会从上游账号自动复制。',
  readonly: '只读下游不能发送消息；不影响面板里的编辑。',
  reconnect: '断开后自动尝试重新连接。',
};
const CONNECTION_CHOICES = [['connect', '网关拨出（connect）'], ['listen', '等待连入（listen）']];
const clone = value => JSON.parse(JSON.stringify(value));
const draftEndpoints = () => (configDraft ? configDraft.endpoints : {});
const draftRoutes = () => (configDraft ? configDraft.routes : []);
const routeRefs = id => draftRoutes().filter(route => route.upstream === id || route.downstream === id);
const sideIds = side => Object.keys(draftEndpoints()).filter(id => draftEndpoints()[id].side === side);
const busyEndpoint = id => (newEndpointIds.has(id) || pendingDelete.has(id)) && !allowEdit;
const setAttributeIf = (node, name, value) => { if (typeof node.setAttribute === 'function') node.setAttribute(name, value); };
const addListenerIf = (node, name, handler) => { if (typeof node.addEventListener === 'function') node.addEventListener(name, handler); };

function formatValue(key, value) {
  if (key === 'readonly') return value ? '开启' : '关闭';
  return value === undefined || value === null || value === '' ? '—' : String(value);
}
function fieldRow(owner, key, value, onChange, options = {}) {
  const meta = FIELD_LABELS[key] || [key, key];
  const controlId = `cfg-${owner}-${key}`;
  const row = document.createElement('div'); row.className = 'endpoint-field-row';
  const label = element('label', options.label || meta[0]); label.className = 'field-label'; label.htmlFor = controlId;
  label.append(span('field-key', options.key || meta[1]));
  const control = document.createElement('div'); control.className = 'field-control';
  const editable = allowEdit && !configBusy;
  if (!editable && (key === 'readonly' || key === 'reconnect')) {
    const readOnly = element('span', formatValue(key, value)); readOnly.className = 'field-value'; control.append(readOnly);
  } else if (key === 'readonly' || key === 'reconnect') {
    const wrap = document.createElement('label'); wrap.className = 'field-check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = controlId; input.checked = value === true;
    addListenerIf(input, 'change', () => onChange(input.checked));
    wrap.append(input, span('', key === 'readonly' ? '开启后该下游不能发送消息' : '断开后自动尝试重新连接'));
    control.append(wrap);
  } else if (options.choices) {
    const input = document.createElement('select'); input.id = controlId;
    for (const [choiceValue, text] of options.choices) { const option = element('option', text); option.value = choiceValue; input.append(option); }
    input.value = value ?? '';
    const commit = () => onChange(input.value);
    addListenerIf(input, 'input', commit); addListenerIf(input, 'change', commit);
    control.append(input);
  } else {
    const input = document.createElement('input'); input.id = controlId;
    input.type = key === 'port' ? 'number' : 'text';
    input.value = value ?? '';
    const commit = () => onChange(input.type === 'number' ? Number(input.value) : input.value);
    addListenerIf(input, 'input', commit); addListenerIf(input, 'change', commit);
    control.append(input);
  }
  const help = options.help ?? FIELD_HELP[key];
  if (help) { const helpNode = span('field-help', help); helpNode.id = `${controlId}-help`; control.append(helpNode); }
  row.append(label, control);
  return row;
}
function fieldGroup(legend, rows) {
  const fieldset = document.createElement('fieldset'); fieldset.className = 'endpoint-config';
  fieldset.append(element('legend', legend));
  const list = document.createElement('div'); list.className = 'endpoint-field-rows';
  list.append(...rows); fieldset.append(list);
  return fieldset;
}
function endpointFlag(text, kind) { const node = span(`endpoint-flag ${kind}`, text); return node; }
function endpointLine(label, value) {
  const line = document.createElement('p'); line.className = 'endpoint-line';
  line.append(element('b', label), span('', value)); return line;
}
function connectionSummary(endpoint) {
  if (endpoint.connection === 'connect') return `网关拨出 · ${endpoint.url ?? ''}`;
  return `等待连入 · ${endpoint.host ?? ''}:${endpoint.port ?? ''}`;
}
function actionsRow(id) {
  const actions = document.createElement('div'); actions.className = 'endpoint-actions';
  const toggle = element('button', endpointOpen.has(id) ? '收起配置' : '编辑配置');
  toggle.type = 'button'; toggle.className = 'ghost';
  toggle.setAttribute && toggle.setAttribute('aria-expanded', endpointOpen.has(id) ? 'true' : 'false');
  addListenerIf(toggle, 'click', () => { if (endpointOpen.has(id)) endpointOpen.delete(id); else endpointOpen.add(id); renderConfig(); });
  actions.append(toggle);
  if (allowEdit) {
    if (pendingDelete.has(id)) {
      const undo = element('button', '撤销删除'); undo.type = 'button'; undo.className = 'ghost';
      addListenerIf(undo, 'click', () => { pendingDelete.delete(id); renderConfig(); });
      actions.append(undo);
    } else {
      const remove = element('button', '删除'); remove.type = 'button'; remove.className = 'ghost';
      addListenerIf(remove, 'click', () => { openDeletePanel(id); });
      actions.append(remove);
    }
  }
  return actions;
}
function endpointLines(id, endpoint, flags) {
  const lines = document.createElement('div'); lines.className = 'endpoint-lines';
  const runtime = element('p', '正在读取运行状态，连接情况会自动更新。'); runtime.className = 'muted'; runtime.id = `endpoint-state-${id}`;
  lines.append(runtime);
  lines.append(endpointLine(flags.new ? '草稿配置（未保存）' : '草稿配置', connectionSummary(endpoint)));
  const refs = routeRefs(id);
  const names = refs.map(route => `${route.id || '(未命名路由)'}：${route.upstream} → ${route.downstream} · ${route.policy}`);
  lines.append(endpointLine('草稿关联', names.length ? names.join('；') : '尚未关联路由，不能保存整份配置'));
  return lines;
}
function endpointCard(id, endpoint, flags) {
  const card = document.createElement('article'); card.className = 'endpoint-card';
  if (pendingDelete.has(id)) card.className += ' pending-delete';
  card.id = `endpoint-card-${id}`;
  const summary = document.createElement('div'); summary.className = 'endpoint-summary';
  const name = element('span', id); name.className = 'endpoint-id';
  const proto = element('span', endpoint.protocol || 'onebot_v11'); proto.className = 'endpoint-proto';
  summary.append(name, proto);
  if (flags.new) summary.append(endpointFlag('新增 · 未保存', 'new'));
  else if (flags.edited) summary.append(endpointFlag('已修改', 'edited'));
  if (pendingDelete.has(id)) summary.append(endpointFlag('待删除', 'removed'));
  summary.append(actionsRow(id));
  card.append(summary, endpointLines(id, endpoint, flags));
  const details = document.createElement('div'); details.className = 'endpoint-details';
  details.hidden = !endpointOpen.has(id);
  const connectionRows = [];
  connectionRows.push(fieldRow(id, 'connection', endpoint.connection, value => {
    if (value === 'connect') { endpoint.connection = 'connect'; delete endpoint.host; delete endpoint.port; if (!endpoint.url) endpoint.url = 'ws://example.invalid'; }
    else { endpoint.connection = 'listen'; delete endpoint.url; if (!endpoint.host) endpoint.host = '127.0.0.1'; if (endpoint.port === undefined) endpoint.port = 0; }
    touchDraft(); renderConfig();
  }, { choices: CONNECTION_CHOICES }));
  if (endpoint.connection === 'connect') connectionRows.push(fieldRow(id, 'url', endpoint.url, value => { endpoint.url = value; touchDraft(); }));
  else {
    connectionRows.push(fieldRow(id, 'host', endpoint.host, value => { endpoint.host = value; touchDraft(); }));
    connectionRows.push(fieldRow(id, 'port', endpoint.port, value => { endpoint.port = value; touchDraft(); }));
  }
  const identityRows = [fieldRow(id, 'token_env', endpoint.token_env, value => { endpoint.token_env = value; touchDraft(); })];
  if (endpoint.side === 'upstream') {
    identityRows.push(fieldRow(id, 'expected_self_id', endpoint.expected_self_id, value => { endpoint.expected_self_id = value; touchDraft(); }));
    identityRows.push(fieldRow(id, 'reconnect', endpoint.reconnect, value => { endpoint.reconnect = value; touchDraft(); }));
  } else {
    identityRows.push(fieldRow(id, 'principal', endpoint.principal, value => { endpoint.principal = value; touchDraft(); }));
    identityRows.push(fieldRow(id, 'readonly', endpoint.readonly, value => { endpoint.readonly = value; touchDraft(); }));
  }
  if (endpoint.connection !== 'connect' && endpoint.side === 'upstream') {
    const note = element('p', '监听类上游由对端发起重连，面板不提供自动重连开关。'); note.className = 'field-help';
    identityRows.push(note);
  }
  details.append(fieldGroup('连接', connectionRows), fieldGroup('身份与访问', identityRows));
  details.append(pendingDelete.has(id) ? deleteImpact(id) : routeLinks(id));
  card.append(details);
  return card;
}
function deleteImpact(id) {
  const wrap = document.createElement('div'); wrap.className = 'endpoint-impact';
  wrap.append(element('h3', `删除「${id}」的影响`));
  const refs = routeRefs(id);
  const list = document.createElement('ul'); list.className = 'impact-list';
  if (refs.length) {
    list.append(element('li', `引用它的路由 ${refs.length} 条：${refs.map(route => route.id || '(未命名路由)').join('、')}`));
    const others = refs.map(route => (route.upstream === id ? route.downstream : route.upstream)).filter(other => other && other !== id);
    if (others.length) list.append(element('li', `同一批路由的另一侧端点：${[...new Set(others)].join('、')}`));
    list.append(element('li', '这些路由要一起删掉、或改指到别的端点；否则整份配置会因为引用了不存在的端点而被拒绝。'));
    if (configDraft.routes.length === refs.length) list.append(element('li', '至少要保留一条路由：删完这些路由就无法保存，请先建立替代连接。'));
  } else {
    list.append(element('li', '目前没有任何路由引用它。'));
  }
  wrap.append(list);
  const actions = document.createElement('div'); actions.className = 'form-actions';
  if (refs.length) {
    const alsoRoutes = element('button', `一并删除这些路由（${refs.length} 条）`); alsoRoutes.type = 'button';
    addListenerIf(alsoRoutes, 'click', () => {
      for (const route of refs) { const index = configDraft.routes.indexOf(route); if (index >= 0) configDraft.routes.splice(index, 1); }
      touchDraft(); renderConfig();
    });
    actions.append(alsoRoutes);
  }
  const cancel = element('button', '取消删除'); cancel.type = 'button'; cancel.className = 'ghost';
  addListenerIf(cancel, 'click', () => { pendingDelete.delete(id); renderConfig(); });
  actions.append(cancel);
  wrap.append(actions);
  return wrap;
}
function routeLinks(id) {
  const wrap = document.createElement('div'); wrap.className = 'endpoint-route-links';
  wrap.append(element('h4', '关联路由'));
  const refs = routeRefs(id);
  if (!refs.length) {
    wrap.append(element('p', '尚未关联路由，不能保存整份配置。可在路由页新建路由，或在下方新增表单里同时新建。'));
  }
  for (const route of refs) {
    const line = document.createElement('p'); line.className = 'endpoint-line';
    line.append(span('', `${route.id || '(未命名路由)'}：${route.upstream} → ${route.downstream} · ${route.policy}`));
    wrap.append(line);
  }
  return wrap;
}
function renderEndpoints() {
  const term = endpointSearch.trim().toLowerCase();
  const groups = { upstream: [], downstream: [] };
  const flagsFor = id => ({
    new: newEndpointIds.has(id),
    edited: Boolean(savedConfig && savedConfig.endpoints[id] && JSON.stringify(stripMeta(savedConfig.endpoints[id])) !== JSON.stringify(stripMeta(configDraft.endpoints[id]))),
    removed: pendingDelete.has(id),
  });
  for (const [id, endpoint] of Object.entries(draftEndpoints())) {
    if (term) {
      const haystack = [id, endpoint.url, endpoint.host, endpoint.port, endpoint.expected_self_id, endpoint.principal, endpoint.token_env].join(' ').toLowerCase();
      if (!haystack.includes(term)) continue;
    }
    groups[endpoint.side === 'upstream' ? 'upstream' : 'downstream'].push(endpointCard(id, endpoint, flagsFor(id)));
  }
  for (const side of ['upstream', 'downstream']) {
    const children = groups[side].slice();
    if (allowEdit && newForms[side]) children.push(newEndpointForm(side));
    if (!children.length) {
      const empty = element('p', term ? '没有匹配的端点；清空搜索可看到全部。' : (side === 'upstream' ? '还没有上游端点，点右上角「新增上游」创建。' : '还没有下游端点，点右上角「新增下游」创建。'));
      empty.className = 'muted empty'; children.push(empty);
    }
    $(`endpoints-${side}`).replaceChildren(...children);
    $(`zone-count-${side}`).textContent = `${sideIds(side).length} 个`;
    $(`endpoint-count-${side}`).textContent = sideIds(side).length;
  }
  for (const id of Object.keys(pendingDelete)) {
    const endpoint = draftEndpoints()[id];
    if (endpoint) continue;
    const card = document.createElement('article'); card.className = 'endpoint-card pending-delete'; card.id = `endpoint-card-${id}`;
    const summary = document.createElement('div'); summary.className = 'endpoint-summary';
    summary.append(element('span', id), endpointFlag('已从草稿移除 · 当前实例仍在运行，重启后移除', 'removed'));
    const undo = element('button', '撤销'); undo.type = 'button'; undo.className = 'ghost';
    addListenerIf(undo, 'click', () => { pendingDelete.delete(id); renderConfig(); });
    summary.append(undo);
    card.append(summary); $(`endpoints-${pendingDelete.get(id).side === 'upstream' ? 'upstream' : 'downstream'}`).append(card);
  }
}
function policyChoices() { return (configDraft ? configDraft.policies : []).map(name => [name, name]); }
function newEndpointForm(side) {
  const form = document.createElement('div'); form.className = 'endpoint-form';
  form.append(element('h3', side === 'upstream' ? '新增上游端点' : '新增下游端点'));
  const hint = element('p', '每个端点在保存时必须被路由引用；可同时新建一条路由，也可稍后到路由页关联。'); hint.className = 'muted';
  form.append(hint);
  const rows = [];
  rows.push(fieldRow(`new-${side}`, 'id', draft.id, value => { draft.id = value; }, { label: '端点 ID', key: 'id', help: '必填且全局唯一：以字母开头，可含字母、数字、下划线或连字符，最长 64 字符。加入草稿后不再改动，避免破坏引用。' }));
  rows.push(fieldRow(`new-${side}`, 'connection', draft.connection, value => { draft.connection = value; if (value === 'connect') { draft.host = ''; draft.port = ''; } else { draft.url = ''; } renderConfig(); }, { choices: CONNECTION_CHOICES }));
  if (draft.connection === 'connect') rows.push(fieldRow(`new-${side}`, 'url', draft.url, value => { draft.url = value; }));
  else {
    rows.push(fieldRow(`new-${side}`, 'host', draft.host, value => { draft.host = value; }));
    rows.push(fieldRow(`new-${side}`, 'port', draft.port, value => { draft.port = value; }));
  }
  rows.push(fieldRow(`new-${side}`, 'token_env', draft.token_env, value => { draft.token_env = value; }));
  if (side === 'upstream') {
    rows.push(fieldRow(`new-${side}`, 'expected_self_id', draft.expected_self_id, value => { draft.expected_self_id = value; }));
    rows.push(fieldRow(`new-${side}`, 'reconnect', draft.reconnect, value => { draft.reconnect = value; }));
  } else {
    rows.push(fieldRow(`new-${side}`, 'principal', draft.principal, value => { draft.principal = value; }));
    rows.push(fieldRow(`new-${side}`, 'readonly', draft.readonly, value => { draft.readonly = value; }));
  }
  form.append(fieldGroup('连接与身份', rows));
  const linkRows = [];
  const routeId = `${side === 'upstream' ? 'route' : 'route'}`;
  linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.id, value => { draft.route.id = value; }, { label: '路由名称', key: 'id', help: '必填且全局唯一；用于把两端连起来。' }));
  if (side === 'upstream') {
    const free = sideIds('downstream').filter(id => !draftRoutes().some(route => route.downstream === id));
    linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.downstream, value => { draft.route.downstream = value; }, { label: '下游端点', key: 'downstream', choices: free.map(id => [id, id]), help: free.length ? '只能选择还没有被其它路由占用的下游。' : '当前没有可用的下游端点：请先新增一个下游，再和这条路由一起提交。' }));
  } else {
    linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.upstream, value => { draft.route.upstream = value; }, { label: '上游端点', key: 'upstream', choices: sideIds('upstream').map(id => [id, id]), help: '同一个上游可以被多条路由引用。' }));
  }
  const policies = policyChoices();
  linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.policy, value => { draft.route.policy = value; }, { label: '策略', key: 'policy', choices: policies, help: policies.length ? '策略来自已保存的配置。' : '当前没有可用策略，请先在高级 YAML 里配置策略。' }));
  form.append(fieldGroup('路由关联', linkRows));
  const actions = document.createElement('div'); actions.className = 'form-actions';
  const withRoute = element('button', '加入配置草稿（并新建路由）'); withRoute.type = 'button';
  addListenerIf(withRoute, 'click', () => { commitNewEndpoint(side, true); });
  const alone = element('button', '仅加入草稿，稍后关联'); alone.type = 'button'; alone.className = 'ghost';
  addListenerIf(alone, 'click', () => { commitNewEndpoint(side, false); });
  const cancel = element('button', '取消'); cancel.type = 'button'; cancel.className = 'ghost';
  addListenerIf(cancel, 'click', () => { delete newForms[side]; renderConfig(); });
  actions.append(withRoute, alone, cancel);
  form.append(actions);
  if (draftError) { const error = element('p', draftError); error.className = 'field-error'; form.append(error); }
  return form;
}
function idError(id) {
  if (!id) return '端点 ID 必填。';
  if (!/^[a-zA-Z][\w-]{0,63}$/.test(id)) return '端点 ID 必须以字母开头，只能包含字母、数字、下划线或连字符（最长 64 字符）。';
  if (draftEndpoints()[id]) return `端点 ID「${id}」已存在。`;
  return '';
}
function commitNewEndpoint(side, withRoute) {
  const id = String(draft.id ?? '').trim();
  const problem = idError(id);
  if (problem) { draftError = problem; renderConfig(); return; }
  const endpoint = { side, connection: draft.connection, protocol: 'onebot_v11', token_env: draft.token_env };
  if (draft.connection === 'connect') endpoint.url = draft.url; else { endpoint.host = draft.host; endpoint.port = Number(draft.port); }
  if (side === 'upstream') { endpoint.expected_self_id = draft.expected_self_id; if (draft.connection === 'connect') endpoint.reconnect = draft.reconnect; }
  else { endpoint.principal = draft.principal; endpoint.readonly = draft.readonly; }
  configDraft.endpoints[id] = endpoint;
  newEndpointIds.add(id); endpointOpen.add(id);
  if (withRoute) configDraft.routes.push({ id: draft.route.id, upstream: side === 'upstream' ? id : draft.route.upstream, downstream: side === 'downstream' ? id : draft.route.downstream, policy: draft.route.policy });
  delete newForms[side]; draftError = ''; touchDraft(); renderConfig();
}
function openDeletePanel(id) {
  const refs = routeRefs(id);
  pendingDelete.set(id, { side: draftEndpoints()[id].side, routes: refs.map(route => route.id) });
  renderConfig();
}
function stripMeta(endpoint) {
  const { id: _id, used: _used, ...definition } = endpoint; return definition;
}
function configPayload() {
  return {
    endpoints: Object.fromEntries(Object.entries(configDraft.endpoints)
      .filter(([id]) => !pendingDelete.has(id))
      .map(([id, endpoint]) => [id, stripMeta(endpoint)])),
    routes: configDraft.routes,
  };
}
function normalized(value) { return JSON.stringify(value); }
function changeSummary() {
  if (!savedConfig || !configDraft) return null;
  const before = Object.fromEntries(Object.entries(savedConfig.endpoints).map(([id, endpoint]) => [id, stripMeta(endpoint)]));
  const after = configPayload().endpoints;
  const added = Object.keys(after).filter(id => !before[id]);
  const removed = Object.keys(before).filter(id => !after[id]);
  const edited = Object.keys(after).filter(id => before[id] && normalized(before[id]) !== normalized(after[id]));
  const routes = normalized(savedConfig.routes) !== normalized(configDraft.routes) ? configDraft.routes.length : 0;
  const referenced = new Set(configDraft.routes.flatMap(route => [route.upstream, route.downstream]));
  const unlinked = Object.keys(after).filter(id => !referenced.has(id));
  return { added: added.length, removed: removed.length, edited: edited.length, routes, unlinked, addedIds: added, removedIds: removed };
}
function touchDraft() { renderDraftSummary(); }
function renderDraftSummary() {
  const node = $('config-draft'); if (!node) return;
  if (!configDraft) { node.textContent = configLoaded ? '配置读取失败，草稿不可用。' : '正在读取已保存配置…'; node.className = ''; return; }
  const summary = changeSummary();
  const parts = [];
  if (summary && (summary.added || summary.removed || summary.edited || summary.routes)) {
    parts.push(`未保存：新增 ${summary.added}、修改 ${summary.edited}、删除 ${summary.removed} 个端点，路由变更 ${summary.routes ? '有' : '无'}`);
  } else parts.push('无未保存修改');
  if (pendingRestart) parts.push('已有保存待重启（当前实例仍在用旧配置）');
  if (summary && summary.unlinked.length) parts.push(`未关联路由：${summary.unlinked.join('、')}（不能保存）`);
  parts.push('当前生效版本未核对');
  node.textContent = parts.join(' · ');
  node.className = (summary && (summary.added || summary.removed || summary.edited || summary.routes)) || pendingRestart ? 'dirty' : '';
}
function renderConfig() {
  if (!configDraft) return;
  renderEndpoints();
  routeEditor();
  $('route-runtime').hidden = true;
  for (const button of [$('endpoint-add-upstream'), $('endpoint-add-downstream')]) {
    button.hidden = !allowEdit; button.disabled = configBusy;
  }
  $('config-save').disabled = !allowEdit || configBusy || !configLoaded;
  $('config-restart').disabled = !allowEdit || configBusy || !configLoaded;
  renderDraftSummary();
}
function routeEditor() {
  const rows = configDraft.routes.map((route, index) => {
    const row = document.createElement('fieldset'); row.className = 'config-card config-fields'; row.disabled = !allowEdit || configBusy;
    configField(row, '路由 ID', route.id, value => { route.id = value; touchDraft(); });
    for (const key of ['upstream', 'downstream', 'policy']) {
      const names = key === 'policy' ? configDraft.policies : sideIds(key);
      configField(row, key, route[key], value => { route[key] = value; touchDraft(); }, names.map(id => [id, id]));
    }
    const remove = element('button', '删除路由'); remove.type = 'button';
    addListenerIf(remove, 'click', () => { configDraft.routes.splice(index, 1); touchDraft(); renderConfig(); }); row.append(remove); return row;
  });
  $('route-editor').replaceChildren(...rows);
  $('route-add').hidden = !allowEdit; $('route-add').disabled = configBusy;
}
async function loadConfig(epoch) {
  try {
    const response = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) throw new Error('端点与路由编辑需要登录会话；请配置登录凭据后登录。');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (epoch !== generation) return;
    configDraft = data;
    savedConfig = clone(data);
    configLoaded = true;
    newEndpointIds.clear(); pendingDelete.clear(); newForms.upstream = false; newForms.downstream = false;
    renderConfig();
    $('config-result').textContent = allowEdit
      ? '已读取已保存配置；端点与路由改动需重启网关。当前生效版本未核对。'
      : '只读模式：可以展开查看，不能修改。';
  } catch (error) {
    if (epoch !== generation) return;
    configLoaded = false;
    $('config-result').textContent = error.message;
    renderDraftSummary();
  }
}
$('route-add').addEventListener('click', () => {
  if (!configDraft || !allowEdit || configBusy) return;
  configDraft.routes.push({ id: '', upstream: sideIds('upstream')[0] ?? '', downstream: sideIds('downstream')[0] ?? '', policy: configDraft.policies[0] ?? '' });
  touchDraft(); renderConfig();
});
async function waitForRestart(startedAt) {
  generation++; clearTimeout(pollTimer); streamController?.abort();
  $('connection').textContent = '网关正在重启…';
  $('config-result').textContent = '配置已保存，已请求重启，正在等待新实例…';
  const deadline = Date.now() + 30000;
  while (restarting) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(3000) });
      // A stale session is rejected by the new process. Also detect a changed instance start time.
      if (response.status !== 401 && !(response.ok && (await response.json()).started_at !== startedAt)) continue;
      $('connection').textContent = response.status === 401 ? '会话已失效，请重新登录核对运行状态' : '网关已重启，请重新登录';
      $('config-result').textContent = $('connection').textContent;
      // Leave the notice on screen long enough to read before leaving the panel.
      await new Promise(resolve => setTimeout(resolve, 1800));
      location.replace('/'); return;
    } catch { /* Instance is still stopping or starting. */ }
    if (Date.now() > deadline) {
      $('connection').textContent = '网关仍未恢复';
      $('config-result').textContent = '仍未恢复服务：请检查进程管理器，或手动启动网关；本页会继续等待。';
    }
  }
}
async function saveConfig(restart) {
  if (!configDraft || !configLoaded || !allowEdit || configBusy) return;
  const summary = changeSummary();
  if (summary && summary.unlinked.length) {
    $('config-result').classList.add('failed');
    $('config-result').textContent = `有端点还没有关联路由，不能保存：${summary.unlinked.join('、')}`;
    return;
  }
  configBusy = true; renderConfig();
  $('config-result').classList.remove('failed'); $('config-result').textContent = '正在校验并保存…';
  try {
    const state = restart ? await api('/api/state') : null;
    const payload = configPayload();
    if (restart) restarting = true;
    let result;
    try { result = await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, restart }) }); }
    catch (error) { restarting = false; throw error; }
    savedConfig = clone(configDraft);
    newEndpointIds.clear(); pendingDelete.clear();
    if (restart) { pendingRestart = false; void waitForRestart(state.started_at); }
    else {
      pendingRestart = true;
      $('config-result').textContent = '已保存到配置文件；当前实例仍使用原配置，重启后生效。';
    }
  } catch (error) { $('config-result').textContent = error.message; $('config-result').classList.add('failed'); }
  finally { if (!restarting) { configBusy = false; renderConfig(); } }
}
$('config-save').addEventListener('click', () => { void saveConfig(false); });
$('config-restart').addEventListener('click', () => {
  const button = $('config-restart');
  if (button.dataset.confirm === 'yes') {
    button.dataset.confirm = 'no'; button.textContent = '保存并重启'; void saveConfig(true); return;
  }
  const summary = changeSummary();
  const changes = summary ? `将保存：新增 ${summary.added}、修改 ${summary.edited}、删除 ${summary.removed} 个端点，路由 ${configDraft.routes.length} 条。` : '';
  button.dataset.confirm = 'yes'; button.textContent = '确认：保存配置并重启网关';
  $('config-result').classList.remove('failed');
  $('config-result').textContent = `${changes}重启会中断当前的端点连接，并需要重新登录。再点一次确认。`;
});
addListenerIf($('endpoint-add-upstream'), 'click', () => {
  if (!configDraft || !allowEdit || configBusy) return;
  resetDraft('upstream'); newForms.upstream = true; newForms.downstream = false; renderConfig();
});
addListenerIf($('endpoint-add-downstream'), 'click', () => {
  if (!configDraft || !allowEdit || configBusy) return;
  resetDraft('downstream'); newForms.downstream = true; newForms.upstream = false; renderConfig();
});
addListenerIf($('endpoint-expand-all'), 'click', () => {
  for (const id of Object.keys(draftEndpoints())) endpointOpen.add(id);
  renderConfig();
});
addListenerIf($('endpoint-collapse-all'), 'click', () => { endpointOpen.clear(); renderConfig(); });
addListenerIf($('endpoint-search'), 'input', event => { endpointSearch = String(event?.target?.value ?? ''); renderEndpoints(); });
addListenerIf($('endpoint-jump-upstream'), 'click', () => { const target = $('endpoints-upstream-title'); if (target?.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
addListenerIf($('endpoint-jump-downstream'), 'click', () => { const target = $('endpoints-downstream-title'); if (target?.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
window.addEventListener('pagehide', () => { restarting = false; generation++; clearTimeout(pollTimer); streamController?.abort(); });
window.addEventListener('beforeunload', event => {
  const summary = configDraft ? changeSummary() : null;
  if (!summary || !(summary.added || summary.removed || summary.edited || summary.routes)) return;
  event.preventDefault(); event.returnValue = '有未保存的端点与路由改动，确定离开吗？';
});
function syncConfigBarHeight() {
  const bar = $('config-controls');
  if (!bar || typeof ResizeObserver !== 'function' || typeof document.documentElement?.style?.setProperty !== 'function') return;
  const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--config-bar', `${bar.offsetHeight}px`));
  observer.observe(bar);
}
syncConfigBarHeight();
const PAGES = ['overview', 'endpoints', 'routes', 'rules', 'logs', 'policies'];
function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'overview').toLowerCase();
  const page = PAGES.includes(name) ? name : 'overview';
  document.body.dataset.page = page;
  $('config-controls').hidden = !['endpoints', 'routes'].includes(page);
  const tools = $('endpoint-tools'); if (tools) tools.hidden = page !== 'endpoints';
  for (const link of document.querySelectorAll('nav a')) link.classList.toggle('active', link.dataset.page === page);
}
window.addEventListener('hashchange', route);
route();
connect();
