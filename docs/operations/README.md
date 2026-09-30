# 部署与运行

**安装部署、日常拉起、源码调试是三件事。** [运行手册](./running.md)集中说明各类启动入口，平台与调试文档只维护各自细节；调试入口见[开发调试](../development/debugging/README.md)。

| 目的 | 入口 |
|---|---|
| 本次 0.5.4 固定版本：release / VS Code 安装、启动和关闭 | [Linux 交付步骤](./release-0.5.4.md) |
| 新 Linux / WSL2 电脑从零安装 | [安装指南](./installation.md) |
| 选择脚本、启动/停止、正式服务维护 | [运行手册](./running.md) |
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
| macOS | 安装沿用 launchd 模板与原生 Nano Setup；统一启动 `pnpm chat:start` |
| Windows 原生 / WSL1 / 无 systemd 的生产环境 | 当前没有对应生产脚本；不要把开发前台启动当成常驻部署 |

Docker 不是基础依赖。Nano 固定为 `chat-pi`，Chat 不启动 Nano 原生模型/Agent 容器 Runtime；未来隔离工具环境与当前安装无关。

脚本管理源码与系统服务，用户事实仍由 Chat Home 和 NanoClaw 原生数据目录拥有；不生成用户身份、渠道授权或真实模型凭据。更完整的跨组件任务排空尚未实现，见[生命周期合同](../architecture/chat-system-lifecycle.md)。

## 验证范围

安装/服务控制逻辑由隔离 shell 适配测试验证，Nano 配置与认证健康由本地 HTTP 回归验证；真实生产构建另测试“无 Provider 凭据也可打开 Web 与模型配置”。本次开发机为 macOS，尚未在空白 WSL2/Linux 主机上实际执行系统包安装与 systemd 启停；不能把上述本机测试记为目标平台真机验收。

## 版本号与交付是两件事

- **改版本号**（常见，只影响 `package.json`、tag 与构建产物，不写任何文档）：

```bash
pnpm release:cut -- 0.5.5              # 前端版本按上次标签以来的提交自动推导（feat→minor，其余→patch）
pnpm release:cut -- 0.5.5 0.13.1       # 或显式指定前端版本
pnpm release:cut -- 0.5.5 --dry-run    # 只打印计划
```

  它要求两个仓库工作区干净，然后：抬前端与父仓库版本 → 前端测试/类型检查/构建（`--skip-tests`、`--skip-build` 可跳过）→ 提交 → 推送 → 打 `v<frontend>` / `v<chat>` 标签并推送。**不生成交付页、不改入口文档指针。**

- **切一次 Linux 交付**（较少见；新机器安装需要交付页和安装标签时）：

```bash
pnpm release:deliver -- 0.5.5 0.13.1
```

  在版本号动作之上，额外按模板生成交付页、写验证记录、改写入口文档指针、把上一版交付页标为历史，并运行交付门禁。

门禁只拒绝**损坏的交付**，不要求"当前版本必须有交付页"：交付页自身的版本/标签/chatctl 链接必须自洽并链接到存在的验证记录；入口文档引用的交付页必须存在，且所有入口文档指向同一个交付；版本号可以领先于最新交付页。

