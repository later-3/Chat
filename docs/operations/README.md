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

## 更新版本

版本号、交付页、入口文档指针、验证记录和标签由同一条命令生成，避免漏项（`scripts/deployment-config.test.mjs` 会校验它们一致）：

```bash
pnpm release:cut -- 0.5.4            # 前端版本按上次标签以来的提交自动推导
pnpm release:cut -- 0.5.4 0.12.1     # 或显式指定前端版本
pnpm release:cut -- 0.5.4 --dry-run  # 只打印计划，不写文件、不提交、不推送
pnpm release:cut -- 0.5.4 0.12.1 --scratch /tmp/render  # 只渲染生成的文件供复核
```

脚本要求两个仓库工作区干净，依次抬前端与父仓库版本、按模板生成交付页与验证记录、替换入口文档指针、把上一版交付页标为历史、跑 `check:architecture` 与发布一致性门禁，然后提交、推送并打 `v<frontend>` / `v<chat>` 标签。`--dry-run` 与 `--scratch` 都可先复核生成内容；生成内容仍是草稿：发布前必须人工复核"本版变化"与验证结论，并确认浏览器场景（`pnpm test:dev`）是否真跑过。

本次交付使用父仓库 `v0.5.4` 标签及其三个固定 Submodule Commit；安装脚本和源码使用同一标签，具体步骤见[版本交付页](./release-0.5.4.md)。未提交工作区不属于远端安装内容。
