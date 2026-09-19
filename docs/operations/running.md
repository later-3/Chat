# 已安装实例：启动与维护

以下命令在 Linux / WSL2 内执行，默认安装在 `/opt/chat`。不需要重新安装依赖。自定义安装必须沿用同一组 `CHAT_ROOT`、`CHAT_RUNTIME_ROOT`、`CHAT_RUN_USER`、`CHAT_SERVICE` 和 `--env-file`，不能让运维命令猜另一个实例。

## 日常拉起与停止

```bash
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl status
sudo /opt/chat/deploy/chatctl restart
sudo /opt/chat/deploy/chatctl stop
```

默认管理已安装的 Backend 与可选 Nano Host；未安装 Nano 时只管理 Backend。start 先确认 Backend 健康，再启动并校验 Nano 的服务认证与实例 ID。重复 start 不重启已运行的服务。启动失败只回收本次启动的服务，保留原本已运行的组件并报告失败；不会按端口杀其他进程。

按模块操作：

```bash
sudo /opt/chat/deploy/chatctl start --only backend
sudo /opt/chat/deploy/chatctl start --only nanoclaw
sudo /opt/chat/deploy/chatctl restart --only backend
sudo /opt/chat/deploy/chatctl stop --only nanoclaw
```

单独启动 Nano 需要 Backend 已就绪。停止顺序 Nano → Backend，交给 systemd 发送信号和执行停止期限；当前没有跨组件业务排空保证，先结束重要任务再停机。关闭浏览器、退出 TUI 与停止服务不同；TUI 退出不会关 Backend。

生产网页已嵌入 Backend，不启动 Vite；Pi 和 Long Agent 执行在 Backend 内。独立终端客户端使用 [Chat TUI](../modules/tui/README.md)，从自己的交互终端运行，不能把 TUI 装成后台服务。

## 开机自启与日志

```bash
sudo /opt/chat/deploy/chatctl enable   # 不立即启动
sudo /opt/chat/deploy/chatctl disable  # 不立即停止
sudo journalctl -u chat -n 100 --no-pager
sudo journalctl -u nanoclaw-chat -n 100 --no-pager
```

start/stop 不修改开机策略。WSL 仍须先启动 Linux 发行版；这些命令不配置 Windows 计划任务。`status` 展示 systemd 状态及本地健康；健康通过不等于模型凭据或真实渠道有效。

```bash
sudo /opt/chat/deploy/chatctl doctor
```

doctor 检查配置、模型目录与已配置认证、离线 AgentSession 装配、Release、服务和本机健康；不发计费模型请求。首次尚未配置模型时 doctor 失败是明确待办，不表示安装程序必须重跑。

## 更新与回退

安装/更新不会自动停止或启动正在运行的服务。维护时明确分步：

```bash
sudo /opt/chat/deploy/chatctl stop
sudo /opt/chat/deploy/chatctl update --ref <目标父仓库提交或标签>
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl doctor
```

已安装 Nano 时 update 自动重新准备父提交固定的 Nano 版本；新加 Friend 功能用 `install --with-nanoclaw`，也需要先 stop。保留配置、数据库和 Group，不复制正常环境为 debug 环境。

仅 Backend 的安装可在停止后执行 `chatctl rollback` 选择上一份保留 Release，然后单独 start；它不回退 Chat Home。回退后 doctor 的源码/Release 检查可能提示不同版本，必须核对对应源码。

安装了 Nano 时，Backend 与 Nano 版本需要配对，不能只切 Backend 符号链接。使用 `update --ref <上一版本的父提交>` 完成锁定构建、验证，再 start。旧提交从 `/var/lib/chat/runtime/releases/<release>/release-commits.txt` 查 Chat 行；不删除原生升级收据来强行启动旧版本。数据迁移回退需按对应版本的兼容规则和私有备份处理。

## 与开发调试的区别

| 场景 | 准备 | 运行 | 停止 |
|---|---|---|---|
| 生产 Linux/WSL | chatctl install | chatctl start | chatctl stop |
| 普通源码开发 | 固定依赖 | pnpm dev:all | Ctrl+C 或 pnpm chat:stop -- --debug |
| 隔离全模块调试 | debug:prepare；按需 debug:prepare:nanoclaw | pnpm debug:start -- --nanoclaw 或 F5 | pnpm debug:stop |

生产管理以 chatctl 为准；原有 `pnpm chat:stop -- --normal` 是对当前 checkout 的服务归属检查/停止入口，不是安装工具。完整端口与 F5 使用见[调试手册](../development/debugging/environment.md)。
