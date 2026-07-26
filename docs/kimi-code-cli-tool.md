# Kimi Code CLI开发工具手册

## 1. 已验证基线

2026-07-23源码与命令基线验证：

1. 本机命令为`/Users/xulater/.kimi-code/bin/kimi`，版本`0.29.0`。
2. 匹配上游Tag为`@moonshot-ai/kimi-code@0.29.0`，提交
   `8bf5bacba9e524c38fb808c0122070037ead25a8`。
3. `kimi --prompt ... --output-format stream-json`真实返回Assistant、Tool Call、
   Tool Result和`session.resume_hint`；使用返回的Session ID可继续同一会话。
4. 个人Codex Skill位于
   `/Users/xulater/.codex/skills/kimi-code-cli/SKILL.md`，新Session收到“使用Kimi
   Code CLI工具”时应直接加载，不再重新研究。

2026-07-26本机运行版本已升级为`0.29.1`。本轮重新通过`kimi doctor config`与
交互式TTY完成有界代码修改，命令和权限流程与上述基线兼容；但`0.29.1`源码差异
尚未单独审计，因此源码事实仍只由`0.29.0`固定提交背书，不能把“命令可用”外推为
新版本全部内部实现不变。

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

## 5. 有界实现案例：SD4-A Evidence修复

2026-07-26首次让Kimi K3作为有界写入执行层。任务没有只给“Hash完整、失败关闭”
等口号，而是从[执行层经验手册](./execution-layer-experience.md)选择E01-E07，并给出
SD4-A真实缺陷、错误后果、允许修改路径、禁止项和逐项反例测试。

结果分为4组事实：

1. Kimi正确补上Claim Hash的5个遗漏字段、未交付Result Commit成功门的fail-closed、
   泛型引用Scope解析、权威状态迁移校验和追加竞争冲突，并把错误测试改成攻击测试。
2. Kimi第一次结构修改曾产生47个Pyright错误；它通过质量门发现并修复，说明“先给
   案例再执行”能改善判断，但不能替代编译与测试。
3. Kimi交回时自报48个测试通过；独立审核仍发现SQLite连接未关闭产生线程警告、
   Owner/Scope解析被塞进1324行Repository，以及Result Commit没有绑定Claim Hash/
   版本和Decision Scope。审核者继续拆分模块、补合同与测试后才进入全量门。
4. 最终判断：案例化经验显著降低了原缺陷复发，但Kimi仍是执行层，不是完成事实源。
   后续任务继续按风险选卡，并保留独立Diff审查、语义攻击、全量回归和迁移回放。
