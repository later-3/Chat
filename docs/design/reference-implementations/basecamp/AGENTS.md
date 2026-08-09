# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved prototype direction

- The user rejected the earlier Chat UL1 shell because it remained far from the named reference products.
- This prototype is a private reference-study implementation, not Chat production UI.
- The selected visual truth is the user-provided Basecamp Home screenshot at `2266 × 1282`.
- Reproduce Basecamp's visible layout, density, hierarchy, colors, typography, and interaction rhythm before translating anything into Chat.
- The primary flow is `Home → Project Room → Tool → Item detail → predictable back`.
- Do not reuse the failed UL1 navigation shell, Chat fixtures, Chat themes, or Chat product copy.
- 2026-08-09 用户以“像了”验收通过本参考实现；后续参考产品一律沿用“先锁定真实截图、再高保真还原、最后才讨论 Chat 化”的门槛。
- 2026-08-09 用户要求 v0.2 同时补齐 UI 与点击交互：保留 v0.1 已通过的视觉基线，所有可见按钮必须导航、改变同一份内存状态、打开可操作弹层，或明确 disabled；禁止静默 no-op 与只弹临时 toast 的假完成。
- v0.2 的主验收路径扩展为 `Home → distinct Project → 6 tools → Project Tasks → distinct Todo detail → predictable back`，To-do、subtask 与 comment 必须跨列表和详情复用同一对象状态。
- 2026-08-09 用户明确要求参考实现按“覆盖了什么用户场景”而非按页面数量验收。v0.3 起，每个参考场景必须有 `情境 → UI 模式 → 标志性交互 → 可验证状态 → Chat Take/Adapt/Refuse` 证据矩阵；只有选定场景全部覆盖才可冻结。
- 主题属于全局环境偏好，不属于 Project/card 状态。Home、Folder、Project、Tool 与 Item 导航必须保持主题连续；深色只可作为局部内容或明确的全局主题选项，禁止拼接不同参考截图导致导航换肤。
- Basecamp 场景研究已于 v0.3 冻结；后续只修 P0/P1 缺陷或新增明确研究问题，不再为了“更全”继续复制页面。
