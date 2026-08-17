# Chat PWA 与远程网关部署（拓扑A）

> as-built 事实源：Chat 可安装 PWA + 公网远程访问的部署合同与运维手册。
> 拓扑沿用 pi-web 模式：Chat 完整栈常驻 Mac，云服务器只做 Nginx 同源网关与
> Cloudflare ingress；产品数据、Provider 凭据、会话密钥只留在 Mac。

## 1. 架构

```text
手机 / 桌面 PWA
  │ HTTPS 443（Cloudflare edge）
  ▼
Cloudflare Tunnel db7544a7（chat.ai4child.asia）
  ├─ 当前实际入口：mac-main 的 pi-web cloudflare-direct LaunchAgent，
  │    其 ingress 携带 chat.ai4child.asia → 127.0.0.1:43110
  └─ 云端链路（已部署，阿里云→CF edge 7844 恢复后自动生效）：
       cloud cloudflared → 127.0.0.1:33052（Nginx，deploy/nginx/chat.conf）
       → 127.0.0.1:33051（SSH 反向隧道 listener）
       → SSH -R（com.later.chat.cloud-relay LaunchAgent）→ Mac:43110
  ▼
mac-main: 127.0.0.1:43110（Chat Web 网关，认证 + Host 校验）
  ▼
mac-main: 127.0.0.1:43114（DSH Host，--trusted-host chat.ai4child.asia）
  → Chat API 43111 → Workflow 43112 → pi
```

2026-08-17 部署事实：

1. 阿里云到 Cloudflare edge 的 7844（QUIC 与部分 TCP edge IP）当前不可达，
   云端 cloudflared 无法注册隧道连接；pi-web 当时已改由 Mac 直连隧道承载。
   Chat 跟随同一现实：Mac 直连是当前实际入口，云端链路已部署、网络恢复后
   自动分担。
2. 同一隧道 id 的所有 cloudflared 实例共享入口流量，每个实例独立应用自己的
   ingress，因此**每个实例都必须携带全部主机名的并集路由**。Chat 的 Mac 入口
   由 pi-web 的 `deploy/state/cloudflared-mac-direct.yml` 承载
   （chat.ai4child.asia → 127.0.0.1:43110）；Chat 仓库不另跑 Mac 隧道实例。
   云端 `/etc/cloudflared/config.yml` 同样携带 chat ingress（→33052）。
3. 两条链路汇聚到同一个 43110 网关，产品行为无差异。

端口分配（全 inventory 唯一，云端只绑 loopback）：

| 端口 | 位置 | 用途 |
|---:|---|---|
| 33051 | cloud loopback | Chat 反向隧道 listener |
| 33052 | cloud loopback | Chat Nginx 网关（server_name chat.ai4child.asia） |
| 43110 | Mac loopback | Chat Web 网关（唯一浏览器入口） |

## 2. PWA 事实

- DSH 上游 dist 自带占位 manifest（fullscreen、仅 SVG 图标、无 SW）。Chat 通过
  bridge 具名路由覆盖 `/manifest.webmanifest` 与 `/sw.js`，用 `tapIndex` 注入
  apple/mobile meta、图标与 `/pwa/register.js` 注册脚本；不修改上游 dist。
- 图标位于 `packages/dsh-lifeos-bridge/assets/icons/`（沿用 P1.2 品牌资产），
  `immutable` 长缓存；manifest 与 SW 每次 `no-cache` 重验证。
- Service Worker（`chat-pwa-shell-<version>`）只缓存同源版本化静态外壳
  （`/assets/*`、`/pwa/*`、`/favicon.svg`、manifest）与导航外壳；`/api`、
  `/lifeos` 与 WebSocket 永不进入缓存，离线时产品 API 明确失败，导航回退到
  缓存外壳或内置离线页。activate 清理所有非当前缓存，含历史 apps/web 的
  workbox 缓存（保留旧退役语义）。
- 登录页与重定向不进入外壳缓存。

## 3. 认证事实

- 公网入口强制认证：App 自有登录页 + scrypt 口令散列 + HMAC 签名 HttpOnly
  Cookie（`chat_session`，SameSite=Lax，公网模式下带 Secure，默认 30 天）。
  不用 Nginx auth_basic（已安装 iOS PWA 中浏览器原生认证框没有可恢复登录面）。
- 口令散列与会话密钥只存 Mac 本机文件（0600）：`.data/web-auth/credentials.json`
  与 `.data/web-auth/session-secret`，由 `scripts/service/init-chat-web-auth.mjs`
  交互生成，不进 Git、日志或环境变量值；`.env` 只携带路径。
- 未认证：导航 302 `/login`，API 401 Problem JSON，WebSocket 403。
- 公开放行仅：`/login`、`/healthz`、`/manifest.webmanifest`、`/sw.js`、
  `/favicon.svg`、`/pwa/*`（PWA 安装所需）。
- 失败关闭：设置 `CHAT_PUBLIC_WEB_HOSTNAME` 却没有 `CHAT_WEB_AUTH_REQUIRED=1`，
  或未关闭 Workbench，Gateway 拒绝启动。

## 4. Mac 侧部署步骤

```bash
# 1. 一次性：生成认证凭据（交互输入密码，不经过 argv/日志）
node scripts/service/init-chat-web-auth.mjs

# 2. .env 追加（路径示例；值只是路径与主机名，不是凭据）
CHAT_PUBLIC_WEB_HOSTNAME=chat.ai4child.asia
CHAT_WEB_AUTH_REQUIRED=1
CHAT_WEB_AUTH_CREDENTIALS_FILE=<仓库根>/.data/web-auth/credentials.json
CHAT_WEB_AUTH_SESSION_SECRET_FILE=<仓库根>/.data/web-auth/session-secret

# 3. 安装并启动 LaunchAgent（会自动以 --workbench=off 启动完整栈）
scripts/service/install-chat-production.sh install
scripts/service/install-chat-production.sh status
```

服务管理：

- 停止/恢复：`install-chat-production.sh uninstall|install`。
- 日志：`~/Library/Logs/chat/`。
- 注意：production 服务占用冻结端口 43110–43119；本地 `pnpm dev` 前必须先
  uninstall（或接受端口冲突报错）。`pnpm dev:stop` 停掉进程后 launchd 会按
  KeepAlive 自动拉起，这不是异常。
- 数据主权：Product Store 在主 checkout 的 `.data/`；production 运行根就是
  主 checkout（与 pi-web 同一原则），切分支/升级前应先 uninstall。

## 5. 云侧部署步骤

云端只安装 Nginx 配置与 cloudflared ingress，不安装 Chat 本体：

```bash
# 1. Nginx 配置（通过 device-access 只读校验后安装）
scp deploy/nginx/chat.conf later-cloud-admin:/tmp/chat.conf
ssh later-cloud-admin 'nginx -t -c /etc/nginx/nginx.conf' # 预检现有配置
ssh later-cloud-admin 'cp /etc/nginx/sites-available/chat.conf /var/backups/ 2>/dev/null; cp /tmp/chat.conf /etc/nginx/sites-available/chat.conf && ln -sfn /etc/nginx/sites-available/chat.conf /etc/nginx/sites-enabled/chat.conf && nginx -t && systemctl reload nginx'

# 2. cloudflared ingress 增加 chat.ai4child.asia → http://127.0.0.1:33052
#    并创建 DNS 路由（tunnel id 见 /etc/cloudflared/config.yml）
ssh later-cloud-admin 'cloudflared tunnel route dns <tunnel-id> chat.ai4child.asia'

# 3. 确认 cloudflared 服务 active（若原为 inactive，启用它会同时恢复 pi-web 入口）
```

## 5.1 2026-08-17 首次部署遗留处置

1. 旧 apps/web 时代的 4 个 LaunchAgent 已停止并归档（文件移至
   `~/.local/share/chat-pwa/legacy-launchagents-disabled-20260817T170003/`，未删除）：
   `com.later.chat-pwa-api`、`com.later.chat-pwa-web`、`com.later.chat-pwa-tunnel`、
   `com.later.chat.backend`。它们服务的是已删除的自研前端与 Python 后端。
2. `chat.ai4child.asia` 的 DNS 从旧 Mac 隧道 6dc99792 迁移到共享隧道
   db7544a7（`cloudflared tunnel route dns --overwrite-dns`）。
3. 云端 cloudflared 由 inactive/disabled 恢复为 enabled/active（pi-web 云端
   链路同时恢复）；`protocol` 从 `auto` 固定为 `http2`（QUIC 拨号超时）。
4. Cloudflare edge 对 `.js` 响应的浏览器 cache-control 显示为 `max-age=14400`：
   SW 更新最坏滞后 4 小时（浏览器 24h 后绕过 HTTP 缓存检查更新）。如需严格
   no-cache，后续在 Cloudflare 加 Cache Rule。

## 6. 发布后 Smoke

1. `curl -sI https://chat.ai4child.asia/healthz`：200。
2. 未认证 `curl -sI https://chat.ai4child.asia/`（带 `Accept: text/html`）：302 → `/login`。
3. `curl -s https://chat.ai4child.asia/manifest.webmanifest`：Chat manifest、`no-cache`。
4. `curl -sI https://chat.ai4child.asia/sw.js`：200、`service-worker-allowed: /`、`no-cache`。
5. 错误口令登录：401；正确口令：302 + `Set-Cookie`（Secure/HttpOnly）。
6. 浏览器安装 PWA；断网重开：外壳或离线页，发送明确失败。
7. 确认 `pi.ai4child.asia` 未受影响（不同 Origin、不同端口、不同 SW scope）。

## 7. 回滚

- Mac：`install-chat-production.sh uninstall`；从 `.env` 移除服务器模式配置后
  本地 `pnpm dev` 恢复原姿态。
- 云端：`rm /etc/nginx/sites-enabled/chat.conf && systemctl reload nginx`；
  cloudflared ingress 移除 chat 行并重启。隧道 listener 33051 随 Mac relay
  停止自动消失。
- 浏览器端 PWA：SW 版本升级会自动清理旧缓存；如需完全清除，用户在浏览器
  站点设置中清除站点数据即可。

## 8. 明确不做

- Workbench（code-server）不进入远程部署；远程/多用户 Workbench 需要容器或
  独立 UID Provider，是另一个独立任务。
- Memory 维持默认关闭。
- 云端不持久化任何 Chat 产品数据、口令或密钥。
- 不做多设备 failover（pi-web 的双设备模式不适用于当前 Chat 单数据面）。
