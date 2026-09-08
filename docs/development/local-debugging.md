# 本地开发与调试

完整学习路线、VS Code配置、Web/Telegram/微信场景、Pi源码、配置资源、日志及维护规则见[Chat调试与开发说明书](./debugging/README.md)。

## VS Code专用调试

在Chat根目录运行`pnpm debug:prepare`，F5选择 **Debug Chat**：启动本地假模型、专用Backend，随后启动Vite与独立Chrome调试会话。端口为Backend `45112`、Frontend `35145`、假模型 `45401`；数据是`.data/debug/chat-home`，日志在`.data/debug/logs`。Nitro缓存使用`node_modules/.nitro-debug`，与普通开发分开。

需要NanoClaw时先执行`pnpm debug:prepare:nanoclaw`，它建立独立Git worktree、安装并验证，不操作正常Host。F5选择 **Debug Chat + NanoClaw**，调试Gateway端口为`45300`；默认不启用真实渠道。Telegram/微信必须使用独立测试Bot/账号，详见[渠道步骤](./debugging/channels.md)。

命令行整套拉起用`pnpm debug:start -- --nanoclaw`，停止用`pnpm debug:stop`。Nano启动后自动复用/初始化Lab Group、Workspace、Memory与缺失的Registry。重复拉起会清理已验证归属的旧调试进程；未知端口占用明确报错。新机器交付前按[初始化清单](./debugging/first-install.md)完成配置与两次启动验收。

停止compound只处理本次启动的调试会话与子进程，不停止正常服务。尚未实现[全系统在途任务排空合同](../architecture/chat-system-lifecycle.md)；不要把调试进程停止描述成所有任务都已完成收尾。端口/数据隔离也不隔离同一个源文件的修改；正常dev同时使用本checkout时，源码改动仍会热更新它。

断点、配置列表、锁与Source Map排查见[环境章节](./debugging/environment.md)。启动后可执行`pnpm debug:smoke`验证2个真实Run和Session重读；GUI断点需另外验收。

## 普通开发入口（不使用调试专用端口）

旧命令保留其原有行为，用于普通开发，不应与占用相同端口/数据的实例重复启动：

```bash
pnpm dev:all
# 或明确选择空闲端口
scripts/dev-start.sh --backend-port 44112 --frontend-port 31145
```

默认Backend `43112`、Vite `30145`，Chat Home为`.data/dev/chat-home`，日志是`.data/dev-logs/<时间-PID>`。脚本只管理Backend/Vite，不管理独立NanoClaw。Ctrl+C收回自己的进程组；默认端口占用报错，`--kill`只在显式要求时请求占用者退出，正常使用与调试并存时不要使用该参数。

裸`pnpm dev`仍默认使用`~/.chat`；需要隔离时显式指定CHAT_HOME。首次依赖准备按根README；不要自动复制正式模型/渠道凭据。`pnpm verify`会重建frontend/dist和.output，如果正常实例使用这些产物，应在独立checkout验证。

## 验证与记录

`pnpm test:tooling`覆盖普通启动脚本与专用调试配置；`pnpm verify`包含完整开发/生产假模型门禁。NanoClaw自身验证另行执行。日志定位见[故障手册](./debugging/troubleshooting.md)，交付门槛见[测试说明](../testing.md)。
