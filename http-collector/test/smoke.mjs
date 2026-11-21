// 端到端核对：启动源站与采集站，用真实 HTTP 访问验证
// Vary 缓存键、ETag 条件请求、代次闸门与源站真实请求记录。
// 运行：node test/smoke.mjs（无需任何第三方依赖）

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:5055';
const COLLECTOR = 'http://127.0.0.1:4055';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

async function waitReady(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = fetch(url).then(resolve).catch(reject);
        setTimeout(() => req, 100);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`服务未就绪: ${url}`);
}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
  return data;
}
const post = (u, b) => jfetch(u, { method: 'POST', body: b });
const put = (u, b) => jfetch(u, { method: 'PUT', body: b });
const del = (u) => jfetch(u, { method: 'DELETE' });

// 采集端请求头用数组形式，可表达空值头
const H = {
  zhJson: [{ name: 'Accept-Language', value: 'zh-CN' }, { name: 'Accept', value: 'application/json' }],
  enJson: [{ name: 'Accept-Language', value: 'en-US' }, { name: 'Accept', value: 'application/json' }],
  zhTxt: [{ name: 'Accept-Language', value: 'zh-CN' }, { name: 'Accept', value: 'text/plain' }],
  zhJsonUpper: [{ name: 'accept-language', value: 'zh-CN' }, { name: 'accept', value: 'application/json' }],
  noLang: [{ name: 'Accept', value: 'application/json' }],
  emptyLang: [{ name: 'Accept-Language', value: '' }, { name: 'Accept', value: 'application/json' }],
};
const collect = (headers, force = false) =>
  post(`${COLLECTOR}/api/collect`, { url: '/data', headers, force });
const originState = () => jfetch(`${ORIGIN}/admin/state`);
const clearCache = async () => {
  const s = await jfetch(`${COLLECTOR}/api/state`);
  for (const key of Object.keys(s.entries)) {
    await del(`${COLLECTOR}/api/entries/${encodeURIComponent(key)}`);
  }
};
const originCount = async () => (await originState()).requestLog.length;

const procs = [];
function start(file, env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', file)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`    ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`    ${d}`));
  procs.push(p);
}

try {
  start('origin.js', { ORIGIN_PORT: '5055', COLLECTOR_URL: COLLECTOR });
  start('collector.js', { COLLECTOR_PORT: '4055', ORIGIN_URL: ORIGIN });
  await waitReady(`${ORIGIN}/admin/state`);
  await waitReady(`${COLLECTOR}/api/state`);

  // 确保从规则A、默认 max-age 开始
  await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'A' });
  await put(`${ORIGIN}/admin/max-age`, { ruleSetId: 'A', maxAge: 30 });
  await clearCache();

  console.log('\n[1] 首次接收：同 URL 不同语言/媒体类型是不同缓存键，不串内容');
  const before1 = await originCount();
  const zh = await collect(H.zhJson);
  const en = await collect(H.enJson);
  const txt = await collect(H.zhTxt);
  check('zh 返回中文 JSON 正文', () => {
    assert.equal(zh.decision, 'full-fetch-stored');
    assert.match(zh.body, /你好/);
    assert.equal(zh.cached, true);
  });
  check('en 返回英文 JSON 正文', () => {
    assert.match(en.body, /hello world/);
    assert.notEqual(zh.cacheKey, en.cacheKey);
  });
  check('text/plain 是第三份独立表示', () => {
    assert.match(txt.body, /纯文本/);
    assert.notEqual(txt.cacheKey, zh.cacheKey);
  });
  const zhHit = await collect(H.zhJson);
  check('新鲜命中不再发上游请求', () => {
    assert.equal(zhHit.decision, 'cache-hit-fresh');
    assert.equal(zhHit.upstream, null);
  });

  console.log('\n[2] 源站记录核对：两次语言各有一次真实请求，命中不产生请求');
  const os1 = await originState();
  check('源站只收到 3 个 GET（zh-json、en-json、zh-txt）', () => {
    const gets = os1.requestLog.filter((q) => q.url === '/data');
    assert.equal(gets.length, 3 + before1);
    const langs = gets.map((q) => q.matched.lang).sort();
    assert.deepEqual(langs, ['en', 'zh', 'zh'].sort());
  });
  check('源站记录保留了实际请求头（区分头缺失）', () => {
    const enReq = os1.requestLog.find((q) => q.matched.lang === 'en');
    assert.equal(enReq.requestHeaders['accept-language'], 'en-US');
  });

  console.log('\n[3] 条件请求 304：沿用同一表示正文；ETag 变化后拿 200 新正文');
  await clearCache();
  await put(`${ORIGIN}/admin/max-age`, { ruleSetId: 'A', maxAge: 1 });
  await collect(H.zhJson); // 用 1s 有效期建立缓存
  await new Promise((r) => setTimeout(r, 1050));
  const reval = await collect(H.zhJson);
  check('过期后发起条件请求并收到 304，正文沿用本地同一份', () => {
    assert.equal(reval.decision, 'conditional-304-revalidated');
    assert.equal(reval.status, 304);
    assert.match(reval.body, /你好/);
    assert.equal(reval.upstream.status, 304);
    assert.equal(reval.upstream.body, null);
    assert.match(reval.upstream.request.headers['if-none-match'], /"A-/);
  });
  const newBody = `{"message":"源站改过的正文 ${Date.now()}","lang":"zh"}`;
  await put(`${ORIGIN}/admin/body`, { ruleSetId: 'A', lang: 'zh', mediaType: 'application/json', content: newBody });
  await new Promise((r) => setTimeout(r, 1050));
  const changed = await collect(H.zhJson);
  check('ETag 不匹配时上游返回 200，新正文覆盖缓存', () => {
    assert.equal(changed.decision, 'full-fetch-stored');
    assert.equal(changed.body, newBody);
    assert.equal(changed.upstream.status, 200);
  });
  await put(`${ORIGIN}/admin/max-age`, { ruleSetId: 'A', maxAge: 30 });

  console.log('\n[4] 删除本地正文再取回：不返回空、不借用另一语言正文');
  const st4 = await jfetch(`${COLLECTOR}/api/state`);
  // 键中头名规范化为小写、值保留原始大小写（zh-CN），按小写比较定位 zh/json 表示
  const zhEntry4 = Object.values(st4.entries).find(
    (e) =>
      e.url === '/data' &&
      e.cacheKey.toLowerCase().includes('accept-language=zh-cn') &&
      e.cacheKey.toLowerCase().includes('accept=application/json'),
  );
  assert.ok(zhEntry4, '应存在 zh/json 表示条目');
  await del(`${COLLECTOR}/api/entries/${encodeURIComponent(zhEntry4.cacheKey)}?only=body`);
  const rebuilt = await collect(H.zhJson);
  check('正文缺失时跳过条件请求，无条件重取并写回', () => {
    assert.equal(rebuilt.decision, 'full-fetch-stored');
    assert.ok(rebuilt.body && rebuilt.body.length > 0);
    assert.match(rebuilt.body, /zh/);
  });
  const os2 = await originState();
  check('重取请求没有借用 en 的 ETag/正文', () => {
    const latest = os2.requestLog[0];
    assert.equal(latest.matched.lang, 'zh');
    assert.equal(latest.requestHeaders['if-none-match'], null);
  });

  console.log('\n[5] 晚返回的旧响应不能覆盖后发先确认的结果（同一表示）');
  // 重建两种语言的表示（[3] 中清空过缓存），验证并发竞争不波及另一语言
  await collect(H.enJson);
  await post(`${ORIGIN}/admin/delay`, { lang: 'zh', mediaType: 'application/json', delayMs: 3000 });
  // force：跳过缓存读取（此时本地仍是新鲜的），保证请求真正到达源站；代次闸门照常生效
  const p1 = collect(H.zhJson, true);
  await new Promise((r) => setTimeout(r, 500));
  const r2 = await collect(H.zhJson, true);
  const r1 = await p1;
  check('R2 先确认写回，R1 晚返回被代次/序号闸门拒绝', () => {
    assert.equal(r2.cached, true);
    assert.equal(r1.cached, false);
    assert.equal(r1.decision, 'stale-generation-or-late-rejected');
    assert.ok(r1.body && r1.body.length > 0, '被拒响应仍把真实正文返回给调用方检查');
  });
  const sAfter = await jfetch(`${COLLECTOR}/api/state`);
  check('缓存保留的是 R2（confirmedSeq 为较大序号）', () => {
    assert.equal(sAfter.confirmedSeq[r2.cacheKey], r2.seq);
    assert.equal(sAfter.entries[r2.cacheKey].seq, r2.seq);
  });
  check('不同语言的表示仍各自保存，未被波及', () => {
    const enEntry = Object.values(sAfter.entries).find(
      (e) => e.url === '/data' && e.cacheKey.toLowerCase().includes('accept-language=en-us'),
    );
    assert.ok(enEntry, 'en 表示仍在缓存中');
    assert.match(enEntry.body, /hello world/);
  });

  console.log('\n[6] 规则切换通知：Vary 集合变化，旧键立即失效，在途请求拒绝写回');
  // 仅在当前不是规则A时才需要切回（避免同值切换产生多余通知代次）
  const curRule = (await originState()).ruleSetId;
  if (curRule !== 'A') await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'A' });
  const preEpoch = (await jfetch(`${COLLECTOR}/api/state`)).globalEpoch;
  await post(`${ORIGIN}/admin/delay`, { lang: 'zh', mediaType: 'application/json', delayMs: 2500 });
  const inFlight = collect(H.zhJson, true);
  await new Promise((r) => setTimeout(r, 500));
  const sw = await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'B', silent: false });
  const inFlightResult = await inFlight;
  check('切换前在途请求返回后被拒绝写回', () => {
    assert.equal(sw.notified, true);
    assert.equal(inFlightResult.cached, false);
    assert.equal(inFlightResult.decision, 'stale-generation-or-late-rejected');
  });
  const afterEpoch = (await jfetch(`${COLLECTOR}/api/state`)).globalEpoch;
  const afterSwitch = await collect(H.zhJson);
  check('全局代次递增，旧键代次落后即失效', () => assert.equal(afterEpoch, preEpoch + 1));
  check('切换后首次采集以新代次写入新键（通知已抬代次，不再重复抬升）', () => {
    assert.equal(afterSwitch.decision, 'full-fetch-stored');
    assert.equal(afterSwitch.epoch, afterEpoch);
    assert.equal(afterSwitch.vary, 'accept-language');
  });

  console.log('\n[7] 静默切换：无通知，采集端从新响应自行识别 Vary 变化');
  await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'A', silent: true });
  await collect(H.zhJson, true);
  const gBefore = (await jfetch(`${COLLECTOR}/api/state`)).globalEpoch;
  await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'B', silent: true });
  // force 跳过缓存读取，才能真正拿到新响应并识别 Vary 变化（无通知时不凭空发现）
  const silentRes = await collect(H.zhJson, true);
  const afterSilentState = await jfetch(`${COLLECTOR}/api/state`);
  check('识别到 Vary 变化后该 URL 代次 +1 且响应正常缓存', () => {
    assert.equal(silentRes.cached, true);
    const evt = afterSilentState.events.find((e) => e.type === 'epoch-bump-url');
    assert.ok(evt, '应产生 vary-detected 事件');
    assert.equal(evt.reason, 'vary-detected');
  });
  check('静默切换没有增加全局通知代次', () => {
    assert.equal(afterSilentState.globalEpoch, gBefore);
  });

  console.log('\n[8] Vary: * 不进入可复用缓存');
  await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'C' });
  const star1 = await collect(H.zhJson);
  const star2 = await collect(H.zhJson);
  check('两次都绕过缓存、源站收到两次请求', () => {
    assert.equal(star1.decision, 'not-cacheable-vary-star');
    assert.equal(star2.decision, 'not-cacheable-vary-star');
    assert.equal(star1.cached, false);
  });
  const starState = await jfetch(`${COLLECTOR}/api/state`);
  check('缓存中没有 Vary:* 条目', () => {
    for (const e of Object.values(starState.entries)) assert.ok(!e.varyHeaders.includes('*'));
  });
  await post(`${ORIGIN}/admin/switch-rule`, { ruleSetId: 'A' });

  console.log('\n[9] 头缺失 vs 空值 vs 大小写不敏感');
  await clearCache();
  const noLangRes = await collect(H.noLang);
  const emptyLangRes = await collect(H.emptyLang);
  check('缺失与空值是不同维度（默认 en），缓存键不同', () => {
    assert.match(noLangRes.body, /hello world/);
    assert.match(emptyLangRes.body, /hello world/);
    assert.notEqual(noLangRes.cacheKey, emptyLangRes.cacheKey);
  });
  const lower = await collect(H.zhJsonUpper);
  const zhAgain = await collect(H.zhJson);
  await check('头名称大小写不敏感：小写头命中同一缓存键', () => {
    assert.equal(zhAgain.decision, 'cache-hit-fresh');
    assert.equal(lower.cacheKey, zhAgain.cacheKey);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
} catch (err) {
  console.error('测试运行失败:', err);
  failed += 1;
} finally {
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}
