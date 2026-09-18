# 整套启动器中的终端输入归属

## 现象与根因

2026-09-18验证 `debug:start --tui` 时，TUI能显示首屏，输入文字和 `/help` 却没有响应。只测HTTP、界面渲染和非交互子进程退出都无法发现这一问题。

整套启动器此前把stdin继承给每个后台服务。Vite在stdin为TTY时也监听快捷键，与前台TUI读取同一个终端，导致按键被后台进程消费。stdout分流到日志只能避免画面污染，无法隔离输入。

## 修复与验证

整套启动器对后台model/backend/frontend/nanoclaw使用 `stdio: ["ignore", "pipe", "pipe"]`，仅前台TUI使用 `inherit`。TUI活动期间后台输出继续写各自日志，不写全屏终端。独立F5模块使用自己的终端，不需要共享stdin。

`scripts/debug-tui.test.mjs` 使用真实HTTP子进程模拟会读stdin的后台服务，给父启动器发送文字，验证各服务只得到EOF、未消费任何输入，停止时所有服务退出。另以临时checkout、隔离Chat Home、假模型和真实PTY验证TUI输入能进入Workflow。这是输入归属测试与真实执行测试，两者不能互相替代。

`terminal-stdin-ownership` experience由现有Personal Prompt资源机制发现，显式选择后生效，不全局注入。
