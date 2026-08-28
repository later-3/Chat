# Chat 部署

## 运行结构

Chat产品本体只运行一个进程。当前`chat.ai4child.asia`有两个Cloudflare连接器，
两条路径最终都到达Mac上的同一个Chat进程：

```text
https://chat.ai4child.asia
  → Cloudflare Tunnel
    ├── Mac连接器 → Mac 127.0.0.1:43110
    └── 云服务器连接器 → Cloud 127.0.0.1:33052 Nginx
          → Cloud 127.0.0.1:33051 SSH反向Relay
          → Mac 127.0.0.1:43110
              → Chat Nitro
                ├── PWA前端
                ├── Chat HTTP API
                └── Vercel Workflow Runtime → Pi Coding Agent
```

前端静态文件已经打进`.output`，生产环境不运行Vite，也不需要另行启动Pi Web。
云服务器只做代理，不保存Chat Session、模型配置或Provider Credential。

## 首次安装

Chat部署目录包含两个由父仓库固定提交的私有子模块：

```text
/opt/chat/
├── frontend/
└── pi/
```

部署机器必须配置可读取`later-3/pi`与`later-3/pi-web`的SSH Key或GitHub凭证。首次克隆和构建：

```bash
git clone --recurse-submodules git@github.com:later-3/Chat.git /opt/chat
cd /opt/chat
corepack enable
pnpm pi:prepare
pnpm install --frozen-lockfile
pnpm verify
```

更新版本时不要在服务器上让子模块自行追踪远端分支；使用父仓库提交中记录的精确版本：

```bash
cd /opt/chat
git pull --ff-only
git submodule sync --recursive
git submodule update --init --recursive
pnpm pi:prepare
pnpm install --frozen-lockfile
pnpm verify
```

复制[deploy/chat.env.example](../deploy/chat.env.example)为`/etc/chat/chat.env`，权限设为仅运行用户可读。默认登录账号是：

```text
用户名：later
密码：123456
```

这是当前约定的初始账号。公网长期运行时应修改`CHAT_WEB_AUTH_PASSWORD`，并设置至少32字符的随机`CHAT_WEB_AUTH_SESSION_SECRET`。修改密码或签名密钥后，已有登录Cookie会失效。

需要持久保存且不能提交Git的目录：

```text
/opt/chat/.pi/agent/
/opt/chat/.pi/sessions/
/opt/chat/.workflow-data/
```

## systemd

仓库提供[deploy/systemd/chat.service](../deploy/systemd/chat.service)。安装后执行：

```bash
sudo install -D -m 0644 deploy/systemd/chat.service /etc/systemd/system/chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now chat
curl --fail http://127.0.0.1:43110/api/health
```

更新版本时先完成构建和`pnpm verify`，再执行：

```bash
sudo systemctl restart chat
sudo journalctl -u chat -n 100 --no-pager
```

macOS常驻运行使用[生产LaunchAgent模板](../deploy/macos/com.later.chat.production.plist.in)。Mac直连Cloudflare使用[直连Tunnel模板](../deploy/macos/com.later.chat.cloudflare-direct.plist.in)，其私有配置和Tunnel Credential应放在`~/Library/Application Support/Chat/cloudflared/`，不能放在旧Pi Web目录或提交到Git。

如果Cloudflare还有云服务器连接器，再安装[反向Relay模板](../deploy/macos/com.later.chat.cloud-relay.plist.in)，让云端`127.0.0.1:33051`回到Mac的`127.0.0.1:43110`。模板中的路径占位符必须替换为本机绝对路径，生产入口同样是`.output/server/index.mjs`，不是开发服务器或历史`start.mjs`。

## Chat域名

现有Chat公网入口统一使用：

```text
https://chat.ai4child.asia
```

Mac直连Cloudflare示例见[deploy/cloudflared/config.example.yml](../deploy/cloudflared/config.example.yml)。关键映射是：

```yaml
- hostname: chat.ai4child.asia
  service: http://127.0.0.1:43110
```

同一个Cloudflare Tunnel如果还有云服务器连接器，云端必须同时安装
[Nginx配置](../deploy/nginx/chat.conf)和
[云端Cloudflare配置](../deploy/cloudflared/cloud-relay.example.yml)，并保持Mac上的
`com.later.chat.cloud-relay`常驻。云端链路的端口关系固定为：

```text
Cloudflare → 127.0.0.1:33052 Nginx → 127.0.0.1:33051 Relay → Mac:43110
```

同一个Tunnel的不同连接器各自读取本机ingress；任何一个连接器缺少Relay都会导致公网请求间歇性503，因此发布验收至少连续检查5次健康接口。

公网验收：

```bash
curl --fail https://chat.ai4child.asia/api/health
```

浏览器打开该域名后应进入Chat登录页；登录后可以安装为PWA。Android Chrome使用“安装应用”，iOS Safari使用“添加到主屏幕”。

## 认证边界

- `/api/health`、登录页、manifest、Service Worker和图标可以匿名访问。
- Session、文件、设备和Workflow接口必须携带有效的`chat-session` HttpOnly Cookie。
- Cookie在HTTPS反向代理下带`Secure`，使用`SameSite=Lax`，保持登录默认30天。
- Vercel Workflow的`/.well-known/workflow/*`内部回调不使用浏览器登录Cookie，也不会被Web认证中间件拦截。
