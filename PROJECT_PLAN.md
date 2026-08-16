# Chat 项目计划

## 目标

把Chat建设成用户长期使用的个人Agent操作系统：对话是入口，项目、工作流、记忆、规则、文件、开发工具、浏览器和多Agent协作都是同一产品事实链上的能力。

## 当前路线

### F1 · DSH唯一前端

交付固定版本的DeepSeek Harness Web、LifeOS桥接插件和统一启动器；保留DSH原生侧栏、会话、Composer、模型/权限入口与插件机制。删除旧`apps/web`、Agent Canvas副本和过期UI原型/归档。

完成门：DSH原生页面真实启动；发送创建Chat Session/Message/Run；Plan与Approval来自Chat Query；决定通过Chat Command提交；正式Assistant Message来自Product Store；刷新不会重复命令。

### F2 · Code Workbench

把固定版本code-server作为独立Hosted Workbench运行。DSH只提供全屏入口与返回动作；LifeOS Host负责生命周期、Workspace映射、鉴权边界、HTTP/WebSocket代理和健康检查。

首期能力：Files、Editor、Terminal、Git状态、Diff和VS Code扩展。首期不拆code-server UI，也不让code-server拥有Chat产品Session/Run。

完成门：真实Workspace可读写；Terminal命令在受控Workspace/UID下执行；Git状态与Diff可见；DSH返回后保留原会话；停止应用后进程与端口全部回收。

### F3 · Browser Provider

选择带实时人机共用视图的独立Browser Provider；Agent工具与用户界面必须绑定同一浏览器Session。浏览器运行在Local Host或远程Sandbox，DSH只挂载表面。

### F4 · 长期个人系统

继续交付Project/Stage/Milestone/Iteration/Work、长期Memory、规则、日历、提醒、Artifact/Evidence、多个Agent角色和跨设备恢复。

## 开发原则

1. 一次只交付一个可体验纵向；前端切换与Workbench是两个独立提交。
2. 外部项目优先以固定版本服务或插件使用，不复制上游源码。
3. 每个Adapter写清所有权、权限、幂等、故障恢复、升级与退出路径。
4. 面向用户的纵向必须用真实服务和浏览器E2E证明，不能用截图或Mock代替。
5. Git历史就是删除内容的归档，不在当前树保留“old”“archive”“legacy”目录。
