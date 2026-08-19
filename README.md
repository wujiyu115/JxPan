## 📖 项目简介

**JxPan** 是一个基于 Cloudflare Workers 平台的网盘直链解析工具。它能够解析主流网盘分享链接，提取文件真实下载地址，并通过 JSON 格式输出或 302 重定向直接下载，有效绕过网盘客户端限制。

- 🖥️ **Demo 演示站点**：<https://jx.fsapk.xx.kg>
  - 🔑 **演示账号**：`admin`
  - 🔑 **演示密码**：`admin`
  - ⚠️ 演示站仅用于功能体验，数据会定期清理

### ✨ 核心特性

- 🔗 **直链解析**：支持解析网盘分享链接，获取文件真实下载直链
- 📡 **JSON 输出**：标准化 API 响应，方便二次开发集成
- 🔄 **302 重定向**：支持直接重定向到下载地址，实现无缝下载体验
- 🛡️ **边缘计算**：基于 Cloudflare Workers 平台，避免 IP 封禁
- ⚡ **高速稳定**：利用 CF 全球网络，解析速度快、可用性高
- 🌍 **全球访问**：自动选择最优节点，无视地域限制
- 📊 **统计功能**：记录解析次数、成功/失败次数
- 💾 **D1 数据库存储**：使用 Cloudflare D1 SQL 数据库存储数据
- 🔐 **数据加密**：所有敏感数据 AES 加密存储
- 🐳 **两种部署方式**：既可部署到 Cloudflare Workers，也可用 Docker 自托管到 NAS / VPS（D1 自动换成本地 SQLite）

***

## 🚀 支持平台

| 平台     | 域名                           | 状态    | 扫码登录  |
| ------ | ---------------------------- | ----- | ----- |
| 阿里云盘   | alipan.com / aliyundrive.com | ✅ 已支持 | ✅ 支持  |
| 夸克网盘   | pan.quark.cn                 | ✅ 已支持 | ✅ 支持  |
| UC网盘   | drive.uc.cn / fast.uc.cn     | ✅ 已支持 | ✅ 支持  |
| 移动云盘   | yun.139.com / caiyun.139.com | ✅ 已支持 | ❌ 不支持 |
| 天翼云盘   | cloud.189.cn                 | ✅ 已支持 | ✅ 支持  |
| 123云盘  | 123pan.cn                    | ✅ 已支持 | ❌ 不支持 |
| 小飞机网盘  | feijipan.com                 | ✅ 已支持 | -     |
| 蓝奏云优享版 | ilanzou.com                  | ✅ 已支持 | -     |
| 蓝奏云    | lanzou\*.com                 | ✅ 已支持 | -     |
| 光鸭云盘   | guangyapan.com               | ✅ 已支持 | ✅ 支持  |

> **注意**：\
> 阿里云盘、夸克网盘、UC网盘、移动云盘、天翼云盘、光鸭云盘、123云盘需要配置认证信息才能正常解析。推荐使用后台管理面板的扫码登录功能快速配置。\
> *123云盘需要配置 Token 才能下载文件（免费用户每日有10G下载流量）*\
> *小飞机网盘需要配置账号信息才能解析大文件（＞500MB）*

***

## 💡 快速部署

### ⚙️ Workers 部署

#### 1. 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)，进入 **Workers & Pages**
2. 点击 "创建服务"，输入服务名称（如 `jxpan`），点击 "创建服务"

#### 2. 上传代码

1. 进入 Worker 编辑页面，点击 "编辑代码"
2. 将 `_worker.js` 的完整代码粘贴到编辑器中
3. 点击 "保存并部署"

#### 3. 配置 D1 数据库（必需）

本项目使用 **Cloudflare D1 SQL 数据库** 存储数据（扫码登录信息、统计数据等）。

1. 在 Cloudflare Dashboard 中，进入 **"储存和数据库" → "D1 SQL 数据库"**
2. 点击 **"创建数据库"**，输入名称 `jxpan`
3. 创建完成后，进入 **"Workers & Pages" → 你的 Worker → 设置 → 绑定"**
4. 点击 **"添加绑定" → 选择 "D1 数据库"**
5. 变量名称填写 `jxpan`，选择刚创建的数据库
6. 点击 **"添加绑定"**

> D1 数据库表会在首次请求时自动创建，无需手动执行 SQL。

#### 4. 配置环境变量（可选）

对于需要认证的网盘，可以配置以下环境变量：

| 变量名                    | 说明                        | 适用平台 |
| ---------------------- | ------------------------- | ---- |
| `ALIYUN_AUTHORIZATION` | 阿里云盘的 Authorization Token | 阿里云盘 |
| `QK_COOKIE`            | 夸克网盘的 Cookie              | 夸克网盘 |
| `UC_COOKIE`            | UC网盘的 Cookie              | UC网盘 |
| `MCLOUD_AUTHORIZATION` | 移动云盘的 Authorization Token | 移动云盘 |
| `CLOUD189_TOKEN`       | 天翼云盘的 AccessToken         | 天翼云盘 |
| `PAN123_TOKEN`         | 123云盘的 Authorization Token | 123云盘 |
| `GY_Login`             | 光鸭云盘的登录信息 JSON            | 光鸭云盘 |

配置方法：

1. 在 Worker 页面点击 **"设置" → "变量"**
2. 点击 **"添加变量"**，输入变量名和值
3. 点击 **"保存"**

> **推荐**：通过后台管理面板 `/admin` 的扫码登录功能配置，无需手动填写环境变量。

#### 5. 绑定自定义域（推荐）

1. 在 **"触发器"** 选项卡点击 **"添加自定义域"**
2. 输入您的域名（如 `pan.yourdomain.com`），点击 **"添加自定义域"**
3. 按提示完成 DNS 解析，等待证书生效

#### 6. 配置后台管理面板（可选）

为了启用后台管理面板，需要配置以下环境变量：

| 变量名     | 说明      |
| ------- | ------- |
| `admin` | 后台登录用户名 |
| `pass`  | 后台登录密码  |

配置方法同上。

#### 7. 访问测试

- 访问 `https://your-domain.com/` 查看使用说明
- 访问 `https://your-domain.com/?url=分享链接` 进行解析测试
- 访问 `https://your-domain.com/admin` 进入后台管理面板
  - 演示站账号：`admin`
  - 演示站密码：`admin`

***

### 🐳 Docker 部署（NAS / 自托管）

除 Cloudflare Workers 外，本项目也可以直接跑在 NAS、VPS 或任何装了 Docker 的机器上。解析逻辑（`_worker.js`）完全复用，宿主层用 Node.js 提供 Workers 运行时的等价能力：

| Cloudflare 能力 | 自托管替代 |
| ------------- | ------------------------------------ |
| Workers 运行时  | Node.js 24（`src/server.mjs`）        |
| D1 SQL 数据库   | 本地 SQLite（`node:sqlite`，落盘为单文件） |
| 环境变量绑定       | 容器环境变量                              |

镜像零 npm 依赖，同时提供 `linux/amd64` 和 `linux/arm64`（x86 NAS 和 ARM NAS 都能直接拉）。

#### 1. 一条命令跑起来

```bash
mkdir -p jxpan/data && cd jxpan
docker run -d --name jxpan \
  -p 8787:8787 \
  -v "$PWD/data:/data" \
  -e admin=your_admin \
  -e pass=your_password \
  --restart unless-stopped \
  wujiyu115/jxpan:latest
```

访问 `http://<NAS-IP>:8787/` 即可，后台在 `/admin`。

#### 2. docker compose（推荐）

把仓库里的 `docker-compose.yml` 和 `.env.example` 拷到 NAS 上：

```bash
cp .env.example .env   # 改掉 ADMIN_PASS
docker compose up -d
docker compose logs -f
```

#### 3. 可用环境变量

网盘凭据的变量名与 Workers 部署完全一致（见上文表格），另外多几个宿主层选项：

| 变量名           | 默认值              | 说明                                          |
| ------------- | ---------------- | ------------------------------------------- |
| `admin`       | 无                | 后台登录用户名，不设则 `/admin` 不可用                    |
| `pass`        | 无                | 后台登录密码                                      |
| `PORT`        | `8787`           | 监听端口                                        |
| `DB_PATH`     | `/data/jxpan.db` | SQLite 数据库路径                                |
| `TRUST_PROXY` | `true`           | 是否采信 `X-Forwarded-Proto` / `X-Forwarded-Host` |
| `PUID`／`PGID` | `1000`           | 数据目录属主，NAS 上写不进数据库时改这里                      |
| `PROTECT_CREDENTIALS` | `true`   | 见「安全」一节                                     |
| `QR_AUTOSAVE` | `true`           | 扫码凭据自动落库                                    |

Aria2 相关变量见下面第 5 节。完整清单见 `.env.example`。

#### 4. 反向代理

强烈建议在前面挂 NAS 自带的反代并配 HTTPS。**反代必须传 `X-Forwarded-Proto` 和 `X-Forwarded-Host`**，否则程序生成的短链会指向内网地址（`http://192.168.x.x:8787/...`），分享出去打不开。

Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # 大文件 302 前的流式响应
}
```

#### 5. Aria2 / RPC 推送（Motrix、AriaNg、Aria2 Tools）

> 自托管版专有功能，Cloudflare 部署没有这一层。

解析成功后，结果弹窗和结果区会多出一个 **「⬇ 推送到 Aria2」** 按钮，点一下文件就进下载器。页面右下角的 **「⚙ Aria2」** 是配置入口。

配置项（UI 填的会覆盖环境变量，存在 `./data/jxpan.db` 的 `host_config` 表里）：

| 项 | 环境变量 | 说明 |
| --- | --- | --- |
| RPC 地址 | `ARIA2_RPC_URL` | 完整地址。Motrix 默认 `http://127.0.0.1:16800/jsonrpc`，aria2c 默认端口 `6800` |
| RPC 密钥 | `ARIA2_RPC_TOKEN` | 无密钥留空 |
| 保存目录 | `ARIA2_DIR` | **aria2 那一侧**的路径 |
| 推送方式 | `ARIA2_PUSH_MODE` | `auto`（默认）/ `direct` / `jxpan`，见下表 |
| JxPan 对外地址 | `PUBLIC_BASE_URL` | **可选，一般留空**。只在退回 JxPan 链接时用到 |

**默认（`auto`）优先直推网盘直链，aria2 直连 CDN，不经过 JxPan。** aria2 支持给每个任务单独设请求头，所以需要鉴权的网盘也能直推：

| 网盘 | worker 内部怎么下 | 推送方式 |
| --- | --- | --- |
| UC、天翼、123、蓝奏优享 | 真 302 甩给浏览器 | **直链**，裸推即可（浏览器也没发任何特殊头） |
| 夸克 | 服务端代理 + 请求头 | **直链** + 自动补 `Cookie` / `Referer` / quark-cloud-drive 专用 UA |
| 光鸭 | 服务端代理 + 请求头 | **直链** + 自动补 `Authorization: Bearer …` |
| 阿里云盘 | 服务端代理 + 请求头 | 退回 **JxPan 链接** —— 它的请求头构造函数被混淆器做了控制流平坦化，复刻不出来 |
| 其他 / 未识别 | — | 保守退回 **JxPan 链接**（一定能用） |

夸克和光鸭的凭据从 `login_status` 内部读取，所以**得先扫码登录过**；没有凭据时会自动退回 JxPan 链接而不是让任务 403。推送成功的提示里会写明这次是「直链」还是「经 JxPan 代理」以及原因。

`direct` 强制全部直推（阿里可能 403，自负风险）；`jxpan` 强制全部走 JxPan 链接，兼容性最好但夸克/阿里的流量要过一遍 JxPan。

> ⚠️ **只有退回 JxPan 链接时才需要 `PUBLIC_BASE_URL`** —— 此时 aria2 要用这个地址回连 JxPan 拉文件。
> 留空则用你当前的浏览器地址，多数情况够了。但 aria2 在**另一个容器或另一台机器**上时不能是 `127.0.0.1`，要填局域网 IP（如 `http://192.168.1.10:8787`）或域名。
> 「测试连接」只验证 JxPan 能否连上 aria2，**验证不了 aria2 能否回连 JxPan**。任务加进去却立刻失败，先查这一项。

**推送接口需要管理员身份**（`RPC_REQUIRE_ADMIN=true`，默认）。在 `/admin` 登录一次即可 —— `admin_token` 的 Path 是 `/`，解析页也带着，按钮照常用。这道门是必须的：能改配置的人可以把 `rpc_url` 指向自己的服务器，而 `direct` 模式的 `addUri` 参数里带着你的网盘 Cookie。仅在完全可信的内网才考虑 `RPC_REQUIRE_ADMIN=false`。

也可以直接调接口，不用 UI：

```bash
# 先登录拿 cookie
curl -c jx.cookie -X POST 'http://<host>:8787/admin?action=login' \
  -d 'username=<admin>&password=<pass>'

# 推送整个分享（多文件会逐个推）
curl -b jx.cookie -X POST http://<host>:8787/_host/rpc/push \
  -H 'content-type: application/json' \
  -d '{"shareUrl":"https://pan.quark.cn/s/xxxxxx","pwd":""}'

# 测试 RPC 连通性
curl -b jx.cookie -X POST http://<host>:8787/_host/rpc/test
```

页面上的 **「生成短链」按钮默认隐藏** —— 直接推 RPC 就够了，短链只是噪音。后端 `/api/create-short` 和 `/s/<code>` 路由不受影响，**已经生成过的旧短链继续有效**。想要回来就设 `HIDE_SHORT_LINK=false`。

关掉：`ARIA2_RPC_ENABLED=false`（整个功能）或 `INJECT_RPC_BUTTON=false`（只去掉页面按钮，保留接口）。

按钮是宿主层注入到页面里的，依赖前端的 `updateParseDialog` / `displayResult` 两个函数。上游若改前端，按钮可能不出现，此时解析功能不受影响，接口仍可用。

#### 6. 安全：凭据泄露加固

`GET /?action=login_status` 会把全部 9 家网盘的 Cookie / Authorization / AccessToken **明文**返回，而该接口**不在 `/admin` 的鉴权范围内** —— 服务一旦能被公网访问，等于凭据裸奔。

自托管版默认修掉了这一点：没有有效的管理员 cookie 时，该接口只返回 `logged_in` / `source` / `expired`，`loginInfo` 一律摘除。后台面板本身需要登录，功能不受影响。

设 `PROTECT_CREDENTIALS=false` 可恢复成与 Cloudflare 部署一致的行为，**不建议**。

即便有这道加固，也**不要把 JxPan 裸暴露到公网** —— 解析接口本身无鉴权，任何人都能用你的凭据下载。建议放在反代 + HTTP 基本认证或 IP 白名单后面。

#### 7. 出站代理与自签证书（可选）

**默认直连，绝大多数部署不用配这一节。** 只有 JxPan 所在网络无法直连网盘时才需要 —— 企业网 HTTPS 中间人、受限网络等。

```yaml
environment:
  NODE_USE_ENV_PROXY: "1"                              # 必须，否则下面两行无效
  HTTPS_PROXY: http://192.168.1.10:8080
  HTTP_PROXY: http://192.168.1.10:8080
  NO_PROXY: 127.0.0.1,localhost,192.168.1.20
  NODE_USE_SYSTEM_CA: "1"                              # 企业网自签根证书时
```

三个坑，配错了 **Node 不会报错，只是静默不生效**，表现为请求挂到超时：

1. **必须同时设 `NODE_USE_ENV_PROXY=1`** —— 只设 `HTTPS_PROXY` 的话 Node 的 `fetch` 完全无视它。该开关需要 Node ≥ 22.21.0 / ≥ 24.0.0（官方镜像是 `node:24`，没问题）
2. **`NO_PROXY` 不支持网段写法** —— `192.168.1.0/24` 会被静默忽略，必须写具体 IP、主机名或域名后缀（如 `.lan`）
3. **`NO_PROXY` 至少写上 `127.0.0.1,localhost`** —— 否则健康检查和本机的 Aria2 RPC 也会被塞进代理

启动日志会打印代理状态，并对以上问题直接给出告警：

```
出站代理: http://192.168.1.10:8080  NO_PROXY=127.0.0.1,localhost,192.168.1.0/24
[代理] NO_PROXY 不支持网段写法，192.168.1.0/24 不会生效 —— 要写具体 IP 或域名后缀
```

自签证书也可以用 `NODE_EXTRA_CA_CERTS=/certs/ca.pem` 指定 PEM 文件（挂载进容器），效果等同于 `NODE_USE_SYSTEM_CA`。

#### 8. 数据与备份

所有数据（扫码登录凭据、统计、缓存、短链）都在 `./data/jxpan.db`，备份就是拷这个目录。凭据仍是 AES 加密存储。

#### 9. 自己构建镜像

仓库带了 `.github/workflows/build_docker.yml`，push 到 `main` 会自动跑自检 + 构建双架构镜像并推到 Docker Hub。fork 后需要在 **Settings → Secrets and variables → Actions** 配置：

| 名称                   | 类型                | 说明                          |
| -------------------- | ----------------- | --------------------------- |
| `DOCKERHUB_USERNAME` | Variable 或 Secret | Docker Hub 用户名              |
| `DOCKERHUB_TOKEN`    | Secret            | Docker Hub Access Token（非密码） |

本地构建与自检：

```bash
docker build -t jxpan:test .
npm test              # D1 垫片 / MD5 补丁 / _worker.js 加载 自检
npm start             # 需要 Node >= 22.13
```

***

## 📱 扫码登录功能

后台管理面板 (`/admin`) 提供了便捷的扫码登录功能，支持以下网盘：

### 支持扫码登录的平台

| 平台    | 登录方式         | 存储位置   |
| ----- | ------------ | ------ |
| 阿里云盘  | 阿里云盘 APP 扫码  | D1     |
| 天翼云盘  | 天翼云盘 APP 扫码  | D1     |
| 光鸭云盘  | 手机号+验证码      | D1     |
| 夸克网盘  | 夸克 APP 扫码    | D1     |
| UC网盘  | UC APP 扫码    | D1     |
| 123云盘 | 手动输入 Token   | D1     |

### 使用方式

1. 访问 `https://your-domain.com/admin`
2. 使用管理员账号登录
3. 进入 **"控制面板"** 或 **"扫码登录"** 标签页
4. 点击对应网盘的 **"扫码登录"** 按钮
5. 使用对应网盘 APP 扫描二维码
6. 扫码成功后自动保存登录信息到 D1 数据库
7. 解析时自动优先使用扫码登录的配置信息

### 前端页面配置

前端解析页面也提供了手动配置入口（JSON 输入框）：

- **阿里云盘**：Authorization 手动输入
- **夸克网盘**：Cookie 手动输入
- **UC网盘**：Cookie 手动输入
- **移动云盘**：Authorization + Cookie 手动输入
- **天翼云盘**：AccessToken 手动输入
- **123云盘**：Token 手动输入
- **光鸭云盘**：登录信息 JSON 手动输入

配置优先级：**扫码登录（容易失效） > 前端手动输入 > 环境变量（兜底）**

***

## 📚 API 使用文档

### 基础接口

#### 1. 解析接口（JSON 返回）
