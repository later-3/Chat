# 调试构建目录重入 Workflow 源码扫描

## 现象与影响

2026-09-08准备专用调试入口时，把Nitro buildDir放在`.data/debug/nitro`。首次构建和健康HTTP成功，源文件变化后Workflow构建却把刚生成的`workflow/steps.mjs`当作输入再次扫描，出现227条构建错误，包括Pi中的Node模块不能用于Workflow、原生`.node`文件无法装载等。登录请求返回500，尚未进入真实模型调用。同checkout的普通dev watcher也受到扫描影响并退出；生产Chat/Nano服务没有重启。

## 已验证根因

Workflow LocalBuilder默认扫描工作区源码目录。调试生成文件放在该扫描范围会重入编译；首次健康检查没有触发完整Run与热更新，所以不能证明入口可用。正常开发构建放`node_modules/.nitro`，已有dev测试的隔离缓存也放`node_modules`下。

## 修复与替代保障

专用缓存改为`node_modules/.nitro-debug`，继续与正常`.nitro`分开。同时在`nitro.config.ts`把Workflow发现目录限定为`src/workflows`，避免普通/调试/生产构建扫描无关worktree、运行数据或生成文件；Step可达依赖仍由Builder处理。Source Map匹配专用目录；日志/用户数据仍放`.data/debug`。不修改Pi业务源码来迎合错误的二次编译。恢复普通dev入口后分别验证两个环境。

## 回归门禁

- `scripts/debug-environment.test.mjs`检查Backend隔离环境与launch的缓存映射，防止回到源码扫描范围。
- `pnpm debug:smoke`经过真实Vite代理、Nitro/Workflow、Pi、本地假模型与Session重读，验证文本和read Tool两条路径。
- 修改源码触发热更新后再次执行同一冒烟；健康HTTP与首次构建不能代替。
- `pnpm verify`仍分别覆盖常规CLI开发链、生产构建和Runtime。

## 停机补充回归

实际Vite退出检查发现macOS可能对已退出/仅剩僵尸的进程组返回EPERM而非ESRCH，导致端口释放但锁未清理。启动器仅在进程表确认该组没有活成员时将其视为退出；真实权限错误继续报错并保留锁，不扩大终止范围。进程组测试注入这个OS返回差异，同时真实验证拒绝SIGTERM的孙进程和无关监听器不受影响；Vite实际启动/停止/再次启动另做验收。

对应experience通过既有Personal Prompt资源初始化机制发布，不默认全局注入Agent；是否选用仍由资源选择合同决定。
