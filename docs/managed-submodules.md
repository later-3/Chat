# Chat子模块维护

## 固定关系

Chat使用三个公开的受管源码仓库作为子模块：

| Chat目录 | 公开仓库 | 长期集成分支 | 官方只读上游 |
|---|---|---|---|
| `pi/` | `later-3/pi` | `codex/later-custom` | `earendil-works/pi` |
| `frontend/` | `later-3/chat-frontend` | `main` | `agegr/pi-web` |
| `nanoclaw/` | `later-3/nanoclaw` | `chat` | `nanocoai/nanoclaw` |

父仓库提交保存的是子模块的精确commit，而不是一个会自动移动的分支引用。因此同一个Chat提交在开发机和服务器上会得到相同版本。`.gitmodules`中的`branch`用于人工执行上游更新，不改变这个固定规则。

## 修改子模块

子模块执行`git submodule update`后可能处于detached HEAD。修改前先进入对应的长期集成分支，再建立功能分支：

```bash
git -C pi switch codex/later-custom
git -C pi switch -c codex/<pi-change>

git -C frontend switch main
git -C frontend switch -c codex/<frontend-change>

git -C nanoclaw switch chat
git -C nanoclaw switch -c codex/<nanoclaw-change>
```

代码和测试先在子仓库提交并推送，审核后合入对应长期集成分支。`chat-frontend`是从当前安全代码建立的公开根历史，不包含旧私有Pi Web的设备、SSH和隧道记录。最后回到Chat，固定新的子模块提交：

```bash
git add -- pi frontend nanoclaw
git commit -m "chore: update managed submodules"
```

不要只提交Chat的gitlink而不推送子仓库提交，否则其他环境无法取得该对象。

## 回合官方上游修复

首次使用时为子仓库登记只读官方上游：

```bash
git -C pi remote add upstream https://github.com/earendil-works/pi.git
git -C frontend remote add upstream https://github.com/agegr/pi-web.git
git -C nanoclaw remote add upstream https://github.com/nanocoai/nanoclaw.git
```

以后按需要获取上游，再把经过审核的修复cherry-pick到功能分支；不直接把整个上游默认分支自动合入长期集成分支：

```bash
git -C pi fetch upstream
git -C pi cherry-pick <upstream-pi-commit>

git -C frontend fetch upstream
git -C frontend cherry-pick <upstream-pi-web-commit>

git -C nanoclaw fetch upstream
git -C nanoclaw cherry-pick <upstream-nanoclaw-commit>
```

NanoClaw的Channel和替代Provider由其`/add-*` Skill从官方长期Registry分支复制到用户Fork；不要把官方`channels`或`providers`分支整体合入`chat`。更新NanoClaw核心或安装能力时遵守`nanoclaw/docs/BRANCH-FORK-MAINTENANCE.md`和对应Skill，保持Chat集成代码位于官方扩展缝。

发生冲突时，以Chat当前接缝和子仓库自己的测试为验收依据。子仓库提交推送后，再更新并验证Chat父仓库。

## 克隆与部署

新环境可以匿名读取父仓库和三个公开子模块：

```bash
git clone --recurse-submodules https://github.com/later-3/Chat.git
```

更新现有工作目录时使用父仓库固定版本：

```bash
git pull --ff-only
git submodule sync --recursive
git submodule update --init --recursive
```

部署环境不要执行`git submodule update --remote`，因为该命令会绕过父仓库固定的commit。

发布Chat父仓库前必须确认三个gitlink指向的对象已经推送到各自公开仓库：

```bash
git -C pi branch -r --contains HEAD
git -C frontend branch -r --contains HEAD
git -C nanoclaw branch -r --contains HEAD
```

三个命令应分别显示Pi的`origin/codex/*`、Frontend的`origin/main`和NanoClaw的`origin/chat`。否则当前开发机能够构建，但其他环境在`git submodule update`时会找不到子模块Commit。

## 当前Long Agent版本与跨环境部署

Chat `0.1.0`发布固定Frontend `0.3.0`和NanoClaw `2.4.0`的具体Commit；Pi本期未修改。版本号用于说明各仓库发布语义，真正部署事实仍是父仓库gitlink。

其他机器部署时必须使用稳定、长期存在的父仓库Checkout。NanoClaw原生把`.env`、`data/`和`groups/`保存在自己的Checkout中，因此不能把它作为Chat的临时Release目录反复删除。Linux推荐父源码固定在`/opt/chat`，NanoClaw数据随`/opt/chat/nanoclaw`保留；macOS推荐固定在用户的`~/Code/Chat`。切换开发worktree或移动Checkout前，先停止NanoClaw服务并迁移这三个私有位置，再从新目录重新安装服务。

父仓库将NanoClaw gitlink升级到新Commit后，必须在固定Checkout完成依赖、测试和构建，再通过NanoClaw `service` Setup刷新服务与`data/upgrade-state.json`。只执行`git submodule update`后直接重启会触发NanoClaw的精确代码Tripwire；完整升级步骤见[部署文档](./deployment.md#已有nanoclaw安装升级)。

当前自动化边界如下：

| 环境 | Chat | NanoClaw Long Agent |
|---|---|---|
| Linux + systemd | `deploy/chatctl`自动安装、更新、回滚Chat | 在固定`/opt/chat/nanoclaw`执行NanoClaw Setup，安装用户级systemd服务 |
| macOS + launchd | 使用仓库LaunchAgent模板构建并常驻Chat | 在固定Checkout执行NanoClaw Setup，安装按Checkout隔离的LaunchAgent |
| Windows | 没有受支持的生产服务模板 | 本期不提供受支持的常驻部署 |

`chatctl`当前不会自动编排NanoClaw Host；跨环境部署必须分别验证Chat健康接口、NanoClaw Gateway、Channel Adapter和一条真实Long Agent消息。完整命令与私有数据迁移边界见[部署指南](./deployment.md#跨环境支持矩阵)。
