// 采集站控制台：编辑请求头、发起采集、查看正文/命中理由/上游请求，并控制源站。

const $ = (sel) => document.querySelector(sel);
const api = (p, opts) => fetch(p, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status}`);
  return data;
});
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (p, body) => api(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (p) => api(p, { method: 'DELETE' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 请求头编辑 ----------
function addHeaderRow(name = '', value = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="h-name" value="${esc(name)}" placeholder="如 Accept-Language" /></td>
    <td><input class="h-value" value="${esc(value)}" placeholder="值；留空表示发送空值" /></td>
    <td><button class="del">删除行（=头缺失）</button></td>`;
  tr.querySelector('.del').onclick = () => tr.remove();
  $('#header-rows').appendChild(tr);
}
function readHeaders() {
  // 数组形式：保留“存在但空值”；被删除的行即头缺失
  const list = [];
  for (const tr of $('#header-rows').querySelectorAll('tr')) {
    const name = tr.querySelector('.h-name').value.trim();
    if (!name) continue;
    list.push({ name, value: tr.querySelector('.h-value').value });
  }
  return list;
}
addHeaderRow('Accept-Language', 'zh-CN');
addHeaderRow('Accept', 'application/json');
$('#add-header').onclick = () => addHeaderRow();

// ---------- 采集 ----------
async function doCollect(headersOverride, force = false) {
  const headers = headersOverride || readHeaders();
  $('#spinner').classList.remove('hidden');
  try {
    const result = await post('/api/collect', { url: $('#url').value || '/data', headers, force });
    renderResult(result);
    await refresh();
    return result;
  } finally {
    $('#spinner').classList.add('hidden');
  }
}
$('#send').onclick = () => doCollect();

function decisionBadge(d) {
  const map = {
    'cache-hit-fresh': 'ok',
    'full-fetch-stored': 'info',
    'conditional-304-revalidated': 'ok',
    'full-after-304': 'warn',
    'unconditional-refetch': 'warn',
    'not-cacheable-vary-star': 'warn',
    'not-cacheable-no-max-age': 'warn',
    'stale-generation-or-late-rejected': 'bad',
    'upstream-error': 'bad',
  };
  return `<span class="badge ${map[d] || 'info'}">${esc(d)}</span>`;
}

function renderResult(r) {
  const upstream = r.upstream
    ? `<details><summary>真实上游请求 / 响应</summary>
         <p class="mono">→ ${esc(r.upstream.request.method)} ${esc(r.upstream.request.url)}</p>
         <pre>${esc(JSON.stringify(r.upstream.request.headers, null, 2))}</pre>
         <p class="mono">← 状态 ${esc(r.upstream.status)}（${esc(r.upstream.ms)}ms）</p>
         <pre>${esc(JSON.stringify(r.upstream.headers, null, 2))}</pre>
         ${r.upstream.body === null ? '<p class="mono">上游无正文（304）</p>' : `<pre>${esc(r.upstream.body)}</pre>`}
       </details>`
    : '<p class="mono">本次未发上游请求（缓存命中）</p>';
  $('#result').classList.remove('empty');
  $('#result').innerHTML = `
    <div class="kv">
      <b>判定</b><div>${decisionBadge(r.decision)} <span class="mono">${esc(r.reason || '')}</span></div>
      <b>状态 / 内容类型</b><div>${esc(r.status)} · ${esc(r.contentType || '')}</div>
      <b>ETag</b><div class="mono">${esc(r.etag || '-')}</div>
      <b>Vary</b><div class="mono">${esc(r.vary || '-')}</div>
      <b>Cache-Control</b><div class="mono">${esc(r.cacheControl || '-')}</div>
      <b>缓存键 / 代次 / 序号</b><div class="mono">${esc(r.cacheKey || '-')}<br>epoch=${esc(r.epoch)} seq=${esc(r.seq)} cached=${esc(r.cached)}</div>
    </div>
    <h4>实际正文</h4>
    <pre>${esc(r.body ?? '(空)')}</pre>
    ${upstream}`;
}

// ---------- 状态轮询 ----------
async function refresh() {
  const [cs, os] = await Promise.all([api('/api/state'), api(`${originBase()}/admin/state`)]);
  renderEntries(cs);
  renderFetches();
  renderEvents(cs);
  renderOrigin(os);
  renderRuleButtons(os);
}
function originBase() {
  return window.ORIGIN_BASE || 'http://127.0.0.1:5000';
}

function fmtExpiry(e) {
  if (e.expiresAt === null) return '无 max-age';
  const left = Math.round((e.expiresAt - Date.now()) / 1000);
  const cls = e.body == null ? 'missing' : left > 0 ? 'fresh' : 'stale';
  const label = e.body == null ? '正文已删除' : left > 0 ? `新鲜（剩 ${left}s）` : `已过期 ${-left}s`;
  return `<span class="${cls}">${label}</span><br><span class="mono">${new Date(e.expiresAt).toLocaleTimeString()}</span>`;
}

function renderEntries(cs) {
  $('#global-epoch').textContent = cs.globalEpoch;
  const rows = Object.values(cs.entries).map((e) => `
    <tr>
      <td class="mono">${esc(e.cacheKey)}</td>
      <td>${esc(e.epoch)}<br><span class="pill">seq ${esc(e.seq)}</span></td>
      <td class="mono">${esc(e.etag || '-')}</td>
      <td>${e.body == null ? '<span class="badge bad">正文缺失</span>' : `<pre style="margin:0;max-height:80px">${esc(e.body)}</pre>`}</td>
      <td>${fmtExpiry(e)}</td>
      <td class="mono">${esc(JSON.stringify(e.sourceRequestHeaders))}</td>
      <td>
        <button class="del" onclick="deleteEntry('${encodeURIComponent(e.cacheKey)}', true)">删除正文</button><br>
        <button class="del" onclick="deleteEntry('${encodeURIComponent(e.cacheKey)}', false)">删除整条</button>
      </td>
    </tr>`).join('');
  $('#entry-rows').innerHTML = rows || '<tr><td colspan="7" class="hint">暂无缓存表示</td></tr>';
}

window.deleteEntry = async (encKey, onlyBody) => {
  await del(`/api/entries/${encKey}${onlyBody ? '?only=body' : ''}`);
  refresh();
};

async function renderFetches() {
  const logs = await api('/api/fetches');
  $('#fetch-rows').innerHTML = logs.slice(0, 40).map((f) => `
    <tr>
      <td class="mono">${new Date(f.at).toLocaleTimeString()}</td>
      <td>${esc(f.mode)}</td>
      <td>${decisionBadge(f.decision)}</td>
      <td>${f.upstream ? `${esc(f.upstream.status)}<br><span class="mono">${esc(f.upstream.ms)}ms</span>` : '<span class="mono">未发请求</span>'}</td>
      <td class="mono">${esc(f.epochAtDispatch)} / ${f.seq ?? '-'}</td>
      <td><details><summary>${esc(f.reason || '')}</summary><pre>${esc(JSON.stringify({ key: f.finalKey, headers: f.requestHeaders, upstream: f.upstream }, null, 2))}</pre></details></td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">暂无流水</td></tr>';
}

function renderEvents(cs) {
  $('#event-rows').innerHTML = cs.events.map((e) => `
    <tr><td class="mono">${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.type)}</td>
    <td class="mono">${esc(e.reason || '')} ${esc(JSON.stringify(e.detail || {}))}</td></tr>`).join('')
    || '<tr><td colspan="3" class="hint">暂无事件</td></tr>';
}

function renderOrigin(os) {
  $('#origin-rows').innerHTML = os.requestLog.slice(0, 30).map((q) => `
    <tr>
      <td class="mono">${new Date(q.at).toLocaleTimeString()}</td>
      <td>${esc(q.ruleSetId)}</td>
      <td>${esc(q.matched.lang)} / ${esc(q.matched.mediaType)}<br>
        <span class="mono">AL:${q.matched.acceptLanguagePresent ? '有' : '缺'} AC:${q.matched.acceptPresent ? '有' : '缺'}</span></td>
      <td>${esc(q.status)}</td>
      <td class="mono">${esc(q.requestHeaders['if-none-match'] || '-')}</td>
      <td>${q.delayMs ? `<span class="badge warn">${esc(q.delayMs)}ms</span>` : '-'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">源站尚无请求</td></tr>';
}

function renderRuleButtons(os) {
  const box = $('#rule-buttons');
  if (box.dataset.current === os.ruleSetId) return;
  box.dataset.current = os.ruleSetId;
  box.innerHTML = Object.values(os.rules).map((r) => `
    <button data-rule="${esc(r.id)}" ${r.id === os.ruleSetId ? 'class="primary"' : ''}>
      ${esc(r.id)}：Vary ${esc(r.vary.includes('*') ? '*' : r.vary.join(', '))}（max-age=${esc(r.maxAge)}）
    </button>`).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => post(`${originBase()}/admin/switch-rule`, {
      ruleSetId: b.dataset.rule,
      silent: $('#silent-switch').checked,
    }).then(refresh);
  });
}

// ---------- 源站控制 ----------
$('#save-body').onclick = async () => {
  await put(`${originBase()}/admin/body`, {
    ruleSetId: $('#edit-rule').value,
    lang: $('#edit-lang').value,
    mediaType: $('#edit-type').value,
    content: $('#edit-content').value,
  });
  demoLog('源站正文已更新，ETag 版本 +1');
  refresh();
};
$('#add-delay').onclick = async () => {
  await post(`${originBase()}/admin/delay`, {
    lang: $('#delay-lang').value || null,
    mediaType: $('#delay-type').value || null,
    delayMs: Number($('#delay-ms').value),
  });
  demoLog('已给源站匹配的下一个请求加延迟');
  refresh();
};
$('#clear-delays').onclick = () => del(`${originBase()}/admin/delays`).then(refresh);

// ---------- 演示场景 ----------
const demoLogEl = $('#demo-log');
function demoLog(msg) {
  demoLogEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  demoLogEl.scrollTop = demoLogEl.scrollHeight;
}
const H = {
  zhJson: [{ name: 'Accept-Language', value: 'zh-CN' }, { name: 'Accept', value: 'application/json' }],
  enJson: [{ name: 'Accept-Language', value: 'en-US' }, { name: 'Accept', value: 'application/json' }],
  zhTxt: [{ name: 'Accept-Language', value: 'zh-CN' }, { name: 'Accept', value: 'text/plain' }],
};

const demos = {
  async first() {
    demoLog('首次采集 zh 与 en（同 URL，不同 Vary 维度 → 不同缓存键）');
    const r1 = await doCollect(H.zhJson);
    const r2 = await doCollect(H.enJson);
    demoLog(`zh 正文: ${r1.body}\nen 正文: ${r2.body}`);
    demoLog(`键不同：\n  ${r1.cacheKey}\n  ${r2.cacheKey}`);
    const r3 = await doCollect(H.zhJson);
    demoLog(`再次采 zh：${r3.decision}（源站不会收到这次请求）`);
  },
  async revalidate() {
    demoLog('把规则A max-age 调为 1 秒并清空缓存，便于观察过期校验');
    await put(`${originBase()}/admin/max-age`, { ruleSetId: 'A', maxAge: 1 });
    await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'A' });
    const st = await api('/api/state');
    for (const key of Object.keys(st.entries)) await del(`/api/entries/${encodeURIComponent(key)}`);
    await doCollect(H.zhJson);
    demoLog('等待过期后再采：应带 If-None-Match，源站 304，本地正文沿用');
    await sleep(1050);
    const r2 = await doCollect(H.zhJson);
    demoLog(`判定=${r2.decision}，正文仍为: ${r2.body}`);
    await put(`${originBase()}/admin/body`, {
      ruleSetId: 'A', lang: 'zh', mediaType: 'application/json',
      content: `{"message":"正文已被源站修改 ${Date.now()}","lang":"zh"}`,
    });
    demoLog('源站正文已改（ETag 变化），等待过期再采：条件请求拿到 200 新正文');
    await sleep(1050);
    const r3 = await doCollect(H.zhJson);
    demoLog(`判定=${r3.decision}，新正文: ${r3.body}`);
    await put(`${originBase()}/admin/max-age`, { ruleSetId: 'A', maxAge: 30 });
  },
  async 'switch-lang'() {
    const r1 = await doCollect(H.zhJson);
    const r2 = await doCollect(H.enJson);
    const r3 = await doCollect(H.zhJson);
    demoLog(`zh/en 各自独立保存，互不串用；第三次 zh 命中: ${r3.decision}`);
    demoLog('可在“源站真实入站请求记录”核对：只有前两次到达源站');
  },
  async 'delete-body'() {
    const r1 = await doCollect(H.zhJson);
    demoLog('删除该表示的本地正文（元数据与 ETag 保留）');
    await del(`/api/entries/${encodeURIComponent(r1.cacheKey)}?only=body`);
    await refresh();
    demoLog('再次采集：正文缺失 → 无条件重新获取，不返回空、不借用 en 的正文');
    const r2 = await doCollect(H.zhJson);
    demoLog(`判定=${r2.decision}，正文: ${r2.body}`);
  },
  async late() {
    await del(`${originBase()}/admin/delays`);
    await post(`${originBase()}/admin/delay`, { lang: 'zh', mediaType: 'application/json', delayMs: 4000 });
    demoLog('已让源站把下一个 zh/json 请求延迟 4 秒；先发起 R1，再发起 R2（强制采集确保请求到达源站）');
    const p1 = doCollect(H.zhJson, true).then((r) => { demoLog(`R1 晚返回：${r.decision}（seq=${r.seq}）${r.cached ? '' : ' → 被拒绝写回，正文仅随本次响应展示'}`); return r; });
    await sleep(400);
    const r2 = await doCollect(H.zhJson, true);
    demoLog(`R2 先确认：${r2.decision}（seq=${r2.seq}）`);
    const r1 = await p1;
    demoLog(`缓存中保留的是 R2 的结果；R1 真实响应见流水。R1 正文=${r1.body?.slice(0, 40)}…`);
  },
  async 'rule-switch'() {
    await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'A', silent: false });
    await doCollect(H.zhJson);
    demoLog('切换到规则B（Vary 集合变化），源站同步通知采集端 → 旧键立即失效');
    const r = await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'B', silent: false });
    demoLog(`通知已送达: ${r.notified}`);
    const r2 = await doCollect(H.zhJson);
    demoLog(`切换后首次采集: ${r2.decision}，新键 epoch=${r2.epoch}`);
  },
  async 'silent-switch'() {
    await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'A' });
    await doCollect(H.zhJson, true);
    demoLog('静默切换到规则B：源站不发通知');
    await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'B', silent: true });
    // 强制采集：无通知时不会凭空发现变化，必须真的发一次上游请求才能识别
    const r = await doCollect(H.zhJson, true);
    demoLog(`采集端从新响应识别 Vary 变化: ${r.decision}，事件中可见 vary-detected，旧键失效`);
  },
  async 'vary-star'() {
    await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'C' });
    const r1 = await doCollect(H.zhJson);
    const r2 = await doCollect(H.zhJson);
    demoLog(`Vary: * 两次都绕过缓存：${r1.decision} / ${r2.decision}，源站收到两次请求`);
    await post(`${originBase()}/admin/switch-rule`, { ruleSetId: 'A' });
  },
};

document.querySelectorAll('.demo-buttons button').forEach((b) => {
  b.onclick = async () => {
    b.disabled = true;
    try {
      demoLog(`—— 场景：${b.textContent} ——`);
      await demos[b.dataset.demo]();
      demoLog('—— 场景结束 ——\n');
    } catch (err) {
      demoLog(`演示出错: ${err.message}`);
    } finally {
      b.disabled = false;
      refresh();
    }
  };
});

refresh();
setInterval(refresh, 1000);
