// 自托管侧增强：扫码登录成功后把凭据落库。
//
// _worker.js 的 *_qr_poll 拿到凭据后只写进程内全局变量，落库依赖前端在
// d.data.status === "confirmed" 时回调 *_qr_save。但 poll 的响应里
// status 并不是 "confirmed"，前端那条分支永远不跑 —— 结果扫码后能解析
// （靠进程内存），一重启就全丢，D1/SQLite 里始终没有 *_login_default。
//
// 这里在 poll 响应上做两件事：
//   1. 服务端直接补调一次 *_qr_save，保证即使用户立刻关掉页面也已落库
//   2. 把 data.status 补成 "confirmed"，让前端按它自己的逐网盘逻辑再存一次
//      （*_qr_save 是 INSERT OR REPLACE，重复保存无副作用），顺带让界面显示成功
//
// 注意：这是自托管特有的行为，部署在 Cloudflare 上不会有这一层。
// 设 QR_AUTOSAVE=false 可关闭。

function pick(data, keys) {
  const out = {};
  for (const key of keys) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  return out;
}

// 参数名与前端面板里各网盘的 *_qr_save 调用逐一对齐；
// 返回 null 表示这次轮询还没拿到可用凭据，不做任何事。
const PROVIDERS = {
  quark_qr_poll: {
    save: 'quark_qr_save',
    params: (d) =>
      d.cookie ? { cookie: d.cookie } : d.ticket ? { cookie: `ticket=${d.ticket}` } : null,
  },
  uc_qr_poll: {
    save: 'uc_qr_save',
    params: (d) => (d.ticket ? { cookie: `ticket=${d.ticket}` } : d.cookie ? { cookie: d.cookie } : null),
  },
  aliyun_qr_poll: {
    save: 'aliyun_qr_save',
    params: (d) => (d.authorization ? pick(d, ['authorization', 'ck', 'lgToken']) : null),
  },
  guangya_qr_poll: {
    save: 'guangya_qr_save',
    params: (d) =>
      d.access_token ? pick(d, ['access_token', 'refresh_token', 'expires_in', 'device_id']) : null,
  },
  feiji_qr_poll: {
    save: 'feiji_qr_save',
    params: (d) =>
      d.access_token
        ? { ...pick(d, ['access_token', 'refresh_token', 'expires_in', 'device_id']), login_method: d.token_type || 'oauth' }
        : null,
  },
};

export function withQrPersistence(worker, { enabled = true } = {}) {
  if (!enabled) return worker;

  return {
    async fetch(request, env, ctx) {
      const response = await worker.fetch(request, env, ctx);

      const url = new URL(request.url);
      const action = url.searchParams.get('action');
      const provider = action && PROVIDERS[action];
      if (!provider) return response;
      if (!(response.headers.get('content-type') ?? '').includes('json')) return response;

      // 轮询响应都很小，整体读进来无所谓
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return new Response(text, { status: response.status, headers: response.headers });
      }

      const data = payload?.data;
      const params = payload?.success && data ? provider.params(data) : null;
      if (!params) {
        return new Response(text, { status: response.status, headers: response.headers });
      }

      const saveUrl = new URL(url);
      saveUrl.search = '';
      saveUrl.searchParams.set('action', provider.save);
      for (const [key, value] of Object.entries(params)) saveUrl.searchParams.set(key, value);

      // 后台保存接口要登录态，把原请求的 cookie 带过去
      const headers = new Headers();
      const cookie = request.headers.get('cookie');
      if (cookie) headers.set('cookie', cookie);

      try {
        const saved = await worker.fetch(new Request(saveUrl, { headers }), env, ctx);
        const body = await saved.text();
        console.log(`[qr-persist] ${action} -> ${provider.save}: ${saved.status} ${body.slice(0, 120)}`);
      } catch (err) {
        console.error(`[qr-persist] ${provider.save} 保存失败:`, err);
      }

      if (data.status !== 'confirmed') data.status = 'confirmed';
      return new Response(JSON.stringify(payload), { status: response.status, headers: response.headers });
    },
  };
}
