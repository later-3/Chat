# 开发、验证与持续维护

## 一次开发怎样完成

1. **选择场景。** 写明本手册场景编号、入口、Project、预期和失败行为。新增场景若缺入口，先补章节。
2. **定位拥有者。** 依据源码地图确认是Frontend展示、Backend合同、Pi通用能力还是Nano路由/投递；复用公共入口。
3. **先复现。** 保存脱敏ID和最后成功节点，用本地假模型或对应Fixture做最小复现；真实平台问题另外保留平台验收。
4. **修改并解释。** 在核心接口旁写输入/输出、身份来源、持久化点、失败/重试/释放责任，避免逐行翻译代码。机制解释留在权威文档，场景操作留本手册。
5. **验证实际链。** 定向回归、模块门禁、父仓库verify和本场景实际断点/Runtime证据分别记录。
6. **维护文档与交付。** 同一变更更新场景流程、路径/命令、配置引用、错误表和验证记录。提交只包含本次文件。

公共装配、HTTP ingress与Workflow薄包装已有注释示范：[pi-agent-session](../../../src/agents/pi-agent-session.ts)、[events路由](../../../src/routes/api/internal/channel/v1/events.post.ts)、[agent-definition](../../../src/workflows/agent-definition.ts)。新增接口应说明“202前保存了什么”“谁负责重试”“模型参数为什么不能提供身份”，而不是只写“发送事件”。

## 测试入口

| 范围 | 命令/证据 |
|---|---|
| 调试配置与隔离回归 | `pnpm test:debug`，随`pnpm test:tooling`进入完整门禁 |
| 实际调试 Web/Backend/Pi | 启动Debug Chat后`pnpm debug:smoke`；2个Run和Session重读 |
| 实际Nano渠道公共链 | 完成CLI-01后在调试Nano工作区`pnpm chat DEBUG_HELLO`，终端回复与Nano投递日志 |
| 新环境与重复拉起 | first-install清单；重复debug:start/F5，验证旧owner退出、端口复用、Group/Memory/配置不变、异常启动回收 |
| Backend定向测试 | `node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test <文件>` |
| Frontend合同 | `pnpm test:frontend`或目标`frontend/lib/*.test.mjs` |
| 全部Chat门禁 | `pnpm verify`：架构/工具、前后端测试、类型、构建、built、dev |
| Nano独立工作区 | `pnpm debug:prepare:nanoclaw`中的安装/format/typecheck/build/全部Vitest |
| Pi通用代码 | 遵守`pi/AGENTS.md`的check与非e2e/定向测试，再跑父仓库实际装配链 |
| GUI断点 | VS Code中实际命中Frontend、Backend Step、Pi和Nano断点；仅schema检查不能替代 |
| Telegram/微信 | 独立测试账号的一条消息、平台回复、两侧Session/Delivery/Ack证据 |

`pnpm verify`**会覆盖当前checkout的frontend/dist与.output**。如果正常实例依赖这些产物，先在独立checkout验证本次改动，不在运行它的目录构建。准备方式：将当前修改应用到独立Chat checkout，初始化父仓库固定Submodule并安装依赖；在那边执行verify。不要复制正式.env、Nano data/groups或Chat Home。单纯软链接源码/输出目录不能隔离构建。

验证完成还要执行`git diff --check`和`git -C frontend diff --check`。新增开发故障结论必须带回归测试；实际调试专用入口和常规Nitro CLI入口都要验，不让邻近链路通过掩盖缺口。

## 子模块的工作区与提交

Frontend、Pi、Nano是独立Git仓库，父仓库记录gitlink。联调无需多个窗口，但提交要按仓库分别处理：

- Frontend/Pi在自己的开发分支完成测试、提交和推送，随后父仓库更新相应固定Commit。
- Nano调试在`.data/debug/nanoclaw` detached worktree开始，首次开发先创建`codex/<任务名>`分支。其修改不会自动复制回正常Nano checkout。
- Nano变更应通过受控合并进入公开Fork的`chat`分支，确认远端存在Commit后更新父仓库gitlink。**若正常Nano Host使用原checkout，不要在Host运行中切换它的Commit来做gitlink更新**；用独立父仓库checkout组装提交，部署另走既有流程。
- 父仓库只暂存本次明确路径；子模块先推送，父仓库后推送；不强推，不把运行数据带入提交。

提交/推送不等于部署。部署前后健康、版本、渠道验收按[部署文档](../../deployment.md)，不能为了调试重启正常服务。

## 手册如何持续更新

本目录由父仓库统一维护，避免在4个模块复制相同端口与流程。`environment.md`维护调试环境操作；`configuration-resources.md`引用配置格式；`code-map.md`维护函数入口；各场景页维护操作；`troubleshooting.md`维护症状到证据的映射。

| 变更触发 | 同步维护 |
|---|---|
| 端口、启动脚本、数据/缓存目录变化 | environment、launch/tasks、隔离测试、实际启动冒烟 |
| HTTP字段/状态/流变化 | code-map、对应场景、前端parser及合同测试 |
| Agent装配、Tool/Skill选择变化 | configuration-resources、pi、公共接口注释、开发/生产Runtime验证 |
| Nano路由、Trigger、投递/恢复变化 | channels、troubleshooting、两侧合同测试和真实账号验收范围 |
| 日志字段或持久位置变化 | troubleshooting、诊断规范、脱敏示例 |
| 能力从目标进入实现 | 对照实现更新架构状态与场景验收，不能只改手册措辞 |

`pnpm check:architecture`检查本目录的Markdown本地链接；`pnpm test:debug`检查launch引用、专用端口、隔离路径、环境继承和本地假模型。链接存在并不能证明流程正确；提交记录还需注明实际跑过的场景和未验证部分。

本次版本的审核与验证结果见[2026-09-08调试手册验收记录](../../architecture/reviews/2026-09-08-debugging-handbook.md)。以后每次大幅调整仍在同目录追加日期化证据；小改动在提交中写明章节与验证。手册不是自动化监控任务，不会自行执行测试或登录渠道。
