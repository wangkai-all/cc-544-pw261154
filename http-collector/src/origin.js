// 可控源站（origin）：
// - 同一个 GET /data 地址，按 Accept-Language 返回不同语言、按 Accept 返回不同媒体类型
// - 每个响应带 ETag 与 Vary，Cache-Control 使用明确的 max-age
// - 管理接口可：编辑正文、切换 Vary 字段集合（切换时 webhook 通知采集端）、延迟某个请求
// - 完整保留真实入站请求记录，供页面与测试核对

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  applyCors,
  getHeaderCI,
  nowIso,
  parseAccept,
  parseAcceptLanguage,
  readJsonBody,
  sendJson,
  sleep,
} from '../lib/util.js';

const PORT = Number(process.env.ORIGIN_PORT || 5000);
const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://127.0.0.1:4000';
const DATA_PATH = '/data';

// 三套可切换规则，演示 Vary 字段集合的变化（含 Vary: *）。
const RULE_SETS = {
  A: {
    id: 'A',
    label: '规则A：Vary Accept-Language, Accept',
    vary: ['accept-language', 'accept'],
    maxAge: 30,
    versions: {
      zh: {
        'application/json': '{"message":"你好，世界","lang":"zh","media":"json"}',
        'text/plain': '你好，世界（纯文本）',
      },
      en: {
        'application/json': '{"message":"hello world","lang":"en","media":"json"}',
        'text/plain': 'hello world (plain text)',
      },
    },
    etagVersion: 1,
  },
  B: {
    id: 'B',
    label: '规则B：仅 Vary Accept-Language（字段集合发生变化）',
    vary: ['accept-language'],
    maxAge: 30,
    versions: {
      zh: {
        'application/json': '{"message":"你好，世界·规则B","lang":"zh"}',
        'text/plain': '你好，世界·规则B（纯文本）',
      },
      en: {
        'application/json': '{"message":"hello world rule B","lang":"en"}',
        'text/plain': 'hello world rule B (plain text)',
      },
    },
    etagVersion: 1,
  },
  C: {
    id: 'C',
    label: '规则C：Vary: *（不可复用缓存）',
    vary: ['*'],
    maxAge: 30,
    versions: {
      zh: {
        'application/json': '{"message":"你好，世界·规则C","lang":"zh"}',
        'text/plain': '你好，世界·规则C（纯文本）',
      },
      en: {
        'application/json': '{"message":"hello world rule C","lang":"en"}',
        'text/plain': 'hello world rule C (plain text)',
      },
    },
    etagVersion: 1,
  },
};

const state = {
  ruleSetId: 'A',
  rules: structuredClone(RULE_SETS),
  // 延迟指令：[{ id, match: {lang?, mediaType?}, delayMs, once, used }]
  delays: [],
  // 真实入站请求记录（最多保留 200 条）
  requestLog: [],
  // 切换历史
  switchLog: [],
  startupAt: nowIso(),
};

function currentRule() {
  return state.rules[state.ruleSetId];
}

/** ETag 与“正文 + 规则版本 + 语言 + 媒体类型”绑定，正文被编辑后必然变化。 */
function computeEtag(rule, lang, mediaType) {
  return `"${rule.id}-v${rule.etagVersion}-${lang}-${mediaType === 'text/plain' ? 'txt' : 'json'}"`;
}

function mediaTypeForResponse(rule, mediaType) {
  return rule.versions.en[mediaType] ? mediaType : 'application/json';
}

function pushRequestLog(entry) {
  state.requestLog.unshift(entry);
  if (state.requestLog.length > 200) state.requestLog.length = 200;
}

function findDelay(lang, mediaType) {
  const now = Date.now();
  for (const d of state.delays) {
    if (d.used || d.notBefore > now) continue;
    const langOk = !d.match.lang || d.match.lang === lang;
    const typeOk = !d.match.mediaType || d.match.mediaType === mediaType;
    if (langOk && typeOk) return d;
  }
  return null;
}

/** 规则切换时通知采集端；silent=true 时不通知（用于验证采集端靠新响应自行识别 Vary 变化）。 */
async function notifyCollector(reason, silent, ruleSetId) {
  if (silent) return;
  try {
    const url = new URL('/internal/origin-rule-changed', COLLECTOR_URL);
    await new Promise((resolve, reject) => {
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          timeout: 3000,
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('webhook timeout')));
      req.end(JSON.stringify({ reason, ruleSetId, at: nowIso() }));
    });
  } catch (err) {
    // 通知失败只记录，不影响源站本身
    state.switchLog.push({ at: nowIso(), error: `通知采集端失败: ${err.message}` });
  }
}

async function handleData(req, res) {
  applyCors(res);
  const rule = currentRule();
  const al = getHeaderCI(req.headers, 'accept-language');
  const ac = getHeaderCI(req.headers, 'accept');
  const inm = getHeaderCI(req.headers, 'if-none-match');
  const { lang, headerPresent: alPresent } = parseAcceptLanguage(al.value, al.present);
  const { mediaType: wantedType, headerPresent: acPresent } = parseAccept(ac.value, ac.present);
  const mediaType = mediaTypeForResponse(rule, wantedType);
  const etag = computeEtag(rule, lang, mediaType);

  const reqId = randomUUID();
  const logEntry = {
    id: reqId,
    at: nowIso(),
    method: req.method,
    url: DATA_PATH,
    ruleSetId: rule.id,
    matched: { lang, mediaType, acceptLanguagePresent: alPresent, acceptPresent: acPresent },
    requestHeaders: {
      'accept-language': al.present ? al.value : null,
      accept: ac.present ? ac.value : null,
      'if-none-match': inm.present ? inm.value : null,
    },
    delayMs: 0,
    status: null,
    responseHeaders: {},
  };

  const delay = findDelay(lang, mediaType);
  if (delay) {
    logEntry.delayMs = delay.delayMs;
    if (delay.once) delay.used = true;
    await sleep(delay.delayMs);
  }

  // 条件请求：If-None-Match 与当前表示的 ETag 一致时返回 304（无正文）
  if (inm.present) {
    const tags = inm.value.split(',').map((t) => t.trim());
    if (tags.includes(etag) || tags.includes('*')) {
      res.writeHead(304, {
        etag,
        vary: rule.vary.includes('*') ? '*' : rule.vary.join(', '),
        'cache-control': `max-age=${rule.maxAge}`,
        'content-type': `${mediaType}; charset=utf-8`,
      });
      logEntry.status = 304;
      logEntry.responseHeaders = {
        etag,
        vary: rule.vary.includes('*') ? '*' : rule.vary.join(', '),
        'cache-control': `max-age=${rule.maxAge}`,
      };
      pushRequestLog(logEntry);
      res.end();
      return;
    }
  }

  const body = rule.versions[lang][mediaType];
  const varyHeader = rule.vary.includes('*') ? '*' : rule.vary.join(', ');
  res.writeHead(200, {
    'content-type': `${mediaType}; charset=utf-8`,
    etag,
    vary: varyHeader,
    'cache-control': `max-age=${rule.maxAge}`,
    'x-origin-request-id': reqId,
    'x-rule-set': rule.id,
  });
  logEntry.status = 200;
  logEntry.responseHeaders = {
    'content-type': `${mediaType}; charset=utf-8`,
    etag,
    vary: varyHeader,
    'cache-control': `max-age=${rule.maxAge}`,
    'x-origin-request-id': reqId,
    'x-rule-set': rule.id,
  };
  pushRequestLog(logEntry);
  res.end(body);
}

async function handleAdmin(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // 只读：源站当前完整状态（规则、延迟、真实请求记录、切换历史）
  if (req.method === 'GET' && path === '/admin/state') {
    return sendJson(res, 200, state);
  }
  if (req.method === 'GET' && path === '/admin/requests') {
    return sendJson(res, 200, state.requestLog);
  }

  // 编辑某条表示的正文：ETag 版本 +1，使旧 ETag 立即失效；不主动通知采集端
  if (req.method === 'PUT' && path === '/admin/body') {
    const body = await readJsonBody(req);
    const { ruleSetId, lang, mediaType, content } = body;
    const rule = state.rules[ruleSetId] || currentRule();
    if (!rule.versions[lang] || !rule.versions[lang][mediaType]) {
      return sendJson(res, 400, { error: '未知的语言或媒体类型' });
    }
    rule.versions[lang][mediaType] = String(content);
    rule.etagVersion += 1;
    const entry = {
      at: nowIso(),
      action: 'edit-body',
      ruleSetId: rule.id,
      lang,
      mediaType,
      etagVersion: rule.etagVersion,
    };
    state.switchLog.unshift(entry);
    return sendJson(res, 200, { ok: true, etag: computeEtag(rule, lang, mediaType) });
  }

  // 切换规则（Vary 字段集合变化）；默认同时通知采集端
  if (req.method === 'POST' && path === '/admin/switch-rule') {
    const body = await readJsonBody(req);
    const { ruleSetId, silent = false } = body;
    if (!state.rules[ruleSetId]) return sendJson(res, 400, { error: '未知规则集' });
    const previous = state.ruleSetId;
    state.ruleSetId = ruleSetId;
    const entry = {
      at: nowIso(),
      action: 'switch-rule',
      from: previous,
      to: ruleSetId,
      silent: Boolean(silent),
      vary: currentRule().vary,
      notified: !silent,
    };
    state.switchLog.unshift(entry);
    await notifyCollector('switch-rule', silent, ruleSetId);
    return sendJson(res, 200, { ok: true, ...entry });
  }

  // 调整规则集的 max-age（供演示快速触发过期校验）
  if (req.method === 'PUT' && path === '/admin/max-age') {
    const body = await readJsonBody(req);
    const rule = state.rules[body.ruleSetId] || currentRule();
    rule.maxAge = Math.max(0, Number(body.maxAge));
    const entry = { at: nowIso(), action: 'max-age', ruleSetId: rule.id, maxAge: rule.maxAge };
    state.switchLog.unshift(entry);
    return sendJson(res, 200, { ok: true, maxAge: rule.maxAge });
  }

  // 给某个表示的下一个请求加延迟
  if (req.method === 'POST' && path === '/admin/delay') {
    const body = await readJsonBody(req);
    const { lang = null, mediaType = null, delayMs = 3000, once = true } = body;
    const entry = {
      id: randomUUID(),
      at: nowIso(),
      match: { lang, mediaType },
      delayMs: Number(delayMs),
      once: Boolean(once),
      used: false,
      notBefore: Date.now(),
    };
    state.delays.unshift(entry);
    if (state.delays.length > 50) state.delays.length = 50;
    return sendJson(res, 200, { ok: true, delay: entry });
  }

  if (req.method === 'DELETE' && path === '/admin/delays') {
    state.delays.length = 0;
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return handleAdmin(req, res);
  if (req.method === 'GET' && url.pathname === DATA_PATH) {
    return handleData(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  }
  if (url.pathname.startsWith('/admin/')) {
    return handleAdmin(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[origin] 可控源站已启动: http://127.0.0.1:${PORT}  数据地址 GET ${DATA_PATH}`);
});

export { server, state, computeEtag };
