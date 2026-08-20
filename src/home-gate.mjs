// 未登录后台时，首页（解析页）直接 302 到 /admin。
// 自托管场景下网盘凭据全靠 /admin 里录入，没登录过的实例点解析必然失败，
// 与其让人对着报错猜，不如先把他送去登录。
//
// 只拦「浏览器打开首页」这一种请求，判据是 pathname === '/' 且 Accept 里有
// text/html。刻意放过的两类：
//   1. 带 type= 参数的（type=down / type=json）—— aria2 回连 JxPan 拿文件流走的
//      就是 /?url=…&type=down，它没有也不可能有 admin cookie；
//   2. 带 action= 参数的 —— 前端 XHR（含 login_status、扫码轮询），归 guard 管。
// /admin、/s/ 短链、/_host/* 都不在 '/' 上，天然不受影响。
import { isAdmin } from './guard.mjs';

export function shouldGate(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const url = new URL(request.url);
  if (url.pathname !== '/') return false;
  if (url.searchParams.has('type') || url.searchParams.has('action')) return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

export function withHomeGate(inner, { db, enabled = true, target = '/admin' } = {}) {
  if (!enabled) return inner;

  return {
    async fetch(request, env, ctx) {
      if (!shouldGate(request)) return inner.fetch(request, env, ctx);
      if (await isAdmin(db, request)) return inner.fetch(request, env, ctx);

      // no-store：登录完再回首页时不能命中这条重定向的缓存
      return new Response(null, {
        status: 302,
        headers: { location: target, 'cache-control': 'no-store' },
      });
    },
  };
}
