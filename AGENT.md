# AGENT.md — 本仓库维护约定

## 仓库结构

本仓库是 [ByLsPro/JxPan](https://github.com/ByLsPro/JxPan) 的下游自托管 fork，叠加了一层 Node.js 宿主代码。

```
worker-src.js   ← 上游的「未加密源码」，自托管的默认解析内核（明文，可读可改）
_worker.js      ← 上游的混淆发布物，仅作回退（WORKER_PATH 指向它时才加载）
src/            ← 宿主层（零 npm 依赖，Node >= 22.13），wrapper 链套在 worker 外面
test/           ← 自检 node test/selftest.mjs，改动后必须全绿
data/           ← 本地 SQLite（不入库），冒烟测试用 DB_PATH 指向它
```

宿主层 wrapper 链（内→外）见 `src/server.mjs` 顶部注释：qr-persist → host-routes →
guard → inject → home-gate。每层只管自己那件事，顺序有讲究，不要随意调整。

## 同步上游的规则

上游 remote 是 `upstream`（https://github.com/ByLsPro/JxPan）。同步流程：

1. `git fetch upstream main`
2. **上游的 `未加密源码.js` 是同步主目标**：拉到后必须重命名为 `worker-src.js`
   （`git mv 未加密源码.js worker-src.js`），保持仓库里没有中文文件名。
   `_worker.js` 也跟着同步，但仅作回退用途，不要更新它的引用。
3. 合并时**只接受上游对这两个 worker 文件的改动**；上游不会动 `src/`、`test/`、
   `Dockerfile` 等，出现这类冲突一律保留本仓库版本。
4. 同步后必做：
   - `npm test`（全部通过，加载检查默认验证 `worker-src.js`）
   - 本地冒烟：`DB_PATH=./data/jxpan.db PORT=8799 node src/server.mjs`，
     确认首页 / `/admin` / `?action=login_status` 正常
5. **同步后要复查三件事**（上游的已知 bug，靠宿主层 wrapper 兜底，上游若修复了
   才能拆兜底，没修复就原样保留）：
   - `verifyAdminToken` 对 `storeGet` 结果做二次 `JSON.parse` → `src/compat.mjs`
     的 `patchTolerantJsonParse` 兜底
   - `*_qr_poll` 成功响应缺 `status: "confirmed"`、凭据不落库 → `src/qr-persist.mjs` 兜底
   - `login_status` 无鉴权返回全部网盘明文凭据 → `src/guard.mjs` 脱敏兜底
6. 若上游改了各家网盘的 `getXxxDownloadHeaders()`（在 `worker-src.js` 里搜函数名），
   记得把新配方同步进 `src/pan-headers.mjs` —— 直推 aria2 的请求头全部复刻自那里，
   并更新 `test/selftest.mjs` 对应断言。

## 命名与提交约定

- 提交信息用中文，`feat:` / `fix:` / `refactor:` / `chore:` 前缀，正文写清楚「为什么」。
- 环境变量开关默认行为写在 `.env.example`，文档改 `README.md`，两处要同步。
- 不要给 `src/` 引入 npm 依赖（镜像靠零依赖构建，见 Dockerfile）。
- `_worker.js` 是黑盒：不要试图解读或修改它，需要看实现时一律查 `worker-src.js`。
