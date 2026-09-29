# 前端已停发的字段，后端不得仍是必填

## 1. 现象与影响

2026-09-29，Web 私聊发消息整体失败：`POST /api/long-agents/:id/turns` 返回 409「私聊消息必须携带 Friend 项目关联 revision」。前端 0.10.0 已经按统一项目合同不再发送 `interactionRevision`，后端仍在准入处 `requireInteractionRevision: true`，于是一次都不成功。

影响面不止开发环境：标签 `v0.5.1`（前端 `691bcfc` = 0.10.0 + 当时的后端）把两侧捆在一起发布，按交付页装出来的实例 Friend 私聊直接不可用；窗口期是前端 `38b3860`（09-29 08:42）到后端 `56e2c6eeb`（09-29 18:05）。

## 2. 已验证的直接根因

退役一个请求字段需要同时改两侧：**发送端**停止携带、**接收端**停止要求或校验。这次 LA6-A 退役由两条工作线分开落地，前端先删发送（`38b3860`），后端隔了 9 小时才删 `requireInteractionRevision` 与 409 分支（`56e2c6eeb`）。中间任何"新前端 + 旧后端"的组合都会在准入处被拒。

同一批次内的正确做法已经体现在退役提交里：只读兼容（旧 scope 用历史 checksum 校验后按新键重算、旧 conversation 读时剥字段、旧定义剥退役 Tool、`interactionRevision` 仅作旧轮次摘要重试兼容）与写路径的必填校验分开处理。

## 3. 为什么现有验证没有发现

- 后端测试覆盖的是"缺失必填字段应当 409"，没有一条用例断言"前端当前真实请求体可以被准入"；
- 前端测试只断言自己不再引用该字段（`lib/long-agents-browser.test.mjs`），它不经过后端；
- 两侧各自绿，组合红。发布标签又是在窗口期内切出的，交付页不会因为标签内部不一致而失败；
- 当时 CI 的浏览器用例红在别处（被删除的 `scripts/friend-project-browser.test.mjs` 流），这条新失败被当成既知红点忽略。

## 4. 正确实现与验证姿势

1. 退役字段时，同一个提交里同时改发送端与接收端；跨仓时以"以哪一侧为准"写清顺序，不能靠时间差兜底。
2. 接收端的必填校验只对**当前**契约生效；历史兼容只放在读取/摘要校验路径，不能继续作为新请求的必填项。
3. 发布前对**真实 HTTP 入口**跑一次"前端当前请求体"的对偶准入：请求体取自前端实际构造的字段集合，而不是后端测试自己拼的旧格式。
4. 标签切出前核对前后端版本组合：`git ls-tree <tag>` 的 submodule 指针 + 各侧是否为同一契约。

## 5. 自动化回归门禁

- 后端（`test/long-agents/turn-feedback.test.mjs`）：`the unified contract accepts a bare per-turn contextProjectId and freezes it` —— 通过真实 `/turns` 路由只发 `contextProjectId`（不带 `interactionRevision`），断言 202、响应与持久记录里的冻结项目，以及新受理轮的 `interactionRevision == null`。若后端重新要求该字段，这条用例立刻变红。
- 前端（`lib/long-agents-browser.test.mjs`）：断言 AppShell 不再出现 `FriendProjectContext|friend-interaction-project|interactionRevision`，保证发送端与后端契约一致。
