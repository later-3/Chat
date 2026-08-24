# 最低供应链基线

本基线只覆盖当前可执行工程风险，不建立发布平台、SBOM、签名、tag或部署自动化。

- 三仓来源：[`config/managed-sources.json`](../../config/managed-sources.json)唯一锁定Chat工具链、Pi/DSH
  origin、branch、commit、锁文件、构建输入、marker、许可证与Chat source link。
- Action与权限：`.github/workflows/ci.yml`的Action固定完整SHA，checkout关闭凭据持久化，顶层只读权限和
  concurrency/cancel由YAML结构测试验证。
- 安装生命周期：`pnpm-workspace.yaml`只允许`@deepseek-ai/dsh-subprocess-local`与`node-pty`；Pi/DSH
  安装统一`--ignore-scripts`，真实构建只执行Manifest白名单命令。
- 许可证：Chat与DSH分别用其固定pnpm枚举完整生产树，Pi从Manifest的3个真实linked package递归解析已安装
  production/optional运行闭包；三仓结果统一由
  [`config/supply-chain-policy.json`](../../config/supply-chain-policy.json)检查。例外绑定仓库、精确版本和精确
  包名或仅尾随`*`的平台工件前缀；新`Unknown`或非允许许可证失败。
- 密钥：扫描全部tracked与未忽略的新文本文件；Provider、GitHub、Google、AWS和私钥形态0命中。
- Audit：`pnpm supply-chain:audit`以去凭据环境只读运行Chat `pnpm audit --prod`、Pi
  `npm audit --omit=dev`和DSH固定pnpm版本的`audit --prod`，不修改Fork锁文件。

`pnpm supply-chain:check`是本地静态门；依赖、锁文件、Managed Fork或CI变化还要运行audit。普通CI不
设置Provider或外部写开关。上游audit工具若因注册表不可用而不能完成，应报告真实限制，不能改锁文件或
跳过来源验证伪造成功。
