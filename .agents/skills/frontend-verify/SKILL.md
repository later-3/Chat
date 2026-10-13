---
name: frontend-verify
description: Chat 前端改动的自验证闭环（写之后）。修改 frontend/ 或任何影响界面的代码后，需要证明"没写坏 / 已修好"时使用：typecheck、起 dev 双服务栈、布局体检、双视口截图 + console 采集、读图自评、修复循环。与 web-design-guidelines（写之前的质量门禁）互补。
---

# frontend-verify：前端自验证闭环

作用：在宣称前端改动完成之前，**自己拿到"写坏了没有 / 修好没有"的证据**。
分工：写之前的规范查 `frontend/.agents/skills/web-design-guidelines` 与 `react-best-practices`；
架构问题查 `.agents/skills/chat-architecture`；本 skill 只管**写之后的验证回路**。
执行脚本在本 skill 的 `scripts/capture.mjs`（复用仓库 `scripts/cdp.mjs`，与 browser 测试同源，零新依赖）。

## 硬规则（不分任务大小，每次编辑后立即执行）

1. **编辑后即跑类型检查**：`pnpm --dir frontend typecheck`（实测约 7s）——红了先修再继续，不攒到任务末尾；
2. **浏览器 E2E 前必须 `pnpm build:frontend`**（案例 C83 教训：E2E 读的是构建产物）；
3. 任务结束仍按仓库 `AGENTS.md` 跑完整 `pnpm verify`——本 skill 不替代它。

## 闭环六步（UI 改动完成后必走）

### 0. 确认"能看见"（前端规范第九步）
当前会话模型必须支持图像输入：`read` 一张 PNG 确认可读。
不能读图 → 切多模态模型重启会话，或在汇报里显式标注"视觉未验证，需人工确认"——
**禁止拿 DOM 指标冒充视觉通过**（C49/C52/C58 都是用户先发现的）。

### 1. 类型检查
```bash
pnpm --dir frontend typecheck
```

### 2. 起 dev 双服务栈（前端 30145 + 后端 43112）
```bash
lsof -iTCP:43112 -iTCP:30145 -sTCP:LISTEN   # 已有栈直接用：不要重复起、不要停它
# 没有才起。注意：脚本启动完成后会 `while kill -0 …; do sleep 1; done` 死等子进程，
# 前台跑会永久阻塞——必须后台起（实测教训，2026-10-13）：
nohup bash scripts/dev-start.sh >/dev/null 2>&1 &
# 轮询就绪：
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:30145/ && curl -sf -o /dev/null http://127.0.0.1:43112/api/health && break; sleep 2; done
```
停栈（**自己起的栈收尾时必停**）：
```bash
bash scripts/dev-start.sh stop debug         # 正常路径
# 若报「端口仍占用」（启动 shell 已死、归属记录丢失）：不绕过校验、不按端口盲杀，
# 按归属三证据核对后定向停（案例 C145）：① .data/dev-logs/ 最新目录创建时间
# ② ps -o lstart 进程启动时刻与之对应 ③ 当日无其他启动记录 → kill -TERM <pid>
```

### 3. 布局体检（前端规范第八步，DOM 层硬检查）
```bash
node scripts/ui-layout-audit.mjs "<URL>" "<打开悬浮窗的选择器>"
```
通过标准（规范原文）：视图内只有 1 个主滚动容器 / 关键区域不被裁切 / 无横向溢出 /
756×469 可读可滚到底 / 首屏能看到主要信息 / 底栏不盖正文 / 同屏信息不重复。

### 4. 采集截图与 console
```bash
node .agents/skills/frontend-verify/scripts/capture.mjs "<URL>" [--wait "<页面就绪表达式>"]
```
输出 JSON 到 stdout，PNG 写入 `.data/ui-capture/<时间戳>/`；**退出码只表示采集本身是否跑起来**（0 成功 / 1 采集失败 / 2 参数错），页面有没有问题看 JSON：
- `screenshots`：双视口（1440×900 + 756×469）；
- `consoleErrors` / `exceptions`：控制台错误与未捕获异常（含来源与行号）；
- `failedRequests` / `badResponses`：失败请求与 ≥400 响应。

### 5. 读图自评（视觉判定）
`read` 两张截图，按顺序自查：
1. **小视口图先看**（756×469）——大屏看不出的局部滚动/裁切，小屏立刻暴露（C58）；
2. 前端规范「元素级检查」：同类元素计数与预期一致、同屏信息不重复、导航不自指、元素对齐；
3. JSON 里每条 console error / exception / failedRequest / badResponse **逐条解释**：修掉，或说明为何与本次改动无关；
4. 布局体检（步骤 3）与截图结论冲突时，以截图+人工走查为准，并回头查体检为何没拦住。

### 6. 修复循环与证据
不达标 → 回到步骤 1 修改 → 重跑 1–5，直到截图与 console 干净。
**汇报必须带证据**：typecheck 结果、体检输出、capture JSON 摘要、截图路径。
测试全绿 ≠ 视觉通过（C81/C85）；只有"门禁绿"没有截图 = 没有完成步骤 5。

## 需要交互式操作时（点击流、填表单、多步导航）
已接入 **Playwright MCP**（`pi mcp list` 可见：25 个 `browser_*` 工具，connected）：
navigate / click / fill_form / snapshot / take_screenshot / console_messages / network_requests 等。
- 工具默认经 `codemode`（Pi 自动启用）或 `tool_search` 调用；
- **优先快照路线**（`browser_snapshot`：a11y 结构树，省 token、确定性强），只有视觉问题才截图；
- 回滚：`pi mcp remove playwright`。

## 备选与留观（未安装，按需替换，不在本 skill 默认路径里）

| 工具 | 补什么 | 接入/触发条件 |
|---|---|---|
| `chrome-devtools-mcp` | performance trace、source-mapped 堆栈 | 性能或疑难报错时：`pi mcp add devtools -- npx chrome-devtools-mcp@latest` |
| `agent-browser` / `pi-agent-browser-native` | CLI / Pi 原生浏览器工具 | 想去掉 MCP 间接层时替换 Playwright MCP |
| `pi-lens`（LSP/lint 实时反馈） | 写时即红的增量反馈 | **留观**，满足任一才装：① 实测模型频繁忘跑 typecheck；② 项目引入 eslint/prettier；③ 需要跨文件影响面分析。装时先 `contextInjection.enabled=false`（拉取式，避免注入累积 + prompt-cache 失效），**永不默认开 autofix / commit-guard** |

## 与既有资产的关系

- 布局体检与元素级检查是前端规范第八步/元素级检查的**执行入口**，标准以规范为准；
- 本 skill 的闭环是「改完自己证明」，`pnpm verify` 是「提交前全量门禁」，两者不互相替代。
