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
  $('connection').textContent = '面板已连接';
  pairs($('overview'), [['网关健康', state.healthy ? '健康' : '等待端点就绪'], ['启动时间', time(state.started_at)], ['最后事件', time(state.last_event_at)], ['允许', state.totals.allowed], ['拒绝', state.totals.denied]]);
  $('endpoints').replaceChildren(...Object.entries(state.endpoints).map(([name, endpoint]) => {
    const card = document.createElement('article'); const details = document.createElement('dl');
    pairs(details, [['角色', endpoint.side], ['连接方式', `${endpoint.connection} · ${endpoint.onebot}`], ['已连接 / 就绪', `${yes(endpoint.connected)} / ${yes(endpoint.ready)}`], ['缓冲字节', endpoint.buffered_bytes], ['重连次数', endpoint.reconnect_attempts]]);
    card.append(element('h3', name), details); return card;
  }));
  $('routes').replaceChildren(...state.routes.map(route => {
    const row = document.createElement('tr'); row.append(...[route.id, yes(route.upstream_ready), yes(route.downstream_ready), yes(route.ready), route.pending_requests].map(value => element('td', value))); return row;
  }));
  pairs($('queues'), Object.entries(state.queues));
  pairs($('rules'), Object.entries(state.hits_by_rule)); pairs($('issues'), Object.entries(state.transport_issues));
  if (!Object.keys(state.hits_by_rule).length) pairs($('rules'), [['尚无规则命中', '—']]);
  if (!Object.keys(state.transport_issues).length) pairs($('issues'), [['尚无传输问题', '—']]);
  logLimit = state.log_ring_size; reload(state.reload);
}
async function poll(epoch) {
  try { const state = await api('/api/state'); if (epoch !== generation) return; render(state); $('error').textContent = ''; }
  catch (error) { if (epoch !== generation) return; $('connection').textContent = '面板连接中断'; $('error').textContent = error.message; }
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
            $('logs').append(element('li', JSON.stringify(event)));
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
connect();
