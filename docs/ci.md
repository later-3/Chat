# Chat CI

## 职责边界

Chat使用父仓库固定两个公开Submodule Commit：`pi/`和`frontend/`。因此CI分两层负责：

1. 子仓库CI验证子仓库自己的源码。Pi的完整构建、检查和测试属于`later-3/pi`；Frontend的独立测试应在`later-3/chat-frontend`执行。
2. Chat父仓库CI只验证父提交固定的两个Commit能够共同构建，并通过Chat的前后端、Workflow、Pi装配和生产服务集成闭环。

父仓库不重复运行Pi的完整测试，否则每次Chat改动都会重复两千余条与Chat接缝无关的用例。更新gitlink之前，仍应要求目标子仓库Commit自己的CI通过。

## 公开Submodule读取

`later-3/pi`和`later-3/chat-frontend`均为公开仓库，`.gitmodules`固定使用HTTPS URL。`actions/checkout`可以直接递归读取父提交记录的gitlink，不需要个人Token、SSH私钥或额外的Actions Secret；同时保留`persist-credentials: false`，避免后续构建步骤继承GitHub写入凭证。

外部Fork的`pull_request`也能读取公开Submodule，因此不需要`pull_request_target`，更不能借此让不受信任的PR代码获得额外权限。

## 阻断式检查

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)保留单一名为`ci`的Job，与`main`分支保护要求的Context一致。它在`push main`、`pull_request`和手工触发时执行：

```text
读取固定Submodule Commit
→ pnpm pi:prepare
→ pnpm install --frozen-lockfile
→ pnpm verify
→ Git/Submodule差异检查
```

`pnpm verify`已经包含后端与前端测试、类型检查、前端与Nitro生产构建、构建产物HTTP测试，以及Nitro开发链的真实Workflow/Pi AgentSession测试。因此CI不再重复增加一个仅检查`/api/health`的服务。

当前保持单Job，因为拆分后每个Runner都必须重新拉取Submodule、安装两套包管理器依赖并构建Pi；通过Artifact传递Pi `dist`、`.output`和原生依赖也会增加平台与陈旧产物风险。只有冷启动持续超过10分钟且能证明分Job节省总时间时，才考虑拆分。

CI固定使用Ubuntu 24.04、Node.js 22.19.0和pnpm 10.13.1。缓存只包含pnpm Store和Pi的npm下载缓存，不缓存`node_modules`、Pi `dist`、Frontend `dist`或`.output`。

## 当前非目标

- CI不部署、不读取正式Provider密钥，也不运行付费或外部写测试。
- 已删除的`maintenance` Workflow不恢复；依赖审计或模型目录漂移检查应在出现明确需求后单独设计。
- `pnpm pi:prepare`目前仍会联网生成Pi模型目录。这与真实安装链一致，但受外部模型目录可用性影响；后续应优先在Pi仓库提供带Digest的可复用模型数据准备入口，再由Chat调用，避免父仓复制Pi内部版本常量。
