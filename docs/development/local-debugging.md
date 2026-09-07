# 本地开发与调试

在 Chat 根目录工作；首次依赖准备按 [README](../../README.md)执行 `pnpm pi:prepare`、`pnpm install --frozen-lockfile`。不启动或重启生产 NanoClaw Host；本地 Web/Workflow 开发与生产部署分开。

**当前范围**：下面的一键脚本和F5只管理开发Backend/Vite，不启动或停止独立NanoClaw。用户已确认应升级为完整实例生命周期，见[系统生命周期合同](../architecture/chat-system-lifecycle.md)；在实现完成前，不把停止这些入口称为停止整个Chat。

## 一键启动

```bash
pnpm dev:all
# 或使用同一个脚本，指定空闲端口
scripts/dev-start.sh --backend-port 44112 --frontend-port 31145
```

默认后端 `127.0.0.1:43112`，前端 `127.0.0.1:30145`。脚本等待后端健康检查和前端 HTTP 就绪，前端复用版本注入入口并固定端口；任一进程退出即停止另一进程，Ctrl+C 清理本次启动的进程组。默认遇到占用端口报错；只有显式 `--kill` 才请求占用进程退出，不升级强杀占用者。

默认 `CHAT_HOME=<仓库>/.data/dev/chat-home`，日志位于 `.data/dev-logs/<时间-PID>/{backend,frontend}.log`，按启动保留，不自动删除。这些目录不进入 Git。显式设置 `CHAT_HOME` 可选择其他数据目录；不要同时让开发和生产进程写入同一 Chat Home。裸 `pnpm dev` 保留原行为，未指定时使用 `~/.chat`，因此建议始终显式设置。

开发目录第一次启动不含生产模型认证和配置。按[系统配置](../configuration.md)在这个 Chat Home 配置模型、Workflow等；配置来自 Chat 的 `agent/`，不能改 `~/.pi`。脚本不自动复制密钥、项目历史或 Nano 服务认证。需要测试模型执行时可使用开发模型配置；自动化门禁使用隔离目录与本地假模型。

## VSCode

打开 Chat 根目录，F5 选择 **Debug Chat**：启动 Nitro/Workflow，后端就绪后启动前端并打开浏览器。启动配置使用同一个独立开发 Chat Home，前后端端口与一键脚本默认值一致。停止后端调试会停止关联的前端调试。也可从 Tasks 运行一键启动、架构入口检查或完整验证。

断点优先放在 `src/`；涉及 Pi 时放在 `pi/packages/*/src`，先完成 `pnpm pi:prepare`。配置开启子进程自动附着、Source Map 及 Workflow 开发产物映射。修改 Pi 源码后要重建 Pi；业务 Workflow 的 Nitro Step bundle 是否可执行由 `pnpm test:dev` 验证。未命中断点时检查实际启动入口、子进程是否附着和 Source Map，不能只看编译通过。

单独启动可用于排障：

```bash
CHAT_HOME="$PWD/.data/dev/chat-home" pnpm dev
pnpm dev:frontend --host 127.0.0.1 --port 30145 --strictPort
```

## 验证和诊断

```bash
pnpm check:architecture
pnpm test:tooling
pnpm verify
git diff --check
git -C frontend diff --check
```

工具测试使用本地假服务验证端口拒绝、启动失败、版本/代理传递与退出清理，不调用模型。`pnpm verify` 还包括真实 Nitro 开发/生产链的假模型测试。启动脚本的真实服务冒烟和 VSCode 手工断点检查是不同证据；不能把脚本通过当成已经人工验证 F5。NanoClaw 改动另跑它自己的门禁，见[测试指南](../testing.md)。

反馈与日志的关联方式见[诊断与记录](./diagnostics.md)。需要调试 Channel 时，先按[集成基线](../architecture/chat-nanoclaw-pi-integration.md)准备隔离的实例、服务认证和配置，不复用生产 Bot 去跑自动化测试。
