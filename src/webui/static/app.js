'use strict';
const $ = id => document.getElementById(id);
let writeToken = '';
try { sessionStorage.removeItem('guard-read-token'); writeToken = sessionStorage.getItem('guard-write-token') || ''; } catch { /* Session storage may be disabled. */ }
let streamController;
let pollTimer;
let logLimit = 200;
let generation = 0;
const yes = value => value ? '是' : '否';
const time = value => value ? new Date(value).toLocaleString() : '暂无';
function element(tag, text) { const node = document.createElement(tag); node.textContent = String(text); return node; }
function pairs(target, entries) {
  target.replaceChildren(...entries.map(([key, value]) => {
    const row = document.createElement('div'); row.append(element('dt', key), element('dd', value)); return row;
  }));
}
function span(cls, text) { const node = document.createElement('span'); node.className = cls; node.textContent = String(text ?? ''); return node; }
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
  const level = { denied: 'denied', allowed: 'allow', session_open: '连接', session_close: '断开', transport_issue: '传输', reload: '重载' }[kind] ?? kind;
  const bucket = kind === 'denied' || kind === 'allowed' ? String(event.direction ?? '')
    : kind.startsWith('session') ? String(event.side ?? '') : '';
  const detail = kind === 'denied' ? `${event.route ?? ''} · ${event.rule ?? ''} · ${event.reason ?? ''}${event.scope ? ` · ${event.scope}` : ''}`
    : kind === 'allowed' ? `${event.route ?? ''} · ${event.rule ?? ''}${event.scope ? ` · ${event.scope}` : ''}`
    : kind === 'transport_issue' ? `${event.endpoint ?? ''} · ${event.reason ?? ''}`
    : kind === 'reload' ? `${event.ok ? '成功' : '失败'} · ${event.reason ?? ''}`
    : `${event.endpoint ?? ''} · ${event.generation ? String(event.generation).slice(0, 8) : ''}`;
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
  pairs($('queues'), Object.entries(state.queues));
  pairs($('rules'), Object.entries(state.hits_by_rule)); pairs($('issues'), Object.entries(state.transport_issues));
  if (!Object.keys(state.hits_by_rule).length) pairs($('rules'), [['尚无规则命中', '—']]);
  if (!Object.keys(state.transport_issues).length) pairs($('issues'), [['尚无传输问题', '—']]);
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
  streamController = new AbortController(); void poll(generation); void loadPolicies(generation); void logs(streamController.signal);
}
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('登出失败，请重试');
    writeToken = ''; $('write-token').value = '';
    try { sessionStorage.removeItem('guard-write-token'); } catch { /* Already absent. */ }
    location.replace('/');
  } catch (error) { $('error').textContent = error.message; }
});
$('policy-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('edit-controls').hidden) return;
  $('save').disabled = true; $('policy-result').textContent = '正在校验并保存…'; $('policy-result').classList.remove('failed');
  if ($('write-token').value) writeToken = $('write-token').value;
  const token = writeToken; $('write-token').value = '';
  try { sessionStorage.setItem('guard-write-token', token); } catch { /* Keep in memory only. */ }
  try {
    const result = await api('/api/policies', { method: 'PUT', headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ policies: $('policy-yaml').value }) });
    $('policy-result').textContent = `保存成功 · ${result.reload.reason}`; reload(result.reload);
  } catch (error) { $('policy-result').textContent = error.message; $('policy-result').classList.add('failed'); }
  finally { $('save').disabled = false; }
});
window.addEventListener('pagehide', () => { generation++; clearTimeout(pollTimer); streamController?.abort(); });
const PAGES = ['overview', 'endpoints', 'routes', 'logs', 'policies'];
function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'overview').toLowerCase();
  const page = PAGES.includes(name) ? name : 'overview';
  document.body.dataset.page = page;
  for (const link of document.querySelectorAll('nav a')) link.classList.toggle('active', link.dataset.page === page);
}
window.addEventListener('hashchange', route);
route();
connect();
