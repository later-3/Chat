# Chat子模块维护

## 固定关系

Chat使用两个私有Fork作为源码子模块：

| Chat目录 | 私有Fork | 长期集成分支 | 官方只读上游 |
|---|---|---|---|
| `pi/` | `later-3/pi` | `codex/later-custom` | `earendil-works/pi` |
| `frontend/` | `later-3/pi-web` | `codex/chat-frontend` | `agegr/pi-web` |

父仓库提交保存的是子模块的精确commit，而不是一个会自动移动的分支引用。因此同一个Chat提交在开发机和服务器上会得到相同版本。`.gitmodules`中的`branch`用于人工执行上游更新，不改变这个固定规则。

## 修改子模块

子模块执行`git submodule update`后可能处于detached HEAD。修改前先进入对应的长期集成分支，再建立功能分支：

```bash
git -C pi switch codex/later-custom
git -C pi switch -c codex/<pi-change>

git -C frontend switch codex/chat-frontend
git -C frontend switch -c codex/<frontend-change>
```

代码和测试先在子仓库提交并推送，审核后合入对应长期集成分支。最后回到Chat，固定新的子模块提交：

```bash
git add -- pi frontend
git commit -m "chore: update managed submodules"
```

不要只提交Chat的gitlink而不推送子仓库提交，否则其他环境无法取得该对象。

## 回合官方上游修复

首次使用时为子仓库登记只读官方上游：

```bash
git -C pi remote add upstream https://github.com/earendil-works/pi.git
git -C frontend remote add upstream https://github.com/agegr/pi-web.git
```

以后按需要获取上游，再把经过审核的修复cherry-pick到功能分支；不直接把整个上游默认分支自动合入长期集成分支：

```bash
git -C pi fetch upstream
git -C pi cherry-pick <upstream-pi-commit>

git -C frontend fetch upstream
git -C frontend cherry-pick <upstream-pi-web-commit>
```

发生冲突时，以Chat当前接缝和子仓库自己的测试为验收依据。子仓库提交推送后，再更新并验证Chat父仓库。

## 克隆与部署

新环境必须拥有两个私有Fork的读取权限：

```bash
git clone --recurse-submodules git@github.com:later-3/Chat.git
```

更新现有工作目录时使用父仓库固定版本：

```bash
git pull --ff-only
git submodule sync --recursive
git submodule update --init --recursive
```

部署环境不要执行`git submodule update --remote`，因为该命令会绕过父仓库固定的commit。

发布Chat父仓库前必须确认两个gitlink指向的对象已经推送到各自私有Fork：

```bash
git -C pi branch -r --contains HEAD
git -C frontend branch -r --contains HEAD
```

两个命令都应显示对应的`origin/codex/*`分支。否则当前开发机能够构建，但其他环境在`git submodule update`时会找不到子模块Commit。
