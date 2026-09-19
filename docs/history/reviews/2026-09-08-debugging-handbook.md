# 2026-09-08 调试与开发手册验收

## 范围与机制

场景：正常Chat继续运行时，开发者在一个VS Code窗口学习和调试Frontend、Backend、Pi及NanoClaw，并能沿Web/Telegram/微信查问题。

本次属于开发工具与文档工作，复用Nitro公开builder/dev server、现有Vite配置/版本注入、Nano原生worktree/cwd/CLI/upgrade marker和公共Pi装配。没有新增产品运行时或生产生命周期控制面。

专用端口为45112/35145/45300/45401；分别隔离Chat Home、Workflow数据、Nitro/Vite缓存、Chrome资料与Nano工作区/账号。进程组清理只作用于本次启动者；没有部署或重启生产服务。早期缓存重入影响同checkout普通dev并使其退出；修复Workflow发现范围后已恢复原普通dev入口，43112/30145健康。原源码仍共享的热更新影响在手册明确说明，生产构建放隔离验证目录。

## 已完成证据

- `pnpm test:debug`：7条通过，覆盖调试引用、端口、环境过滤、私有文件保留、符号链接拒绝、本地模型协议、失败退出与拒绝SIGTERM的自有孙进程清理。
- 专用入口真实启动：Backend45112、Vite35145、本地假模型45401；Vite代理登录、2个Workflow Run均completed，read Tool返回DEBUG_SKILL_LOADED，Session重读通过。
- 源码变化热更新后重复执行相同冒烟通过；修复了`.data`构建缓存被Workflow再次扫描的问题，案例与experience已归档。
- Nano独立工作区安装、format、typecheck、build成功；限制2 workers后209个测试文件、2345条测试全部通过。首次默认并发出现1条30秒超时，单文件复测通过，随后全部重跑通过；没有降低断言或绕过门禁。
- Nano45300默认无真实渠道启动成功；通过原生ncl创建离线Group，Web长期同事通过真实Gateway读取Group并完成Pi对话/Session重读。
- Nano原生CLI的cli/local渠道实际完成入站→Chat耐久事件→Pi→Nano Delivery→终端回复DEBUG_OK，日志记录Message routed和Message delivered；没有发送外部平台消息。
- 完整`pnpm verify`在隔离源码副本通过：工具10、Backend225、Frontend112、生产Runtime28、真实dev Runtime1，共376条测试；前后端类型检查及生产构建通过。正常checkout的frontend/dist和.output未被该构建覆盖。

最终`check:architecture`及父仓库/Frontend的`git diff --check`通过。4个本次调试进程已停止，45112/35145/45300/45401释放、启动锁清理；正常生产Chat43110与Nano3000的PID保持不变，普通开发43112/30145恢复后均HTTP200。

## 验证边界

没有使用真实模型API、没有登录或发送Telegram/微信真实账号消息；真实平台收发步骤供独立测试账号验收。当前自动化使用的模型是确定性Fixture，不能证明模型理解Skill或能规划任务。

没有把启动脚本/Source Map配置检查说成VS Code GUI手工断点验收。浏览器/Backend/Pi/Nano实际GUI断点仍按手册逐一验收；端到端HTTP Runtime已有上述证据。

本次增加Nitro的Workflow发现目录约束（src/workflows），并让Builder回归使用真实配置；未修改Frontend/Pi/Nano子仓库源码及父仓库gitlink；Nano的独立调试worktree仍使用父仓库选定Commit。资源策略/权限、数据库归属、单一Pi装配与生产服务模式没有改变。
