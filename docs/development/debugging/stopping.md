# 分别关闭正常与调试 Chat

在目标Chat checkout根目录执行。命令必须显式选择一个范围；不带参数只显示帮助。关闭浏览器或VS Code窗口不等于关闭后台服务。

```bash
pnpm chat:stop -- --normal --check  # 只检查正常服务
pnpm chat:stop -- --normal          # 关闭正常Backend + NanoClaw

pnpm chat:stop -- --debug --check   # 只检查开发/调试
pnpm chat:stop -- --debug           # 关闭专用调试栈 + 本checkout普通dev:all
```

VS Code → Terminal → Run Task中也有`Chat: check normal services`、`Chat: stop normal services`、`Chat: check development and debug`和`Chat: stop development and debug`。停止正常服务不是F5的自动步骤，必须主动选择。

## 选择范围

| 选项 | 关闭内容 | 保留内容 |
| --- | --- | --- |
| `--normal` | 当前checkout已安装的Chat Backend及NanoClaw原生服务；从安装配置读取服务名、工作目录和端口，默认43110/3000 | 开发/调试进程、其他checkout、共享Tunnel/Relay/Nginx、Docker daemon、外部模型 |
| `--debug` | F5/`debug:start`的stack、Nano、Vite、Backend、本地练习模型，默认45300/35145/45112/45401；同一用户及checkout的`dev:all`脚本（默认43112/30145，支持脚本端口参数） | 正常服务、其他checkout与用户的进程 |

Pi在Backend中执行，生产Frontend是静态文件，两者都没有独立的服务需要关闭。工具Docker尚未接入当前Chat运行合同，脚本不会清理整机容器。手动直接启动的`pnpm dev`/`vite`/`node`没有本入口认可的归属记录；若端口仍占用，脚本报出失败，需在其原终端Ctrl+C或用实际管理者停止。不能因同端口就认定是本实例。

仅停止专用调试、保留普通`dev:all`时，继续使用`pnpm debug:stop`；加`-- --check`只检查，加`-- backend`仅停止Backend角色。单模块停止不能解释为整个系统已关闭。

## 如何读取输出

- `[范围]`：当前checkout和所选正常/调试选项。
- `[检查]`：服务名或角色、PID、监听端口及状态；正常服务额外显示服务管理状态和自启动配置。占用或无法检查不等于已确认健康。
- `[关闭]`：实际bootout、systemctl stop或自有进程终止动作；已停止则跳过。
- `[结果]`：复核服务/进程已退出、端口空闲。未知占用、权限错误或未退出显示`[失败]`，最终退出码为1；所有所选检查通过才返回0。
- `[再次启动]`：正常服务的准确恢复命令；`[其他入口]`说明还有独立开发入口运行。

`--check`是只读检查，服务正在运行也返回0；查询或归属验证失败返回1。它不创建调试配置，不发送信号。未安装受支持的正常服务时会报错，不猜测PID。脚本只输出必要状态，不打印Token、完整环境变量、对话或Memory。需要保存证据可重定向stdout/stderr到自己的日志文件；包含路径的检查信息也不应提交到Git。

## 服务管理与再次启动

macOS：以安装LaunchAgent的登录用户运行，不加sudo。脚本扫描该用户`~/Library/LaunchAgents/*.plist`，校验工作目录、程序入口及**已加载定义**，先关闭Nano，再关闭Backend。使用`launchctl bootout gui/<uid>/<label>`，避免直接kill后KeepAlive复活。plist不删除，自启动策略不变；下次登录可能再次启动。立即恢复时按输出的`launchctl bootstrap gui/<uid> "/准确路径/service.plist"`，先Backend后Nano。已bootout的服务不能只用`kickstart`恢复。

Linux：支持[部署模板](../../../deploy/systemd/chat.service)的系统级Chat，以及同一运行用户的用户级Nano或系统级Nano。自动核对unit的WorkingDirectory/ExecStart；Nano用户级管理器从Chat服务User解析，sudo运行时通过该用户的runtime bus操作。系统级stop通常需管理员权限：

```bash
sudo node scripts/chat-stop.mjs --normal --check
sudo node scripts/chat-stop.mjs --normal
# 安装时自定义了Chat unit名才加此项：
sudo node scripts/chat-stop.mjs --normal --chat-service my-chat.service
```

脚本调用`systemctl stop`，不执行disable；下次开机启用策略保留。恢复用输出的准确start命令，先Backend后Nano。无systemd、Nano nohup fallback、自定义包装器或其他用户私自运行的Host尚不支持自动关闭，应按该部署的明确管理入口操作，不能把未发现当作不存在。

调试：停止操作校验PID启动时间、用户和已记录进程组。普通dev wrapper可能不是进程组leader，只给wrapper发TERM，由其已有trap清理自有子进程。专用调试支持有界等待后的自有进程强制清理；普通dev超时则明确报错，不扩大kill范围。重复停止保留所有配置、Workspace、Memory、Session、日志与Nano worktree，下一次可直接`pnpm debug:start`、F5或`pnpm dev:all`。

## 在途工作与能力边界

本命令实现**进程/服务停止**，会中断正在进行的模型、工具和投递；没有实现跨Backend/Nano的业务排空协议。恢复后按[日志与故障定位](./troubleshooting.md)检查未完成Run和未确认Delivery，外部动作是否成功不能仅凭本地停机结果判断。[系统生命周期合同](../../architecture/chat-system-lifecycle.md)中的暂停接收、有界收尾、取消与投递恢复仍是后续实施范围。

实现入口：[chat-stop](../../../scripts/chat-stop.mjs)、[debug-stop](../../../scripts/debug-stop.mjs)、[dev-stop](../../../scripts/dev-stop.mjs)。回归覆盖只检查不变更、重复关闭、归属冲突、残留端口/原PID、服务管理器失败和无关监听器保留；Linux使用适配器合同测试，macOS额外运行真实临时KeepAlive服务，不能用它宣称Linux真实主机已验收。
