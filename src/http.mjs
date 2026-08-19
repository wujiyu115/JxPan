// node:http 的 IncomingMessage/ServerResponse 与 Web Request/Response 互转。
import { Readable } from 'node:stream';

// 逐跳首部不能透传给 fetch 层
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function resolveUrl(req, trustProxy) {
  const header = (name) => {
    const value = req.headers[name];
    return typeof value === 'string' ? value.split(',')[0].trim() : undefined;
  };
  // NAS 上通常挂在反代后面。不认这两个头，_worker.js 生成的短链会指向内网地址。
  const proto = (trustProxy && header('x-forwarded-proto')) || 'http';
  const host = (trustProxy && header('x-forwarded-host')) || req.headers.host || 'localhost';
  return new URL(req.url, `${proto}://${host}`);
}

export function toWebRequest(req, { trustProxy = true } = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(resolveUrl(req, trustProxy), {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual',
  });
}

export async function sendWebResponse(res, response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    // undici 的 fetch 已经解压过 body，但保留了 content-encoding；
    // 原样转发会让客户端二次解压失败。长度同理，交给 chunked。
    if (name === 'content-encoding' || name === 'content-length' || name === 'set-cookie') continue;
    headers[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers['set-cookie'] = cookies;

  res.writeHead(response.status, headers);

  // 302 直链跳转、204/304 都没有 body
  if (!response.body || res.req.method === 'HEAD' || response.status === 204 || response.status === 304) {
    res.end();
    await response.body?.cancel().catch(() => {});
    return;
  }

  const body = Readable.fromWeb(response.body);
  body.on('error', () => res.destroy());
  body.pipe(res);
}

export function createRequestHandler(worker, env, { trustProxy = true } = {}) {
  const ctx = {
    waitUntil(promise) {
      Promise.resolve(promise).catch((err) => console.error('[waitUntil]', err));
    },
    passThroughOnException() {},
  };

  return async function handle(req, res) {
    try {
      const response = await worker.fetch(toWebRequest(req, { trustProxy }), env, ctx);
      if (!(response instanceof Response)) throw new Error('worker.fetch 未返回 Response');
      await sendWebResponse(res, response);
    } catch (err) {
      console.error(`[${req.method} ${req.url}]`, err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 500, msg: '服务内部错误', error: String(err?.message ?? err) }));
    }
  };
}
