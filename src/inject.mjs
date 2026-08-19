// 往 worker 生成的 HTML 里插一行 script，用来加「推送到 Aria2」按钮。
// 用外链而不是内联：注入只加几十字节，脚本本身能被浏览器缓存，也方便单独调试。
const TAG = '<script src="/_host/rpc/client.js" defer></script>';

export function injectIntoHtml(html) {
  const index = html.lastIndexOf('</body>');
  if (index === -1) return null; // 结构不认识就不猜，原样返回
  return html.slice(0, index) + TAG + html.slice(index);
}

export function withHtmlInjection(inner, { enabled = true } = {}) {
  if (!enabled) return inner;

  return {
    async fetch(request, env, ctx) {
      const response = await inner.fetch(request, env, ctx);
      if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;

      const html = await response.text();
      const injected = injectIntoHtml(html);
      return new Response(injected ?? html, { status: response.status, headers: response.headers });
    },
  };
}
