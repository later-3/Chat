# 统一会话执行与导航的接缝

日期：2026-09-27；适用范围：Chat 单进程 Nitro API/Workflow Step/Pi Session。

## 现象与根因

1. 新统一链在 work 后失败：`Agent配置包含未知字段: sources`。ResolvedWorkflowAgentDefinition 带检查来源，扩展结构直接写进严格 Agent 装配快照；下一阶段读取按 capability Schema 校验失败。快照应只含明确的配置字段，来源仍留检查记录。
2. 同进程 SDK Step 与 API 的模块实例不一定相同。锁、取消句柄放在模块局部 Map 会让 API 看不到当前 Pi，或两个入口以为自己都持有写权。使用稳定 Symbol 的同进程槽共享既有锁/句柄；不把它当持久状态、多进程锁或新执行引擎。
3. 单条会话 GET 很快，但轮询时点击仍卡顿。旧页面同时请求多个 Project 列表，列表反复解析原生全文。应测轮询碰撞而非刻意等网络静默：原生摘要按 stat 指纹重验，一个 overview 响应共享归属读取，前端 ETag 不变不重绘。

4. API 和两帧完成计时很快，点击仍有刷新感：联系人按钮短暂全部 disabled 并降到 0.55 透明度；keyed ChatWindow 首帧 loading，随后 effect/Promise 才应用已缓存的数据；滚动又延迟一帧。保留会话隔离，在 layout effect 同步应用已校验交接数据并初始定位；短暂导航不变灰整列，忙碌文字延迟至 300ms。

5. 隔离预览列表正常但部分详情 404：副本 Session 的 cwd 与运行后 Project Registry 不一致，群参与标记引用的成员登记也未复制。必须验证所有可列出详情，保留原权限检查；仅修复隔离夹具路径/依赖，不能修改正式历史或移除绑定。`unified-session-perf.mjs --audit-sessions` 真实 HTTP 门禁在修正前 181/187、修正后 187/187，失败返回非零。

6. 记忆页同名 Agent 重复且 Project Memory 返回 500：旧过滤只认 `daily-` 前缀，迁移后的 home 已由 Registry `kind=agent` 表达。目录/新建目标均按 kind 过滤，错误目标返回 400，Agent 切换不发 Catalog 请求。个人库和 NanoClaw 分别检查，隔离副本的空库/离线不当作数据丢失。门禁是 `test/memory/memory-tree.test.mjs`、`memory-manager.test.mjs` 与 `scripts/session-memory-switch-browser.test.mjs`。

7. 日历绿点能请求到 Session，但聊天为空：dailySessions 是每日归属，不是活动事实，已分配空壳也有绑定；后台工作和主题又不在该表。复用 Agent Home 原生列表与消息日期，空壳不亮、同日多个会话在工作区侧栏展示，不补一个新的日历账本。`daily-lifecycle.test.mjs` 与真实浏览器同时覆盖空壳和两条同日会话，不能只断言导航 URL 或 HTTP 200。

8. 去掉历史只读文案不等于恢复会话：owner 投影、接受目标、执行重开和默认今日指针必须一致；已完成总结要因新接受轮次更新 cutoff。旧迁移 Home header 只能凭精确迁移回执及源 Registry cwd 在公共打开入口兼容，不能全局忽略目录校验。日历/普通链接打开主题还必须保留服务端节点绑定，不能丢到默认日常发送。

9. 后台工作列表包含合法可选 topicIntegration，但严格前端解析器未同步，导致整张列表失败。扩展 HTTP 类型必须同步运行时解析器并验证可选结构，不能只改 TypeScript 接口或直接忽略未知字段。

10. 日期清单只显示工作标题时，同一定时任务的两次正常执行看起来像重复记录；旧日期选择又按会话数量分三种行为，主侧栏仍列全部历史。日期统一导航到当日工作区，侧栏按日期投影既有 Session/work，显示创建时间，URL 只保留视图日期。用相同标题、不同 Session/日期的浏览器夹具验证切日、刷新和返回今日。

11. Friend 协作项目栏与 `height:100%` 聊天区相加超过父容器，底部工具栏被 overflow:hidden 裁切。父容器按列分配剩余高度、消息区允许收缩、输入区不收缩；会话记忆入口进入同一工具栏。浏览器必须检查整个输入/工具栏/记忆入口的实际矩形在视口内，不能仅确认 textarea 存在。

## 为什么相邻验证不够

未打包的领域测试只有一个模块实例；只测 work 不读 remember 快照；只测小会话或等待轮询空闲会掩盖全量解析竞争。测试必须贯穿真实 Runtime，并分别报告接口、可见目标消息、输入和绘制，不能用 body 中藏着文本作为聊天已可用。

## 回归

- `scripts/unified-session-runtime.test.mjs`：真实 SDK 默认/审核/恢复/remember/停止/节点业务 Workflow，实际进程 kill 后没有未知工具自动重放。
- `scripts/topics-browser.test.mjs`、`session-memory-switch-browser.test.mjs`：真实聊天与记忆通知/取消。
- `test/session-files.test.mjs`：外部追加、重命名、删除可见，未变文件不重复 parse。
- `frontend/lib/session-view-cache.test.mjs`：目标隔离、取消、并发合并、有界缓存、下一次导航权威重读。
- `scripts/session-memory-switch-browser.test.mjs`：实际跨联系人暖切换，DOM/逐帧检查输入不消失、联系人不灰闪；`frontend/lib/chat-auto-scroll.test.mjs` 验证初次定位无需等动画帧。
- `scripts/unified-session-perf.mjs`：非门禁毫秒测量，含与轮询同时发生的点击。

## experience 资源

以下是可显式导入的资源，未写入用户正式资源库、未全局注入。

```json
{
  "schemaVersion": 1,
  "id": "unified-session-runtime-seams",
  "revisions": [
    {
      "schemaVersion": 1,
      "id": "unified-session-runtime-seams",
      "revision": 1,
      "kind": "experience",
      "title": "统一执行要验证装配快照、跨 bundle 句柄和轮询碰撞",
      "purpose": "避免会话迁移只有表面接口统一，而遗漏阶段装配或读取竞争。",
      "content": "统一会话时保留 Pi 历史与公共装配，队列只管来源和顺序，SDK 负责 Run/Step。不要把 resolved Agent 的检查来源元数据直接持久成严格配置。真实 Nitro API 与 Step bundle 可能加载不同模块副本，本进程锁/取消句柄须共享实例，持久事实仍归 SDK 和领域存储。性能基线必须含列表轮询重叠，测目标 Session 的消息/输入/绘制，不能只看单 API 时间或隐藏 DOM。缓存是可丢弃投影，每次导航重读授权与原生版本。低延迟不等于无闪动：缓存同步进入首帧、初次滚动在绘制前完成、短暂导航不降低整列透明度；用 DOM/逐帧回归而非仅最终计时验证。数据副本还须保存 Project 路径一致性和群参与授权依赖，分享预览前遍历列表做真实详情读取，缺失依赖不得放宽产品校验。Memory 目录按 Project kind 分类，不只检查迁移前 ID 前缀；隔离 Catalog 为空和 NanoClaw 离线要分别核实，不能声称正式记忆丢失。日历活动不能仅凭每日绑定点亮：复用原生 Session 消息日期，空壳不亮、同日多会话在工作区侧栏展示；浏览器必须断言对应内容可见，不能只看 URL 或 HTTP 200。显式旧会话续聊须同时验证 owner、受理、执行和默认今日指针；迁移 cwd 只凭准确回执兼容，不全局放开。可选 HTTP 字段也要同步严格前端解析器，避免一条新记录挡住整个列表。日期导航应统一改变工作区的日期视角，同名工作靠耐久身份和时间区分，不能按标题去重。额外项目栏不得叠在100%高度聊天区之外；验证完整底部工具栏的可见矩形，不只检查输入框存在。",
      "tags": [
        "workflow",
        "session",
        "performance"
      ],
      "status": "active",
      "sources": [
        {
          "type": "manual",
          "entryIds": [],
          "context": "docs/development/experiences/unified-session-runtime-seams.md",
          "capturedAt": "2026-09-27T00:00:00.000Z"
        }
      ],
      "author": {
        "type": "agent"
      },
      "createdAt": "2026-09-27T00:00:00.000Z"
    }
  ]
}
```
