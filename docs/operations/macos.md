# macOS 现有服务

Linux/WSL 自动安装见[安装指南](./installation.md)。macOS 不运行 `chatctl install`；保留既有 launchd 方式，安装与构建完成后再单独启动。先按[开发准备](../development/debugging/first-install.md)安装固定依赖并执行 `pnpm verify`。

macOS常驻运行使用[生产LaunchAgent模板](../../deploy/macos/com.later.chat.production.plist.in)。先把`deploy/chat.env.example`复制到`~/Library/Application Support/Chat/chat.env`并设置`0600`权限，把其中`CHAT_HOME`和`WORKFLOW_LOCAL_DATA_DIR`改为该用户下的绝对路径，再把模板中的`__ENV_FILE__`替换为配置文件绝对路径；Node通过`--env-file`读取与systemd相同的生产配置。随后替换`__CHAT_ROOT__`、`__NODE__`、`__HOME__`和`__LOG_DIR__`。Mac直连Cloudflare使用[直连Tunnel模板](../../deploy/macos/com.later.chat.cloudflare-direct.plist.in)，其私有配置和Tunnel Credential应放在`~/Library/Application Support/Chat/cloudflared/`，不能放在旧Pi Web目录或提交到Git。


## 运行与停止

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.later.chat.production.plist
launchctl kickstart -k gui/$(id -u)/com.later.chat.production
launchctl bootout gui/$(id -u)/com.later.chat.production
```

bootstrap 用于尚未装载的服务，已经装载时使用 kickstart；bootout 后不能只 kickstart，需重新 bootstrap。NanoClaw 继续使用其原生 Setup 生成的独立 LaunchAgent，服务名从安装输出取得；不要照抄其他机器的路径/标签。正常与调试停止边界见[关闭手册](../development/debugging/stopping.md)。

Nano 首次按 `chat-pi` 配置 Backend URL、实例 `local` 和相同服务 Token，锁定安装依赖并执行原生 Setup service；该原生命令会构建并启动 Host，不属于 Linux 新安装脚本的“只安装”合同。模型认证留在 Chat，渠道账号单独连接。当前正常服务不得迁入临时调试 worktree。
