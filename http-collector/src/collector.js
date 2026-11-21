// 采集站（collector）：
// 缓存键 = URL + Vary 指定请求头的取值（头缺失与空值区分，头名大小写不敏感），
// 绝不只拿 URL 当键。每个表示分别保存：正文、ETag、来源请求头、有效期。
//
// 代次控制（只表达“本地发起的先后”，不判断源站内容业务新旧）：
//   1. epoch：源站规则切换（通知或从响应识别到 Vary 变化）使该 URL 的 epoch +1，
//      旧键立即失效；切换前已在途的请求返回时 epoch 对不上，拒绝写回缓存。
//   2. seq：同一缓存键内按本地发起顺序递增；晚返回的旧响应序号更小，
//      若该键已有更新的确认结果，则拒绝覆盖。不同语言/媒体类型是不同键，各自保存。
//
// 本题范围：仅 GET、ETag、Vary、明确 max-age。Vary: * 不进入可复用缓存。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  applyCors,
  buildCacheKey,
  getHeaderCI,
  nowIso,
  parseMaxAge,
  parseVary,
  readJsonBody,
  sameVarySet,
  sendJson,
} from '../lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.COLLECTOR_PORT || 4000);
const ORIGIN_URL = process.env.ORIGIN_URL || 'http://127.0.0.1:5000';
const UPSTREAM_TIMEOUT_MS = 30000;

const state = {
  originBase: ORIGIN_URL,
  globalEpoch: 0,
  // url -> { epoch, lastVary, epochReason, updatedAt }
  urlStates: {},
  // cacheKey -> 表示条目
  entries: {},
  // 每个键的“本地发起序号”与“已确认发布序号”
  dispatchSeq: {},
  confirmedSeq: {},
  // 全部采集流水（含被拒绝写回的请求），保留真实请求与响应
  fetchLog: [],
  // 代次/失效事件
  events: [],
  startupAt: nowIso(),
};

function pushEvent(event) {
  state.events.unshift({ id: randomUUID(), at: nowIso(), ...event });
  if (state.events.length > 100) state.events.length = 100;
}

function pushFetchLog(entry) {
  state.fetchLog.unshift(entry);
  if (state.fetchLog.length > 200) state.fetchLog.length = 200;
}

function touchUrl(url) {
  let s = state.urlStates[url];
  if (!s) {
    s = state.urlStates[url] = {
      url,
      epoch: state.globalEpoch,
      lastVary: null,
      // 通知抬代次后置 true：新代次的首个响应只是“确认新 schema”，不再重复抬升
      schemaPending: false,
      epochReason: 'init',
      updatedAt: nowIso(),
    };
  }
  return s;
}

/** 通知驱动：所有已知 URL 进入新代次，旧键立即失效。
 *  保留 lastVary：切换后首个响应携带的 Vary 与旧值不同，但它已属于新代次，
 *  不会再被 vary-detected 重复抬升（见 fetchAndPublish 的代次判断）。 */
function bumpAllEpochs(reason, detail) {
  state.globalEpoch += 1;
  for (const s of Object.values(state.urlStates)) {
    s.epoch = state.globalEpoch;
    s.epochReason = reason;
    s.updatedAt = nowIso();
    // 标记 schema 待确认：之后首个响应的 Vary 差异是确认而非新失效事件
    s.schemaPending = true;
  }
  pushEvent({ type: 'epoch-bump-all', reason, detail, globalEpoch: state.globalEpoch });
}

/** 从新响应识别到 Vary 集合变化：仅该 URL 进入新代次。 */
function bumpUrlEpoch(urlState, reason, detail) {
  urlState.epoch += 1;
  urlState.epochReason = reason;
  urlState.updatedAt = nowIso();
  pushEvent({ type: 'epoch-bump-url', url: urlState.url, reason, detail, epoch: urlState.epoch });
}

function findEntry(url, requestHeaders) {
  const urlState = state.urlStates[url];
  for (const entry of Object.values(state.entries)) {
    if (entry.url !== url) continue;
    // 旧代次的键视为已失效
    if (entry.epoch !== urlState.epoch) continue;
    const key = buildCacheKey(url, entry.varyHeaders, requestHeaders);
    if (key === entry.cacheKey) return entry;
  }
  return null;
}

function isFresh(entry) {
  return entry.expiresAt !== null && Date.now() < entry.expiresAt;
}

/** 发起上游 GET，保留真实请求/响应。只处理 GET。 */
function upstreamGet(urlPath, requestHeaders, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, ORIGIN_URL);
    const headers = { ...requestHeaders, ...extraHeaders };
    // 节点可能保留 connection 等；确保只发受控头 + 自动 Host
    delete headers.connection;
    const startedAt = Date.now();
    const req = http.request(
      url,
      { method: 'GET', headers, timeout: UPSTREAM_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawBody,
            upstreamRequest: {
              method: 'GET',
              url: url.toString(),
              headers: { ...headers, host: res.req.host || url.host },
            },
            upstreamMs: Date.now() - startedAt,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.end();
  });
}

function nextSeq(key) {
  const seq = (state.dispatchSeq[key] || 0) + 1;
  state.dispatchSeq[key] = seq;
  return seq;
}

/**
 * 写回前的代次闸门：返回 { accepted, reason }。
 * @param effectiveEpoch 本条响应实际落库的代次（发现 Vary 变化时为新代次）
 * - epoch 不符当前代次：规则已切换的在途旧请求，一律拒绝写回。
 * - 同键序号只做“严格小于已确认序号”的拦截：后来的请求已确认、更早发起的才晚到。
 */
function generationGate(effectiveEpoch, record, urlState, finalKey) {
  if (effectiveEpoch !== urlState.epoch) {
    return { accepted: false, reason: `源站规则已切换（在途请求代次 ${record.epoch} ≠ 当前代次 ${urlState.epoch}），拒绝写回缓存` };
  }
  const confirmed = state.confirmedSeq[finalKey] || 0;
  if (record.seq < confirmed) {
    return {
      accepted: false,
      reason: `晚返回的旧响应（本键序号 ${record.seq}，已有更新确认序号 ${confirmed}），拒绝覆盖`,
    };
  }
  return { accepted: true };
}

function confirmWrite(finalKey, record) {
  // 只增不减：同一键始终以已确认的最大序号为准
  state.confirmedSeq[finalKey] = Math.max(state.confirmedSeq[finalKey] || 0, record.seq);
}

function buildEntry({ url, cacheKey, varyHeaders, requestHeaders, upstream, record, maxAge, effectiveEpoch }) {
  const storedAt = Date.now();
  return {
    cacheKey,
    url,
    varyHeaders,
    // 来源请求头：逐头记录 present/value，缺失与空值可区分，头名保留原始写法
    sourceRequestHeaders: Object.fromEntries(
      Object.entries(requestHeaders).map(([k, v]) => [k, { present: true, value: String(v) }]),
    ),
    body: upstream.rawBody,
    etag: getHeaderCI(upstream.headers, 'etag').value || null,
    status: upstream.status,
    contentType: getHeaderCI(upstream.headers, 'content-type').value || null,
    cacheControl: getHeaderCI(upstream.headers, 'cache-control').value || null,
    maxAge,
    storedAt,
    expiresAt: maxAge === null ? null : storedAt + maxAge * 1000,
    epoch: effectiveEpoch,
    seq: record.seq,
    originRequestId: getHeaderCI(upstream.headers, 'x-origin-request-id').value || null,
    ruleSetId: getHeaderCI(upstream.headers, 'x-rule-set').value || null,
    storedAtIso: nowIso(),
  };
}

/**
 * 执行一次上游获取并按代次规则决定是否写缓存。
 * options.conditionalEtag 存在时先发条件请求；304 且本地正文可用则只元数据续期。
 */
async function fetchAndPublish({ url, urlState, requestHeaders, prelimKey, record, conditionalEtag, localEntry, logBase }) {
  let upstream;
  let mode = 'full';
  if (conditionalEtag) {
    upstream = await upstreamGet(url, requestHeaders, { 'if-none-match': conditionalEtag });
    mode = 'conditional';
  }
  // 304 只能沿用“本次校验的那份”正文；本地缺正文则重新无条件获取
  if (upstream && upstream.status === 304) {
    if (!localEntry || localEntry.body === null || localEntry.body === undefined) {
      pushEvent({
        type: 'unconditional-refetch',
        url,
        reason: '收到 304 但本地正文缺失，重新无条件获取（不返回空内容、不借用其它表示）',
      });
      upstream = await upstreamGet(url, requestHeaders);
      mode = 'full-after-304';
    }
  }
  if (!upstream) {
    upstream = await upstreamGet(url, requestHeaders);
  }

  const logEntry = {
    id: randomUUID(),
    at: nowIso(),
    url,
    requestHeaders,
    prelimKey,
    epochAtDispatch: record.epoch,
    seq: record.seq,
    mode,
    upstream: {
      request: upstream.upstreamRequest,
      status: upstream.status,
      headers: upstream.headers,
      body: upstream.status === 304 ? null : upstream.rawBody,
      ms: upstream.upstreamMs,
    },
    accepted: false,
    decision: null,
    reason: null,
    finalKey: null,
  };

  const varyHeader = getHeaderCI(upstream.headers, 'vary');
  const varyHeaders = parseVary(varyHeader.present ? varyHeader.value : '');

  // 304 只是对“本地那份表示”的校验确认，不携带新表示：
  // 不做 Vary 变化检测、不更新 lastVary，键与 Vary 维度一律沿用本地条目。
  // 非 304 时，只有“响应属于当前代次”才做 Vary 变化检测：
  // 通知切换已把 URL 抬到新代次，携带旧 Vary 的在途响应（record.epoch 落后）
  // 不会触发重复抬升；无通知场景下当前代次响应的 Vary 变化才被识别。
  const varyChanged =
    upstream.status !== 304 &&
    urlState.lastVary &&
    !sameVarySet(varyHeaders, urlState.lastVary);
  let detectedEpoch = null;
  if (varyChanged && record.epoch === urlState.epoch) {
    if (urlState.schemaPending) {
      // 通知已使该 URL 失效并抬过代次：这里只是确认新 schema，不再重复抬升
      urlState.schemaPending = false;
    } else {
      // 无通知场景：从响应自行识别 Vary 变化，该 URL 进入新代次
      bumpUrlEpoch(urlState, 'vary-detected', {
        from: urlState.lastVary,
        to: varyHeaders,
      });
      // 本次响应是新 Vary 的发现者，可按新代次落库；但不回写 record.epoch，
      // 否则通知切换场景下携带旧 Vary 的在途响应会被错误地“洗白”成新代次。
      detectedEpoch = urlState.epoch;
    }
  }
  // 落库/返回使用的代次：发现 Vary 变化的本次响应用新代次，其余保持发起代次
  const effectiveEpoch = detectedEpoch ?? record.epoch;
  // 只有与当前代次一致的响应才能更新 lastVary / 确认 schema：
  // 通知切换后晚到的旧 Vary 响应（record.epoch 落后）不得改回基线，
  // 否则随后的新 Vary 响应会被误判为又一次变化而重复抬代次。
  if (upstream.status !== 304 && effectiveEpoch === urlState.epoch) {
    urlState.lastVary = varyHeaders;
    urlState.schemaPending = false;
  }

  const finalKey =
    upstream.status === 304 && localEntry
      ? localEntry.cacheKey
      : buildCacheKey(url, varyHeaders, requestHeaders);
  logEntry.finalKey = finalKey;

  // Vary: * 不进入可复用缓存（真实响应仍原样返回、仍记录流水）；304 不会带 Vary: * 表示
  if (upstream.status !== 304 && varyHeaders.includes('*')) {
    logEntry.decision = 'not-cacheable-vary-star';
    logEntry.reason = '上游返回 Vary: *，按协议不进入可复用缓存';
    pushFetchLog({ ...logBase, ...logEntry });
    return {
      status: upstream.status,
      body: upstream.rawBody,
      contentType: getHeaderCI(upstream.headers, 'content-type').value || null,
      etag: getHeaderCI(upstream.headers, 'etag').value || null,
      vary: '*',
      cacheControl: getHeaderCI(upstream.headers, 'cache-control').value || null,
      decision: logEntry.decision,
      reason: logEntry.reason,
      cacheKey: finalKey,
      epoch: effectiveEpoch,
      seq: record.seq,
      upstream: logEntry.upstream,
      cached: false,
    };
  }

  const gate = generationGate(effectiveEpoch, record, urlState, finalKey);

  // 304：仅允许沿用同一键、同一份正文
  if (upstream.status === 304) {
    if (!gate.accepted) {
      logEntry.decision = 'stale-generation-or-late-rejected';
      logEntry.reason = `304 被代次闸门拒绝：${gate.reason}；改走无条件获取`;
      pushFetchLog({ ...logBase, ...logEntry });
      // 不能把 304 的空内容返回给页面：重新无条件获取一次
      return fetchAndPublish({
        url,
        urlState,
        requestHeaders,
        prelimKey: finalKey,
        record: { epoch: urlState.epoch, seq: nextSeq(finalKey) },
        conditionalEtag: null,
        localEntry: null,
        logBase,
      });
    }
    if (!localEntry || localEntry.body === null || localEntry.body === undefined) {
      // 理论上前面已处理，这里兜底：绝不返回空
      logEntry.decision = 'unconditional-refetch';
      logEntry.reason = '304 无本地正文可沿用，无条件重取';
      pushFetchLog({ ...logBase, ...logEntry });
      return fetchAndPublish({
        url,
        urlState,
        requestHeaders,
        prelimKey: finalKey,
        record: { epoch: urlState.epoch, seq: nextSeq(finalKey) },
        conditionalEtag: null,
        localEntry: null,
        logBase,
      });
    }
    // 校验通过：沿用本次校验的那份正文，只刷新有效期与 ETag
    const maxAge = parseMaxAge(getHeaderCI(upstream.headers, 'cache-control').value);
    localEntry.storedAt = Date.now();
    localEntry.expiresAt = maxAge === null ? localEntry.expiresAt : Date.now() + maxAge * 1000;
    localEntry.maxAge = maxAge ?? localEntry.maxAge;
    localEntry.cacheControl = getHeaderCI(upstream.headers, 'cache-control').value || localEntry.cacheControl;
    const newEtag = getHeaderCI(upstream.headers, 'etag').value;
    if (newEtag) localEntry.etag = newEtag;
    localEntry.sourceRequestHeaders = Object.fromEntries(
      Object.entries(requestHeaders).map(([k, v]) => [k, { present: true, value: String(v) }]),
    );
    confirmWrite(finalKey, record);
    logEntry.accepted = true;
    logEntry.decision = 'conditional-304-revalidated';
    logEntry.reason = '条件请求收到 304，沿用同一表示的本地正文并刷新有效期';
    pushFetchLog({ ...logBase, ...logEntry });
    return {
      status: 304,
      body: localEntry.body,
      contentType: localEntry.contentType,
      etag: localEntry.etag,
      vary: varyHeaders.join(', '),
      cacheControl: localEntry.cacheControl,
      decision: logEntry.decision,
      reason: logEntry.reason,
      cacheKey: localEntry.cacheKey,
      epoch: effectiveEpoch,
      seq: record.seq,
      upstream: logEntry.upstream,
      cached: true,
    };
  }

  // 200 等完整响应：没有明确 max-age 不缓存
  const maxAge = parseMaxAge(getHeaderCI(upstream.headers, 'cache-control').value);
  if (maxAge === null) {
    logEntry.decision = 'not-cacheable-no-max-age';
    logEntry.reason = '响应没有明确 max-age，不写入可复用缓存';
    pushFetchLog({ ...logBase, ...logEntry });
    return {
      status: upstream.status,
      body: upstream.rawBody,
      contentType: getHeaderCI(upstream.headers, 'content-type').value || null,
      etag: getHeaderCI(upstream.headers, 'etag').value || null,
      vary: varyHeaders.join(', '),
      cacheControl: getHeaderCI(upstream.headers, 'cache-control').value || null,
      decision: logEntry.decision,
      reason: logEntry.reason,
      cacheKey: finalKey,
      epoch: effectiveEpoch,
      seq: record.seq,
      upstream: logEntry.upstream,
      cached: false,
    };
  }

  if (!gate.accepted) {
    logEntry.decision = 'stale-generation-or-late-rejected';
    logEntry.reason = gate.reason;
    pushFetchLog({ ...logBase, ...logEntry });
    return {
      status: upstream.status,
      body: upstream.rawBody,
      contentType: getHeaderCI(upstream.headers, 'content-type').value || null,
      etag: getHeaderCI(upstream.headers, 'etag').value || null,
      vary: varyHeaders.join(', '),
      cacheControl: getHeaderCI(upstream.headers, 'cache-control').value || null,
      decision: logEntry.decision,
      reason: gate.reason,
      cacheKey: finalKey,
      epoch: effectiveEpoch,
      seq: record.seq,
      upstream: logEntry.upstream,
      cached: false,
    };
  }

  const entry = buildEntry({
    url,
    cacheKey: finalKey,
    varyHeaders,
    requestHeaders,
    upstream,
    record,
    maxAge,
    effectiveEpoch,
  });
  state.entries[finalKey] = entry;
  confirmWrite(finalKey, record);
  logEntry.accepted = true;
  logEntry.decision = 'full-fetch-stored';
  logEntry.reason = '完整获取并写入缓存（键含 Vary 指定头的取值）';
  pushFetchLog({ ...logBase, ...logEntry });
  return {
    status: upstream.status,
    body: upstream.rawBody,
    contentType: entry.contentType,
    etag: entry.etag,
    vary: varyHeaders.join(', '),
    cacheControl: entry.cacheControl,
    decision: logEntry.decision,
    reason: logEntry.reason,
    cacheKey: finalKey,
    epoch: effectiveEpoch,
    seq: record.seq,
    upstream: logEntry.upstream,
    cached: true,
  };
}

async function handleCollect(req, res) {
  const body = await readJsonBody(req);
  const url = body.url || '/data';
  const force = Boolean(body.force);
  const requestHeaders = {};
  // 支持两种入参：
  //   数组 [{name, value}]：保留“存在但空值”，数组里没有的头即缺失
  //   对象 {Name: value}：兼容写法，空串按缺失处理
  if (Array.isArray(body.headers)) {
    for (const h of body.headers) {
      if (h && h.name) requestHeaders[h.name] = h.value ?? '';
    }
  } else {
    for (const [k, v] of Object.entries(body.headers || {})) {
      if (typeof v === 'string' && v.length > 0) requestHeaders[k] = v;
    }
  }

  const urlState = touchUrl(url);
  const prelimVary = urlState.lastVary || [];
  const prelimKey = buildCacheKey(url, prelimVary, requestHeaders);

  // 1) 新鲜命中：不发上游请求
  const entry = force ? null : findEntry(url, requestHeaders);
  if (entry && entry.body !== null && entry.body !== undefined && isFresh(entry)) {
    const logEntry = {
      id: randomUUID(),
      at: nowIso(),
      url,
      requestHeaders,
      prelimKey,
      epochAtDispatch: urlState.epoch,
      seq: null,
      mode: 'cache-hit',
      upstream: null,
      accepted: true,
      decision: 'cache-hit-fresh',
      reason: '命中同代次同 Vary 维度的新鲜缓存，未发上游请求',
      finalKey: entry.cacheKey,
    };
    pushFetchLog(logEntry);
    return sendJson(res, 200, {
      status: entry.status,
      body: entry.body,
      contentType: entry.contentType,
      etag: entry.etag,
      vary: entry.varyHeaders.join(', '),
      cacheControl: entry.cacheControl,
      decision: logEntry.decision,
      reason: logEntry.reason,
      cacheKey: entry.cacheKey,
      epoch: entry.epoch,
      seq: entry.seq,
      upstream: null,
      cached: true,
    });
  }

  // 2) 需要上游：分配本地发起代次与序号
  const record = { epoch: urlState.epoch, seq: nextSeq(prelimKey) };

  // 3) 选择条件请求还是无条件请求
  let conditionalEtag = null;
  let localEntry = null;
  if (entry) {
    localEntry = entry;
    if (entry.body !== null && entry.body !== undefined && entry.etag) {
      // 过期但有正文有 ETag：条件校验
      conditionalEtag = entry.etag;
    }
    if (entry.body === null || entry.body === undefined) {
      pushEvent({
        type: 'unconditional-refetch',
        url,
        cacheKey: entry.cacheKey,
        reason: '本地正文缺失，跳过条件请求直接无条件获取',
      });
    }
  }

  try {
    const result = await fetchAndPublish({
      url,
      urlState,
      requestHeaders,
      prelimKey,
      record,
      conditionalEtag,
      localEntry,
    });
    sendJson(res, 200, result);
  } catch (err) {
    pushFetchLog({
      id: randomUUID(),
      at: nowIso(),
      url,
      requestHeaders,
      prelimKey,
      epochAtDispatch: record.epoch,
      seq: record.seq,
      mode: 'error',
      upstream: null,
      accepted: false,
      decision: 'upstream-error',
      reason: err.message,
      finalKey: null,
    });
    sendJson(res, 502, { error: `上游请求失败: ${err.message}` });
  }
}

function handleInternal(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/internal/origin-rule-changed') {
    return readJsonBody(req)
      .then((body) => {
        bumpAllEpochs('origin-notification', body);
        sendJson(res, 200, { ok: true, globalEpoch: state.globalEpoch });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }
  sendJson(res, 404, { error: 'not found' });
}

function handleApi(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'POST' && path === '/api/collect') return handleCollect(req, res);
  if (req.method === 'GET' && path === '/api/state') {
    return sendJson(res, 200, {
      originBase: state.originBase,
      globalEpoch: state.globalEpoch,
      urlStates: state.urlStates,
      entries: state.entries,
      dispatchSeq: state.dispatchSeq,
      confirmedSeq: state.confirmedSeq,
      events: state.events,
      startupAt: state.startupAt,
    });
  }
  if (req.method === 'GET' && path === '/api/fetches') return sendJson(res, 200, state.fetchLog);
  if (req.method === 'DELETE' && path.startsWith('/api/entries/')) {
    const key = decodeURIComponent(path.slice('/api/entries/'.length));
    const onlyBody = url.searchParams.get('only') === 'body';
    const entry = state.entries[key];
    if (!entry) return sendJson(res, 404, { error: '缓存键不存在' });
    if (onlyBody) {
      entry.body = null;
      entry.bodyDeletedAt = nowIso();
      pushEvent({ type: 'body-deleted', cacheKey: key });
      return sendJson(res, 200, { ok: true, entry });
    }
    delete state.entries[key];
    pushEvent({ type: 'entry-deleted', cacheKey: key });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  if (url.pathname.startsWith('/internal/')) return handleInternal(req, res);

  // 静态页面
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[collector] 采集站已启动: http://127.0.0.1:${PORT}  上游源站: ${ORIGIN_URL}`);
});

export { server, state };
