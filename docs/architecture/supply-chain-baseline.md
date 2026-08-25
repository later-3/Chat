# 最低供应链基线

本基线只覆盖当前可执行工程风险，不建立发布平台、SBOM、签名、tag或部署自动化。

- 三仓来源：[`config/managed-sources.json`](../../config/managed-sources.json)唯一锁定Chat工具链、Pi/DSH
  origin、branch、commit、锁文件、构建输入、marker、许可证与Chat source link。
- Action与权限：`.github/workflows/ci.yml`的Action固定完整SHA，checkout关闭凭据持久化，顶层只读权限和
  concurrency/cancel由YAML结构测试验证。
- 安装生命周期：`pnpm-workspace.yaml`只允许`@deepseek-ai/dsh-subprocess-local`与`node-pty`；Pi/DSH
  安装统一`--ignore-scripts`，真实构建只执行Manifest白名单命令。
- 许可证：Chat枚举锁文件生产树（其中包含实际运行的DSH发布包），Pi与DSH Fork分别从Manifest的真实
  linked package递归解析production/optional源码闭包；三仓结果统一由
  [`config/supply-chain-policy.json`](../../config/supply-chain-policy.json)检查。例外绑定仓库、精确版本和精确
  包名或仅尾随`*`的平台工件前缀；新`Unknown`或非允许许可证失败。
- 密钥：扫描全部tracked与未忽略的新文本文件；Provider、GitHub、Google、AWS和私钥形态0命中。
- Audit：`pnpm supply-chain:audit`以去凭据环境生成4层证据：Chat production；Pi的3个链接执行包；DSH
  Manifest链接workspace、固定构建产物import与Chat锁文件运行解析；DSH whole-fork债务。前三层有任一
  告警即失败。Whole-fork仍用固定pnpm执行完整只读`audit --prod`，但只有机器路径证明不在Chat真实闭包
  的告警才作为report-only债务；不使用静态漏洞白名单。向`ui-trajectory`实际闭包注入告警的反例必须失败。

`pnpm supply-chain:check`是本地静态门；依赖、锁文件、Managed Fork或CI变化还要运行audit。普通CI不
设置Provider或外部写开关。上游audit工具若因注册表不可用而不能完成，应报告真实限制，不能改锁文件或
跳过来源验证伪造成功。Whole-fork report-only不表示DSH仓库整体安全通过，只表示当前Chat不执行该路径。
