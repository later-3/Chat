# Chat

Chat 是一个以对话为入口、以耐久Workflow为执行骨架、由用户持续介入和审核的个人Agent协作产品。

它把自然语言输入转化为上下文、计划、人工决定、执行、结果、证据和可恢复的长期状态，而不只是显示模型消息。

## 当前技术基线

- 唯一前端：固定版本DeepSeek Harness Web。
- DSH集成：本仓库的`@chat/dsh-lifeos-bridge` Host/Client插件。
- 产品API：REST Query/Command；Product Store拥有权威事实。
- HTTP：Node.js + TypeScript + Hono。
- 耐久执行：Vercel Workflow。
- Agent Runtime：`pi-agent-core`与`pi-ai`。
- Memory：memmy与Tencent MemoryCore Adapter。
- 开发工作台：固定版本code-server，以独立Hosted Workbench接入。

```text
Browser -> LifeOS Web Gateway (127.0.0.1:43110)
         -> DeepSeek Harness Web -> LifeOS Bridge
         -> Code Workbench (localhost虚拟Host -> code-server)
LifeOS Bridge
-> Chat Query / Command API
-> Product Application + Product Store
-> Vercel Workflow
-> pi Agent Node / Governed Tool
-> Product Commit
-> DSH原生会话投影
```

DSH Session、Product Session、Product Run、Workflow Run、Checkpoint、pi Session和浏览器连接始终是不同对象。

## 全新克隆与本地运行

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run setup
pnpm dev
```

主界面固定为`http://127.0.0.1:43110/`。状态和停止命令：

```bash
pnpm dev:status
pnpm dev:stop
```

`pnpm run setup`会按仓库固定证据自动准备DSH Profile、两套Memory源码/依赖和code-server，
不需要另外克隆DeepSeek Harness、memmy、Tencent MemoryCore或code-server。没有配置
`DASHSCOPE_API_KEY`时服务仍可启动和浏览，但真实规划/执行会明确显示Provider not ready。
支持平台、工具链、首次下载、配置与故障处理以[本地安装指南](./docs/getting-started/local-install.md)为唯一入口。

`pnpm dev`默认同时启动Code Workbench；从DSH侧边栏底部的全局入口打开即可，空白新会话也可直接使用。临时不需要时可用`pnpm dev -- --workbench=off`。code-server只监听受管0600 Unix socket，浏览器只能经43110 Gateway访问；43114是DSH loopback内部端口。扩展市场默认离线，不连接Open VSX或自动查询Copilot；未来若接入扩展Provider，必须另行建立显式网络与权限合同。

完整固定端口与断点入口见[本地调试](./docs/debug/local-debug.md)。

## 文档入口

1. [项目上下文](./PROJECT_CONTEXT.md)
2. [当前状态](./PROJECT_STATE.md)
3. [当前计划](./PROJECT_PLAN.md)
4. [技术与所有权合同](./docs/architecture/technology-contract.md)
5. [DSH前端与Chat后端交互](./docs/architecture/frontend-backend-interaction.md)
6. [仓库地图](./docs/architecture/repository-map.md)
7. [Workflow运行设计](./docs/architecture/runtime-workflows.md)
8. [状态与运行时边界](./docs/architecture/system-boundaries.md)
9. [产品设计准则](./docs/product/design-guidelines.md)
10. [工程规范](./docs/engineering-standards.md)
11. [本地安装指南](./docs/getting-started/local-install.md)

当前树不保存旧前端、上游源码副本、历史UI原型或归档目录；需要历史时直接使用Git。
