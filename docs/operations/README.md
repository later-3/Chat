# 部署与运行

**安装部署、日常拉起、源码调试是三件事。** 本目录只维护安装和运维；调试入口见[开发调试](../development/debugging/README.md)。

| 目的 | 入口 |
|---|---|
| 新 Linux / WSL2 电脑从零安装 | [安装指南](./installation.md) |
| 启动、停止、重启、开机自启、更新、回退、诊断 | [运行手册](./running.md) |
| Friend 旧数据迁移、升级冲突、回退 | [Friend 升级](./friend-migration.md) |
| 现有 macOS 常驻服务 | [macOS](./macos.md) |
| SSH、域名与可选代理 | [网络访问](./network.md) |
| 模型、Provider、Project、Friend 配置 | [配置合同](../configuration/README.md) |

生产拓扑只有 2 类服务：Backend 内含 Web 静态文件、Workflow 和 Pi SDK；可选的一个 NanoClaw Host 承载多个 Friend。没有单独的 Pi Server、生产 Vite 或每个 Friend 一个进程。TUI 是独立客户端，见[终端使用](../modules/tui/README.md)。

```text
浏览器 / TUI → Chat Backend（内含 Web / Workflow / Pi）
                         ↕ 认证 HTTP
                  NanoClaw Host（可选）
                  Group / Memory / Channel
```

| 环境 | 路径与边界 |
|---|---|
| Linux x86_64 / aarch64，运行中的 systemd | `deploy/chatctl`；apt-get / dnf / yum 系统依赖 |
| WSL2 Linux，已启用 systemd | 同一脚本；Windows 浏览器访问 localhost；Windows/WSL 的启动和关机另由宿主管理 |
| macOS | 现有 launchd 模板与原生 Nano Setup |
| Windows 原生 / WSL1 / 无 systemd 的生产环境 | 当前没有对应生产脚本；不要把开发前台启动当成常驻部署 |

Docker 不是基础依赖。Nano 固定为 `chat-pi`，Chat 不启动 Nano 原生模型/Agent 容器 Runtime；未来隔离工具环境与当前安装无关。

脚本管理源码与系统服务，用户事实仍由 Chat Home 和 NanoClaw 原生数据目录拥有；不生成用户身份、渠道授权或真实模型凭据。更完整的跨组件任务排空尚未实现，见[生命周期合同](../architecture/chat-system-lifecycle.md)。

## 验证范围

安装/服务控制逻辑由隔离 shell 适配测试验证，Nano 配置与认证健康由本地 HTTP 回归验证；真实生产构建另测试“无 Provider 凭据也可打开 Web 与模型配置”。本次开发机为 macOS，尚未在空白 WSL2/Linux 主机上实际执行系统包安装与 systemd 启停；不能把上述本机测试记为目标平台真机验收。

交付到新电脑前，需要使用包含本次改动且三个 Submodule Commit 均可获取的父仓库版本。未提交工作区不属于远端 main 的安装内容。
