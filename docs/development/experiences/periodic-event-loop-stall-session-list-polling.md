# 周期性事件循环阻塞：Session 列表轮询触发 Pi listAll 全量流式解析

## 现象与影响

2026-09-28，用户在 Chat Web 点击不同 Long Agent 切换会话时持续感到卡顿（p50 1.4s / max 2.5s，违反 ui-ux-guidelines 300ms 要求）。外部 100ms 间隔探测 release 后端 `/api/long-agents` 发现毛刺成簇出现：每 ~6.3s 一簇 231-1006ms。前端 0 longtask——卡顿全部来自后端事件循环阻塞期间排队等响应。

## 排查方法

1. `sample <pid>` 排除同步 fs：阻塞在纯 JS microtask。
2. `kill -USR1 <pid>` 开 inspector，从 `/json/list` 取 UUID WebSocket URL（根路径返回 non-101）。
3. `Profiler.setSamplingInterval(1ms)` + 20s 采样，按 self-time 聚合；父子关系必须由 `children` 数组推导（CPU profile 节点没有 parent 字段），否则调用链全部断在 root。

## 根因（两层叠加）

1. **SessionSidebar 每 4s（有活动时 1s）对每个 available project 轮询 `GET /api/sessions`**。后端 `toListItems` 对每个 session 文件做两次全量解析：一次 `SessionManager.open().getEntries()` 算 subsession relation，一次 `firstSessionUtterance` 内部再次 open；`findActiveChatSessionFile` 也有同款双解析。
2. **Pi 的 `SessionManager.listAll` → `buildSessionInfo` 本身对每个文件全量逐行流式解析**（含 `allMessagesText` 拼接）。Friend 项目 30-37 个 session 文件 → 每次轮询阻塞 300-800ms。

早期修复（Intl.DateTimeFormat 缓存、859KB state 文件读缓存、calendar 重扫指纹跳过）只消掉维护路径的热点；轮询路径的 listAll + 双解析仍在，毛刺只是变小（每 ~4.7s 一次 300-600ms）。

## 修复（Chat 读模型层，行为保持）

`src/session-files.ts`：抽 `firstUtteranceFromEntries(entries, fallback)` 纯函数，`firstSessionUtterance` 变薄包装，`findActiveSessionFile` 复用已打开的 entries。

`src/session-read-model.ts`：

- `listItemDerived`：每文件一次 open，relation + firstMessage 同批 entries，按 `ino:mtimeMs:size` 指纹缓存。
- `cachedListActiveSessionFiles`：目录指纹（文件名名单 + 每文件 stat）命中则跳过 `listAll`。Session 文件 append 必增 size/mtime，替换文件必换 ino，因此指纹失效可靠。

## 结果

探测 ≥200ms 样本 38 → 3 次（p95 14ms）；切换 p50=p95=max=157ms，0 longtask，0 慢 API。剩余孤立毛刺是缓存失效后的预期重算（数据变了必须重算），频率等于写频率而非周期性。

## 正确姿势

1. "每 N 秒一个慢请求"优先怀疑周期性调用方（前端轮询、interval 任务）× 无缓存的全量解析叠加；单次快不代表轮询便宜。
2. 缓存 append-only 文件的派生数据用 `ino:mtimeMs:size` 指纹即可保证新鲜度；rename 落盘的 state 文件同样适用。失效正确性必须有回归测试：外部 append 必须可见（messageCount+1）、同路径重建（新 ino）必须可见。
3. 回归门禁：`test/session-read-model.test.mjs`（list 指纹缓存）、`test/long-agents/daily-lifecycle.test.mjs`（state 读缓存新鲜度、calendar 重扫跳过）。
