# Kimi Code CLI开发工具手册

## 1. 已验证基线

2026-07-23验证：

1. 本机命令为`/Users/xulater/.kimi-code/bin/kimi`，版本`0.29.0`。
2. 匹配上游Tag为`@moonshot-ai/kimi-code@0.29.0`，提交
   `8bf5bacba9e524c38fb808c0122070037ead25a8`。
3. `kimi --prompt ... --output-format stream-json`真实返回Assistant、Tool Call、
   Tool Result和`session.resume_hint`；使用返回的Session ID可继续同一会话。
4. 个人Codex Skill位于
   `/Users/xulater/.codex/skills/kimi-code-cli/SKILL.md`，新Session收到“使用Kimi
   Code CLI工具”时应直接加载，不再重新研究。

不得读取、输出或提交Kimi的私有认证配置。版本升级后先重新执行`kimi --version`、
`kimi doctor config`和最小只读合同测试。

## 2. 开发期使用

代码、界面和架构审查默认执行：

```sh
/Users/xulater/.codex/skills/kimi-code-cli/scripts/run-readonly-review.sh \
  /Users/xulater/Code/Chat \
  "说明要审查的问题、相关页面或截图绝对路径，并返回文件位置和验证建议。"
```

包装器通过显式Agent文件只暴露`Read`、`ReadMediaFile`、`Glob`和`Grep`，因此
即使Print模式自动批准权限，也没有写文件或执行Shell的能力。Kimi结论是外部
建议，当前开发者仍需依据源码、Diff、自动测试和浏览器验证做最终判断。

如果明确要求Kimi亲自编辑，使用交互式TTY启动`kimi`，逐项审查权限；禁止
`--prompt`、`--auto`和`--yolo`无人值守修改。

## 3. 为什么不能直接复制pi集成

pi当前通过官方JSONL RPC、临时Provider配置和Chat本机网关实现两道门：
每次Provider Body生成ModelCallDraft，每个内部Tool在执行前进入独立审批。

Kimi有两条不同通道：

1. Print模式输出结构化转录，但匹配源码会启用自动权限，不能作为产品安全门。
2. ACP通过stdio JSON-RPC提供Session、流式更新、Tool Call和Permission Request，
   适合产品Adapter；但ACP不自动公开Kimi内部完整Provider Payload。

所以未来把Kimi加入Chat Tool目录时，应采用`Kimi ACP Adapter -> Tool Permission
Gate -> AG-UI HITL`。若产品仍要求“Kimi内部每次模型调用都展示完整Payload”，
还必须加入独立Provider网关；在此之前只能声明“受控Runtime/Tool权限”，不能
声明“逐次Provider Payload审批”。

## 4. 当前验证

个人Skill已通过`quick_validate.py`。真实只读回合读取
`frontend/package.json`，事件只包含`Read`，正确返回项目名和12个Script，并生成
可恢复Session ID；这证明CLI、显式只读Agent、NDJSON解析入口和认证状态可用，
不代表Chat产品Kimi ACP Adapter已经实现。

随后使用同一只读包装器完成2次真实开发审查：

1. 字号审查读取当前页面截图、样式和前端组件，定位工作台、会话元数据和输入区的
   7–10px显式字号；修复后由项目测试固定11px下限，并在桌面与371px视口复核。
2. 交互审查读取25节点Workflow运行视图及其代码，识别标题语义、节点定位、多详情
   查看和窄屏返回问题；建议经当前开发者结合产品概念边界筛选后实施，并由
   Playwright、键盘焦点和真实浏览器投影独立验证。

这两次使用进一步验证了新Session无需重新研究命令即可调用Skill，但不改变
“Kimi只读提出建议、当前开发者负责修改与验收”的责任边界。
