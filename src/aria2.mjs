// aria2 JSON-RPC 客户端（Motrix / AriaNg / aria2c --enable-rpc 通用）。
const TIMEOUT_MS = 10_000;
let sequence = 0;

export async function rpcCall(config, method, params = []) {
  if (!config?.rpc_url) throw new Error('未配置 RPC 地址');

  // aria2 约定：密钥必须是 params 的第 0 项，形如 "token:xxx"。
  // 没有密钥时不能传空串占位，否则会被当成第一个真实参数。
  const body = {
    id: String(++sequence),
    jsonrpc: '2.0',
    method,
    params: config.rpc_token ? [`token:${config.rpc_token}`, ...params] : params,
  };

  let response;
  try {
    response = await fetch(config.rpc_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // 地址不通/超时的原因藏在 cause 里，带出来才好排查
    const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message;
    throw new Error(`连接 RPC 失败: ${reason}`);
  }

  if (!response.ok) throw new Error(`RPC 返回 HTTP ${response.status}`);

  // 端口填错时最常见的表现：连到了某个网页服务，拿回一坨 HTML。
  // 直接抛 JSON 解析错误没人看得懂，这里说清到底怎么了。
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const contentType = response.headers.get('content-type') ?? '未知';
    throw new Error(
      `RPC 返回的不是 JSON（content-type: ${contentType}）—— ` +
        `${config.rpc_url} 很可能没指向 aria2。检查端口：aria2c 默认 6800，Motrix 默认 16800`,
    );
  }
  if (json?.error) throw new Error(`aria2 错误 ${json.error.code}: ${json.error.message}`);
  return json?.result;
}

export const getVersion = (config) => rpcCall(config, 'aria2.getVersion');

export const addUri = (config, uris, options) =>
  rpcCall(config, 'aria2.addUri', options ? [uris, options] : [uris]);
