# Chat 部署

直接执行Workflow中的Agent可以显式加载项目Skill
`.chat/skills/chat-deployment/SKILL.md`执行本仓库部署。Skill在Linux上统一调用`chatctl`，不取代本文，也不授予未经用户明确要求的生产变更权限。

**生命周期设计更新（2026-09-08）**：整套Chat启停须统一协调Backend、NanoClaw与实例拥有的资源，见[系统生命周期合同](./architecture/chat-system-lifecycle.md)。下文仍描述当前部署入口；目前`chatctl`与Nano服务独立，不能将其操作结果解释为整套系统已启停。

## 运行结构

Chat Web与Workflow由一个Chat进程承载；启用Long Agent时，同一系统用户再常驻一个NanoClaw Host。NanoClaw Host内部承载多个Agent Group和多个Channel Adapter实例，不按Bot、Agent或Session重复启动Host。下面是可选的双Cloudflare连接器拓扑；公开域名由每台机器未跟踪的`chat.env`和代理配置决定，两条路径最终都到达同一个Chat进程：

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
4. 能访问GitHub公开仓库与Release附件、`nodejs.org`、配置的npm Registry，以及依赖原生二进制包使用的下载/CDN地址。

脚本通过系统包管理器安装`ca-certificates`、`curl`、`git`、OpenSSH客户端、`xz`、C/C++编译工具、`make`、`python3`和`pkg-config`；从`nodejs.org`下载固定的Node.js `22.19.0`并用官方`SHASUMS256.txt`校验，然后通过Corepack固定使用pnpm `10.13.1`。Pi模型目录也从Pi Commit指定的固定Release快照恢复并校验SHA256，不以实时模型目录作为部署输入。脚本不会使用系统中碰巧存在的其他Node或pnpm版本。

### 跨环境支持矩阵

| 环境 | 支持级别 | Chat服务 | NanoClaw服务与数据 |
|---|---|---|---|
| Linux `x86_64/aarch64` + systemd | 生产支持 | `chatctl`管理系统级Chat服务和版本化Release | NanoClaw Setup单独安装用户级systemd服务；使用稳定`/opt/chat/nanoclaw`保存`.env/data/groups` |
| macOS + launchd | 本机生产支持 | 使用`deploy/macos`模板；构建产物位于稳定Chat Checkout | NanoClaw Setup安装按Checkout隔离的LaunchAgent；`.env/data/groups`随稳定Checkout保存 |
| Windows | 未提供生产支持 | 无服务模板 | 无本期验收过的常驻方案 |
| Docker/Kubernetes | 未提供生产支持 | 没有镜像、数据卷和健康编排合同 | `chat-pi`不要求Agent Docker，但不等于Chat/NanoClaw已有容器化部署 |

“可在其他环境部署”不等于单命令完成Long Agent。`chatctl`目前只管理Chat进程；NanoClaw Host仍使用自己的Setup和服务管理。新环境发布顺序固定为：克隆父仓库及固定Submodule、配置Chat私有环境、构建并启动Chat、配置NanoClaw私有环境和Channel、安装NanoClaw服务、最后做双服务和真实消息验收。

源码、Credential和运行数据的边界：

```text
稳定Chat Checkout/                 可更新源码，不使用临时worktree作为生产路径
├── frontend/                      父仓库固定Commit
├── pi/                            父仓库固定Commit
└── nanoclaw/
    ├── .env                       NanoClaw与Channel私有Credential，0600
    ├── data/                      NanoClaw数据库与Mailbox事实
    └── groups/                    Agent Group Workspace与OKF Markdown Memory

CHAT_HOME/                         Chat用户事实，与源码分离
├── long-agents.json               Long Agent映射和Chat运行策略
├── projects/                      Project、Session与Project Memory
├── memory/                        Personal Memory
├── runtime/long-agents/           Ingress、Binding与派生/不可变Snapshot
└── logs/audit.jsonl               管理和Agent Memory写入审计
```

当前NanoClaw仍采用原生的“数据随稳定Checkout”模型；升级不得删除或重新克隆该目录。迁移Checkout时先停止Host，完整复制`.env`、`data/`和`groups/`并保留权限，再从目标Checkout重装服务。不要只复制SQLite主文件而漏掉可能存在的WAL/SHM；最安全的迁移点是Host已经停止之后。

安装仍有一类输入必须由用户提供：

- Web登录密码，以及至少一种可用的模型Provider凭证和对应的默认Provider/模型。

默认部署`main`。也可以显式选择Tag或Commit；Pi、前端和NanoClaw源码版本始终由Chat父仓库记录的三个Submodule Commit决定，脚本不会让子模块自行追踪远端分支。当前Linux `chatctl`仍只管理Chat进程；NanoClaw Host使用它自己的确定性Setup和服务管理配置，后续由Chat部署控制面统一编排。所有构建都必须在目标机器完成，因为Chat与NanoClaw包含和操作系统、CPU架构相关的原生依赖与容器镜像，不能从其他机器复制构建产物。

## 首次安装

自动部署不是“完全零前置”：新机器至少需要可用的`root`或`sudo`权限和上述网络访问。系统依赖、固定Node/pnpm、运行用户、源码、Submodule、构建和systemd服务均由脚本处理；Chat与三个Submodule共四个源码仓库均可通过HTTPS匿名读取。

可以直接下载公开`main`中的单个bootstrap脚本并执行：

```bash
curl --fail --location \
  https://raw.githubusercontent.com/later-3/Chat/main/deploy/chatctl \
  -o /tmp/chatctl
sudo install -o root -g root -m 0755 /tmp/chatctl /usr/local/sbin/chatctl-bootstrap
sudo /usr/local/sbin/chatctl-bootstrap install
```

首次运行会自动创建`chat`系统用户，通过公开HTTPS克隆Chat，并自动同步父提交固定的三个Submodule Commit。无需创建GitHub Token、Deploy Key或SSH配置；如需单独排查网络，可以匿名检查四个仓库：

```bash
sudo -u chat -H git ls-remote https://github.com/later-3/Chat.git HEAD
sudo -u chat -H git ls-remote https://github.com/later-3/pi.git HEAD
sudo -u chat -H git ls-remote https://github.com/later-3/chat-frontend.git HEAD
sudo -u chat -H git ls-remote https://github.com/later-3/nanoclaw.git HEAD
```

如果第一次运行停在用户配置阶段，填写配置后重新运行同一个命令即可继续：

```bash
sudo /usr/local/sbin/chatctl-bootstrap install
```

也可以先通过公开HTTPS手工克隆`main`，再运行`sudo ./deploy/chatctl install`。无论使用哪种bootstrap方式，都不需要手工初始化子模块。`chatctl install`会同步并检出父仓库固定的Submodule Commit、准备构建环境、构建候选版本、执行发布验证、渲染systemd服务，并把运行产物保存为版本化Release：

```text
/opt/chat/                                  稳定源码与Agent工作目录
├── frontend/                              父仓库固定的Pi Web Submodule
├── pi/                                    父仓库固定的Pi Submodule
└── nanoclaw/                              父仓库固定的长期Agent源码与独立常驻Host
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

`update`默认更新`main`，也可选择明确的Tag或Commit。它先在新的Release中构建和验证，成功后才原子切换`current`并重启服务；readiness失败时恢复上一版本。默认保留最近3个Release，可通过`CHAT_KEEP_RELEASES`调整为2到20；`rollback`切回保留的上一Release，不回退或覆盖用户数据。启动后只应存在一个Chat进程；不要另行启动Vite或Pi Web后端。Long Agent使用一个NanoClaw Host，不按Agent或Bot启动多个Host。

需要直接查看服务状态和日志时使用：

```bash
sudo systemctl status chat --no-pager
sudo journalctl -u chat -n 100 --no-pager
```

macOS常驻运行使用[生产LaunchAgent模板](../deploy/macos/com.later.chat.production.plist.in)。先把`deploy/chat.env.example`复制到`~/Library/Application Support/Chat/chat.env`并设置`0600`权限，把其中`CHAT_HOME`和`WORKFLOW_LOCAL_DATA_DIR`改为该用户下的绝对路径，再把模板中的`__ENV_FILE__`替换为配置文件绝对路径；Node通过`--env-file`读取与systemd相同的生产配置。随后替换`__CHAT_ROOT__`、`__NODE__`、`__HOME__`和`__LOG_DIR__`。Mac直连Cloudflare使用[直连Tunnel模板](../deploy/macos/com.later.chat.cloudflare-direct.plist.in)，其私有配置和Tunnel Credential应放在`~/Library/Application Support/Chat/cloudflared/`，不能放在旧Pi Web目录或提交到Git。

### NanoClaw Long Agent常驻服务

在父仓库固定的`nanoclaw/`目录完成一次性Channel Gateway初始化。Token只从Chat私有Bot Registry渲染到NanoClaw的`0600` `.env`，不能提交；模型与Agent凭据由Chat Pi管理，不进入NanoClaw、OneCLI或Agent容器。`chat-pi`模式不安装OneCLI、不执行NanoClaw Provider认证，也不构建Agent镜像：

```bash
cd nanoclaw
pnpm install --frozen-lockfile
pnpm exec tsx setup/index.ts --step set-env -- --key NANOCLAW_EXECUTION_MODE --value chat-pi
pnpm exec tsx setup/index.ts --step set-env -- --key CHAT_BACKEND_URL --value http://127.0.0.1:43110
pnpm exec tsx setup/index.ts --step set-env -- --key CHAT_INTEGRATION_INSTANCE_ID --value local
pnpm exec tsx setup/index.ts --step set-env -- --key CHAT_CHANNEL_GATEWAY_TOKEN --value '<same-random-token-as-chat-backend>'
pnpm exec tsx setup/index.ts --step service
```

`CHAT_CHANNEL_GATEWAY_TOKEN`至少32个字符，并以`0600`权限分别保存在Chat和NanoClaw的私有环境文件中。Chat的`long-agents.json`只登记NanoClaw的`gatewayBaseUrl`，默认本机地址为`http://127.0.0.1:3000/webhook/chat-backend`；远程Channel Gateway必须通过HTTPS访问。不要把NanoClaw的全权限`ncl.sock`或本地`cli.sock`转发成HTTP服务。

`service`只构建Node Host，并在macOS生成按Checkout隔离的LaunchAgent，在Linux生成用户级systemd服务；两者都设置开机启动与异常重启。`chat-pi`下该步骤不会检查Docker用户组或Docker Socket。服务直接在Node启动时读取NanoClaw `.env`。当Node版本支持时，生成的启动参数会加入`--use-env-proxy`，确保LaunchAgent/systemd在需要代理访问Telegram时使用`HTTP_PROXY`、`HTTPS_PROXY`与`NO_PROXY`，而不是依赖交互Shell环境。一个Host可以同时连接默认Telegram实例和`TELEGRAM_INSTANCES`列出的命名实例。每个Chat Long Agent映射一个Agent Group，每只Bot通过Wiring连接到对应Agent Group。

#### 启用微信

在同一个稳定 NanoClaw Checkout 按 [add-wechat Skill](../nanoclaw/.claude/skills/add-wechat/SKILL.md) 安装适配器、注册测试和固定依赖，完成构建及 NanoClaw 验证后再启用 `WECHAT_ENABLED=true`。扫码凭据保存在 `data/wechat/auth.json`，目录应为 `0700`，凭据为 `0600`。可以先单独完成登录，再用上述 `service` 步骤重启现有 Host，避免等待扫码阻塞其他通道初始化。

通过本机 `ncl` 把扫码用户加入目标 Agent Group 成员名单，创建微信私聊 Messaging Group，并用 Wiring 连接到已登记的 Chat Long Agent。保留 `unknown_sender_policy=strict`，按需要使用 `sender_scope=known`；扫码登录与 Wiring 均不会自动授权其他联系人。无需把 Chat Registry 的 Telegram inbox 替换为微信地址。

验收顺序：确认 `WeChat adapter ready`、Host 完成启动、Chat 与 Gateway 健康，再由扫码用户发送一条真实文本；确认 Chat Session 记录入站、Pi 回复、微信 Delivery 和 Ack。仅有登录成功或适配器 ready 不算收发验收。当前先支持 Chat 私聊自动绑定，多 Agent 的触发与群聊限制见[配置指南](./configuration.md#微信通道与多个-long-agent)。停用时将 `WECHAT_ENABLED` 改为 `false` 并重启现有 Host，保留私有凭据与 Wiring 以便恢复。

#### 已有NanoClaw安装升级

父仓库更新后如果`nanoclaw` gitlink发生变化，不能只切换Commit后直接重启Host。NanoClaw会用`data/upgrade-state.json`校验版本、Commit和Tree；跳过依赖安装、构建与升级标记的更新会被启动Tripwire拒绝。Chat固定Submodule的部署采用下面的受控流程：

1. 停止当前NanoClaw Host，并在Host停止后备份`.env`、`data/`和`groups/`；SQLite的WAL/SHM必须与主文件一起保留。
2. 更新Chat父仓库并同步父提交固定的NanoClaw Commit，不让NanoClaw自行漂移到其他分支头。
3. 在`nanoclaw/`运行`pnpm install --frozen-lockfile`，然后运行`pnpm format:check`、`pnpm typecheck`、`pnpm build`和`pnpm exec vitest run --testTimeout=30000`。
4. 验证成功后运行`pnpm exec tsx setup/index.ts --step service`。该步骤会重新构建、写入当前精确Commit的升级标记、刷新服务定义并重启Host。
5. 检查服务状态、`data/ncl.sock`、Gateway鉴权、所有Channel Adapter和一次真实消息。任何一步失败时保留备份和旧Commit，不手工删除Tripwire文件。

自建自动部署若不调用`service`步骤，也必须只在依赖、测试、构建和所需迁移全部成功后运行`pnpm exec tsx scripts/upgrade-state.ts set`，再做健康门禁重启。写入升级标记代表部署系统确认当前Checkout已经完成受控升级，不能把它当作绕过失败检查的命令。

服务与配置验收：

```bash
ncl groups list --json
ncl wirings list --json
launchctl list | grep nanoclaw          # macOS
systemctl --user status nanoclaw       # Linux，实际Unit带Checkout标识
```

NanoClaw工作区、数据库、Channel Session和日志仍由它自己的Checkout管理；Chat不直接读写这些文件。NanoClaw通过带服务认证的HTTP Event API主动调用Chat Backend，Chat通过NanoClaw窄HTTP Gateway完成Delivery与Ack；Web和Channel最终进入同一个Chat LongAgent Runtime。删除或移动正在作为服务WorkingDirectory的Checkout前，必须先把服务迁移到新的稳定Checkout并重装服务。

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
