# Chat 统一开发启动与调试任务书

> 状态：已完成并合入本地`main`，待远端同步

## 1. 用户场景

开发者只把Chat理解成一个前后端应用。无论从终端还是VS Code启动，都应使用同一套仓库入口，
一次看到应用是否就绪、失败在哪个服务，并能一次停止全部本地进程。

## 2. 当前问题

1. 根Workspace没有统一`dev`入口，服务生命周期散落在`.vscode/launch.json`和`tasks.json`。
2. VS Code Compound把Memory、Workflow、API、Web暴露成多个并列“应用”，产品语言错误。
3. API侧的Workflow就绪等待会与Workflow Bundle构建并发计时，冷启动可能在服务真正启动前超时。
4. 多个子配置分别执行停止任务，产生大量终端面板，也让命令行、CI和VS Code无法共享启动合同。

## 3. 交付结果

1. `pnpm dev`成为普通本地开发的唯一入口。
2. `pnpm dev:debug`使用完全相同的服务图，只为Chat拥有的API和Workflow开放Inspector。
3. 仓库级启动器按确定顺序准备并启动Memory依赖、Workflow、API和Web；就绪期限从对应进程
   真正启动后计算。
4. Workflow Bundle构建后先检查活动Run版本：同版本继续耐久恢复；本地代码变化且旧Bundle不可用时
   保留历史证据，原子终结旧Product Run/Outbox并取消旧SDK Run，不能让一个不可恢复的旧Run阻止整套应用启动，也不能删除`.data`后盲目重跑。
5. 启动器拥有子进程生命周期：必要服务异常退出时整套环境失败关闭；SIGINT/SIGTERM时停止整棵进程树，
   监督器按反向顺序收敛仍在运行的子进程并清理登记。
6. 默认本地Profile启动memmy与Tencent MemoryCore；可用`--memory=memmy|memorycore|all`缩小范围。
7. VS Code只保留一个用户入口`Chat：调试应用`，调用同一启动器并在Ready后打开Chrome。
8. 固定端口属于Git仓库级排他资源：所有worktree共享PID登记；登记丢失时只回收通过端口角色、命令、
   cwd与Git Common Directory四重验证的同仓库Chat进程，其他占用者仍拒绝清理。
9. 同一Git仓库的worktree共享经过commit/tree/Hash校验的固定源码缓存，避免重复下载和原生编译；
   Product Store、Workflow Store、Memory数据库和其他运行数据仍按worktree物理隔离。
10. PID登记是Git仓库级、可重建的运行投影：监督器是正常运行时的单写者；终端强制中断后，下一次
    status/start/stop会剔除已确认退出或僵尸的记录，但仍保留活PID并继续执行身份复核。
11. 前端调试使用worktree专属浏览器Profile；启动前只终止携带该精确Profile参数的遗留浏览器并清理
    Profile锁，父调试会话停止时强制收敛整个专属浏览器，不影响日常Chrome。

## 4. 明确不做

1. 不修改前端、产品API、Workflow业务语义、Memory Adapter合同或Product Store。
2. 不增加Docker、PM2、concurrently、wait-on等运行依赖；现有Node标准库已经足够拥有本地进程图。
3. 不把本地开发启动器当成生产部署器；生产仍由未来部署编排分别管理应用和外部依赖。
4. 不在普通启动时调用付费模型；只有用户实际提交规划或执行请求时才调用Provider。
5. 不为第三方Memory源码创建默认调试会话；日常断点位于Chat自己的API、Workflow和Adapter。

## 5. 运行合同

```text
preflight（安全清理已登记旧进程 + 检查固定端口）
→ 准备所选Memory固定源码缓存
→ 构建Workflow Bundles
→ 检查并安全收敛本地不兼容的活动Workflow Run
→ 启动所选Memory并逐个等待真实健康检查
→ 启动Workflow并等待/healthz
→ 启动API并等待/api/readyz
→ 启动Vite并等待页面
→ 输出唯一`[chat] ready: http://127.0.0.1:43110/`标记
```

每个就绪门只观察自己的进程与HTTP探针，不重试业务命令。Memory冷启动期限为180秒，Workflow、
API和Web为30秒；期限从对应`spawn`成功后开始。进程提前退出时立即失败，不等待期限耗尽。

## 6. 完成门

1. 纯规则测试固定参数解析、Profile服务图、Inspector边界、就绪期限和反向停止顺序。
2. VS Code合同测试证明只有一个应用级入口、没有`tasks.json`服务编排、没有凭据进入配置。
3. `pnpm dev`真实启动两套Memory、Workflow、API和Web，五个HTTP入口全部Ready。
4. `pnpm dev:debug`证明API/Workflow Inspector固定在43120/43121，Memory不创建默认Inspector。
5. 从终端SIGINT停止后，全部固定端口释放；连续启动两次不依赖旧产物或残留进程。
6. 从VS Code真实F5启动`Chat：调试应用`，Chrome可访问页面、TypeScript断点可绑定，停止后端口释放。
7. 预置一轮携带专属Profile的遗留Chrome及锁文件后，下一次F5自动收敛旧浏览器、无旧Session警告，
   新浏览器成功附加；连续干净F5也通过。
8. 从另一个worktree遗留无PID登记的Workflow、API和Web后，当前worktree下一次F5只清理已证明属于
   同一Git仓库的Chat进程并成功Ready；伪装成node的其他仓库进程仍拒绝清理。
9. `format:check`、`lint`、`typecheck`、相关测试与`build`通过。

## 7. 本地验收结果

1. `scripts/dev/app-runtime.test.mjs`覆盖参数/Profile、服务顺序、Inspector边界、共享缓存、准备阶段自动附加隔离、浏览器精确身份/锁清理、就绪期限和反向停止；与VS Code合同测试合计76项相关测试通过。
2. 终端普通模式和Debug模式均真实到达Ready；5个HTTP入口返回200，Debug模式仅`43120/43121`监听。
3. 真实VS Code F5只显示`Chat：调试应用`，Ready后Chrome自动进入调试；Call Stack识别Workflow与API的TypeScript源码，API源码断点已成功绑定，未附加两套Memory或准备阶段短命令。
4. 终端SIGINT和VS Code停止均已验证；当前7个固定端口全部释放，`pnpm dev:status`为空。
5. 全仓`format:check`、`lint`、`typecheck`、503项Workspace测试、11个Workspace构建和`pnpm audit --prod`全部通过；另有6项固定memmy脚本合同通过。
6. 使用真实Chrome专属Profile制造遗留进程和`SingletonLock`后，下一次F5自动清理并成功建立
   `Chat：前端浏览器（内部）`会话；没有旧Debug Session弹窗。一次Stop同时结束浏览器与应用，第二次F5继续成功。
