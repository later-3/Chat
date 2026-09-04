# Chat 部署

直接执行Workflow中的Agent可以显式加载项目Skill
`.chat/skills/chat-deployment/SKILL.md`执行本仓库部署。Skill在Linux上统一调用`chatctl`，不取代本文，也不授予未经用户明确要求的生产变更权限。

## 运行结构

Chat产品本体只运行一个进程。下面是可选的双Cloudflare连接器拓扑；公开域名由每台机器未跟踪的`chat.env`和代理配置决定，两条路径最终都到达同一个Chat进程：

```text
https://chat.example.com
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

Linux自动部署入口是[deploy/chatctl](../deploy/chatctl)，支持同时满足以下条件的机器：

1. 使用`systemd`管理服务。
2. CPU架构为`x86_64`或`aarch64`。
3. 发行版使用`apt-get`、`dnf`或`yum`之一；其他包管理器会明确拒绝，不会猜测安装命令。
4. 能访问GitHub公开仓库、`nodejs.org`、配置的npm Registry、依赖原生二进制包使用的下载/CDN地址，以及Pi构建所需的公开模型目录。

脚本通过系统包管理器安装`ca-certificates`、`curl`、`git`、OpenSSH客户端、`xz`、C/C++编译工具、`make`、`python3`和`pkg-config`；从`nodejs.org`下载固定的Node.js `22.19.0`并用官方`SHASUMS256.txt`校验，然后通过Corepack固定使用pnpm `10.13.1`。它不会使用系统中碰巧存在的其他Node或pnpm版本。

安装仍有一类输入必须由用户提供：

- Web登录密码，以及至少一种可用的模型Provider凭证和对应的默认Provider/模型。

默认部署`main`。也可以显式选择Tag或Commit；真正生效的Pi和前端版本始终由Chat父仓库记录的两个Submodule Commit决定，脚本不会让子模块自行追踪远端分支。所有构建都在目标机器上完成，因为生产产物包含与操作系统和CPU架构有关的原生依赖，不能从其他机器复制`.output`。

## 首次安装

自动部署不是“完全零前置”：新机器至少需要可用的`root`或`sudo`权限和上述网络访问。系统依赖、固定Node/pnpm、运行用户、源码、Submodule、构建和systemd服务均由脚本处理；三个源码仓库均可通过HTTPS匿名读取。

可以直接下载公开`main`中的单个bootstrap脚本并执行：

```bash
curl --fail --location \
  https://raw.githubusercontent.com/later-3/Chat/main/deploy/chatctl \
  -o /tmp/chatctl
sudo install -o root -g root -m 0755 /tmp/chatctl /usr/local/sbin/chatctl-bootstrap
sudo /usr/local/sbin/chatctl-bootstrap install
```

首次运行会自动创建`chat`系统用户，通过公开HTTPS克隆Chat，并自动同步父提交固定的两个Submodule Commit。无需创建GitHub Token、Deploy Key或SSH配置；如需单独排查网络，可以匿名检查三个仓库：

```bash
sudo -u chat -H git ls-remote https://github.com/later-3/Chat.git HEAD
sudo -u chat -H git ls-remote https://github.com/later-3/pi.git HEAD
sudo -u chat -H git ls-remote https://github.com/later-3/chat-frontend.git HEAD
```

如果第一次运行停在用户配置阶段，填写配置后重新运行同一个命令即可继续：

```bash
sudo /usr/local/sbin/chatctl-bootstrap install
```

也可以先通过公开HTTPS手工克隆`main`，再运行`sudo ./deploy/chatctl install`。无论使用哪种bootstrap方式，都不需要手工初始化子模块。`chatctl install`会同步并检出父仓库固定的Submodule Commit、准备构建环境、构建候选版本、执行发布验证、渲染systemd服务，并把运行产物保存为版本化Release：

```text
/opt/chat/                                  稳定源码与Agent工作目录
├── frontend/                              父仓库固定的Pi Web Submodule
└── pi/                                    父仓库固定的Pi Submodule
/var/lib/chat/runtime/
├── releases/<release-id>/                 不可变的已构建版本
└── current -> releases/<release-id>/      systemd当前运行版本
```

首次运行会从[deploy/chat.env.example](../deploy/chat.env.example)生成私有环境配置、自动生成独立的Session签名密钥，并从[deploy/settings.json.example](../deploy/settings.json.example)生成Pi设置模板。因为脚本不能替用户决定密码、Provider和模型，它会在生成这些文件后有意停止，而不会带着占位符启动公网服务。

此时完成以下配置：

1. 编辑`/etc/chat/chat.env`，把`CHAT_WEB_AUTH_PASSWORD`设为自己的强密码。保留脚本生成的`CHAT_WEB_AUTH_SESSION_SECRET`，不要复制示例占位符覆盖它。
2. 在同一文件中设置实际使用的Provider API Key，或者按下一节以`chat`用户完成OAuth登录。
3. 编辑`/home/chat/.chat/agent/settings.json`，填写真实存在的`defaultProvider`、`defaultModel`和`defaultThinkingLevel`。
4. 重新执行安装；脚本会校验用户配置，然后继续构建和启动：

```bash
cd /opt/chat
sudo ./deploy/chatctl install
```

重复执行`install`是安全的：已完成的主机不会因同一命令被重复初始化。安装成功后执行：

```bash
sudo ./deploy/chatctl doctor
```

### 用户配置：Web登录和Provider

`/etc/chat/chat.env`权限由脚本限制为仅运行用户可读。Web认证默认开启，仓库不提供可直接用于生产的默认密码。修改密码或签名密钥后，已有登录Cookie会失效。若修改默认目录，`WORKFLOW_LOCAL_DATA_DIR`必须是`CHAT_HOME`内部的绝对路径；配置到其他位置会被`chatctl`拒绝。

Provider认证支持两种方式，选择一种即可：

- API Key：在`/etc/chat/chat.env`中取消对应变量的注释，例如`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY`、`DEEPSEEK_API_KEY`或`KIMI_API_KEY`。只配置实际使用的Provider。
- OAuth或Pi认证文件：以`chat`用户运行Pi交互登录，并把Pi配置目录明确指向Chat Agent目录：

```bash
sudo -u chat -H env \
  PI_CODING_AGENT_DIR=/home/chat/.chat/agent \
  /var/lib/chat/runtime/toolchains/node/bin/node \
  /opt/chat/pi/packages/coding-agent/dist/cli.js
```

进入Pi后执行`/login`，完成后退出。远程SSH环境无法接收本机浏览器回调时，按Pi提示粘贴最终跳转URL或授权码。认证结果写入`/home/chat/.chat/agent/auth.json`，不能提交Git，也不要从终端打印其内容。

Pi运行时固定读取`CHAT_HOME/agent`。默认位置及职责如下：

- `/home/chat/.chat/agent/settings.json`：选择默认Provider、模型和Thinking Level；格式参考[deploy/settings.json.example](../deploy/settings.json.example)。
- `/home/chat/.chat/agent/models.json`：可选的自定义Provider与模型定义，可能包含Credential。
- `/home/chat/.chat/agent/auth.json`：Pi保存的API Key或OAuth认证。

使用内置模型目录时不需要创建`models.json`，但`settings.json`所选Provider与模型必须存在且具有有效认证。`chatctl doctor`会检查配置、目录权限、当前Release、systemd状态和本机健康接口；它不会发起一次可能计费的模型调用。

### 用户配置：多设备目录（可选）

Pi Web保留多设备切换界面，但它是纯浏览器客户端，不读取设备文件。需要在多个Chat实例之间切换时，将[deploy/devices.json.example](../deploy/devices.json.example)复制到每台机器的`$CHAT_HOME/devices.json`，填写所有实例的公开根URL：

```bash
sudo -u chat -H install -m 0600 \
  /opt/chat/deploy/devices.json.example \
  /home/chat/.chat/devices.json
sudo -u chat -H editor /home/chat/.chat/devices.json
```

Chat Backend根据`CHAT_PUBLIC_URL`在目录中识别当前实例，只向已登录的浏览器返回`id`、`name`和规范化根URL。账号、SSH地址、内网地址、密钥路径、隧道端口和其他额外字段都会被拒绝，不能经`/api/devices`暴露。配置缺失或损坏时，Chat仍以当前实例启动；当前实现使用直接URL导航，不要求中心网关或共享Session密钥。

Schema位于[schemas/device-directory.schema.json](../schemas/device-directory.schema.json)。`devices.json`是用户运行数据，不属于源码仓库，也不能提交Git。

### 数据目录

源码、构建产物和用户数据相互分离。升级与回滚只切换`/var/lib/chat/runtime/current`，不会覆盖`CHAT_HOME`：

```text
/home/chat/.chat/devices.json            可选的私有多设备目录
/home/chat/.chat/agent/                 Pi模型、设置、认证与全局资源
/home/chat/.chat/memory/                Personal Memory
/home/chat/.chat/projects/              Project配置、Session和Project Memory
/home/chat/.chat/runtime/workflow-data/ Workflow Run、Step和Event
/home/chat/.chat/cache/fastembed/       可重新下载的Embedding模型缓存
```

这些目录必须纳入私有备份，不能提交Git。`auth.json`、`models.json`和`chat.env`都可能含有Credential。已有Session的`cwd`是绝对路径；迁移到另一台机器时还要准备相同的Agent工作目录，否则Chat会拒绝以不匹配的`cwd`继续Session。

## systemd

仓库提供[deploy/systemd/chat.service](../deploy/systemd/chat.service)作为占位符模板，由`chatctl install`渲染和安装，不应直接复制未渲染文件。服务始终以`chat`用户运行，工作目录稳定为`/opt/chat`，实际执行版本化的`/var/lib/chat/runtime/current/server/index.mjs`。这样Session中的工作目录不会随Release变化，而失败更新可以切回上一Release。

日常操作统一使用：

```bash
sudo ./deploy/chatctl doctor
sudo ./deploy/chatctl update
sudo ./deploy/chatctl rollback
```

`update`默认更新`main`，也可选择明确的Tag或Commit。它先在新的Release中构建和验证，成功后才原子切换`current`并重启服务；readiness失败时恢复上一版本。默认保留最近3个Release，可通过`CHAT_KEEP_RELEASES`调整为2到20；`rollback`切回保留的上一Release，不回退或覆盖用户数据。启动后只应存在一个Chat进程；不要另行启动Vite、Pi Web后端或第二个Agent服务。

需要直接查看服务状态和日志时使用：

```bash
sudo systemctl status chat --no-pager
sudo journalctl -u chat -n 100 --no-pager
```

macOS常驻运行使用[生产LaunchAgent模板](../deploy/macos/com.later.chat.production.plist.in)。先把`deploy/chat.env.example`复制到`~/Library/Application Support/Chat/chat.env`并设置`0600`权限，把其中`CHAT_HOME`和`WORKFLOW_LOCAL_DATA_DIR`改为该用户下的绝对路径，再把模板中的`__ENV_FILE__`替换为配置文件绝对路径；Node通过`--env-file`读取与systemd相同的生产配置。随后替换`__CHAT_ROOT__`、`__NODE__`、`__HOME__`和`__LOG_DIR__`。Mac直连Cloudflare使用[直连Tunnel模板](../deploy/macos/com.later.chat.cloudflare-direct.plist.in)，其私有配置和Tunnel Credential应放在`~/Library/Application Support/Chat/cloudflared/`，不能放在旧Pi Web目录或提交到Git。

如果Cloudflare还有云服务器连接器，再安装[反向Relay模板](../deploy/macos/com.later.chat.cloud-relay.plist.in)，让云端`127.0.0.1:33051`回到Mac的`127.0.0.1:43110`。将`__CHAT_CLOUD_TARGET__`替换为用户自己`~/.ssh/config`中的Host别名，并替换所有路径占位符；真实别名、主机、账号和IdentityFile不进入仓库。生产入口同样是`.output/server/index.mjs`，不是开发服务器或历史`start.mjs`。

## Chat域名

公开入口由`CHAT_PUBLIC_URL`配置，例如：

```text
https://chat.example.com
```

Mac直连Cloudflare示例见[deploy/cloudflared/config.example.yml](../deploy/cloudflared/config.example.yml)。所有`example.com`值都必须在部署机的私有副本中替换，关键映射是：

```yaml
- hostname: chat.example.com
  service: http://127.0.0.1:43110
```

同一个Cloudflare Tunnel如果还有云服务器连接器，云端必须从
[Nginx配置模板](../deploy/nginx/chat.conf)和
[云端Cloudflare配置模板](../deploy/cloudflared/cloud-relay.example.yml)生成不跟踪的本地配置，并保持Mac上的
`com.later.chat.cloud-relay`常驻。云端链路的端口关系固定为：

```text
Cloudflare → 127.0.0.1:33052 Nginx → 127.0.0.1:33051 Relay → Mac:43110
```

同一个Tunnel的不同连接器各自读取本机ingress；任何一个连接器缺少Relay都会导致公网请求间歇性503，因此发布验收至少连续检查5次健康接口。

将示例域名替换为当前环境的`CHAT_PUBLIC_URL`后做公网验收：

```bash
curl --fail https://chat.example.com/api/health
```

健康接口应返回`{"ok":true,"service":"chat"}`。随后用浏览器完成以下验收：登录、创建Session、运行直接执行和规划执行，并让Planner Orchestrator在计划批准后调用多个子Workflow；观察Thinking/工具过程、父子Session、刷新恢复和“完整历史”中的`Workflow → Stage · Agent → 输入/模型思考/工具调用与输出/Agent输出`结构。

浏览器打开该域名后应进入Chat登录页；登录后可以安装为PWA。Android Chrome使用“安装应用”，iOS Safari使用“添加到主屏幕”。

## 认证边界

- `/api/health`、登录页、manifest、Service Worker和图标可以匿名访问。
- Session、文件、设备和Workflow接口必须携带有效的`chat-session` HttpOnly Cookie。
- Cookie在HTTPS反向代理下带`Secure`，使用`SameSite=Lax`，保持登录默认30天。
- Vercel Workflow的`/.well-known/workflow/*`内部回调不使用浏览器登录Cookie，也不会被Web认证中间件拦截。
