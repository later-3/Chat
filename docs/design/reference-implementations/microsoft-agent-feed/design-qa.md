# Microsoft Agent Feed Design QA

final result: passed

## Comparison target

- source visual truth: `/tmp/microsoft-agent-feed-reference-2026-08-09/agent-feed-expand.png`（2711×779，官方 link-only 截图的本地临时副本；仓库不收录）
- source focused truth: `/tmp/microsoft-agent-feed-reference-2026-08-09/agent-feed-card-map.png`（1433×640）
- rendered implementation: `http://127.0.0.1:8127/`
- desktop implementation screenshot: `/tmp/agent-feed-implementation-full-insights-normalized-v2.png`（1440×900）
- desktop comparison input: `/tmp/agent-feed-source-implementation-comparison-v2.png`（1440×1800，官方 full-screen 状态在上，原型 full-screen 状态在下）
- focused data-entry implementation: `/tmp/agent-feed-implementation-data-entry-v4.jpg`；右侧 focused capture v1 用于定位，v4 用于复核修订后结构
- mobile implementation screenshot: `/tmp/agent-feed-implementation-mobile-normalized-v1.png`（390×844 responsive evidence）

## Viewport and normalization

1. Desktop CSS viewport：1440×900；in-app Browser 报告 `devicePixelRatio=0.75`。
2. Browser 原始 raster 为 1920×1200 compositor mosaic；使用左上 1080×675 可见 tile 并 Lanczos 归一到 1440×900。原型 DOM、边界框和交互断言始终在真实 1440×900 CSS viewport 上执行。
3. Source full-screen 状态从 2711×779 composite 的 `x=747, width=1964` 区域裁出，等比缩放并置于 1440×900 白色画布；没有用浏览器 chrome 或外部页面空白判断差异。
4. Mobile CSS viewport：390×844；同一 Browser compositor 产生 493×1099 mosaic，左上 293×633 tile 归一到 390×844。完整宽度行为另外以 DOM 可见性和 bounding box 验证，避免把 compositor tile 裁切误判为页面溢出。

## States compared

1. Official full-screen Agent filter + Needs attention feed + Insights。
2. Prototype full-screen All agents + Needs attention + Insights 7 days。
3. Official data-entry task + source + editable record + top actions。
4. Prototype data-entry candidate + related project + editable fields + top actions。
5. Prototype mobile feed-first、task detail、Back。

## Findings and comparison history

### Iteration 1 — blocked

- [P1 · behavior] Agent filter changed the list but could leave a filtered-out task in the detail pane.
  - Evidence: selecting Evidence Scout left the Project Pilot decision open while the feed showed one assistance task.
  - Fix: added a visible-projection synchronization effect; when an existing selection leaves the projection, detail selects the first matching task and closes nested views.
- [P2 · responsiveness] Mobile computed a fallback selected item even when the route intentionally had no task, so the first screen was detail instead of Feed.
  - Evidence: at 390×844 `.feed-pane` was hidden and `.detail-pane` visible on `/`.
  - Fix: `selectedItem` now requires an explicit `selectedId`; mobile root stays feed-first.
- [P2 · interaction layout] Official assistance/data-entry actions are visible in the task command area; the first implementation kept actions only in a bottom footer.
  - Evidence: source `agent-feed-card-map.png` puts Accept/Dismiss at the top; implementation v1 put them at the bottom edge.
  - Fix: desktop action row is now sticky below attribution and above detail content; mobile keeps the thumb-reachable bottom action row.
- [P3 · content] “Preview reference” read like implementation commentary inside the product.
  - Fix: replaced it with standalone product copy explaining the projection boundary.

### Iteration 2 — passed

- post-fix evidence: `/tmp/agent-feed-source-implementation-comparison-v2.png` and browser DOM checks at 1440×900 / 390×844。
- Agent filter now changes the detail title to `Confirm access to the Agent Feed source record`。
- Mobile root shows Feed, opening a row shows detail, and Back restores Feed on the same mounted list。
- data-entry action group bounding box is `x=678, y=309, width=762, height=51`；Accept button is visible at `x=1180, y=317` in the 1440×900 viewport。
- no actionable P0/P1/P2 difference remains. The prototype intentionally keeps Chat-specific typed objects and does not copy Microsoft fixture content or its unsafe permission model.

## Required fidelity surfaces

1. **Fonts / typography**：Segoe UI and system fallbacks match Fluent character; 10–13px list/meta text and 19–28px hierarchy preserve the dense source rhythm. Weights, truncation and line clamps were checked in feed rows and agent labels.
2. **Spacing / layout rhythm**：thin dividers, low-radius pills, compact rows, side pane/full screen columns and top action band match the reference anatomy. The Chat page header is an intentional host-app context layer.
3. **Colors / tokens**：white and Fluent greys dominate; `#5b5fc7` is the stable selection/action token; critical red and high-impact orange are semantic additions, not decorative theme drift.
4. **Image quality**：four 160×160 own-work generated Agent portraits remain sharp at 23–44px circular crops. All interface icons come from `@fluentui/react-icons`; no emoji, handcrafted SVG, CSS illustration or placeholder asset is used.
5. **Copy / content**：fixture copy is realistic for Chat multi-project work and explicitly distinguishes candidate, accepted fact, Decision revision, evidence and unknown external result. Reference-only commentary was removed from the app surface.
6. **Icons**：Fluent outline icons share size/stroke; generated portraits are reserved for Agent identity rather than replacing controls.
7. **Responsiveness**：1440×900 and 390×844 core paths passed. Mobile hides desktop rails, keeps two tab pills, uses feed-first navigation and a full-screen detail.
8. **Accessibility**：semantic tabs, dialog labels, form labels, focus-visible outline, icon-button names, disabled reasons and status toast are present. No core enabled control is a silent no-op.

## Primary interactions tested

1. Side pane → full screen, with URL state retained。
2. All agents → Evidence Scout filter; list/detail synchronization。
3. Assistance Complete → Completed → Undo。
4. Data entry edit → Accept and complete；accepted field value remains visible。
5. `outcome_unknown` has zero Retry buttons；Reconcile → provider lookup → Outcome reconciled。
6. Open related record → Product Store owner → Back to Agent task。
7. Insights 7/14/30 days；30-day state rendered 10 bars and the value warning。
8. Mobile Feed → task detail → Back。
9. Browser console error check：0 errors。

## Residual P3 polish

- The official full-screen capture is wider and denser than a 16:10 desktop viewport. The prototype preserves the same column anatomy but allows the host Project Operations chrome to remain visible; this is intentional context, not a production UI decision.
