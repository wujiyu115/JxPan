// 代理是完全可选的：只有出站访问网盘需要绕行时才配（企业网中间人、受限网络等）。
// 但 Node 对代理配置的坑很安静 —— 配错了不报错，只是默默不生效，然后表现为
// 请求挂到超时。这里在启动时把已知的坑挑明。

// NODE_USE_ENV_PROXY 在 Node 24.0.0 加入，并回移植到 22.21.0
function supportsEnvProxy(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major >= 24) return true;
  return major === 22 && minor >= 21;
}

export function proxyHints(env = process.env, nodeVersion = process.versions.node) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  const hints = [];
  if (!proxy) return hints;

  const noProxy = env.NO_PROXY || env.no_proxy || '';
  const enabled = env.NODE_USE_ENV_PROXY === '1';

  if (!enabled) {
    hints.push(
      '设了 HTTP(S)_PROXY 但没设 NODE_USE_ENV_PROXY=1 —— Node 的 fetch 会直接忽略代理，' +
        '不会报错。要么加上这个变量，要么去掉代理配置。',
    );
  } else if (!supportsEnvProxy(nodeVersion)) {
    hints.push(
      `当前 Node ${nodeVersion} 不支持 NODE_USE_ENV_PROXY（需要 >= 22.21.0 或 >= 24.0.0），` +
        '代理不会生效。',
    );
  }

  // 亲身踩过：NO_PROXY 只认主机名/IP/域名后缀，网段写法被静默忽略，
  // 结果本该直连的局域网地址被塞进代理，一路挂到超时。
  const cidr = noProxy.split(',').map((s) => s.trim()).filter((s) => s.includes('/'));
  if (cidr.length > 0) {
    hints.push(
      `NO_PROXY 不支持网段写法，${cidr.join('、')} 不会生效 —— 要写具体 IP 或域名后缀，` +
        '例如 192.168.1.10 或 .lan。',
    );
  }

  const entries = noProxy.split(',').map((s) => s.trim().toLowerCase());
  if (!entries.includes('127.0.0.1') || !entries.includes('localhost')) {
    hints.push(
      'NO_PROXY 建议至少包含 127.0.0.1,localhost —— 否则健康检查和本机 Aria2 RPC 也会走代理。',
    );
  }

  return hints;
}

export function logProxyStatus(env = process.env, log = console) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (!proxy) {
    log.log('出站代理: 未配置（直连）');
  } else {
    log.log(`出站代理: ${proxy}  NO_PROXY=${env.NO_PROXY || env.no_proxy || '(空)'}`);
  }
  for (const hint of proxyHints(env)) log.warn(`[代理] ${hint}`);
}
