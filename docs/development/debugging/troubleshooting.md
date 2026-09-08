# 日志与故障定位手册

先回答：哪个入口、哪个实例、哪次请求、最后成功到哪里。健康接口只证明HTTP存活；Channel ready只证明适配器启动；202只证明接收。三者都不能代替用户最终收到结果。

## 日志在哪里、怎么看

每个调试启动器会在终端打印本次log完整路径。优先直接打开该文件，或者在Chat根目录执行：

```bash
ls -lt .data/debug/logs
# 替换成终端打印的本次文件，不同时tail所有历史日志
tail -n 100 .data/debug/logs/<本次时间-PID-backend>.log
tail -f .data/debug/logs/<本次时间-PID-nanoclaw>.log
rg -n 'accepted|step starting|tool started|tool finished|failed|completed' .data/debug/logs/<本次Backend文件>
```

| 需要的信息 | 位置 | 注意 |
|---|---|---|
| 页面报错、请求/响应 | 专用Chrome Console、Network | Console堆栈、HTTP状态、响应体、发起者分别看 |
| Vite构建/代理错误 | `*-frontend.log` | 不是浏览器运行时异常日志 |
| Backend/Workflow/Pi执行 | `*-backend.log` | `[workflow]`与`[pi]`；Long Agent日志标签可能不同 |
| 本地假模型收到请求 | `*-model.log` | 只记录模型/消息数/响应类别，不记录完整Prompt |
| Nano启动、路由、投递 | `*-nanoclaw.log` | ANSI颜色正常；LOG_LEVEL=debug仅在调试Nano env显式开启 |
| Group/Memory与配置写审计 | `.data/debug/chat-home/logs/audit.jsonl` | 不代表每个HTTP请求都有审计 |
| 原始模型/Tool消息 | 调试Home `projects/<projectId>/sessions/*.jsonl` | 先通过Web完整历史/Session API阅读；不要手改JSONL |
| Workflow耐久数据 | 调试Home `runtime/workflow-data` | 不用删除目录修复单个Run |
| Channel待处理/绑定状态 | 调试Home `runtime/long-agent-state.json` | 人工只读排查；Chat写入由原子更新服务负责 |
| Nano实体和状态 | 调试工作区中的`pnpm ncl ... --json` | Chat业务不得直接读Nano DB；CLI输出可能含身份信息 |
| Group快照 | 调试Home `runtime/long-agents/<id>/...` | latest派生缓存与按revision不可变Snapshot不是同一用途 |

Backend时间包含UTC偏移；Nano控制台常用本地时分秒，日志文件名用UTC ISO时间。对齐时记录日期和时区，不能把相差8小时误判为旧事件。运行日志不是完整分布式Trace，部分关联需断点与持久状态一起看。

## 关联ID不要混用

| ID | 来自哪里 | 用途 |
|---|---|---|
| projectId | Project/API | 确认数据与权限作用域 |
| Chat sessionId | `/runs`、Long Agent响应、Session API | 原生对话历史 |
| runId | `/runs`返回 | Workflow状态、取消、事件流 |
| workflowInvocationId | Run响应/Session CustomEntry | 串起同一Workflow的阶段与配置 |
| longAgentId | Registry/长期同事API | 长期身份 |
| Nano sessionId / agentGroupId | Nano路由/实体 | 渠道坐标与Group身份，不能代替Chat sessionId |
| eventId / turnId | Nano Outbox/Chat ingress/Turn marker | 重试同一轮；完成事件不重复执行 |
| deliveryId | Chat→Nano Delivery | 投递去重，典型由稳定Turn生成 |

可用`rg -n --fixed-strings '<已知ID>' <本次日志>`搜索已有字段；搜不到不表示没执行，先判断该层是否实际记录该ID。不要按消息正文跨系统“去重”。

## 按症状定位

| 症状 | 先查 | 继续到哪里 |
|---|---|---|
| F5提示端口/lock占用 | 归属记录、PID启动时间、端口、并发control操作 | 重试启动或debug:stop；未知归属不按端口强杀 |
| 页面显示正常环境历史 | 浏览器profile、URL、projectId、Backend agentDir | 停本次调试，修复路径；不要删正常数据 |
| 页面401/登录循环 | `chat-session` Cookie、profile、签名密钥 | 单独调试profile；不清理正常浏览器 |
| 点击发送无网络请求 | useAgentSession、owner、输入校验 | Frontend分支/事件处理 |
| `/runs`返回400 | 响应错误、Project、workflow、Agent选择 | 配置/请求parser，不先调模型 |
| 202后一直running | Step日志、Workflow内部回调、Source Map | 开发产物、队列，再到Pi |
| Node模块不能用于Workflow | 报错路径是否生成的steps.mjs | 缓存目录重入；见开发经验 |
| 模型401/429/连接失败 | 实际provider/model、认证、服务错误 | ModelRuntime与Provider；不要默认无限重试Tool |
| Skill不生效 | Catalog→selection→reload→Prompt→read | [资源章节](./configuration-resources.md) |
| Tool不存在/Schema拒绝 | 注册名、active tools、参数Schema | registry、Pi注册、Provider兼容 |
| TG/WX平台消息未入Chat | Adapter、sender权限、Wiring、Inbox/Outbox | [渠道章节](./channels.md) |
| Channel已202但无回复 | Chat pending事件、绑定、Turn错误 | Long Agent模型/资源/执行 |
| Pi完成但平台无回复 | Delivery落盘、Adapter在线、投递错误/Ack | 不重新调用模型修投递 |
| Group修改409 | expectedRevision与当前revision | 重读并处理草稿，不强制覆盖 |
| Group身份看起来旧 | Snapshot revision、stale原因 | 临时网络失败可用缓存；401/404/合同错误不能用旧缓存掩盖 |
| 改默认模型后旧Session没变 | Session最近选择/显式覆盖 | 重置该Agent或新Session验证 |
| Nano启动Tripwire失败 | worktree commit、marker、安装/构建/测试 | 受控升级完成后写marker，不删除保护 |
| “停止”后还看到服务 | 进程是否属于普通dev/生产，或独立启动配置 | 按[关闭手册](./stopping.md)选择--normal或--debug；跨组件业务排空尚未实现 |

## 人工只读检查Nano

```bash
cd .data/debug/nanoclaw
pnpm ncl groups list --json
pnpm ncl messaging-groups list --json
pnpm ncl wirings list --json
pnpm ncl sessions list --json
pnpm ncl dropped-messages list --json
```

确需查看数据库时仅限操作者在隔离实例的只读诊断，遵守Nano原生`q.ts`规则；不要把SQL嵌入Chat业务来跨越HTTP合同。修改状态始终用对应管理接口，不手写Inbox、ACK或Session完成标记。

## 故障记录模板

```text
场景：WEB-01 / TG-01 / WX-01 / ...
时间和时区：
版本：Chat / Frontend / Pi / Nano各自Commit；实际Nano调试worktree路径
环境：调试端口、Chat Home、模型（不含Credential）
复现：最小输入、前置配置、预期、实际
关联：projectId/sessionId/runId/eventId等适用字段
证据：最后成功节点、首个失败节点、脱敏错误类别
结果：根因/修复/回归测试/文档章节/未验证范围
```

私有日志可能含用户内容、平台ID、文件路径、Tool输出。分享前删Cookie、Authorization、模型/Bot Token、二维码和私有正文；不要默认上传整份HAR或整个Chat Home。发布到Git的事故记录只保留可复用机制与合成示例。

形成可复用事故时进入`docs/development-experiences`，并通过既有Prompt资源机制形成experience；至少增加一条自动化回归门禁。统一诊断视图、完整actor追踪、日志保留策略仍是待实现产品能力，详见[诊断与记录](../diagnostics.md)。
