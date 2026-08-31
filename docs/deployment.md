# Chat 部署

直接执行Workflow中的Agent可以显式加载项目Skill
`.chat/skills/chat-deployment/SKILL.md`执行本仓库部署。Skill只编排本文已有的构建、服务重启和验收入口，不取代本文，也不授予未经用户明确要求的生产变更权限。

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

## 可移植部署前提

另一台机器从空目录部署需要满足以下条件：

1. Node.js `>=22.19.0`、Corepack、Git，以及能够运行`npm ci`所需的基础构建环境。
2. Git身份能读取`later-3/Chat`、`later-3/pi`和`later-3/pi-web`三个私有仓库。
3. 构建阶段能访问Pi使用的公开模型目录；`pnpm pi:prepare`需要生成Git中不保存的Provider模型数据。
4. 目标机器上安全准备Pi模型和Provider认证；这些凭证不在Git中。
5. 在目标机器上执行构建。`.output`包含与构建机器操作系统和CPU架构有关的原生依赖，不能跨平台复制。

当前评审版本位于`codex/pi-web-frontend-in-chat`。在该分支合入`main`之前，首次安装命令必须带上`--branch codex/pi-web-frontend-in-chat`；合入后可以省略该参数。无论部署哪个分支或Tag，真正生效的Pi和前端版本都由Chat父仓库记录的两个Submodule Commit决定。

## 首次安装

Chat部署目录包含两个由父仓库固定提交的私有子模块：

```text
/opt/chat/
├── frontend/
└── pi/
```

部署机器必须先创建`chat`系统用户，并为该用户配置可读取三个私有仓库的SSH Key或GitHub凭证。systemd模板固定使用`chat`用户，而且当前Coding Agent的默认工作目录就是Chat目录，所以应让`chat`用户拥有仓库并使用该用户完成安装与构建：

```bash
corepack enable
sudo install -d -o chat -g chat -m 0750 /opt/chat
sudo -u chat -H git clone \
  --branch codex/pi-web-frontend-in-chat \
  --recurse-submodules \
  git@github.com:later-3/Chat.git /opt/chat
sudo -u chat -H sh -lc 'cd /opt/chat && pnpm pi:prepare'
sudo -u chat -H sh -lc 'cd /opt/chat && pnpm install --frozen-lockfile'
sudo -u chat -H sh -lc 'cd /opt/chat && pnpm verify'
```

`chat`用户的SSH配置必须能读取私有仓库。也可以使用专用Deploy Key；不要把私钥放进Chat仓库。

命令职责如下：

- `pnpm pi:prepare`按Pi自己的锁文件安装依赖，联网生成`pi/packages/ai/src/providers/data/`，再生成`pi/packages/*/dist`。模型数据目录由Pi忽略，不会污染Submodule状态。
- `pnpm install --frozen-lockfile`按Chat锁文件安装后端与`frontend/`依赖，并把Chat依赖连接到当前`pi/`源码。
- `pnpm verify`运行后端与前端测试、类型检查、生产构建和隔离生产服务HTTP测试。

更新版本时不要在服务器上让子模块自行追踪远端分支；使用父仓库提交中记录的精确版本：

```bash
sudo -u chat -H git -C /opt/chat pull --ff-only
sudo -u chat -H git -C /opt/chat submodule sync --recursive
sudo -u chat -H git -C /opt/chat submodule update --init --recursive
sudo -u chat -H sh -lc 'cd /opt/chat && pnpm pi:prepare'
sudo -u chat -H sh -lc 'cd /opt/chat && pnpm install --frozen-lockfile'
sudo -u chat -H sh -lc 'cd /opt/chat && pnpm verify'
```

复制[deploy/chat.env.example](../deploy/chat.env.example)为`/etc/chat/chat.env`，权限设为仅运行用户可读。默认登录账号是：

```text
用户名：later
密码：123456
```

这是当前约定的初始账号。公网长期运行时应修改`CHAT_WEB_AUTH_PASSWORD`，并设置至少32字符的随机`CHAT_WEB_AUTH_SESSION_SECRET`。修改密码或签名密钥后，已有登录Cookie会失效。

Pi运行时固定读取`CHAT_HOME/agent`。systemd示例把`CHAT_HOME`设为`/home/chat/.chat`，其中：

- `/home/chat/.chat/agent/settings.json`选择默认Provider、模型和Thinking Level。
- `/home/chat/.chat/agent/models.json`保存自定义Provider与模型定义，可能包含Credential，不能提交Git。
- `/home/chat/.chat/agent/auth.json`保存Pi Provider认证，不能提交Git。

如果使用Pi内置模型目录，可以不提供自定义`models.json`，但必须通过Pi支持的认证方式让默认Provider可用。部署前至少确认`settings.json`选择的Provider与模型在该机器上存在且已经认证。不要从终端打印或从Git传递Credential。

需要持久保存且不能提交Git的目录：

```text
/home/chat/.chat/agent/
/home/chat/.chat/memory/
/home/chat/.chat/projects/
/home/chat/.chat/runtime/workflow-data/
```

systemd模板使用`chat`用户运行。安装服务前应确保仓库及Agent允许操作的工作目录属于`chat`用户，Chat Home运行时目录可写：

```bash
sudo chown -R chat:chat /opt/chat
sudo install -d -o chat -g chat -m 0700 \
  /home/chat/.chat/agent \
  /home/chat/.chat/memory \
  /home/chat/.chat/projects \
  /home/chat/.chat/runtime/workflow-data \
  /home/chat/.chat/cache/fastembed
sudo chown -R chat:chat /home/chat/.chat
```

当前前端默认使用Chat进程的工作目录；在下面的systemd模板中就是`/opt/chat`。已有Session的`cwd`是绝对路径，把Session迁移到另一台机器时必须同时准备对应工作目录，否则Chat会拒绝以不匹配的`cwd`继续该Session。

## systemd

仓库提供[deploy/systemd/chat.service](../deploy/systemd/chat.service)。安装后执行：

```bash
sudo install -D -m 0644 deploy/systemd/chat.service /etc/systemd/system/chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now chat
curl --fail http://127.0.0.1:43110/api/health
```

模板假设Node位于`/usr/bin/node`。如果`command -v node`返回其他路径，安装前应修改`ExecStart`。启动后只需要一个Chat进程；不要再启动Vite、Pi Web后端或第二个Agent服务。

更新版本时先完成构建和`pnpm verify`，再执行：

```bash
sudo systemctl restart chat
sudo journalctl -u chat -n 100 --no-pager
```

macOS常驻运行使用[生产LaunchAgent模板](../deploy/macos/com.later.chat.production.plist.in)。先把`deploy/chat.env.example`复制到`~/Library/Application Support/Chat/chat.env`并设置`0600`权限，把其中`CHAT_HOME`和`WORKFLOW_LOCAL_DATA_DIR`改为该用户下的绝对路径，再把模板中的`__ENV_FILE__`替换为配置文件绝对路径；Node通过`--env-file`读取与systemd相同的生产配置。随后替换`__CHAT_ROOT__`、`__NODE__`、`__HOME__`和`__LOG_DIR__`。Mac直连Cloudflare使用[直连Tunnel模板](../deploy/macos/com.later.chat.cloudflare-direct.plist.in)，其私有配置和Tunnel Credential应放在`~/Library/Application Support/Chat/cloudflared/`，不能放在旧Pi Web目录或提交到Git。

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

健康接口应返回`{"ok":true,"service":"chat"}`。随后用浏览器完成以下验收：登录、创建Session、分别运行两个Workflow、观察Thinking/工具过程、刷新后继续同一Session，以及打开“完整历史”确认`Workflow → Stage · Agent → 输入/模型思考/工具调用与输出/Agent输出`结构。

浏览器打开该域名后应进入Chat登录页；登录后可以安装为PWA。Android Chrome使用“安装应用”，iOS Safari使用“添加到主屏幕”。

## 认证边界

- `/api/health`、登录页、manifest、Service Worker和图标可以匿名访问。
- Session、文件、设备和Workflow接口必须携带有效的`chat-session` HttpOnly Cookie。
- Cookie在HTTPS反向代理下带`Secure`，使用`SameSite=Lax`，保持登录默认30天。
- Vercel Workflow的`/.well-known/workflow/*`内部回调不使用浏览器登录Cookie，也不会被Web认证中间件拦截。
