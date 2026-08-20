// JxPan 自托管入口：把 Cloudflare Worker 跑在 Node.js 上。
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { applyWorkersCompat } from './compat.mjs';
import { openD1 } from './d1.mjs';
import { createRequestHandler } from './http.mjs';
import { withQrPersistence } from './qr-persist.mjs';
import { withCredentialGuard } from './guard.mjs';
import { withHtmlInjection } from './inject.mjs';
import { withHomeGate } from './home-gate.mjs';
import { withHostRoutes } from './host-routes.mjs';
import { initHostConfig } from './host-config.mjs';
import { logProxyStatus } from './proxy-hints.mjs';

// 必须先打补丁，_worker.js 顶层就可能触发 crypto.subtle
applyWorkersCompat();

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/data/jxpan.db';
const WORKER_PATH = process.env.WORKER_PATH ?? resolve(import.meta.dirname, '..', '_worker.js');
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';

const db = openD1(DB_PATH);
await initHostConfig(db);
const { default: worker } = await import(pathToFileURL(WORKER_PATH).href);
if (typeof worker?.fetch !== 'function') {
  throw new Error(`${WORKER_PATH} 没有导出 default.fetch`);
}

// 混淆代码里存在动态 env[key] 访问，无法用白名单，整个 process.env 透传。
// jxpan 是 _worker.js 里硬编码的 D1 绑定名。
const env = { ...process.env, jxpan: db };

// 宿主层增强，由内到外套在 worker 外面。每一层只管自己那一件事：
//   qr-persist  扫码凭据自动落库
//   host-routes /_host/rpc/* 自己处理，不透传给 worker
//   guard       login_status 凭据脱敏
//   inject      HTML 里插一行 script
//   home-gate   未登录后台时首页 302 到 /admin
//
// host-routes 刻意放在 guard **内侧**：它在 direct 模式下要内部读一次
// login_status 拿 Cookie 去拼 aria2 请求头，从内侧发起才不会被自己的脱敏挡住。
// 外部请求走的是 guard，照旧脱敏；host-routes 本身有管理员校验。
let handler = worker;
handler = withQrPersistence(handler, { enabled: process.env.QR_AUTOSAVE !== 'false' });
handler = withHostRoutes(handler, {
  db,
  enabled: process.env.ARIA2_RPC_ENABLED !== 'false',
  requireAdmin: process.env.RPC_REQUIRE_ADMIN !== 'false',
});
handler = withCredentialGuard(handler, { db, enabled: process.env.PROTECT_CREDENTIALS !== 'false' });
handler = withHtmlInjection(handler, { enabled: process.env.INJECT_RPC_BUTTON !== 'false' });
// 最外层：命中就直接 302，不浪费下面几层的活
handler = withHomeGate(handler, { db, enabled: process.env.HOME_REQUIRE_ADMIN !== 'false' });

const server = createServer(createRequestHandler(handler, env, { trustProxy: TRUST_PROXY }));
server.headersTimeout = 120_000;
server.requestTimeout = 0; // 大文件解析可能耗时较久

server.listen(PORT, HOST, () => {
  console.log(`JxPan 已启动: http://${HOST}:${PORT}  (数据库: ${DB_PATH}, 信任反代: ${TRUST_PROXY})`);
  // 代理是可选的，但配错了 Node 只会静默忽略，这里主动挑明
  logProxyStatus();
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`收到 ${signal}，正在关闭...`);
    server.close(() => {
      try {
        db.close();
      } catch {
        // 关库失败不阻塞退出
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
