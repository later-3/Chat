# 会话导航性能合同与实测

状态：2026-09-27 开发分支实现；尚未发布到正式 43110。架构事实归[模块合同](../architecture/chat-module-contracts.md#三类会话的统一执行与导航2026-09-26)；本文维护导航流程、性能目标与验证方法。历史数字见[统一会话交付](../history/reviews/2026-09-27-unified-session-delivery.md)。

## 用户场景与目标

用户点击 Friend、Project Session 或主题节点，应连续看到目标消息并可输入；切换 Workflow 只改变下一轮选择，不启动执行，不重建原生 Session。不能通过丢消息、跳过授权、隐藏错误或取消后台工作获得速度。

本机暖切换目标：选中/历史/输入可用 p95 ≤50ms，稳定绘制 p95 ≤100ms。性能同时包括视觉连续性：已有视图不得先变成加载页，联系人列不得因一次点击整体变灰，首帧不得先显示历史顶部再跳到底部。真正慢加载约 300ms 后显示忙碌反馈；API p95 和这些用户指标分别报告。这是指定数据规模的工程目标，不是所有设备、超大历史和远程网络的保证。

## 从点击到显示

| 环节 | 实际工作与归属 | 耗时与可优化边界 |
|---|---|---|
| 1. 点击反馈 | 浏览器保留当前聊天和列表，阻止重复提交；目标忙碌由 aria-busy 表达，超过 300ms 才显示打开中文字 | 不变灰整列，不发模型请求 |
| 2. 解析 Friend 日历 | `POST /api/long-agents/:id/start` 返回服务端今日 Session / projectId | 前批 50 次暖测 p50 11ms / p95 21ms；不可直接用旧 primarySessionId 代替跨日解析 |
| 3. 准备目标详情 | `fetchProjectSessionById`：有近期视图则立即交接，没有则等一次 GET；并发读取共享同一请求 | 近期视图 16 项 / 8MiB / 5 分钟；不是无限缓存 |
| 4. 首帧聊天 | `useAgentSession` 在 layout effect 同步解析已交接数据；聊天仍按 Session 隔离草稿、观察器和运行引用；首次滚动在绘制前定位 | 缓存/刚下载的数据不经过异步 loading 空白帧；不常驻多个执行控制器 |
| 5. 权威校验 | 暖导航重新 GET 当前 Session；冷导航共享刚取得的响应；执行结束与外部同步另读最新历史 | 不以导航缓存代替状态、权限、CAS；失败可见，旧目标响应不得覆盖当前目标 |
| 6. 画面更新 | 稳定消息 key；同内容轮询不是新活动，不抢阅读位置；流式/真实新活动仍跟随末尾 | 首屏定位同步，后续布局/增量按动画帧合并；后台校验不显示整页加载 |

上表的阶段有重叠，不能把不同样本的 p95 相加当端到端。当前实现仍重新挂载目标聊天以隔离状态，优化的是挂载首帧和重读行为，没有引入第二套聊天循环。

## 读路径与失效

- 侧栏每轮一个 `GET /api/sessions/overview`，共享 ownership 快照，替代按 Project fan-out。ETag 未变返回 304，页面保留原列表。
- Backend 只缓存 Pi 原生文件的派生摘要（最多 2048 项），每次 stat 的 dev/ino/size/mtimeNs/ctimeNs 变化即重读；外部 Pi CLI 追加、重命名、删除可见。没有缓存可写 SessionManager 或授权结论。
- `GET /api/sessions/:id?view=chat` 保留完整当前上下文消息；tree 只传分支身份、标签、压缩路径和 160 字预览。全文/完整树保持原合同；工具媒体、思考详情按需读取。
- 浏览器缓存键为 projectId + sessionId，限容量和时间；每次导航重新校验，错误失效。Service Worker 不缓存 Session API。切换仅取消本页读取/观察，不取消执行。

## 已有实测基线

Chrome/CDP，1440×1000，生产构建；隔离数据副本包含 187 个原生会话、约 50MB，三个日常目标消息数 23/0/0；无网络响应替换。首次访问并非进程冷启动。

| 场景 | 次数 | 消息/输入 p50 / p95 | 两帧绘制 p50 / p95 |
|---|---:|---:|---:|
| 页面首访（服务已热） | 3 | 64 / 82ms | 97 / 101ms |
| 暖切换 | 50 | 32 / 33ms | 65 / 66ms |
| 轮询重叠 | 10 | 35 / 38ms | 69 / 71ms |

这是去闪动修复前的速度基线：两帧终态指标很快，仍可能存在中间闪动，不能据此声称视觉连续性通过。连续性回归另检查 DOM 变化及逐帧状态。

18,049,034 字节原生大会话的 202 条当前消息不变：详情从 19,484,665 降至 1,445,347 字节（减少约 92.6%），5 次 API 读取中位数约 168→97ms。没有将这个数字等同于大历史浏览器首帧。

## 验证与证据

- 自动化回归：`scripts/session-memory-switch-browser.test.mjs` 经实际 Friend 点击切换，跨多个联系人后检查无聊天空白、无整列灰闪、历史保留；已纳入 `pnpm test:dev`。
- `frontend/lib/chat-auto-scroll.test.mjs`：首屏绘制前定位；未变轮询保留阅读位置；后续工具/正文/延迟布局仍跟随。
- 缓存/失效：`test/session-files.test.mjs`、`frontend/lib/session-view-cache.test.mjs`；真实 Run 能力使用 `scripts/unified-session-runtime.test.mjs`。
- 延迟实验：`node scripts/unified-session-perf.mjs http://127.0.0.1:<隔离端口> 50`。脚本拒绝正式 43110；保留原始 summary/samples、目标身份/消息数和轮询碰撞。私有证据放 gitignored `.data/verification/unified-session/`，不入库。
- 每次报告注明构建、设备、数据规模、冷/暖/后台活动；毫秒阈值用受控性能实验，功能门禁验证连续性和正确性，避免机器负载造成假失败。

未来评估大历史渲染、移动端或跨网连接时单列基线，不把当前三目标测量冒充全场景上限。当前反馈聚焦切换连续性，不改变执行、记忆、审核或恢复合同。

本次连续性修正验证：`pnpm verify` exit=0（56 / 655 / 200 / 30 / 12），架构链接与两仓 diff 检查通过；修正版已运行在隔离预览 63291，正式 43110 未部署。

## 隔离预览的数据完整性门禁

复制原生 Session 用于预览时，必须同时准备其读路径依赖：Project Registry 的实际 root 与 Session header.cwd 一致；系统共享 Project 使用既有 managed workspace；群参与 Session 的 `chat.group-participation.v1` 引用必须存在对应群定义/成员登记。只复制 JSONL 会使列表正常、详情却 404。源码工作区本身的 Project ID 可能与副本占用同一登记身份，应在预览启动后核实实际路径，不假设初次复制后的 registry 永不变化。

分享预览前运行：

```bash
node scripts/unified-session-perf.mjs http://127.0.0.1:<隔离端口> --audit-sessions
```

该模式经实际 overview 与详情 API 逐项校验 Session 身份和消息数组，任一失败 exit=1，脱敏结构化结果写入 gitignored `session-audit.json`。这是只读预览门禁，不启动模型、不重放失败执行。保持原后端权限校验，不能通过删除群参与标记或放宽 cwd 校验来制造成功。

2026-09-27 真实预览发现 6 个 Chat 项目群参与会话读取失败：副本目录不匹配，且漏了 3 份群登记。修正仅作用于隔离副本（33 个 header 路径对齐，所有消息 Entry 字节不变），补入被引用的群定义，不复制渠道、投递、工作队列或凭据。修复前门禁 181/187、exit=1；修复后 187/187、exit=0。原链接返回 12 条消息，无历史 assistant error；正式 43110 数据未改。
