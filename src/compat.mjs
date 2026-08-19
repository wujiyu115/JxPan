// Cloudflare Workers 运行时兼容补丁。
// 必须在 import('_worker.js') 之前执行。
import { createHash } from 'node:crypto';

// Workers 的 crypto.subtle.digest 支持 "MD5"，这是 Cloudflare 的私有扩展，
// 标准 WebCrypto（含 Node）不支持。_worker.js 依赖它计算网盘接口签名。
function patchMd5Digest() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || subtle.__jxpanMd5Patched) return;

  const original = subtle.digest.bind(subtle);
  const patched = async function digest(algorithm, data) {
    const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
    if (typeof name === 'string' && name.toUpperCase() === 'MD5') {
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const hash = createHash('md5').update(bytes).digest();
      // 复制到独立 ArrayBuffer，避免暴露 Node Buffer 的共享内存池
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    }
    return original(algorithm, data);
  };

  Object.defineProperty(subtle, 'digest', { value: patched, writable: true, configurable: true });
  Object.defineProperty(subtle, '__jxpanMd5Patched', { value: true });
}

// _worker.js 自身的 bug 兜底：
//   saveAdminToken 存的是字符串 -> storePut 走 d1PutRaw 存明文 JSON
//   -> storeGet 见到 "{" 开头就 JSON.parse 返回对象
//   -> verifyAdminToken 又 JSON.parse(对象) -> String(对象) = "[object Object]" -> 抛错
// 结果后台登录态永远无法通过校验（这个 bug 在 Cloudflare 上同样存在）。
// 这里只把「传入非 null 对象」这一种必然抛错的情况改成原样返回，
// 其余输入行为完全不变，所以不会掩盖真实的 JSON 语法错误。
function patchTolerantJsonParse() {
  if (JSON.parse.__jxpanTolerant) return;
  const original = JSON.parse;
  let warned = false;
  const patched = function parse(text, reviver) {
    if (typeof text === 'object' && text !== null) {
      if (!warned) {
        warned = true;
        console.warn('[compat] JSON.parse 收到对象，已原样返回（规避 _worker.js 的 admin_token 双重解析 bug）');
      }
      return text;
    }
    return original(text, reviver);
  };
  Object.defineProperty(patched, '__jxpanTolerant', { value: true });
  JSON.parse = patched;
}

export function applyWorkersCompat() {
  patchMd5Digest();
  patchTolerantJsonParse();
}
