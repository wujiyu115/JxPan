// 各网盘直链推给 aria2 时需要的请求头。
//
// 配方全部对齐 worker-src.js（上游明文源码）里各家网盘的 getXxxDownloadHeaders()。
// 早期 _worker.js 是混淆过的，阿里的 header 构造函数被控制流平坦化读不出来，
// 只能退回推 JxPan 链接；现在有明文源码，直接照抄。
// 判断依据是 handleResponse() 对每家网盘的处理方式：
//   走真 302 的（UC / 天翼 / 123 / 蓝奏优享）—— 浏览器拿到裸链就能下，说明直链
//     自带签名、不需要任何头部，aria2 同理，可以直推。
//   走 proxyDownload() 的（夸克 / 阿里 / 光鸭）—— 直链必须带 Cookie/Authorization
//     + Referer + 专用 UA，裸推必然 403。
// 拿不准的网盘一律退回 JxPan 链接（一定能用），需要时可强制 direct 模式自行尝试。

const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 ' +
  'Safari/537.36 Channel/pckk_other_ch';

const GUANGYA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 对齐 getQuarkDownloadHeaders()。省掉 Connection / Accept-Encoding / Sec-Fetch-*：
// 那些是浏览器传输层的噪音，交给 aria2 自己管，留着反而可能干扰分片。
function quarkHeaders(credential, env) {
  const cookie = credential?.cookie || env.QK_COOKIE || '';
  if (!cookie) return null; // 没 Cookie 直推必 403，让调用方退回 JxPan 链接
  return {
    'User-Agent': env.QK_USER_AGENT || QUARK_UA,
    Cookie: cookie,
    Referer: 'https://pan.quark.cn/',
    Origin: 'https://pan.quark.cn',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}

// 对齐 getGuangyaDownloadHeaders()。注意 Referer 用的是 guangyupan.com
// （和 README 里写的 guangyapan.com 不是一个域名），照代码来。
function guangyaHeaders(credential, env) {
  const token = credential?.access_token;
  if (!token) return null;
  return {
    'User-Agent': env.GY_USER_AGENT || GUANGYA_UA,
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://guangyupan.com/',
    Origin: 'https://guangyupan.com',
  };
}

const ALIYUN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

// 对齐 getAliyunDownloadHeaders(config, authorization)：
// 阿里的 type=down 走 proxyDownload，直链裸推必 403，必须带 Authorization + Referer。
// 凭据来自 login_status 里 aliyun.loginInfo.authorization（扫码或 env 都会归到这里）。
function aliyunHeaders(credential, env) {
  const token = credential?.authorization || env.ALIYUN_AUTHORIZATION || '';
  if (!token) return null; // 没凭据直推必 403，让调用方退回 JxPan 链接
  return {
    Referer: 'https://www.alipan.com/',
    'User-Agent': env.ALIYUN_USER_AGENT || ALIYUN_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
  };
}

// platform 对应 login_status 响应里的键名
const PROVIDERS = [
  { name: 'quark', test: /pan\.quark\.cn/i, direct: true, platform: 'quark', headers: quarkHeaders, proxyStream: true },
  { name: 'uc', test: /drive\.uc\.cn|fast\.uc\.cn/i, direct: true },
  { name: 'cloud189', test: /cloud\.189\.cn/i, direct: true },
  { name: 'pan123', test: /123pan\.(?:cn|com)/i, direct: true },
  { name: 'ilanzou', test: /ilanzou\.com/i, direct: true },
  { name: 'guangya', test: /guangyapan\.com|guangyupan\.com/i, direct: true, platform: 'guangya', headers: guangyaHeaders, proxyStream: true },
  { name: 'aliyun', test: /alipan\.com|aliyundrive\.com/i, direct: true, platform: 'aliyun', headers: aliyunHeaders, proxyStream: true },
];

export function detectProvider(shareUrl) {
  return PROVIDERS.find((p) => p.test.test(shareUrl)) ?? null;
}

// 夸克/阿里的 type=down 是服务端代理流，未必支持 Range，多线程分片会拿到坏文件
export function needsSingleConnection(shareUrl) {
  return detectProvider(shareUrl)?.proxyStream === true;
}

// 内部向 worker 要一次 login_status（无鉴权接口，返回明文凭据）
async function loadCredential(inner, env, ctx, request, platform) {
  if (!platform) return null;
  const url = new URL('/', new URL(request.url).origin);
  url.searchParams.set('action', 'login_status');
  const response = await inner.fetch(new Request(url), env, ctx);
  const payload = await response.json().catch(() => null);
  return payload?.data?.[platform]?.loginInfo ?? null;
}

/**
 * 决定这次推送用直链还是 JxPan 链接。
 * mode: 'auto' | 'direct' | 'jxpan'
 * 返回 { kind: 'direct', headers } 或 { kind: 'jxpan', reason }
 */
export async function planPush({ inner, env, ctx, request, shareUrl, downloadUrl, mode, processEnv = process.env }) {
  if (mode === 'jxpan') return { kind: 'jxpan', reason: '配置为强制走 JxPan 链接' };
  if (!downloadUrl) return { kind: 'jxpan', reason: '解析结果没有 download_url' };

  const provider = detectProvider(shareUrl);
  if (!provider) {
    if (mode === 'direct') return { kind: 'direct', headers: {} };
    return { kind: 'jxpan', reason: '未识别的网盘，保守起点走 JxPan 链接' };
  }
  // 强制 direct：明知会 403 也照推，把能拼出来的头部带上
  if (mode === 'direct') {
    const credential = provider.platform ? await loadCredential(inner, env, ctx, request, provider.platform).catch(() => null) : null;
    return { kind: 'direct', headers: provider.headers?.(credential, processEnv) ?? {} };
  }
  if (!provider.headers) return { kind: 'direct', headers: {} };

  const credential = await loadCredential(inner, env, ctx, request, provider.platform);
  const headers = provider.headers(credential, processEnv);
  if (!headers) {
    return { kind: 'jxpan', reason: `${provider.name} 缺少可用凭据，直链会被拒` };
  }
  return { kind: 'direct', headers };
}

export function toAria2Headers(headers) {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}
