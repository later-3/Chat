# Linux 调试关闭：僵尸进程组与暂停的启动器

## 现象与影响

0.5.0 的 Ubuntu CI 停在重复启动、孤儿恢复和暂停启动器替换回归。本机 macOS 同一场景通过。替换失败后的测试清理只发送 SIGTERM，暂停进程无法处理信号，导致测试的清理阶段也无法结束。

## 根因

Linux 对只含僵尸进程的进程组仍可让 `kill(-pgid, 0)` 成功。启动器被 SIGSTOP 暂停时，已退出的子进程要等待父进程恢复或退出后才能回收。旧 `stopGroup()` 把这类进程当成仍在执行，等待并升级 SIGKILL 仍无法消除僵尸，阻断了后续结束暂停启动器的步骤。原有 `identity()` 已排除 Z 状态，进程组探针却只在 macOS 的 EPERM 路径中检查状态。

## 为什么原验证遗漏

macOS 与 Linux 对退出进程组的信号探针结果不同；只通过 macOS 的真实临时进程测试不能证明 Linux 停止行为。测试超时也不能保证异步清理返回，尤其不能只向 SIGSTOP 的测试子进程发 SIGTERM 后无限等待。

## 修正与门禁

- 成功的进程组存活探针还要检查 `ps` 的组成员状态；只有非 Z 成员才计为仍存活。未知权限错误继续失败，不扩大信号目标。
- 归属仍由 PID、启动时间、UID、进程组与 checkout 记录确认，不能根据端口或进程名强杀。
- 原真实进程回归保留正常替换、孤儿恢复、SIGSTOP 启动器替换和无关监听器保护；退出断言改为无存活身份、无活跃组、端口可重新使用，而非要求 OS 立即回收所有 PID。
- 失败清理先恢复测试拥有的暂停子进程，再发送 TERM，并为这些子进程设置有界 KILL 后备。

自动化入口是 `node --test scripts/debug-environment.test.mjs`，纳入 `pnpm test:tooling` / `pnpm verify`；必须在 Ubuntu CI 和 macOS 分别执行。真实 Linux systemd 安装和 VS Code GUI 断点仍属于独立验收。
