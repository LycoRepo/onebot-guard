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
let rulesDirty = false;
let policyDirty = false;
let rulesLoaded = false;
let rulesBusy = false;
let rulesSaving = false;
let policyBusy = false;
let rulesRequest = 0;
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
    principal: ['下游身份', '用于区分下游应用的身份标识。'], readonly: ['下游只读模式', '开启后拦下发送消息请求。'],
    upstream: ['上游端点', ''], downstream: ['下游端点', ''], policy: ['策略', ''],
    '路由 ID': ['路由标识', '区分路由的唯一名称。'],
  },
  sources: {
    event: ['上游事件', ''], action: ['下游请求', ''], response: ['上游响应', ''],
    upstream: ['上游', ''], downstream: ['下游', ''],
  },
  queues: {
    application_queue: ['等待下游接收（条）', '网关不排队转发，此值固定为 0'],
    pending_requests: ['等待上游响应（个）', '已发给上游的请求，短暂大于 0 属正常'],
    identity_probes: ['正在验证的账号（个）', '连接建立后短暂增加，完成后归零'],
    dedupe_entries: ['消息去重记录（条）', '随消息量变化，过期后清理'],
    inbound_rate_entries: ['接收限流对象（个）', '正在跟踪的消息来源数，随流量变化'],
    outbound_rate_entries: ['发送限流对象（个）', '正在跟踪的发送目标数，随流量变化'],
  },
  rules: {
    'event.scope.allow': ['接收放行', '上游事件通过规则，已提交下游传输'],
    'event.scope.deny': ['接收范围被拦下', '事件匹配接收拦下规则'],
    'event.scope.default': ['接收范围未放行', '事件未匹配接收放行规则'],
    'event.self': ['自身消息被拦下', '消息由上游账号自身发送'],
    'event.bot': ['指定账号被拦下', '发送账号在拦下名单中'],
    'event.keyword': ['关键词命中', '消息文字含拦下关键词，整条拦下'],
    'event.regex': ['正则规则命中', '消息文字匹配拦下正则规则，整条拦下'],
    'event.segment': ['接收类型被拦下', '含拦下类型或无法检查类型的编码消息'],
    'event.duplicate': ['重复消息被拦下', '消息标识重复，未再次转发'],
    'event.rate': ['接收频率超限', '接收频率超过策略上限'],
    'event.identity': ['事件账号不符', '事件账号与上游绑定账号不一致'],
    'event.delivery': ['下游转发失败', '下游未就绪或发送受限'],
    'event.route': ['路由已关闭', '路由已停止转发'],
    'action.send': ['发送请求放行', '下游发送请求通过规则，已提交上游传输'],
    'action.read': ['查询请求放行', '下游查询请求通过规则，已提交上游传输'],
    'action.name.default': ['请求接口未放行', '请求接口未匹配策略放行规则'],
    'action.name.deny': ['请求接口被拦下', '请求接口匹配策略拦下规则'],
    'action.resource': ['发送目标未放行', '目标群或账号不在放行名单中'],
    'action.segment': ['发送类型被拦下', '请求包含未放行的消息类型'],
    'action.media': ['媒体内容被拦下', '媒体内容不符合策略要求'],
    'action.target': ['发送目标有误', '群号或账号参数缺失或冲突'],
    'action.params': ['请求参数有误', '参数不符合接口要求'],
    'action.readonly': ['下游只读限制', '下游只读模式开启，发送请求被拦下'],
    'action.unsupported': ['请求接口不支持', '网关不支持此请求接口'],
    'action.identity': ['请求身份未通过', '端点会话身份未通过验证'],
    'action.reference': ['引用消息被拦下', '无法确认被引用消息的可信归属'],
    'action.rate': ['发送频率超限', '发送频率超过策略上限'],
    'action.upstream': ['上游未就绪', '上游连接或身份尚未就绪'],
    'action.delivery': ['上游发送失败', '请求未能正常提交，实际结果需核对'],
    'action.pending': ['等待响应请求已满', '等待上游响应的请求数达到配置上限'],
    'action.route': ['路由已关闭', '路由已停止转发'],
    'response.correlated': ['响应转发放行', '上游响应已提交给发起请求的下游'],
    'response.delivery': ['响应转发失败', '下游已断开或响应发送受限'],
    'response.failure': ['请求未正常完成', '响应超时或请求因连接中断等原因终止'],
  },
  issues: {
    unverified_upstream_packet: ['验证前收到数据', '上游账号验证前的数据已拦下。频繁出现需检查'],
    ping_timeout: ['端点心跳超时', '端点未回应心跳，已断开会话'],
    account_probe_failed: ['上游账号验证失败', '上游账号响应无效或与配置不符'],
    account_probe_timeout: ['上游账号验证超时', '上游未在时限内响应账号验证'],
    dial_or_socket_error: ['端点连接出错', '建立连接或传输数据时出错'],
    listener_error: ['端点监听失败', '监听地址不可用或端口被占用'],
    invalid_json_packet: ['收到无效 JSON', '收到的数据无法解析为 JSON'],
    binary_packet_denied: ['二进制数据被拦下', '端点仅接收 JSON 文本，会话已断开'],
    outgoing_message_too_large: ['发送数据过大', '数据超过配置上限，会话已断开'],
    buffer_event_dropped: ['缓冲已满，拦下事件', '接收方处理较慢，发送缓冲达到上限'],
    buffer_connection_closed: ['缓冲已满，断开会话', '发送缓冲达到上限，按配置或数据类型断开'],
    send_error_result_unknown: ['数据发送出错', '实际结果未知，网关不会自动重发'],
    authorization_denied: ['端点凭据验证失败', '连接凭据未通过验证'],
    upstream_role_or_account_mismatch: ['上游身份不符', '连接声明的角色或账号与配置不符'],
    endpoint_session_limit: ['端点会话数已满', '每个端点同时仅允许一个会话'],
    unverified_upstream_response: ['收到未验证响应', '上游响应未通过账号验证检查'],
    upgrade_failed: ['连接握手失败', '无法建立 WebSocket 会话'],
  },
};
const word = (group, key) => (WORDS[group] && WORDS[group][key]) || null;
const human = (group, key, fallback) => { const w = word(group, key); return w ? (w[1] ? `${w[0]} · ${w[1]}` : w[0]) : (fallback ?? key); };

const SEGMENT_CHOICES = [['image', '图片'], ['record', '语音'], ['video', '视频'], ['file', '文件'], ['forward', '合并转发'], ['json', 'JSON 卡片'], ['xml', 'XML 卡片'], ['face', '表情']];
const SEND_TYPE_CHOICES = [['text', '文字'], ['at', '提及账号'], ['image', '图片'], ['face', '表情'], ['reply', '引用回复']];
const rulesText = new Map([['rules-groups', '接收群放行名单'], ['rules-users', '接收私聊放行名单'], ['rules-keywords', '拦下关键词'], ['rules-send-groups', '发送群放行名单'], ['rules-send-users', '发送私聊放行名单']]);
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
  const tag = span('tag', endpoint.connection === 'connect' ? '网关主动连接' : '等待端点连接');
  const meta = span('meta', ''); meta.id = `endpoint-state-${name}`;
  meta.append(
    pair('状态', `${connected(endpoint.connected)} · ${ready(endpoint.ready)}`, endpoint.ready ? 'ok' : ''),
    pair('待发送（字节，通常为 0）', `${endpoint.buffered_bytes} 字节`),
    pair('连续重连次数（就绪后归零）', endpoint.reconnect_attempts),
  );
  summary.append(who, tag, meta);
  const hint = element('p', '仅显示运行状态，配置暂不可用。'); hint.className = 'muted';
  row.append(summary, hint);
  return row;
}
function logRow(event) {
  const kind = String(event.event ?? '');
  const row = document.createElement('li');
  setAttributeIf(row, 'data-kind', kind);
  if (kind === 'denied') row.className = String(event.rule ?? '').startsWith('action.') ? 'rejected' : 'denied';
  else if (kind === 'allowed') row.className = 'allowed';
  const level = { denied: '拦下', allowed: '放行', session_open: '会话建立', session_close: '会话断开', transport_issue: '传输问题', reload: '策略加载' }[kind] ?? kind;
  const bucket = kind === 'denied' || kind === 'allowed' ? String(event.direction ?? '')
    : kind.startsWith('session') ? String(event.side ?? '') : '';
  const detail = kind === 'denied' || kind === 'allowed'
    ? `${human('rules', String(event.rule ?? ''))}${event.scope && event.scope !== 'private:unknown' ? ` · ${event.scope}` : ''}`
    : kind === 'transport_issue' ? human('issues', String(event.reason ?? ''))
    : kind === 'reload' ? `${event.ok ? '策略加载成功' : '策略加载失败'}${event.reason ? ` · ${event.reason}` : ''}`
    : `${event.endpoint ?? ''}${event.side ? ` · ${event.side === 'upstream' ? '上游' : '下游'}` : ''}`;
  row.append(span('tm', timeOf(event.time)), span('lv', level), span('rt', human('sources', bucket)), span('msg', `${event.route ? `${event.route} · ` : ''}${detail}`));
  return row;
}
function filterLogs() {
  const term = ($('log-search')?.value ?? '').trim().toLowerCase();
  const kind = $('log-filter')?.value || 'all';
  let visible = 0;
  for (const row of $('logs').children) {
    row.hidden = (kind !== 'all' && row.dataset?.kind !== kind) || !row.textContent.toLowerCase().includes(term);
    if (!row.hidden) visible++;
  }
  $('log-count').textContent = `${visible} / ${$('logs').children.length} 条记录${visible === 0 && (term || kind !== 'all') ? ' · 无匹配，可清空筛选' : ''}`;
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
function reload(result) { $('reload-status').textContent = result ? `${time(result.time)} · ${result.ok ? '策略加载成功' : '策略加载失败'} · ${result.reason}` : '尚无重新加载记录'; }
function render(state) {
  runtimeState = state;
  $('connection').className = 'pill good'; $('connection').textContent = '面板已连接';
  pairs($('overview'), [['网关状态', ready(state.healthy)], ['启动时间', time(state.started_at)], ['最近网关事件时间', time(state.last_event_at)], ['累计放行（次，非送达数）', state.totals.allowed], ['累计拦下（次）', state.totals.denied]]);
  $('overview').firstChild.lastChild.className = state.healthy ? 'ok' : 'warn';
  $('overview').firstChild.className = state.healthy ? 'is-ready' : 'is-waiting';
  const endpoints = Object.values(state.endpoints);
  for (const side of ['upstream', 'downstream']) {
    const group = endpoints.filter(e => e.side === side);
    $(`flow-${side}`).textContent = `${group.filter(e => e.ready).length} / ${group.length} 就绪 · ${group.filter(e => e.connected).length} 已连接`;
  }
  $('flow-policies').textContent = `${(state.policies ?? []).length} 份已加载策略`;
  const readyRoutes = state.routes.filter(r => r.ready).length;
  const allReady = state.routes.length > 0 && readyRoutes === state.routes.length;
  $('flow-status').className = `flow-status ${allReady ? 'ok' : 'warn'}`;
  $('flow-status').textContent = allReady ? `全部 ${readyRoutes} 条路由已就绪，可按策略转发消息。`
    : `${readyRoutes} / ${state.routes.length} 条路由已就绪。请到连接端点检查连接与账号验证，再核对路由关联。`;
  if ($('policy-summary')) pairs($('policy-summary'), [['已加载策略（份，至少 1）', (state.policies ?? []).length], ['编辑权限', state.allow_policy_edit ? '可编辑' : '只读模式'], ['策略加载状态', state.reload ? (state.reload.ok ? '策略加载成功' : '策略加载失败') : '尚无重新加载记录']]);
  if ($('session-summary')) pairs($('session-summary'), [['上游会话（已连接 / 总端点）', `${endpoints.filter(e => e.side === 'upstream' && e.connected).length} / ${endpoints.filter(e => e.side === 'upstream').length}`], ['下游会话（已连接 / 总端点）', `${endpoints.filter(e => e.side === 'downstream' && e.connected).length} / ${endpoints.filter(e => e.side === 'downstream').length}`], ['路由（已就绪 / 总数）', `${state.routes.filter(r => r.ready).length} / ${state.routes.length}`]]);
  $('routes').replaceChildren(...state.routes.map(route => {
    const cell = (text, cls) => { const td = element('td', text); if (cls) td.className = cls; return td; };
    const row = document.createElement('tr');
    row.append(cell(route.id, 'mono'), cell(ready(route.upstream_ready), route.upstream_ready ? 'ok' : 'warn'), cell(ready(route.downstream_ready), route.downstream_ready ? 'ok' : 'warn'), cell(ready(route.ready), route.ready ? 'ok' : 'warn'), cell(route.pending_requests));
    return row;
  }));
  if (!state.routes.length) {
    const row = document.createElement('tr'); const cell = element('td', '暂无运行路由，请核对配置。'); cell.colSpan = 5; cell.className = 'empty'; row.append(cell); $('routes').append(row);
  }
  if (!configDraft) {
    const sides = { upstream: [], downstream: [] };
    for (const [name, endpoint] of Object.entries(state.endpoints)) sides[endpoint.side === 'upstream' ? 'upstream' : 'downstream'].push([name, endpoint]);
    for (const [side, target] of [['upstream', 'endpoints-upstream'], ['downstream', 'endpoints-downstream']]) {
      const rows = sides[side].map(([name, endpoint]) => runtimeOnlyRow(name, endpoint));
      $(target).replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), { className: 'muted empty', textContent: '此方向暂无端点配置。' })]));
      const count = $(`endpoint-count-${side}`); if (count) count.textContent = sides[side].length;
      const zone = $(`zone-count-${side}`); if (zone) zone.textContent = `${sides[side].length} 个`;
    }
  } else {
    for (const id of Object.keys(draftEndpoints())) {
      const target = document.getElementById(`endpoint-state-${id}`); if (!target) continue;
      const live = state.endpoints[id];
      if (live) target.textContent = `当前会话：${connected(live.connected)} · ${ready(live.ready)}。待发送 ${live.buffered_bytes} 字节，通常为 0。连续重连 ${live.reconnect_attempts} 次，就绪后归零。`;
      else if (newEndpointIds.has(id)) target.textContent = '端点尚未运行，保存并重启后生效。';
      else target.textContent = '运行中的端点不存在，请核对重启状态。';
    }
  }
  pairs($('queues'), Object.entries(state.queues), 'queues');
  pairs($('rules'), Object.entries(state.hits_by_rule), 'rules'); pairs($('issues'), Object.entries(state.transport_issues), 'issues');
  if (!Object.keys(state.hits_by_rule).length) pairs($('rules'), [['启动以来暂无规则命中', '—']]);
  if (!Object.keys(state.transport_issues).length) pairs($('issues'), [['启动以来未记录传输问题', '—']]);
  const previousEdit = allowEdit;
  allowEdit = state.allow_policy_edit === true;
  updateRuleControls();
  if (configDraft && previousEdit !== allowEdit) renderConfig();
  logLimit = state.log_ring_size; reload(state.reload);
}
async function poll(epoch) {
  try { const state = await api('/api/state'); if (epoch !== generation) return; render(state); $('error').textContent = ''; }
  catch (error) { if (epoch !== generation) return; $('connection').className = 'pill bad'; $('connection').textContent = '面板连接中断'; $('error').textContent = `状态读取失败，将重试。原因：${error.message}`; }
  if (epoch === generation) pollTimer = setTimeout(() => poll(epoch), 3000);
}
async function loadPolicies(epoch) {
  try {
    const data = await api('/api/policies'); if (epoch !== generation) return;
    if (!policyDirty) $('policy-yaml').value = data.yaml;
    $('policy-yaml').readOnly = !data.allow_policy_edit;
    $('edit-controls').hidden = !data.allow_policy_edit;
    $('policy-result').textContent = data.allow_policy_edit ? '可编辑' : '只读模式';
    $('policy-result').classList.remove('failed');
    reload(data.reload);
  } catch (error) { if (epoch === generation) { $('policy-result').textContent = `策略读取失败，请刷新。原因：${error.message}`; $('policy-result').classList.add('failed'); } }
}
async function logs(signal) {
  while (!signal.aborted) {
    try {
      const response = await fetch('/api/logs', { credentials: 'same-origin', cache: 'no-store', signal });
      checkSession(response);
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      $('stream-status').textContent = '日志已连接，等待网关事件。';
      // A reconnect starts a fresh replay. Keep the DOM bounded without duplicating history.
      $('logs').replaceChildren();
      filterLogs();
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 1048576) throw new Error('单条日志超过大小上限');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            $('logs').append(logRow(event));
            while ($('logs').children.length > logLimit) $('logs').firstElementChild.remove();
          }
          filterLogs();
          if ($('follow').checked) $('logs').scrollTop = $('logs').scrollHeight;
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      if (!signal.aborted) $('stream-status').textContent = '日志已断开，将自动重连。';
    } catch (error) { if (signal.aborted) return; $('stream-status').textContent = `日志连接失败，将重连。原因：${error.message}`; }
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
  if (hasUnsavedChanges() && !window.confirm('还有未保存的修改，退出登录将丢失这些修改。确认退出？')) return;
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('退出登录失败，请重试');
    try { sessionStorage.removeItem('guard-write-token'); } catch { /* Already absent. */ }
    rulesDirty = false; policyDirty = false; configDraft = null; newForms.upstream = false; newForms.downstream = false;
    location.replace('/');
  } catch (error) { $('error').textContent = error.message; }
});
$('policy-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('edit-controls').hidden) return;
  if (rulesBusy || rulesSaving || policyBusy) return;
  if (pendingRestart) { $('policy-result').textContent = '端点或路由配置已保存但尚未生效，请先重启网关。'; return; }
  if (rulesDirty) { $('policy-result').textContent = '过滤规则有未保存的修改，请先保存或撤销，再编辑完整策略。'; return; }
  policyBusy = true; $('policy-yaml').readOnly = true; updateRuleControls();
  $('save').disabled = true; $('policy-result').textContent = '正在校验并保存…'; $('policy-result').classList.remove('failed');
  try {
    const result = await api('/api/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policies: $('policy-yaml').value }) });
    policyDirty = false;
    $('policy-result').textContent = `策略已保存。加载结果：${result.reload.reason}`; reload(result.reload);
    rulesPolicy = null;
    await loadRules(generation);
  } catch (error) { $('policy-result').textContent = error.message; $('policy-result').classList.add('failed'); }
  finally { policyBusy = false; $('save').disabled = false; $('policy-yaml').readOnly = !allowEdit; updateRuleControls(); }
});
function updateRuleControls() {
  const disabled = !allowEdit || !rulesLoaded || rulesBusy || rulesSaving || policyBusy;
  for (const input of document.querySelectorAll('#rules-form input, #rules-form textarea, #rules-form button')) input.disabled = disabled;
  $('rules-save').disabled = disabled || pendingRestart;
  $('save').disabled = policyBusy || rulesSaving || pendingRestart;
  $('rules-policy-select').disabled = !rulesLoaded || rulesBusy || rulesSaving || policyBusy;
  $('policy-discard').disabled = policyBusy || rulesSaving;
  setAttributeIf($('rules-form'), 'aria-busy', String(rulesBusy));
}
async function loadRules(epoch) {
  const request = ++rulesRequest;
  rulesBusy = true; updateRuleControls();
  try {
    const data = await api('/api/rules' + (rulesPolicy ? `?policy=${encodeURIComponent(rulesPolicy)}` : ''));
    if (epoch !== generation || request !== rulesRequest) return false;
    rulesPolicy = data.policy;
    rulesRegex = data.rules.receive.keywords_regex;
    const select = $('rules-policy-select');
    select.replaceChildren(...(data.policies ?? [data.policy]).map(name => { const option = element('option', name); option.value = name; return option; }));
    select.value = data.policy;
    if (configDraft && data.policies) { configDraft.policies = data.policies; if (savedConfig) savedConfig.policies = [...data.policies]; routeEditor(); }
    $('rules-policy').textContent = `策略「${data.policy}」` + (rulesRegex.length ? `。正则规则 ${rulesRegex.length} 条。请在策略 YAML 中编辑。` : '');
    $('rules-groups').value = data.rules.receive.group_ids.join('\n');
    $('rules-users').value = data.rules.receive.user_ids.join('\n');
    $('rules-keywords').value = data.rules.receive.keywords.join('\n');
    $('rules-send-groups').value = data.rules.send.group_ids.join('\n');
    $('rules-send-users').value = data.rules.send.user_ids.join('\n');
    checks('rules-blocked', SEGMENT_CHOICES, data.rules.receive.blocked_segments);
    checks('rules-send-types', SEND_TYPE_CHOICES, data.rules.send.segments);
    rulesLoaded = true; rulesDirty = false;
    $('rules-result').classList.remove('failed');
    $('rules-result').textContent = allowEdit ? '保存规则后立即重新加载策略。' : '规则已加载，当前仅可查看。';
    return true;
  } catch (error) {
    if (epoch === generation && request === rulesRequest) { $('rules-result').textContent = error.message; $('rules-result').classList.add('failed'); }
    return false;
  } finally { if (request === rulesRequest) { rulesBusy = false; updateRuleControls(); } }
}
$('rules-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!allowEdit) { $('rules-result').textContent = '请先在配置中开启策略编辑。'; return; }
  if (!rulesLoaded || rulesBusy || rulesSaving || policyBusy) return;
  if (pendingRestart) { $('rules-result').textContent = '端点或路由配置已保存但尚未生效，请先重启网关。'; return; }
  if (policyDirty) { $('rules-result').textContent = '策略 YAML 有未保存的修改，请先保存或撤销，避免覆盖。'; return; }
  rulesSaving = true; $('policy-yaml').readOnly = true; updateRuleControls();
  $('rules-save').disabled = true; $('rules-result').textContent = '正在校验并保存…'; $('rules-result').classList.remove('failed');
  try {
    const rules = {
      receive: { group_ids: lines('rules-groups'), user_ids: lines('rules-users'), keywords: lines('rules-keywords'), keywords_regex: rulesRegex, blocked_segments: checkedValues('rules-blocked') },
      send: { group_ids: lines('rules-send-groups'), user_ids: lines('rules-send-users'), segments: checkedValues('rules-send-types') },
    };
    const result = await api('/api/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: rulesPolicy, rules }) });
    rulesDirty = false;
    await loadRules(generation);
    await loadPolicies(generation);
    $('rules-result').textContent = result.reload && result.reload.ok ? '规则已保存，策略已生效。' : `规则已保存，策略加载失败。原因：${result.reload ? result.reload.reason : '未知'}`;
    $('rules-result').classList.toggle('failed', !(result.reload && result.reload.ok));
  } catch (error) { $('rules-result').textContent = error.message; $('rules-result').classList.add('failed'); }
  finally { rulesSaving = false; $('policy-yaml').readOnly = !allowEdit; updateRuleControls(); }
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
  input.addEventListener(choices || type === 'checkbox' ? 'change' : 'input', () => change(type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value));
  wrap.append(input); parent.append(wrap); return wrap;
}
// ── 端点页：草稿模型、行式字段、增删端点 ──
const FIELD_LABELS = {
  connection: ['连接方式', 'connection'], url: ['连接地址', 'url'], host: ['监听地址', 'host'],
  port: ['监听端口', 'port'], token_env: ['凭据环境变量', 'token_env'], expected_self_id: ['上游账号', 'expected_self_id'],
  principal: ['下游身份', 'principal'], readonly: ['下游只读模式', 'readonly'], reconnect: ['自动重连', 'reconnect'],
};
const FIELD_HELP = {
  url: '填写 ws:// 或 wss:// 地址。不可含用户信息、查询参数或片段。',
  host: '填写网关用于接收端点连接的本机地址。',
  port: '填写 0–65535 的整数。填 0 由系统自动分配。',
  token_env: '填写环境变量名，不要填写凭据值。需预先设置变量；保存时仅校验名称。',
  expected_self_id: '填写上游账号；与上游上报账号不符时断开。',
  principal: '填写下游身份标识，不会自动使用上游账号。',
  readonly: '开启后拦下下游发送请求。面板编辑权限单独控制。',
  reconnect: '断开后自动尝试重新连接。',
};
const CONNECTION_CHOICES = [['connect', '网关主动连接'], ['listen', '等待端点连接']];
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
    input.value = value ?? ''; input.disabled = !editable;
    const commit = () => onChange(input.value);
    addListenerIf(input, 'input', commit); addListenerIf(input, 'change', commit);
    control.append(input);
  } else {
    const input = document.createElement('input'); input.id = controlId;
    input.type = key === 'port' ? 'number' : 'text';
    input.value = value ?? ''; input.disabled = !editable;
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
  if (endpoint.connection === 'connect') return `网关主动连接 · ${endpoint.url ?? ''}`;
  return `等待端点连接 · ${endpoint.host ?? ''}:${endpoint.port ?? ''}`;
}
function actionsRow(id) {
  const actions = document.createElement('div'); actions.className = 'endpoint-actions';
  const toggle = element('button', endpointOpen.has(id) ? '收起配置' : '展开配置');
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
      const remove = element('button', '删除端点'); remove.type = 'button'; remove.className = 'ghost danger'; remove.disabled = configBusy;
      addListenerIf(remove, 'click', () => { openDeletePanel(id); });
      actions.append(remove);
    }
  }
  return actions;
}
function endpointLines(id, endpoint, flags) {
  const lines = document.createElement('div'); lines.className = 'endpoint-lines';
  const runtime = element('p', '正在读取端点运行状态…'); runtime.className = 'muted'; runtime.id = `endpoint-state-${id}`;
  const live = runtimeState?.endpoints[id];
  if (live) runtime.textContent = `当前会话：${connected(live.connected)} · ${ready(live.ready)}。待发送 ${live.buffered_bytes} 字节，通常为 0。连续重连 ${live.reconnect_attempts} 次，就绪后归零。`;
  lines.append(runtime);
  lines.append(endpointLine(flags.new ? '草稿配置（未保存）' : '草稿配置', connectionSummary(endpoint)));
  const refs = routeRefs(id);
  const names = refs.map(route => `${route.id || '(未命名路由)'}：${route.upstream} → ${route.downstream} · ${route.policy}`);
  lines.append(endpointLine('草稿关联路由', names.length ? names.join('；') : '端点未关联路由，暂不能保存'));
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
    const note = element('p', '等待连接时，由上游负责断线重连。'); note.className = 'field-help';
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
    list.append(element('li', `关联路由 ${refs.length} 条：${refs.map(route => route.id || '(未命名路由)').join('、')}`));
    const others = refs.map(route => (route.upstream === id ? route.downstream : route.upstream)).filter(other => other && other !== id);
    if (others.length) list.append(element('li', `关联路由的另一端点：${[...new Set(others)].join('、')}`));
    list.append(element('li', '请删除关联路由，或改为引用其他端点。引用不存在的端点将无法保存。'));
    if (configDraft.routes.length === refs.length) list.append(element('li', '至少需保留一条路由。请先添加替代路由。'));
  } else {
    list.append(element('li', '此端点暂无关联路由。'));
  }
  wrap.append(list);
  const actions = document.createElement('div'); actions.className = 'form-actions';
  if (refs.length) {
    const alsoRoutes = element('button', `删除关联路由（${refs.length} 条）`); alsoRoutes.type = 'button';
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
    wrap.append(element('p', '端点未关联路由，暂不能保存。请前往路由页添加关联路由。'));
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
      const empty = element('p', term ? '无匹配端点，请清空搜索重试。' : (side === 'upstream' ? '暂无上游端点配置。' : '暂无下游端点配置。'));
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
    summary.append(element('span', id), endpointFlag('已从草稿移除，保存并重启后生效。', 'removed'));
    const undo = element('button', '撤销删除'); undo.type = 'button'; undo.className = 'ghost';
    addListenerIf(undo, 'click', () => { pendingDelete.delete(id); renderConfig(); });
    summary.append(undo);
    card.append(summary); $(`endpoints-${pendingDelete.get(id).side === 'upstream' ? 'upstream' : 'downstream'}`).append(card);
  }
}
function policyChoices() { return (configDraft ? configDraft.policies : []).map(name => [name, name]); }
function newEndpointForm(side) {
  const form = document.createElement('div'); form.className = 'endpoint-form';
  form.append(element('h3', side === 'upstream' ? '新增上游端点' : '新增下游端点'));
  const hint = element('p', '保存前每个端点须关联路由。可同时新建路由，或稍后到路由页关联。'); hint.className = 'muted';
  form.append(hint);
  const rows = [];
  rows.push(fieldRow(`new-${side}`, 'id', draft.id, value => { draft.id = value; }, { label: '端点标识', key: 'id', help: '必填且唯一，最长 64 字符。以字母开头。可含字母、数字、下划线或连字符。加入草稿后不可修改。' }));
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
  linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.id, value => { draft.route.id = value; }, { label: '路由标识', key: 'id', help: '填写唯一的路由标识，关联上游与下游。' }));
  if (side === 'upstream') {
    const free = sideIds('downstream').filter(id => !draftRoutes().some(route => route.downstream === id));
    linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.downstream, value => { draft.route.downstream = value; }, { label: '下游端点', key: 'downstream', choices: free.map(id => [id, id]), help: free.length ? '每个下游只能关联一条路由。' : '暂无可用下游，请先添加下游端点。' }));
  } else {
    linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.upstream, value => { draft.route.upstream = value; }, { label: '上游端点', key: 'upstream', choices: sideIds('upstream').map(id => [id, id]), help: '同一个上游可以被多条路由引用。' }));
  }
  const policies = policyChoices();
  linkRows.push(fieldRow(`new-${side}`, 'route', draft.route.policy, value => { draft.route.policy = value; }, { label: '策略', key: 'policy', choices: policies, help: policies.length ? '策略来自已保存的配置。' : '暂无策略，请先在策略 YAML 中添加。' }));
  form.append(fieldGroup('路由关联', linkRows));
  const actions = document.createElement('div'); actions.className = 'form-actions';
  const withRoute = element('button', '将端点与新路由加入草稿'); withRoute.type = 'button';
  addListenerIf(withRoute, 'click', () => { commitNewEndpoint(side, true); });
  const alone = element('button', '将端点加入草稿'); alone.type = 'button'; alone.className = 'ghost';
  addListenerIf(alone, 'click', () => { commitNewEndpoint(side, false); });
  const cancel = element('button', '取消新增'); cancel.type = 'button'; cancel.className = 'ghost';
  addListenerIf(cancel, 'click', () => { delete newForms[side]; renderConfig(); });
  actions.append(withRoute, alone, cancel);
  form.append(actions);
  if (draftError) { const error = element('p', draftError); error.className = 'field-error'; form.append(error); }
  return form;
}
function idError(id) {
  if (!id) return '请填写端点标识。';
  if (!/^[a-zA-Z][\w-]{0,63}$/.test(id)) return '端点标识格式有误，请参照说明。';
  if (draftEndpoints()[id]) return `端点标识已存在：${id}`;
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
  const routes = normalized(savedConfig.routes) !== normalized(configDraft.routes);
  const referenced = new Set(configDraft.routes.flatMap(route => [route.upstream, route.downstream]));
  const unlinked = Object.keys(after).filter(id => !referenced.has(id));
  return { added: added.length, removed: removed.length, edited: edited.length, routes, unlinked, addedIds: added, removedIds: removed };
}
function touchDraft() {
  const button = $('config-restart');
  if (button.dataset) button.dataset.confirm = 'no';
  button.textContent = '保存并重启';
  renderDraftSummary();
}
function configIsDirty() {
  const summary = changeSummary();
  return Boolean(summary && (summary.added || summary.removed || summary.edited || summary.routes));
}
function hasUnsavedChanges() { return configIsDirty() || rulesDirty || policyDirty || newForms.upstream || newForms.downstream; }
function discardConfig() {
  if (!savedConfig || configBusy) return;
  configDraft = clone(savedConfig);
  newEndpointIds.clear(); pendingDelete.clear(); endpointOpen.clear();
  newForms.upstream = false; newForms.downstream = false;
  touchDraft(); renderConfig();
  $('config-result').classList.remove('failed');
  $('config-result').textContent = '已恢复到最近保存的配置。';
}
function renderDraftSummary() {
  $('restart-warning').hidden = !pendingRestart;
  updateRuleControls();
  const node = $('config-draft'); if (!node) return;
  if (!configDraft) { node.textContent = configLoaded ? '配置读取失败，草稿暂不可用。' : '正在读取已保存配置…'; node.className = ''; return; }
  const summary = changeSummary();
  const parts = [];
  if (summary && (summary.added || summary.removed || summary.edited || summary.routes)) {
    parts.push(`草稿新增端点 ${summary.added} 个。修改端点 ${summary.edited} 个。删除端点 ${summary.removed} 个。路由改动：${summary.routes ? '有' : '无'}。`);
  } else parts.push('草稿与已保存配置一致');
  if (pendingRestart) parts.push('配置已保存，仍在使用原配置，待重启。');
  if (summary && summary.unlinked.length) parts.push(`端点未关联路由，无法保存：${summary.unlinked.join('、')}`);
  if (!pendingRestart) parts.push('运行状态见概览；保存状态不代表连接就绪');
  node.textContent = parts.join(' · ');
  node.className = (summary && (summary.added || summary.removed || summary.edited || summary.routes)) || pendingRestart ? 'dirty' : '';
  $('config-discard').disabled = configBusy || !(configIsDirty() || newForms.upstream || newForms.downstream);
}
function renderConfig() {
  if (!configDraft) return;
  const restartButton = $('config-restart');
  if (restartButton.dataset) restartButton.dataset.confirm = 'no';
  restartButton.textContent = '保存并重启';
  renderEndpoints();
  routeEditor();
  $('route-runtime').hidden = false;
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
    row.append(element('legend', `路由 ${index + 1}${route.id ? ` · ${route.id}` : ' · 待填写'}`));
    configField(row, '路由 ID', route.id, value => { route.id = value; touchDraft(); });
    for (const key of ['upstream', 'downstream', 'policy']) {
      const names = key === 'policy' ? configDraft.policies : sideIds(key);
      configField(row, key, route[key], value => { route[key] = value; touchDraft(); }, names.map(id => [id, id]));
    }
    const remove = element('button', '删除路由'); remove.type = 'button'; remove.className = 'ghost danger';
    addListenerIf(remove, 'click', () => { configDraft.routes.splice(index, 1); touchDraft(); renderConfig(); }); row.append(remove); return row;
  });
  $('route-editor').replaceChildren(...rows);
  if (!rows.length) { const empty = element('p', '暂无路由，请添加路由。'); empty.className = 'empty'; $('route-editor').append(empty); }
  $('route-add').hidden = !allowEdit; $('route-add').disabled = configBusy;
}
async function loadConfig(epoch) {
  try {
    const response = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) throw new Error('请设置登录凭据并登录后编辑。');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (epoch !== generation) return;
    configDraft = data;
    savedConfig = clone(data);
    pendingRestart = data.restart_required === true;
    configLoaded = true;
    newEndpointIds.clear(); pendingDelete.clear(); newForms.upstream = false; newForms.downstream = false;
    renderConfig();
    $('config-result').textContent = allowEdit
      ? '已读取配置。改动需重启后生效。'
      : '当前仅可展开查看配置。';
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
  $('config-result').textContent = '配置已保存，正在等待网关重启…';
  const deadline = Date.now() + 30000;
  while (restarting) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(3000) });
      // A stale session is rejected by the new process. Also detect a changed instance start time.
      if (response.status !== 401 && !(response.ok && (await response.json()).started_at !== startedAt)) continue;
      $('connection').textContent = response.status === 401 ? '登录会话已失效，请重新登录。' : '网关已重启，请重新登录';
      $('config-result').textContent = $('connection').textContent;
      // Leave the notice on screen long enough to read before leaving the panel.
      await new Promise(resolve => setTimeout(resolve, 1800));
      location.replace('/'); return;
    } catch { /* Instance is still stopping or starting. */ }
    if (Date.now() > deadline) {
      $('connection').textContent = '网关仍未恢复';
      $('config-result').textContent = '网关尚未恢复，将继续等待。请检查网关进程或手动启动。';
    }
  }
}
async function saveConfig(restart) {
  if (!configDraft || !configLoaded || !allowEdit || configBusy) return;
  if (restart && (rulesDirty || policyDirty || rulesSaving || policyBusy)) { $('config-result').textContent = '请先保存或撤销规则与 YAML 的修改，再重启网关。'; return; }
  const summary = changeSummary();
  if (summary && summary.unlinked.length) {
    $('config-result').classList.add('failed');
    $('config-result').textContent = `端点未关联路由，无法保存：${summary.unlinked.join('、')}`;
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
    configDraft = { ...configDraft, ...payload };
    savedConfig = clone(configDraft);
    newEndpointIds.clear(); pendingDelete.clear();
    if (restart) { pendingRestart = false; void waitForRestart(state.started_at); }
    else {
      pendingRestart = true;
      $('config-result').textContent = '配置已保存，重启网关后生效。';
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
  const changes = summary ? `将保存：新增端点 ${summary.added} 个。修改端点 ${summary.edited} 个。删除端点 ${summary.removed} 个。保存后共 ${configDraft.routes.length} 条路由。` : '';
  button.dataset.confirm = 'yes'; button.textContent = '确认保存并重启';
  $('config-result').classList.remove('failed');
  $('config-result').textContent = `${changes}重启将断开端点会话。之后需重新登录。请再次点击确认。`;
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
  if (!hasUnsavedChanges() || restarting) return;
  event.preventDefault(); event.returnValue = '草稿尚未保存，确认离开？';
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
  $('page-name').textContent = { overview: '概览', endpoints: '连接端点', routes: '消息路由', rules: '过滤规则', logs: '实时日志', policies: '策略 YAML' }[page];
  $('config-controls').hidden = !['endpoints', 'routes'].includes(page);
  // Keep every page title in the same position, with the shared draft bar below it.
  const heading = document.querySelector?.(`${page === 'endpoints' ? '#endpoints' : '#page-' + page} > .phead`);
  if (['endpoints', 'routes'].includes(page)) heading?.after?.($('config-controls'));
  const tools = $('endpoint-tools'); if (tools) tools.hidden = page !== 'endpoints';
  for (const link of document.querySelectorAll('nav a')) {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
    setAttributeIf(link, 'aria-current', active ? 'page' : 'false');
  }
}
window.addEventListener('hashchange', route);
addListenerIf($('config-discard'), 'click', () => {
  if (configBusy || !window.confirm('撤销端点和路由的未保存修改，恢复最近保存的配置？')) return;
  discardConfig();
});
addListenerIf($('rules-form'), 'input', () => { rulesDirty = true; $('rules-result').textContent = '有未保存的规则修改'; });
addListenerIf($('policy-yaml'), 'input', () => { policyDirty = true; $('policy-result').textContent = '有未保存的 YAML 修改'; });
addListenerIf($('rules-policy-select'), 'change', async () => {
  const select = $('rules-policy-select'); const previous = rulesPolicy;
  if (rulesBusy || rulesSaving || policyBusy || (rulesDirty && !window.confirm('切换策略将丢弃当前未保存的规则修改，是否继续？'))) { select.value = previous; return; }
  rulesPolicy = select.value;
  if (!await loadRules(generation)) { rulesPolicy = previous; select.value = previous; }
});
addListenerIf($('log-search'), 'input', filterLogs);
addListenerIf($('log-filter'), 'change', filterLogs);
addListenerIf($('rules-discard'), 'click', async () => {
  if (rulesBusy || rulesSaving || policyBusy || (rulesDirty && !window.confirm('撤销未保存的规则修改？'))) return;
  await loadRules(generation);
});
addListenerIf($('policy-discard'), 'click', async () => {
  if (policyBusy || rulesSaving || (policyDirty && !window.confirm('撤销未保存的 YAML 修改？'))) return;
  const wasDirty = policyDirty;
  policyBusy = true; policyDirty = false; $('policy-yaml').readOnly = true; updateRuleControls();
  try { await loadPolicies(generation); if ($('policy-result').classList.contains('failed')) policyDirty = wasDirty; }
  finally { policyBusy = false; $('policy-yaml').readOnly = !allowEdit; updateRuleControls(); }
});
route();
connect();
