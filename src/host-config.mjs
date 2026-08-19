// 宿主自有配置，存在独立的 host_config 表里。
// 刻意不用 worker 的 kv_store：那张表的读写会经过 worker 的 AES 加解密和
// storeGet 的「以 { 开头就 JSON.parse」逻辑，掺进去只会互相干扰。

// 配置项 -> 环境变量兜底
export const CONFIG_KEYS = {
  rpc_url: 'ARIA2_RPC_URL',
  rpc_token: 'ARIA2_RPC_TOKEN',
  rpc_dir: 'ARIA2_DIR',
  public_base_url: 'PUBLIC_BASE_URL',
  // auto（默认）| direct（强制推直链）| jxpan（强制推 JxPan 链接）
  push_mode: 'ARIA2_PUSH_MODE',
};

export const PUSH_MODES = ['auto', 'direct', 'jxpan'];

const SECRET_KEYS = new Set(['rpc_token']);

export async function initHostConfig(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS host_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
}

// 优先级：host_config 表 > 环境变量。UI 存过就以 UI 为准。
export async function readConfig(db, env = process.env) {
  const rows = (await db.prepare('SELECT key, value FROM host_config').all()).results;
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const config = {};
  const sources = {};
  for (const [key, envName] of Object.entries(CONFIG_KEYS)) {
    if (stored.has(key)) {
      config[key] = stored.get(key);
      sources[key] = 'saved';
    } else {
      config[key] = env[envName] ?? '';
      sources[key] = config[key] ? 'env' : 'unset';
    }
  }
  // 枚举项别回空串，调用方不用再兜一次
  if (!PUSH_MODES.includes(config.push_mode)) config.push_mode = 'auto';
  return { config, sources };
}

export async function writeConfig(db, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in CONFIG_KEYS)) continue;
    if (key === 'push_mode' && !PUSH_MODES.includes(value)) continue;
    // 密钥传空串表示「不修改」，避免前端因为打码回显而把已存的密钥清掉
    if (SECRET_KEYS.has(key) && value === '') continue;
    await db.prepare('INSERT OR REPLACE INTO host_config (key, value) VALUES (?, ?)').bind(key, String(value)).run();
  }
}

// 给前端看的版本：密钥不回明文
export function maskConfig(config, sources) {
  const out = {};
  for (const key of Object.keys(CONFIG_KEYS)) {
    out[key] = SECRET_KEYS.has(key) ? (config[key] ? '__SET__' : '') : config[key];
  }
  return { config: out, sources };
}
