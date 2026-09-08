# 正常与调试关闭入口审核

## 场景、机制与决定

用户需要从另一个终端分别关闭正常Chat或开发/调试Chat，并看到检查、动作与结果。复用原生launchd/systemd和已有调试进程归属记录，新增`chat:stop`选择入口；普通dev复用dev-start的TERM清理trap。没有新增常驻Supervisor、产品配置源、HTTP管理API或Pi执行路径。

依照[模块合同](../chat-module-contracts.md)和[系统生命周期](../chat-system-lifecycle.md)：服务定义属于原生管理器，配置/Session/Memory归属不变，VS Code任务与CLI消费同一脚本。范围必须显式选择；正常服务不能只kill PID。当前只实现明确中断的进程停止，未实现跨组件在途业务排空，不将后者标为完成。

## 边界与替代保障

- 正常范围预检全部安装定义及加载定义，核对checkout/程序后才开始停止；服务管理失败不退回按端口kill。先Nano后Backend是当前中断式停止顺序，不冒充生命周期§6的先排空再关闭。
- 调试记录按原PID身份/进程组校验。普通dev仅识别明确脚本、相同用户和cwd；其wrapper不是必然的进程组leader，禁止向wrapper的父Shell进程组发信号。
- 不删除数据或改变开机自启动。成功要求管理者/原PID退出且端口释放，残留占用明确失败；并发外部启动不受脚本锁控制，结果是检查时点的事实。
- 未发现受管服务不能解释为全机无Chat；无管理记录的直接启动、其他用户、nohup及共享附属服务属于明确未覆盖范围。

## 验证与交接

`scripts/chat-stop.test.mjs`覆盖只检查、停止顺序、重复停止、加载归属改变、权限失败、残留端口/PID、Linux系统/用户管理器适配，以及真实macOS临时KeepAlive和真实dev-start子进程回收。端口回归补充IPv4通配监听，修复macOS探测漏报；案例及experience随本次归档。

真实正常Chat/Nano只执行`--check`；停止测试仅作用于临时服务和独立fixture。完整`pnpm verify`在独立源码/构建目录执行。使用命令与能力限制以[关闭手册](../../development/debugging/stopping.md)为准。后续实现业务排空时须补跨组件接收关闭确认、在途状态和投递恢复门禁，不以本次脚本测试替代。

最终结果：完整verify退出0，工具22、Backend225、Frontend112、built28、dev1，共388项测试通过，类型检查和生产构建通过；128个本次相关本地文档链接检查通过，父仓库与Frontend的diff检查通过。正常Backend/Nano的PID及启动时间未变，Chat健康HTTP为200。Linux管理器路径仅完成合同测试，未在真实Linux部署上执行停机验收。
