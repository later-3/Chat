# Chat CI/CD基线

本页只回答代码怎样被验证、发布和部署，不把产品架构、项目协调或上游仓库内部测试混入CI/CD。

## 仓库责任

- Pi Fork在`later-3/pi`运行自己的build/check/test，稳定分支为`codex/later-custom`。
- DSH Fork在`later-3/deepseek-harness-chat`运行自己的构建、静态检查和Trajectory增量测试，稳定分支为
  `codex/chat-trajectory-location-rc6`。
- Chat固定两个已经通过各自CI的Commit SHA，只验证来源、构建结果和Chat接缝；不重跑Fork全仓测试。

Fork变更的顺序固定为：Fork功能分支/PR → Fork CI → 合入受保护稳定分支 → Chat更新Manifest SHA →
Chat CI运行接缝。Chat不持有跨仓Token去主动派发Fork CI。

## 普通CI

`.github/workflows/ci.yml`在PR和`main` push运行一个稳定命名的Required Job `ci`：

1. `pnpm bootstrap`只准备一次固定Pi、DSH和Chat运行工件；
2. build、lint、format、typecheck；
3. 全部Chat确定性测试；
4. 一条真实DSH → Bridge → Chat → Workflow → Pi AgentSession浏览器接缝；
5. 安装后的完整系统启动、健康检查、SIGINT停止和停止状态检查。

普通CI清空Provider、Memory、GitHub和动态模型凭据，关闭paid、external、Memory与Beta
Workbench。它不运行真实模型、外部写或Fork整仓测试。

## 定时维护

`.github/workflows/maintenance.yml`只在定时或人工触发时运行：

1. 完整确定性Browser套件；
2. 标准`pnpm audit --prod`检查Chat生产依赖。

Pi、DSH的生产依赖检查属于各自Fork。Chat不因两个上游仓库中与实际接缝无关的依赖报告而伪造失败。

## 安装、Release与Deploy

当前公开安装入口是`pnpm bootstrap`；它支持全新macOS和受支持的Linux源码安装。CI会真实执行同一入口，
避免文档和安装脚本分叉。

当前没有Chat Release和自动Linux Deploy。原因是尚未冻结以下三个产品事实：

1. 发布制品选择源码包、OCI镜像还是其他形式；
2. 家用Linux使用systemd、Compose或其他Supervisor；
3. Product Store数据备份、迁移和失败回滚合同。

在这三项确定前不提交空壳`release.yml`或`deploy.yml`。确定后，Release必须绑定版本与完整Commit SHA，
输出不可变制品及Digest；Deploy只接受已发布Digest，并在变更服务前备份数据，完成健康检查，失败恢复上一
版本与备份。Release与Deploy保持独立、人工授权。

## GitHub合并看护

`main`的Branch Protection只要求稳定Check `ci`通过；`maintenance`不阻塞普通PR。两个Fork的稳定分支
分别要求它们自己的CI Check。工作流文件存在不等于看护完成，必须以GitHub上的真实成功Run和分支保护
设置为证据。
