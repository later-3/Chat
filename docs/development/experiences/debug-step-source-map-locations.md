# Nitro Step 断点映射目录遗漏

## 现象与根因

2026-09-18，F5 启动后 `src/workflows/minimal-pi-coding-agent/step.ts` 断点为灰色。配置仅允许 `.nitro-debug` 中间产物和 Workflow VM 路径，遗漏 Nitro 实际输出 `.data/debug/output/server`。

只读 Inspector 检查确认 Nitro Worker 已加载该目录的 `index.mjs`，其外置 map 的 `sourcesContent` 与当前 `step.ts` 一致；第 19 行 `const stepStartedAt = Date.now()` 映射到生成代码，V8 也报告有效断点位置。独立 Step bundle 在运行时按需加载，不能假定启动时已经加载。

## 修复与验证边界

两个 Backend F5 配置的 `outFiles` 与 `resolveSourceMapLocations` 同时覆盖 Nitro server 输出和 Workflow Step 中间产物，继续保留无扩展名的 Workflow VM 映射。更新 launch.json 后必须重新 F5。检查真正执行的 Nitro Worker，不能只检查启动器。

此前测试只覆盖中间 bundle 与 VM 路径；构建成功或 Workflow VM 命中都不能证明 Step 断点已绑定。`scripts/debug-environment.test.mjs` 现对两个 Backend 配置逐一验证实际 server 与 Step bundle 均可被发现并允许解析映射。执行 `pnpm test:tooling`；手工验收在第 19 行设置断点，再从普通会话选择直接执行 Workflow 发消息。Inspector 可断点位置验证不等同于 VS Code 界面已实际命中。

## Experience Prompt 资源

以下按既有版本化资源格式归档，供显式导入 Personal 或 Project Prompt 库；不自动加入任何 Agent 默认能力。

```json
{
  "schemaVersion": 1,
  "id": "debug-step-source-map-locations",
  "revisions": [{
    "schemaVersion": 1,
    "id": "debug-step-source-map-locations",
    "revision": 1,
    "kind": "experience",
    "title": "源码断点需覆盖实际 Worker 输出与独立 Step bundle",
    "purpose": "排查 Nitro 和 Workflow 源码断点未绑定，避免用相邻执行链验证代替实际脚本证据。",
    "content": "先检查实际执行 Worker 的 scriptParsed URL，再核对 source map、源码内容与可断点位置。F5 的 outFiles 和 resolveSourceMapLocations 必须同时覆盖 Nitro server 输出及按需加载的 Step bundle；Workflow VM 另有无扩展名脚本 URL。更新 launch.json 后重新启动调试会话。使用函数体内可执行行和真实 Workflow 入口验收；构建成功、健康 HTTP、VM 命中均不能代替 Step 断点命中。",
    "tags": ["development", "incident", "debugging", "workflow"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/debug-step-source-map-locations.md", "capturedAt": "2026-09-18T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-18T00:00:00.000Z"
  }]
}
```
