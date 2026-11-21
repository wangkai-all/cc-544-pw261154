// 通用工具：HTTP 头处理、Vary/max-age 解析等。
// 注意：头名称大小写不敏感；头“缺失”与“存在但为空值”严格区分。

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 大小写不敏感读取头。返回 { present, value }，present 用于区分缺失与空值。 */
export function getHeaderCI(headers, name) {
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return { present: true, value: Array.isArray(v) ? v.join(', ') : String(v) };
    }
  }
  return { present: false, value: '' };
}

/** 解析 Vary 头：'*' 返回 ['*']；多个头名按逗号拆分并小写、去重、排序。无 Vary 返回 []。 */
export function parseVary(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  const raw = String(value).trim();
  if (raw === '*') return ['*'];
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(names)].sort();
}

export function sameVarySet(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** 只识别明确的 max-age 指令；没有则返回 null（不实现其它缓存指令）。 */
export function parseMaxAge(cacheControl) {
  if (!cacheControl) return null;
  const m = String(cacheControl).match(/(?:^|,\s*)max-age\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** 解析 Accept-Language，取主语言标签；空值视为无法匹配。 */
export function parseAcceptLanguage(rawValue, present) {
  if (!present) return { lang: 'en', headerPresent: false, raw: null };
  const raw = rawValue ?? '';
  const first = raw.split(',')[0]?.trim().toLowerCase() ?? '';
  const primary = first.split(';')[0].trim();
  const sub = primary.split('-')[0];
  const lang = sub === 'zh' ? 'zh' : sub === 'en' ? 'en' : sub || 'en';
  return { lang, headerPresent: true, raw };
}

/** 演示用 Accept 匹配：只区分 application/json 与 text/plain。 */
export function parseAccept(rawValue, present) {
  if (!present) return { mediaType: 'application/json', headerPresent: false, raw: null };
  const raw = rawValue ?? '';
  const lower = raw.toLowerCase();
  const mediaType = lower.includes('text/plain')
    ? 'text/plain'
    : lower.includes('application/json') || lower.includes('*/*') || raw.trim() === ''
      ? 'application/json'
      : 'application/json';
  return { mediaType, headerPresent: true, raw };
}

/** 依据 Vary 头集合构造缓存键的维度部分；缺失头用 __ABSENT__ 标记，与空值区分。 */
export function buildVaryKey(varyHeaders, requestHeaders) {
  const parts = [];
  for (const name of [...varyHeaders].sort()) {
    const { present, value } = getHeaderCI(requestHeaders, name);
    parts.push(`${name}=${present ? value : '__ABSENT__'}`);
  }
  return parts.join('|');
}

export function buildCacheKey(url, varyHeaders, requestHeaders) {
  return `${url}::${buildVaryKey(varyHeaders, requestHeaders)}`;
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
}

export function nowIso() {
  return new Date().toISOString();
}
