# 本地开发与调试入口

完整规范集中在 [调试手册](./debugging/README.md)，本页只导航。

- 先区分正式使用、源码热更新与隔离调试：[启动场景与脚本](../operations/running.md)。
- 新源码与依赖：[首次准备](./debugging/first-install.md)。
- 只调 Backend、组合调试、VS Code 命令面板操作：[环境与 F5](./debugging/environment.md)。
- Web / Pi / Workflow / TUI / Nano 断点：[源码地图](./debugging/code-map.md)。
- 停止服务、普通开发与隔离调试的范围：[停止手册](./debugging/stopping.md)。
- 部署到其他电脑：[Linux / WSL2 安装](../operations/installation.md)；安装完成后的[启停命令](../operations/running.md)。

普通开发与隔离 debug 数据不能混用。Chat 已移除产品登录和 Cookie，Provider 认证与 Nano 服务 Token 仍保留。
