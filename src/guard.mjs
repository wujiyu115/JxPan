// 安全加固：GET /?action=login_status 会把 9 家网盘的 cookie / authorization /
// access_token 明文全量吐出来，而它位于 handleMainRequest 里、**不在 /admin 的鉴权
// 分支内** —— 服务一旦能被公网访问，等于凭据裸奔。（panel.html 只在展示层截断，
// 服务端没有任何脱敏。）
//
// 这里在宿主层补一道校验：没有有效的管理员 cookie 就把 loginInfo 摘掉，只留
// logged_in / source / expired，后台面板的卡片状态照常显示。
// 已确认只有 panel.html 调用这个接口（front.html 0 次），且面板本身要登录，
// 所以不会破坏任何现有功能。设 PROTECT_CREDENTIALS=false 可关闭。
import { timingSafeEqual } from 'node:crypto';

const SAFE_FIELDS = ['logged_in', 'source', 'expired'];

function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function isAdmin(db, request) {
  const presented = readCookie(request, 'admin_token');
  if (!presented) return false;
  try {
    // admin_token 在 kv_store 里是明文 JSON —— 是 worker 的既有 bug
    // （saveAdminToken 传字符串导致走了不加密的 d1PutRaw，详见 compat.mjs 注释），
    // 副作用是宿主层不需要解密就能校验身份。
    const stored = await db.prepare('SELECT value FROM kv_store WHERE key = ?').bind('admin_token').first('value');
    if (!stored) return false;
    const data = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!data?.token) return false;
    if (data.expiresAt && data.expiresAt < Date.now()) return false;
    return sameToken(data.token, presented);
  } catch (err) {
    console.error('[guard] 校验管理员失败:', err.message);
    return false;
  }
}

export function sanitizeLoginStatus(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') return payload;

  const cleaned = {};
  for (const [platform, info] of Object.entries(data)) {
    if (!info || typeof info !== 'object') {
      cleaned[platform] = info;
      continue;
    }
    const kept = {};
    for (const field of SAFE_FIELDS) if (field in info) kept[field] = info[field];
    cleaned[platform] = kept;
  }
  return { ...payload, data: cleaned };
}

export function withCredentialGuard(inner, { db, enabled = true } = {}) {
  if (!enabled) return inner;

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.searchParams.get('action') !== 'login_status') return inner.fetch(request, env, ctx);

      const response = await inner.fetch(request, env, ctx);
      if (await isAdmin(db, request)) return response;

      if (!(response.headers.get('content-type') ?? '').includes('json')) return response;

      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return new Response(text, { status: response.status, headers: response.headers });
      }

      console.log('[guard] login_status 未通过管理员校验，已脱敏');
      return new Response(JSON.stringify(sanitizeLoginStatus(payload)), {
        status: response.status,
        headers: response.headers,
      });
    },
  };
}
