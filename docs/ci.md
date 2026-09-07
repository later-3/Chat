# Chat CI

本文说明CI职责和执行环境。如何为改动选择测试、使用隔离数据与本地假模型，以及何时运行完整验证，见[测试指南](./testing.md)；本地开发入口见[开发文档](./development/README.md)。

## 职责边界

Chat使用父仓库固定三个公开Submodule Commit：`pi/`、`frontend/`和`nanoclaw/`。因此CI分两层负责：

1. 子仓库CI验证子仓库自己的源码。Pi的完整构建、检查和测试属于`later-3/pi`；Frontend的独立测试应在`later-3/chat-frontend`执行；NanoClaw源码改动应在`later-3/nanoclaw`执行自己的构建和测试。
2. Chat父仓库CI验证三个gitlink都能按父提交精确检出，并通过Chat的前后端、Workflow、Pi装配和生产服务集成闭环。NanoClaw尚未接入Chat运行时，因此当前父仓库不安装或构建它的依赖。

父仓库不重复运行Pi的完整测试，否则每次Chat改动都会重复两千余条与Chat接缝无关的用例。更新gitlink之前，仍应要求目标子仓库Commit自己的CI通过。

## 公开Submodule读取

`later-3/pi`、`later-3/chat-frontend`和`later-3/nanoclaw`均为公开仓库，`.gitmodules`固定使用HTTPS URL。`actions/checkout`可以直接递归读取父提交记录的gitlink，不需要个人Token、SSH私钥或额外的Actions Secret；同时保留`persist-credentials: false`，避免后续构建步骤继承GitHub写入凭证。

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
- `pnpm pi:prepare`通过Pi仓库的`restore:model-data`入口恢复固定模型快照；实时模型目录刷新只属于Pi维护和发布流程，不能成为Chat CI或部署的随机输入。

## 本地复现

日常开发可以运行与CI相同的核心验证链：

```bash
pnpm pi:prepare
pnpm install --frozen-lockfile
pnpm verify
git diff --check
git -C frontend diff --check
```

这组命令用于复现构建和测试结果，不包含GitHub Actions的环境与仓库洁净性检查。需要逐项模拟CI时，还要：

1. 使用干净Checkout并递归初始化Submodule。
2. 设置`CI=true`、`CHAT_ALLOW_EXTERNAL_WRITES=0`、`CHAT_ALLOW_PAID_TESTS=0`和`MEM0_TELEMETRY=false`。
3. 确认`pi`、`frontend`与`nanoclaw`当前Commit等于父仓库记录的gitlink。
4. 在验证后运行`git diff --exit-code --submodule=short`，确认构建和测试没有改变跟踪文件或Submodule状态。

如果只有某一层失败，先按[测试指南](./testing.md)运行对应的较小命令定位；提交前仍以`pnpm verify`和差异检查作为父仓库集成结果。CI不得使用正式Provider密钥、付费模型或用户的真实`CHAT_HOME`来复现问题。

以下变化必须同步更新本文和`.github/workflows/ci.yml`：触发条件、权限、运行系统、Node或pnpm版本、缓存范围、Submodule校验、阻断命令及允许的外部访问。
