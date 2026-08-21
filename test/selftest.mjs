// 自检：验证 D1 垫片和 MD5 补丁的行为，以及 _worker.js 能否被加载。
// 用法: node test/selftest.mjs
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { applyWorkersCompat } from '../src/compat.mjs';
import { openD1 } from '../src/d1.mjs';

applyWorkersCompat();

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push([name, true]);
    console.log(`  ok   ${name}`);
  } catch (err) {
    checks.push([name, false]);
    console.error(`  FAIL ${name}: ${err.message}`);
    if (process.env.JXPAN_TEST_STACK === '1') console.error(err.stack);
  }
}

await check('crypto.subtle.digest("MD5") 返回正确摘要', async () => {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode('abc'));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(hex, '900150983cd24fb0d6963f7d28e17f72');
});

await check('crypto.subtle.digest("SHA-256") 未被破坏', async () => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
  assert.equal(new Uint8Array(buf).length, 32);
});

const db = openD1(':memory:');

await check('prepare().run() 建表', async () => {
  const r = await db.prepare('CREATE TABLE kv (id INTEGER PRIMARY KEY, k TEXT UNIQUE, v TEXT)').run();
  assert.equal(r.success, true);
});

await check('bind().run() 返回 changes / last_row_id 且为 number', async () => {
  const r = await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind('token', 'abc123').run();
  assert.equal(r.meta.changes, 1);
  assert.equal(typeof r.meta.last_row_id, 'number');
  assert.equal(r.meta.last_row_id, 1);
  JSON.stringify(r); // BigInt 会在这里抛
});

await check('first() 返回行对象，first(col) 返回列值', async () => {
  const row = await db.prepare('SELECT * FROM kv WHERE k = ?').bind('token').first();
  assert.equal(row.v, 'abc123');
  const v = await db.prepare('SELECT v FROM kv WHERE k = ?').bind('token').first('v');
  assert.equal(v, 'abc123');
});

await check('first() 无匹配行返回 null', async () => {
  assert.equal(await db.prepare('SELECT * FROM kv WHERE k = ?').bind('nope').first(), null);
  assert.equal(await db.prepare('SELECT v FROM kv WHERE k = ?').bind('nope').first('v'), null);
});

await check('all() 返回 { success, results, meta }', async () => {
  const r = await db.prepare('SELECT * FROM kv').all();
  assert.equal(r.success, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].k, 'token');
});

await check('bind() 不修改原语句（D1 语义）', async () => {
  const stmt = db.prepare('SELECT v FROM kv WHERE k = ?');
  assert.equal(await stmt.bind('token').first('v'), 'abc123');
  assert.equal(await stmt.bind('nope').first('v'), null);
});

await check('boolean / undefined 参数被规整', async () => {
  const r = await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind(true, undefined).run();
  assert.equal(r.meta.changes, 1);
  assert.equal(await db.prepare('SELECT v FROM kv WHERE k = ?').bind(1).first('v'), null);
});

await check('exec() 执行多条语句', async () => {
  const r = await db.exec('CREATE TABLE a (x); CREATE TABLE b (y);');
  assert.equal(r.count, 2);
});

await check('batch() 在事务中执行', async () => {
  const r = await db.batch([
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind('b1', '1'),
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind('b2', '2'),
  ]);
  assert.equal(r.length, 2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM kv').first('c')), 4);
});

db.close();

// ---- qr-persist：用假 worker 验证拦截逻辑，不碰网络 ----
const { withQrPersistence } = await import('../src/qr-persist.mjs');

function stubWorker(pollBody) {
  const calls = [];
  const worker = {
    async fetch(request) {
      const action = new URL(request.url).searchParams.get('action');
      calls.push(request.url);
      const body = action?.endsWith('_qr_save')
        ? { code: 200, msg: '保存成功', success: true }
        : pollBody;
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  };
  return { worker, calls };
}

await check('qr-persist: 拿到 cookie 时补调 quark_qr_save 并改写 status', async () => {
  const { worker, calls } = stubWorker({ success: true, data: { status: 'waiting', cookie: '__pus=a; __uid=b' } });
  const wrapped = withQrPersistence(worker);
  const res = await wrapped.fetch(new Request('http://x/?action=quark_qr_poll&token=t'), {}, {});
  const json = await res.json();
  assert.equal(json.data.status, 'confirmed');
  const save = calls.find((u) => u.includes('quark_qr_save'));
  assert.ok(save, '应触发 quark_qr_save');
  assert.equal(new URL(save).searchParams.get('cookie'), '__pus=a; __uid=b');
});

await check('qr-persist: 只有 ticket 时回退成 ticket= 形式', async () => {
  const { worker, calls } = stubWorker({ success: true, data: { status: 'waiting', ticket: 'tk123' } });
  await withQrPersistence(worker).fetch(new Request('http://x/?action=quark_qr_poll'), {}, {});
  const save = calls.find((u) => u.includes('quark_qr_save'));
  assert.equal(new URL(save).searchParams.get('cookie'), 'ticket=tk123');
});

await check('qr-persist: 未拿到凭据时不动响应、不触发保存', async () => {
  const { worker, calls } = stubWorker({ success: true, data: { status: 'waiting' } });
  const res = await withQrPersistence(worker).fetch(new Request('http://x/?action=quark_qr_poll'), {}, {});
  assert.equal((await res.json()).data.status, 'waiting');
  assert.equal(calls.filter((u) => u.includes('_qr_save')).length, 0);
});

await check('qr-persist: 光鸭 access_token 映射到多个参数', async () => {
  const { worker, calls } = stubWorker({
    success: true,
    data: { status: 'x', access_token: 'AT', refresh_token: 'RT', expires_in: 7200, device_id: 'DEV' },
  });
  await withQrPersistence(worker).fetch(new Request('http://x/?action=guangya_qr_poll'), {}, {});
  const q = new URL(calls.find((u) => u.includes('guangya_qr_save'))).searchParams;
  assert.equal(q.get('access_token'), 'AT');
  assert.equal(q.get('refresh_token'), 'RT');
  assert.equal(q.get('expires_in'), '7200');
  assert.equal(q.get('device_id'), 'DEV');
});

await check('qr-persist: 非 poll 请求原样透传', async () => {
  const { worker, calls } = stubWorker({ success: true, data: { cookie: 'x' } });
  await withQrPersistence(worker).fetch(new Request('http://x/?action=get_stats'), {}, {});
  assert.equal(calls.length, 1);
});

await check('qr-persist: QR_AUTOSAVE=false 时返回原 worker', async () => {
  const { worker } = stubWorker({ success: true, data: {} });
  assert.equal(withQrPersistence(worker, { enabled: false }), worker);
});

// ---- aria2 RPC 客户端：用 stub fetch 断言请求体形状 ----
const { rpcCall, addUri } = await import('../src/aria2.mjs');

function stubFetch(reply) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

await check('aria2: 有密钥时 token: 是 params 第 0 项', async () => {
  const s = stubFetch({ result: 'gid1' });
  try {
    await addUri({ rpc_url: 'http://x/jsonrpc', rpc_token: 'sec' }, ['http://f'], { out: 'a.bin' });
    assert.deepEqual(s.seen[0].body.params[0], 'token:sec');
    assert.deepEqual(s.seen[0].body.params[1], ['http://f']);
    assert.deepEqual(s.seen[0].body.params[2], { out: 'a.bin' });
    assert.equal(s.seen[0].body.method, 'aria2.addUri');
  } finally { s.restore(); }
});

await check('aria2: 无密钥时不塞空占位', async () => {
  const s = stubFetch({ result: 'gid2' });
  try {
    await addUri({ rpc_url: 'http://x/jsonrpc', rpc_token: '' }, ['http://f']);
    assert.deepEqual(s.seen[0].body.params, [['http://f']]);
  } finally { s.restore(); }
});

await check('aria2: 返回 HTML 时给出端口提示，而不是裸 JSON 解析错误', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<!DOCTYPE html><html><body>hi</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  try {
    await assert.rejects(
      () => rpcCall({ rpc_url: 'http://host/jsonrpc' }, 'aria2.getVersion'),
      /不是 JSON.*没指向 aria2.*6800.*16800/s,
    );
  } finally { globalThis.fetch = original; }
});

await check('aria2: 非 2xx 先报 HTTP 状态', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 401 });
  try {
    await assert.rejects(() => rpcCall({ rpc_url: 'http://h/j' }, 'aria2.getVersion'), /HTTP 401/);
  } finally { globalThis.fetch = original; }
});

await check('aria2: error 转成异常并带上 code', async () => {
  const s = stubFetch({ error: { code: 1, message: 'Unauthorized' } });
  try {
    await assert.rejects(
      () => rpcCall({ rpc_url: 'http://x/jsonrpc' }, 'aria2.getVersion'),
      /aria2 错误 1: Unauthorized/,
    );
  } finally { s.restore(); }
});

await check('aria2: 未配置地址直接报错', async () => {
  await assert.rejects(() => rpcCall({}, 'aria2.getVersion'), /未配置 RPC 地址/);
});

// ---- host_config：表优先于环境变量 ----
const { initHostConfig, readConfig, writeConfig, maskConfig } = await import('../src/host-config.mjs');
const cfgDb = openD1(':memory:');
await initHostConfig(cfgDb);

await check('host_config: 环境变量兜底', async () => {
  const { config, sources } = await readConfig(cfgDb, { ARIA2_RPC_URL: 'http://env/jsonrpc' });
  assert.equal(config.rpc_url, 'http://env/jsonrpc');
  assert.equal(sources.rpc_url, 'env');
  assert.equal(sources.rpc_dir, 'unset');
});

await check('host_config: 表覆盖环境变量', async () => {
  await writeConfig(cfgDb, { rpc_url: 'http://saved/jsonrpc', rpc_token: 'tk' });
  const { config, sources } = await readConfig(cfgDb, { ARIA2_RPC_URL: 'http://env/jsonrpc' });
  assert.equal(config.rpc_url, 'http://saved/jsonrpc');
  assert.equal(sources.rpc_url, 'saved');
});

await check('host_config: 密钥传空串表示不修改', async () => {
  await writeConfig(cfgDb, { rpc_token: '' });
  const { config } = await readConfig(cfgDb, {});
  assert.equal(config.rpc_token, 'tk');
});

await check('host_config: maskConfig 不回明文密钥', async () => {
  const { config, sources } = await readConfig(cfgDb, {});
  const masked = maskConfig(config, sources);
  assert.equal(masked.config.rpc_token, '__SET__');
  assert.equal(masked.config.rpc_url, 'http://saved/jsonrpc');
});

// ---- host-routes：push 流程 ----
const { withHostRoutes } = await import('../src/host-routes.mjs');

function stubParseWorker(parseReply, loginStatus) {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      calls.push(request.url);
      const action = new URL(request.url).searchParams.get('action');
      const payload = action === 'login_status' ? (loginStatus ?? { success: true, data: {} }) : parseReply;
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  };
}

async function pushWith({ parseReply, body, shareHost = 'pan.quark.cn', loginStatus, mode }) {
  const db = openD1(':memory:');
  await initHostConfig(db);
  // 带 rpc_token，所以下面断言里 params[0] 是 "token:…"、params[1] 是 uris、params[2] 是 options
  await writeConfig(db, {
    rpc_url: 'http://aria2/jsonrpc',
    rpc_token: 'tk',
    rpc_dir: '/dl',
    public_base_url: 'http://nas:8787',
    ...(mode ? { push_mode: mode } : {}),
  });
  const inner = stubParseWorker(parseReply, loginStatus);
  const s = stubFetch({ result: 'GID' });
  try {
    const handler = withHostRoutes(inner, { db, requireAdmin: false });
    const res = await handler.fetch(
      new Request('http://local/_host/rpc/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? { shareUrl: `https://${shareHost}/s/abc` }),
      }),
      {},
      {},
    );
    return { json: await res.json(), rpc: s.seen, parseCalls: inner.calls };
  } finally { s.restore(); }
}

await check('push: 先用 type=json 拿文件名，再推 type=down 链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: '影片.mkv', download_url: 'https://cdn/x' } },
  });
  assert.match(r.parseCalls[0], /type=json/);
  const options = r.rpc[0].body.params[2];
  const uri = r.rpc[0].body.params[1][0];
  assert.match(uri, /^http:\/\/nas:8787\/\?/);
  assert.match(uri, /type=down/);
  assert.equal(options.out, '影片.mkv');
  assert.equal(options.dir, '/dl');
  assert.equal(r.json.success, true);
});

// ---- 推送模式：直链 vs JxPan 链接 ----

await check('push(auto): UC 走 302，直推裸直链不带头部', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mp4', download_url: 'https://uc-cdn/f?sign=1' } },
    shareHost: 'drive.uc.cn',
  });
  assert.equal(r.rpc[0].body.params[1][0], 'https://uc-cdn/f?sign=1');
  assert.equal(r.rpc[0].body.params[2].header, undefined);
  assert.equal(r.json.data.results[0].via, 'direct');
  assert.equal(r.json.data.baseUrl, null, '没走 JxPan 就不该回 baseUrl');
});

await check('push(auto): 夸克有 Cookie 时直推直链并补上请求头', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mkv', download_url: 'https://quark-cdn/f' } },
    shareHost: 'pan.quark.cn',
    loginStatus: { success: true, data: { quark: { logged_in: true, loginInfo: { cookie: '__pus=X; __uid=Y' } } } },
  });
  const header = r.rpc[0].body.params[2].header;
  assert.equal(r.rpc[0].body.params[1][0], 'https://quark-cdn/f');
  assert.ok(header.some((h) => h === 'Cookie: __pus=X; __uid=Y'), `缺 Cookie 头: ${header}`);
  assert.ok(header.some((h) => h === 'Referer: https://pan.quark.cn/'), `缺 Referer: ${header}`);
  assert.ok(header.some((h) => /^User-Agent: .*quark-cloud-drive/.test(h)), `UA 不对: ${header}`);
  assert.equal(r.json.data.results[0].via, 'direct');
});

await check('push(auto): 夸克缺 Cookie 时退回 JxPan 链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mkv', download_url: 'https://quark-cdn/f' } },
    shareHost: 'pan.quark.cn',
    loginStatus: { success: true, data: { quark: { logged_in: false, loginInfo: null } } },
  });
  assert.equal(r.json.data.results[0].via, 'jxpan');
  assert.match(r.json.data.results[0].reason, /凭据/);
  assert.match(r.rpc[0].body.params[1][0], /^http:\/\/nas:8787\/\?.*type=down/);
  assert.equal(r.rpc[0].body.params[2].split, '1');
});

await check('push(auto): 阿里请求头复刻不了，恒走 JxPan 链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mkv', download_url: 'https://ali-cdn/f' } },
    shareHost: 'www.alipan.com',
  });
  assert.equal(r.json.data.results[0].via, 'jxpan');
  assert.match(r.json.data.results[0].reason, /请求头/);
  assert.equal(r.rpc[0].body.params[2].split, '1');
});

await check('push(auto): 光鸭用 Bearer access_token 直推', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mkv', download_url: 'https://gy-cdn/f' } },
    shareHost: 'guangyapan.com',
    loginStatus: { success: true, data: { guangya: { logged_in: true, loginInfo: { access_token: 'AT123' } } } },
  });
  const header = r.rpc[0].body.params[2].header;
  assert.ok(header.some((h) => h === 'Authorization: Bearer AT123'), `缺 Authorization: ${header}`);
  assert.equal(r.json.data.results[0].via, 'direct');
});

await check('push(jxpan): 强制模式下 UC 也走 JxPan 链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mp4', download_url: 'https://uc-cdn/f' } },
    shareHost: 'drive.uc.cn',
    mode: 'jxpan',
  });
  assert.equal(r.json.data.results[0].via, 'jxpan');
  assert.match(r.rpc[0].body.params[1][0], /^http:\/\/nas:8787\//);
});

await check('push(direct): 强制模式下阿里也直推（不带头部，自负风险）', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mkv', download_url: 'https://ali-cdn/f' } },
    shareHost: 'www.alipan.com',
    mode: 'direct',
  });
  assert.equal(r.json.data.results[0].via, 'direct');
  assert.equal(r.rpc[0].body.params[1][0], 'https://ali-cdn/f');
});

await check('push: 未识别的网盘保守走 JxPan 链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.zip', download_url: 'https://unknown/f' } },
    shareHost: 'some-new-pan.example.com',
  });
  assert.equal(r.json.data.results[0].via, 'jxpan');
});

await check('push: 没有 download_url 时只能走 JxPan 链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.mp4' } },
    shareHost: 'drive.uc.cn',
  });
  assert.equal(r.json.data.results[0].via, 'jxpan');
  assert.match(r.json.data.results[0].reason, /download_url/);
});

await check('host-routes: 默认要求管理员身份，未登录回 401', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  await db.prepare('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)').run();
  const handler = withHostRoutes(stubParseWorker({}), { db }); // requireAdmin 默认 true
  const res = await handler.fetch(new Request('http://local/_host/rpc/config'), {}, {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).needAuth, true);
});

await check('host-routes: client.js 不需要鉴权', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  await db.prepare('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)').run();
  const handler = withHostRoutes(stubParseWorker({}), { db });
  const res = await handler.fetch(new Request('http://local/_host/rpc/client.js'), {}, {});
  assert.equal(res.status, 200);
});

await check('host-routes: 带有效 admin_token 时放行', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  await db.prepare('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)').run();
  await db.prepare('INSERT INTO kv_store (key, value, expires_at) VALUES (?, ?, 0)')
    .bind('admin_token', JSON.stringify({ token: 'GOOD', expiresAt: Date.now() + 60_000 })).run();
  const handler = withHostRoutes(stubParseWorker({}), { db });
  const res = await handler.fetch(
    new Request('http://local/_host/rpc/config', { headers: { cookie: 'admin_token=GOOD' } }), {}, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
});

await check('portWarning: 没端口时警告，有端口时放过', async () => {
  const { portWarning } = await import('../src/host-routes.mjs');
  assert.match(portWarning('http://192.168.1.9/jsonrpc'), /没写端口.*6800.*16800/);
  assert.match(portWarning('https://aria2.example.com/jsonrpc'), /连到 443/);
  assert.equal(portWarning('http://192.168.1.9:6800/jsonrpc'), null);
  assert.equal(portWarning(''), null);
  assert.match(portWarning('不是URL'), /不是合法 URL/);
});

await check('config 保存时把端口警告带回去', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  const handler = withHostRoutes(stubParseWorker({}), { db, requireAdmin: false });
  const res = await handler.fetch(
    new Request('http://local/_host/rpc/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpc_url: 'http://192.168.1.9/jsonrpc' }),
    }), {}, {});
  const payload = await res.json();
  assert.equal(payload.success, true);
  assert.match(payload.warning, /没写端口/);
});

await check('host_config: push_mode 只接受合法值', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  await writeConfig(db, { push_mode: 'direct' });
  assert.equal((await readConfig(db, {})).config.push_mode, 'direct');
  await writeConfig(db, { push_mode: '../etc/passwd' });
  assert.equal((await readConfig(db, {})).config.push_mode, 'direct', '非法值不该写进去');
});

await check('push: 夸克/阿里退回 JxPan 时强制单连接', async () => {
  const quark = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.bin', download_url: 'u' } },
    shareHost: 'pan.quark.cn',
  });
  assert.equal(quark.rpc[0].body.params[2].split, '1');
  assert.equal(quark.rpc[0].body.params[2]['max-connection-per-server'], '1');

  const uc = await pushWith({
    parseReply: { success: true, data: { file_name: 'a.bin', download_url: 'u' } },
    shareHost: 'drive.uc.cn',
  });
  assert.equal(uc.rpc[0].body.params[2].split, undefined);
});

await check('push: 多文件逐个推送并用各自 file_id', async () => {
  const r = await pushWith({
    parseReply: {
      success: true,
      data: { file_count: 2, files: [
        { file_name: 'a.mp4', file_id: 'F1' },
        { file_name: 'b.mp4', file_id: 'F2' },
      ] },
    },
  });
  assert.equal(r.rpc.length, 2);
  assert.match(r.rpc[0].body.params[1][0], /id=F1/);
  assert.match(r.rpc[1].body.params[1][0], /id=F2/);
  assert.equal(r.json.msg, '成功 2/2');
});

await check('push: paramUrl 能拆出 url/pwd/id', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'c.iso' } },
    body: { paramUrl: '/?url=https%3A%2F%2Fpan.quark.cn%2Fs%2Fzzz&pwd=1234&id=FID&type=down' },
  });
  assert.match(r.parseCalls[0], /pwd=1234/);
  assert.match(r.parseCalls[0], /id=FID/);
  assert.match(r.rpc[0].body.params[1][0], /pwd=1234/);
});

await check('push: paramUrl 里的 fid 链原样带进解析和回连链接', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'd.mkv' } },
    shareHost: 'www.alipan.com', // 恒走 JxPan 链接，好断言回连 URL
    body: {
      paramUrl:
        '/?url=https%3A%2F%2Fwww.alipan.com%2Fs%2Fzzz&fid=L1&fid2=L2&fid3=L3&d=FID&type=down',
    },
  });
  for (const url of [r.parseCalls[0], r.rpc[0].body.params[1][0]]) {
    const q = new URL(url).searchParams;
    assert.equal(q.get('fid'), 'L1', url);
    assert.equal(q.get('fid2'), 'L2', url);
    assert.equal(q.get('fid3'), 'L3', url);
    assert.equal(q.get('id'), 'FID', url);
  }
});

// 夸克是这个 bug 的实际现场：worker 的 quark 分支拿 fid 链逐级 browseFolder，
// 再用最后一级当 pdir_fid 调 downloadFileById。丢了链就只查根目录，
// 报 "在当前文件夹中未找到指定文件"（两级以上目录时自动搜子文件夹也救不回来）。
await check('push: 夸克多级目录 —— fid 链进解析，直链带 Cookie 推送', async () => {
  const r = await pushWith({
    parseReply: {
      success: true,
      mode: 'download',
      data: {
        file_name: '第01集.mkv',
        download_url: 'https://quark-cdn/f?sign=1',
        is_quark_direct_link: true,
      },
    },
    shareHost: 'pan.quark.cn',
    loginStatus: { success: true, data: { quark: { logged_in: true, loginInfo: { cookie: '__pus=X' } } } },
    body: {
      paramUrl:
        '/?url=https%3A%2F%2Fpan.quark.cn%2Fs%2Fabc&fid=DIR1&fid2=DIR2&d=FILEFID&type=down',
    },
  });
  const q = new URL(r.parseCalls[0]).searchParams;
  assert.equal(q.get('fid'), 'DIR1');
  assert.equal(q.get('fid2'), 'DIR2');
  assert.equal(q.get('id'), 'FILEFID');
  assert.equal(r.json.data.results[0].via, 'direct');
  assert.equal(r.rpc[0].body.params[1][0], 'https://quark-cdn/f?sign=1');
  assert.ok(r.rpc[0].body.params[2].header.includes('Cookie: __pus=X'));
});

await check('push: pan123_auth 一起透传', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'e.zip' } },
    body: { paramUrl: '/?url=https%3A%2F%2Fwww.123pan.com%2Fs%2Fzzz&pan123_auth=TK&type=down' },
  });
  assert.equal(new URL(r.parseCalls[0]).searchParams.get('pan123_auth'), 'TK');
});

await check('push: body.fids 摊成 fid/fid1/fid2', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: 'f.iso' } },
    shareHost: 'www.alipan.com',
    body: { shareUrl: 'https://www.alipan.com/s/abc', id: 'F9', fids: ['A', 'B'] },
  });
  const q = new URL(r.parseCalls[0]).searchParams;
  assert.equal(q.get('fid'), 'A');
  assert.equal(q.get('fid1'), 'B');
  assert.equal(q.get('id'), 'F9');
});

await check('push: 没有 fid 时不塞空参数', async () => {
  const r = await pushWith({ parseReply: { success: true, data: { file_name: 'g.bin' } } });
  assert.ok(!r.parseCalls[0].includes('fid'), r.parseCalls[0]);
});

await check('push: 文件名里的路径分隔符被清掉', async () => {
  const r = await pushWith({
    parseReply: { success: true, data: { file_name: '../../etc/passwd' } },
  });
  const out = r.rpc[0].body.params[2].out;
  assert.ok(!out.includes('/'), `out 仍含斜杠: ${out}`);
  assert.ok(!out.startsWith('.'), `out 仍以点开头: ${out}`);
});

await check('push: 解析失败时不推送', async () => {
  const r = await pushWith({ parseReply: { success: false, msg: '文件不存在' } });
  assert.equal(r.rpc.length, 0);
  assert.match(r.json.msg, /文件不存在/);
});

await check('host-routes: 未配置 rpc_url 回 needConfig', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  const handler = withHostRoutes(stubParseWorker({}), { db, requireAdmin: false });
  const res = await handler.fetch(
    new Request('http://local/_host/rpc/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareUrl: 'https://x/s/a' }),
    }), {}, {});
  const json = await res.json();
  assert.equal(json.needConfig, true);
});

await check('host-routes: client.js 以 js 类型返回', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  const handler = withHostRoutes(stubParseWorker({}), { db, requireAdmin: false });
  const res = await handler.fetch(new Request('http://local/_host/rpc/client.js'), {}, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /推送到 Aria2/);
});

await check('host-routes: 非 /_host 路径原样透传', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  const inner = stubParseWorker({ ok: 1 });
  const handler = withHostRoutes(inner, { db });
  await handler.fetch(new Request('http://local/?url=x'), {}, {});
  assert.equal(inner.calls.length, 1);
});

// ---- 注入脚本：在极简假 DOM 里真跑一遍 ----
// 按钮识别和插入逻辑只有浏览器里才会执行，不这么测就等于没测。
const { createContext, runInContext } = await import('node:vm');

function fakeDom() {
  const byId = new Map();

  function element(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      id: '',
      dataset: {},
      style: { cssText: '' },
      children: [],
      attrs: {},
      innerHTML: '',
      textContent: '',
      value: '',
      disabled: false,
      title: '',
      parentNode: null,
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; },
      addEventListener() {},
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      remove() {
        const siblings = this.parentNode?.children;
        const index = siblings?.indexOf(this) ?? -1;
        if (index >= 0) siblings.splice(index, 1);
      },
      querySelectorAll(selector) {
        const out = [];
        const walk = (n) => {
          for (const child of n.children) {
            const isTag = selector === child.tagName.toLowerCase();
            const isRpcAttr = selector === '[data-jx-rpc]' && child.dataset.jxRpc;
            const isNoteAttr = selector === '[data-jx-note]' && child.dataset.jxNote;
            if (isTag || isRpcAttr || isNoteAttr) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    };
    return node;
  }

  const body = element('body');
  const document = {
    readyState: 'complete',
    body,
    createElement: element,
    addEventListener() {},
    getElementById(id) { return byId.get(id) ?? null; },
  };

  return {
    document,
    body,
    register(id, node) { node.id = id; byId.set(id, node); return node; },
    element,
  };
}

async function runClientScript({ hideShortLink = true, prefillCredentials = true, loginStatus } = {}) {
  const script = await (await withHostRoutes(stubParseWorker({}), { requireAdmin: false, db: await (async () => {
    const d = openD1(':memory:'); await initHostConfig(d); return d;
  })() }).fetch(
    new Request('http://local/_host/rpc/client.js'),
    {},
    {},
  )).text();

  const dom = fakeDom();
  const sandbox = {
    document: dom.document,
    fetch: async (url) => {
      const body = String(url).includes('action=login_status')
        ? (loginStatus ?? { success: true, data: {} })
        : {};
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    },
    setTimeout,
    console,
    Response,
    Promise,
  };
  sandbox.window = sandbox;
  const context = createContext(sandbox);

  // 前端页面里这两个函数是顶层声明，脚本靠包装它们插按钮
  const seen = { modal: 0, result: 0 };
  sandbox.updateParseDialog = () => { seen.modal += 1; };
  sandbox.displayResult = () => { seen.result += 1; };

  // 凭据输入框要先存在，脚本 init 时才回填得到
  const wrapper = dom.element('div');
  dom.document.body.appendChild(wrapper);
  const inputs = {};
  for (const id of ['aliyunAuth', 'quarkCookie', 'ucCookie', 'c189Token', 'guangyaLogin', 'mcloudAuth', 'mcloudCookie']) {
    const box = wrapper.appendChild(dom.element('label'));
    inputs[id] = dom.register(id, box.appendChild(dom.element('input')));
  }

  runInContext(
    `window.__JXPAN_HOST__ = ${JSON.stringify({ hideShortLink, prefillCredentials })};\n` +
      script.replace(/^window\.__JXPAN_HOST__=[^\n]*\n/, ''),
    context,
  );
  // prefillCredentials 是异步的，等它的 promise 链跑完
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { sandbox, dom, seen, inputs };
}

await check('client.js: 带上宿主开关前缀', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  const res = await withHostRoutes(stubParseWorker({}), { db, requireAdmin: false })
    .fetch(new Request('http://local/_host/rpc/client.js'), {}, {});
  const text = await res.text();
  assert.match(text, /^window\.__JXPAN_HOST__=\{[^\n]*"hideShortLink":true/);
  assert.equal(text.match(/__JXPAN_HOST__=/g).length, 1, '前缀不应重复注入');
});

await check('client.js: 在假 DOM 里能初始化并挂上浮动按钮', async () => {
  const { dom, sandbox } = await runClientScript();
  const buttons = dom.body.querySelectorAll('button');
  assert.ok(buttons.some((b) => b.textContent.includes('Aria2')), '未挂上 ⚙ Aria2 按钮');
  assert.equal(typeof sandbox.updateParseDialog, 'function');
});

await check('client.js: 弹窗里删掉短链按钮、加上推送按钮', async () => {
  const { sandbox, dom } = await runClientScript();
  const actions = dom.register('modalActions', dom.element('div'));

  const shortBtn = dom.element('button');
  shortBtn.id = 'modalShortBtn';
  shortBtn.textContent = '生成短链';
  const downBtn = dom.element('button');
  downBtn.textContent = '下载此文件';
  actions.appendChild(shortBtn);
  actions.appendChild(downBtn);

  sandbox.updateParseDialog({ paramUrl: '/?url=x&type=down', fileName: 'a.mkv' });

  const labels = actions.children.map((b) => b.textContent || b.innerHTML);
  assert.ok(!labels.some((t) => t.includes('短链')), `短链按钮没被删掉: ${labels}`);
  assert.ok(labels.some((t) => t.includes('推送到 Aria2')), `推送按钮没加上: ${labels}`);
  assert.ok(labels.some((t) => t.includes('下载此文件')), '误删了下载按钮');
});

await check('client.js: HIDE_SHORT_LINK=false 时保留短链按钮', async () => {
  const { sandbox, dom } = await runClientScript({ hideShortLink: false });
  const actions = dom.register('modalActions', dom.element('div'));
  const shortBtn = dom.element('button');
  shortBtn.setAttribute('onclick', 'generateShortLink(this)');
  shortBtn.textContent = '生成短链接';
  actions.appendChild(shortBtn);

  sandbox.updateParseDialog({ paramUrl: '/?url=x&type=down' });
  assert.ok(actions.children.some((b) => b.textContent.includes('短链')), '短链按钮被误删');
});

await check('client.js: 结果区按 onclick 识别并删掉短链按钮', async () => {
  const { sandbox, dom } = await runClientScript();
  const box = dom.register('result', dom.element('div'));
  const shortBtn = dom.element('button');
  shortBtn.setAttribute('onclick', 'generateShortLink(this)');
  shortBtn.textContent = '生成短链接';
  box.appendChild(shortBtn);

  sandbox.displayResult({ success: true, data: { download_url: 'https://cdn/x', file_name: 'a.mkv' } });

  const labels = box.children.map((b) => b.textContent || b.innerHTML);
  assert.ok(!labels.some((t) => t.includes('短链')), `短链按钮没被删掉: ${labels}`);
  assert.ok(labels.some((t) => t.includes('推送到 Aria2')), `推送按钮没加上: ${labels}`);
});

await check('client.js: 推送按钮不会重复插入', async () => {
  const { sandbox, dom } = await runClientScript();
  const box = dom.register('result', dom.element('div'));
  const payload = { success: true, data: { download_url: 'u', file_name: 'a' } };
  sandbox.displayResult(payload);
  sandbox.displayResult(payload);
  assert.equal(box.querySelectorAll('[data-jx-rpc]').length, 1);
});

// ---- 凭据回填到「网盘配置」输入框 ----

const PREFILL_STATUS = {
  success: true,
  data: {
    quark: { logged_in: true, source: 'qrcode', loginInfo: { cookie: '__pus=A; __uid=B' } },
    uc: { logged_in: true, source: 'env_var', loginInfo: { cookie: 'uc=1' } },
    aliyun: { logged_in: true, source: 'qrcode', loginInfo: { authorization: 'Bearer eyJx' } },
    cloud189: { logged_in: true, source: 'qrcode', loginInfo: { open_access_token: 'OPEN1', access_token: 'ACC1' } },
    guangya: { logged_in: true, source: 'qrcode', loginInfo: { access_token: 'GY', refresh_token: 'RT' } },
    mcloud: { logged_in: false, source: null, loginInfo: null },
  },
};

await check('prefill: 把库里的凭据填进对应输入框', async () => {
  const { inputs } = await runClientScript({ loginStatus: PREFILL_STATUS });
  assert.equal(inputs.quarkCookie.value, '__pus=A; __uid=B');
  assert.equal(inputs.ucCookie.value, 'uc=1');
  assert.equal(inputs.aliyunAuth.value, 'Bearer eyJx');
  assert.equal(inputs.c189Token.value, 'OPEN1', '天翼应优先用 open_access_token');
  assert.equal(JSON.parse(inputs.guangyaLogin.value).access_token, 'GY', '光鸭应填整个 JSON');
});

await check('prefill: 填过的框带上来源说明', async () => {
  const { inputs } = await runClientScript({ loginStatus: PREFILL_STATUS });
  const note = inputs.quarkCookie.parentNode.querySelector('[data-jx-note]');
  assert.ok(note, '缺少来源说明');
  assert.match(note.textContent, /已从数据库载入.*qrcode/);
});

await check('prefill: 不覆盖用户已手填的值', async () => {
  const dom0 = await runClientScript({ loginStatus: { success: true, data: {} } });
  dom0.inputs.quarkCookie.value = '我自己填的';
  // 再跑一次回填，值不应被冲掉
  const { inputs } = await runClientScript({ loginStatus: PREFILL_STATUS });
  inputs.ucCookie.value = 'MINE';
  assert.equal(inputs.ucCookie.value, 'MINE');
  assert.equal(dom0.inputs.quarkCookie.value, '我自己填的');
});

await check('prefill: 未登录（已脱敏）时只提示存在，不显示内容', async () => {
  const { inputs } = await runClientScript({
    loginStatus: { success: true, data: { quark: { logged_in: true, source: 'qrcode' } } },
  });
  assert.equal(inputs.quarkCookie.value, '', '脱敏时不该有值');
  const note = inputs.quarkCookie.parentNode.querySelector('[data-jx-note]');
  assert.match(note.innerHTML, /href="\/admin"/, '应给出可点的登录链接');
  assert.ok(!note.innerHTML.includes('__pus'), '脱敏时不该带上凭据内容');
});

await check('prefill: 未登录的网盘不加说明', async () => {
  const { inputs } = await runClientScript({ loginStatus: PREFILL_STATUS });
  assert.equal(inputs.mcloudAuth.value, '');
  assert.equal(inputs.mcloudAuth.parentNode.querySelector('[data-jx-note]'), null);
});

await check('prefill: PREFILL_CREDENTIALS=false 时完全不动', async () => {
  const { inputs } = await runClientScript({ loginStatus: PREFILL_STATUS, prefillCredentials: false });
  assert.equal(inputs.quarkCookie.value, '');
  assert.equal(inputs.quarkCookie.parentNode.querySelector('[data-jx-note]'), null);
});

await check('client.js: 前缀带上 prefillCredentials 开关', async () => {
  const db = openD1(':memory:');
  await initHostConfig(db);
  const res = await withHostRoutes(stubParseWorker({}), { db, requireAdmin: false })
    .fetch(new Request('http://local/_host/rpc/client.js'), {}, {});
  assert.match(await res.text(), /"prefillCredentials":true/);
});

// ---- 代理配置自检 ----
const { proxyHints } = await import('../src/proxy-hints.mjs');

await check('proxy: 没配代理时一句话都不说', async () => {
  assert.deepEqual(proxyHints({}), []);
});

await check('proxy: 配了代理但没开 NODE_USE_ENV_PROXY 要告警', async () => {
  const hints = proxyHints({ HTTP_PROXY: 'http://p:8080', NO_PROXY: '127.0.0.1,localhost' });
  assert.equal(hints.length, 1);
  assert.match(hints[0], /NODE_USE_ENV_PROXY=1.*会直接忽略代理/s);
});

await check('proxy: NO_PROXY 里的网段写法要点名', async () => {
  const hints = proxyHints({
    HTTPS_PROXY: 'http://p:8080',
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: '127.0.0.1,localhost,192.168.31.0/24',
  }, '22.23.2');
  assert.equal(hints.length, 1);
  assert.match(hints[0], /不支持网段写法.*192\.168\.31\.0\/24/s);
});

await check('proxy: NO_PROXY 缺本机地址要提醒', async () => {
  const hints = proxyHints({ HTTPS_PROXY: 'http://p:8080', NODE_USE_ENV_PROXY: '1', NO_PROXY: 'example.com' }, '24.0.0');
  assert.match(hints.join(' '), /至少包含 127\.0\.0\.1,localhost/);
});

await check('proxy: Node 版本太低时告警', async () => {
  const hints = proxyHints(
    { HTTPS_PROXY: 'http://p:8080', NODE_USE_ENV_PROXY: '1', NO_PROXY: '127.0.0.1,localhost' },
    '22.14.0',
  );
  assert.match(hints[0], /不支持 NODE_USE_ENV_PROXY.*22\.21\.0/s);
});

await check('proxy: 配置正确时不告警', async () => {
  const hints = proxyHints(
    { HTTPS_PROXY: 'http://p:8080', NODE_USE_ENV_PROXY: '1', NO_PROXY: '127.0.0.1,localhost,192.168.31.139' },
    '22.23.2',
  );
  assert.deepEqual(hints, []);
});

// ---- HTML 注入 ----
const { injectIntoHtml, withHtmlInjection } = await import('../src/inject.mjs');

await check('inject: </body> 前插入且只插一次', async () => {
  const out = injectIntoHtml('<html><body><p>x</p></body></html>');
  assert.match(out, /<script src="\/_host\/rpc\/client\.js" defer><\/script><\/body>/);
  assert.equal(out.match(/client\.js/g).length, 1);
});

await check('inject: 没有 </body> 时返回 null（不猜结构）', async () => {
  assert.equal(injectIntoHtml('<div>片段</div>'), null);
});

await check('inject: 非 HTML 响应不动', async () => {
  const inner = { async fetch() { return new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }); } };
  const res = await withHtmlInjection(inner).fetch(new Request('http://x/'), {}, {});
  assert.equal(await res.text(), '{"a":1}');
});

// ---- login_status 脱敏 ----
const { withCredentialGuard, sanitizeLoginStatus } = await import('../src/guard.mjs');

const LOGIN_STATUS = {
  code: 200, success: true,
  data: {
    quark: { logged_in: true, source: 'env_var', expired: false, loginInfo: { cookie: '__pus=SECRET' } },
    aliyun: { logged_in: false, source: null, expired: false, loginInfo: null },
  },
};

function statusWorker() {
  return { async fetch() {
    return new Response(JSON.stringify(LOGIN_STATUS), { headers: { 'content-type': 'application/json' } });
  } };
}

async function guardDb(tokenRow) {
  const db = openD1(':memory:');
  await db.prepare('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)').run();
  if (tokenRow) {
    await db.prepare('INSERT INTO kv_store (key, value, expires_at) VALUES (?, ?, 0)')
      .bind('admin_token', JSON.stringify(tokenRow)).run();
  }
  return db;
}

await check('guard: 无 cookie 时删掉 loginInfo、保留状态字段', async () => {
  const db = await guardDb({ token: 'T', expiresAt: Date.now() + 60_000 });
  const res = await withCredentialGuard(statusWorker(), { db })
    .fetch(new Request('http://x/?action=login_status'), {}, {});
  const json = await res.json();
  assert.equal(json.data.quark.loginInfo, undefined);
  assert.equal(json.data.quark.logged_in, true);
  assert.equal(json.data.quark.source, 'env_var');
  assert.ok(!JSON.stringify(json).includes('SECRET'));
});

await check('guard: 带正确 admin_token 时原样透传明文', async () => {
  const db = await guardDb({ token: 'T', expiresAt: Date.now() + 60_000 });
  const res = await withCredentialGuard(statusWorker(), { db })
    .fetch(new Request('http://x/?action=login_status', { headers: { cookie: 'a=1; admin_token=T' } }), {}, {});
  assert.equal((await res.json()).data.quark.loginInfo.cookie, '__pus=SECRET');
});

await check('guard: token 过期则脱敏', async () => {
  const db = await guardDb({ token: 'T', expiresAt: Date.now() - 1000 });
  const res = await withCredentialGuard(statusWorker(), { db })
    .fetch(new Request('http://x/?action=login_status', { headers: { cookie: 'admin_token=T' } }), {}, {});
  assert.equal((await res.json()).data.quark.loginInfo, undefined);
});

await check('guard: token 不匹配则脱敏', async () => {
  const db = await guardDb({ token: 'RIGHT', expiresAt: Date.now() + 60_000 });
  const res = await withCredentialGuard(statusWorker(), { db })
    .fetch(new Request('http://x/?action=login_status', { headers: { cookie: 'admin_token=WRONG' } }), {}, {});
  assert.equal((await res.json()).data.quark.loginInfo, undefined);
});

await check('guard: 其他 action 不经过脱敏逻辑', async () => {
  const db = await guardDb(null);
  const res = await withCredentialGuard(statusWorker(), { db })
    .fetch(new Request('http://x/?action=get_stats'), {}, {});
  assert.equal((await res.json()).data.quark.loginInfo.cookie, '__pus=SECRET');
});

await check('guard: sanitizeLoginStatus 保留非对象值', async () => {
  const out = sanitizeLoginStatus({ success: true, data: { weird: 'str', quark: { logged_in: true, loginInfo: {} } } });
  assert.equal(out.data.weird, 'str');
  assert.equal(out.data.quark.loginInfo, undefined);
});

// ---- 首页登录门（复用 guardDb 造 admin_token）----
const { withHomeGate } = await import('../src/home-gate.mjs');

const HTML = { accept: 'text/html,application/xhtml+xml' };
function pageWorker() {
  return { async fetch() {
    return new Response('<html><body>front</body></html>', { headers: { 'content-type': 'text/html' } });
  } };
}

await check('home-gate: 未登录访问首页 302 到 /admin', async () => {
  const db = await guardDb(null);
  const res = await withHomeGate(pageWorker(), { db })
    .fetch(new Request('http://x/', { headers: HTML }), {}, {});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

await check('home-gate: 带 url 参数的首页解析同样被拦', async () => {
  const db = await guardDb(null);
  const res = await withHomeGate(pageWorker(), { db })
    .fetch(new Request('http://x/?url=https%3A%2F%2Fpan.quark.cn%2Fs%2Fabc', { headers: HTML }), {}, {});
  assert.equal(res.status, 302);
});

await check('home-gate: 已登录放行', async () => {
  const db = await guardDb({ token: 'T', expiresAt: Date.now() + 60_000 });
  const res = await withHomeGate(pageWorker(), { db })
    .fetch(new Request('http://x/', { headers: { ...HTML, cookie: 'admin_token=T' } }), {}, {});
  assert.equal(res.status, 200);
});

await check('home-gate: aria2 回连的 type=down 不受影响', async () => {
  const db = await guardDb(null);
  const res = await withHomeGate(pageWorker(), { db })
    .fetch(new Request('http://x/?url=https%3A%2F%2Fx%2Fs%2Fa&type=down'), {}, {});
  assert.equal(res.status, 200);
});

await check('home-gate: XHR（action=）与 /admin、/s/ 不受影响', async () => {
  const db = await guardDb(null);
  const gated = withHomeGate(pageWorker(), { db });
  for (const url of ['http://x/?action=login_status', 'http://x/admin', 'http://x/s/abc']) {
    const res = await gated.fetch(new Request(url, { headers: HTML }), {}, {});
    assert.equal(res.status, 200, url);
  }
});

await check('home-gate: HOME_REQUIRE_ADMIN=false 时返回原 handler', async () => {
  const inner = pageWorker();
  assert.equal(withHomeGate(inner, { db: null, enabled: false }), inner);
});

await check('_worker.js 可被加载且导出 default.fetch', async () => {
  const path = resolve(import.meta.dirname, '..', '_worker.js');
  const { default: worker } = await import(pathToFileURL(path).href);
  assert.equal(typeof worker?.fetch, 'function');
});

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
