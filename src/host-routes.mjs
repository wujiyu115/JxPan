// 宿主层自有路由，全部挂在 /_host/ 下。
// worker 占用的路径是 /、/admin、/s/、/api/create-short，不冲突。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addUri, getVersion } from './aria2.mjs';
import { readConfig, writeConfig, maskConfig, CONFIG_KEYS, PUSH_MODES } from './host-config.mjs';
import { planPush, toAria2Headers, needsSingleConnection } from './pan-headers.mjs';
import { isAdmin } from './guard.mjs';

const PREFIX = '/_host/rpc/';

const CLIENT_SCRIPT = readFileSync(resolve(import.meta.dirname, 'client', 'rpc-client.js'), 'utf8');

// 注入脚本是静态文件，宿主侧的开关通过一段前缀传给它
function buildClientScript(env = process.env) {
  const flags = {
    hideShortLink: env.HIDE_SHORT_LINK !== 'false',
    prefillCredentials: env.PREFILL_CREDENTIALS !== 'false',
  };
  return `window.__JXPAN_HOST__=${JSON.stringify(flags)};\n${CLIENT_SCRIPT}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// 最容易犯的配置错误：地址不写端口，于是连到 80/443 上的某个网页服务。
// 不硬拦（有人确实把 aria2 挂在反代的 443 后面），但要当场说出来。
export function portWarning(rpcUrl) {
  if (!rpcUrl) return null;
  let parsed;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return `RPC 地址不是合法 URL: ${rpcUrl}`;
  }
  if (parsed.port) return null;
  return `地址没写端口，会连到 ${parsed.protocol === 'https:' ? 443 : 80} —— aria2c 默认 6800，Motrix 默认 16800。确认这是你想要的。`;
}

// 文件名来自网盘，可能含路径分隔符；不清掉会让 aria2 往 dir 之外写文件
function safeFileName(name) {
  if (!name) return undefined;
  const cleaned = String(name).replace(/[\\/]+/g, '_').replace(/^\.+/, '_').trim();
  return cleaned || undefined;
}

// aria2 是「它自己」去拉这个地址的，所以必须填 aria2 那边能访问到的地址。
// 没配就退回本次请求的 origin（http.mjs 已按 X-Forwarded-* 还原过）。
function resolveBaseUrl(request, config) {
  const configured = config.public_base_url?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

// 多级目录里的文件，worker 靠一条 fid 链逐层进文件夹才能定位到 id：
// 第一级是 fid，后面是 fid1…fid20（前端 showParseDialog 实际发的是 fid、fid2、fid3…，
// worker 两种都读）。丢了这条链，worker 只在根目录找 id，就报「未找到指定的文件」。
const FID_KEYS = ['fid', ...Array.from({ length: 20 }, (_, i) => `fid${i + 1}`)];
// 123 云盘的 token 也挂在参数链上，丢了拿不到直链
const PASSTHROUGH_KEYS = [...FID_KEYS, 'pan123_auth'];

function pickPassthrough(query) {
  const extra = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = query.get(key);
    if (value) extra[key] = value;
  }
  return extra;
}

// 文件夹链只有顺序有意义，按 worker 的读取顺序摊回 fid/fid1/fid2…
function fidsToExtra(fids) {
  const extra = {};
  const list = (Array.isArray(fids) ? fids : []).filter(Boolean).slice(0, FID_KEYS.length);
  list.forEach((fid, index) => {
    extra[FID_KEYS[index]] = String(fid);
  });
  return extra;
}

function applyParams(url, { shareUrl, pwd, fileId, extra }) {
  url.searchParams.set('url', shareUrl);
  if (pwd) url.searchParams.set('pwd', pwd);
  if (fileId) url.searchParams.set('id', fileId);
  for (const [key, value] of Object.entries(extra ?? {})) {
    url.searchParams.set(key, value);
  }
}

function buildDownloadUrl(baseUrl, target) {
  const url = new URL('/', `${baseUrl}/`);
  applyParams(url, target);
  url.searchParams.set('type', 'down');
  return url.toString();
}

// 内部派发给内层 handler，不走网络
async function parseShare(inner, env, ctx, request, target) {
  const url = new URL('/', new URL(request.url).origin);
  applyParams(url, target);
  url.searchParams.set('type', 'json');

  const headers = new Headers();
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);

  const response = await inner.fetch(new Request(url, { headers }), env, ctx);
  return response.json();
}

// 前端弹窗手里已经有现成的 paramUrl（形如 /?url=…&pwd=…&id=…&type=down），
// 直接拆它的 query 比让前端重新拼参数可靠。只取参数、不去 fetch 它，避免 SSRF。
function paramsFromParamUrl(paramUrl) {
  const query = new URL(paramUrl, 'http://jxpan.invalid/').searchParams;
  const shareUrl = query.get('url');
  if (!shareUrl) return null;
  return {
    shareUrl,
    pwd: query.get('pwd') ?? '',
    id: query.get('id') ?? query.get('d') ?? '',
    extra: pickPassthrough(query),
  };
}

async function handlePush(inner, env, ctx, request, db) {
  const body = await request.json().catch(() => ({}));

  let target = {
    shareUrl: body.shareUrl?.trim(),
    pwd: body.pwd ?? '',
    id: body.id ?? '',
    extra: fidsToExtra(body.fids),
  };
  if (!target.shareUrl && body.paramUrl) {
    try {
      target = paramsFromParamUrl(body.paramUrl) ?? target;
    } catch {
      return json({ success: false, msg: 'paramUrl 解析失败' }, 400);
    }
  }
  const shareUrl = target.shareUrl;
  if (!shareUrl) return json({ success: false, msg: '缺少 shareUrl' }, 400);
  body.pwd = target.pwd;
  body.id = target.id;
  const extra = target.extra ?? {};

  const { config } = await readConfig(db);
  if (!config.rpc_url) return json({ success: false, msg: '未配置 Aria2 RPC 地址', needConfig: true }, 400);

  const pwd = body.pwd ?? '';
  const parsed = await parseShare(inner, env, ctx, request, {
    shareUrl,
    pwd,
    fileId: body.id ?? '',
    extra,
  });
  if (!parsed?.success) {
    return json({ success: false, msg: `解析失败: ${parsed?.msg ?? '未知错误'}` }, 502);
  }

  const data = parsed.data ?? {};
  const items = Array.isArray(data.files) && data.files.length > 0 ? data.files : [data];

  const baseUrl = resolveBaseUrl(request, config);
  const singleFileOut = items.length === 1 ? safeFileName(body.out) : undefined;
  const dir = body.dir?.trim() || config.rpc_dir || undefined;
  const mode = PUSH_MODES.includes(config.push_mode) ? config.push_mode : 'auto';

  const results = [];
  for (const item of items) {
    const fileName = singleFileOut ?? safeFileName(item.file_name ?? item.name);
    // 调用方传了 id 就用它（单文件弹窗推送），否则用条目自己的 id。
    // 键名各家不一样：夸克文件夹列表用 fid，别家用 file_id / id。
    // 少了这一步，「整个分享只有一个文件」时回连链接会丢掉 id，
    // worker 收到没 id 的请求就回一整份文件夹列表 JSON，aria2 把 JSON 当文件存下来。
    const fileId = body.id || item.file_id || item.fid || item.id || data.file_id || '';

    // 能复刻请求头就直推网盘直链（aria2 直连 CDN，不过 JxPan）；
    // 复刻不了就退回推 JxPan 的 type=down 链接，让 worker 自己代理。
    const plan = await planPush({
      inner, env, ctx, request,
      shareUrl,
      downloadUrl: item.download_url,
      mode,
    });

    const options = {};
    let uri;
    if (plan.kind === 'direct') {
      uri = item.download_url;
      const header = toAria2Headers(plan.headers);
      if (header.length > 0) options.header = header;
    } else {
      uri = buildDownloadUrl(baseUrl, { shareUrl, pwd, fileId, extra });
      // JxPan 代理流未必支持 Range，分片会拿到坏文件
      if (needsSingleConnection(shareUrl)) {
        options.split = '1';
        options['max-connection-per-server'] = '1';
      }
    }
    if (dir) options.dir = dir;
    if (fileName) options.out = fileName;

    try {
      const gid = await addUri(config, [uri], Object.keys(options).length > 0 ? options : undefined);
      console.log(`[rpc] 已推送 ${fileName ?? uri} (${plan.kind}) -> gid ${gid}`);
      results.push({ ok: true, gid, file_name: fileName ?? null, via: plan.kind, reason: plan.reason ?? null });
    } catch (err) {
      console.error(`[rpc] 推送失败 ${fileName ?? uri} (${plan.kind}):`, err.message);
      results.push({ ok: false, error: err.message, file_name: fileName ?? null, via: plan.kind });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const usedJxpan = results.some((r) => r.via === 'jxpan');
  return json({
    success: okCount > 0,
    msg: `成功 ${okCount}/${results.length}`,
    data: { mode, baseUrl: usedJxpan ? baseUrl : null, results },
  });
}

// 调用前需要先 await initHostConfig(db) 建表，见 server.mjs
export function withHostRoutes(inner, { db, enabled = true, requireAdmin = true } = {}) {
  if (!enabled) return inner;

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(PREFIX)) return inner.fetch(request, env, ctx);

      const route = url.pathname.slice(PREFIX.length);

      try {
        if (route === 'client.js') {
          return new Response(buildClientScript(), {
            headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' },
          });
        }

        // 必须要管理员身份：改配置的人能把 rpc_url 指向自己的服务器，
        // 而 direct 模式的 addUri 参数里带着网盘 Cookie —— 不设门就是凭据外泄通道。
        // admin_token 的 Path 是 /，在 /admin 登录一次后解析页也带着，按钮照常可用。
        if (requireAdmin && !(await isAdmin(db, request))) {
          return json({ success: false, msg: '需要先登录后台（/admin）', needAuth: true }, 401);
        }

        if (route === 'config' && request.method === 'GET') {
          const { config, sources } = await readConfig(db);
          return json({ success: true, data: maskConfig(config, sources) });
        }

        if (route === 'config' && request.method === 'POST') {
          const patch = await request.json().catch(() => ({}));
          // 打码回显的占位值不能当成真值写回去
          if (patch.rpc_token === '__SET__') delete patch.rpc_token;
          await writeConfig(db, patch);
          const { config, sources } = await readConfig(db);
          return json({
            success: true,
            msg: '已保存',
            warning: portWarning(config.rpc_url),
            data: maskConfig(config, sources),
          });
        }

        if (route === 'test' && request.method === 'POST') {
          const { config } = await readConfig(db);
          const version = await getVersion(config);
          return json({ success: true, msg: `aria2 ${version.version}`, data: version });
        }

        if (route === 'push' && request.method === 'POST') {
          return handlePush(inner, env, ctx, request, db);
        }

        return json({ success: false, msg: '未知路由' }, 404);
      } catch (err) {
        console.error(`[rpc] ${route} 出错:`, err);
        return json({ success: false, msg: err.message ?? String(err) }, 500);
      }
    },
  };
}

export { CONFIG_KEYS };
