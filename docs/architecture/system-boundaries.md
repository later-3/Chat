# Chat状态与运行时边界

## 对象所有权

| 对象 | 权威所有者 | DSH/浏览器能否成为真相 |
|---|---|---|
| Product Session、Message、Run | Chat Product Store | 否，只显示Query投影 |
| Plan、Approval、Decision | Chat Product Store | 否，只提交命令 |
| Project、Work、Memory、Rule、Evidence | Chat Product Store | 否 |
| Workflow Run、Checkpoint、Hook | Vercel Workflow与后端私有映射 | 否且不可见 |
| pi Operation、Runtime Session、模型与Tool调用 | Pi Executor Service/pi/Provider | 否且不可作为产品身份 |
| DSH Session与轨迹 | DSH Runtime | 仅是UI/运行缓存 |
| code-server编辑器/终端状态 | Workbench进程 | 仅是Workspace能力状态 |
| 实时连接与页面状态 | Host/Browser | 可丢弃，不是产品事实 |

## 身份隔离

浏览器可以知道Product Session、Message、Run、Plan、Approval和公开Evidence的ID。浏览器不得获得Workflow Run ID、Hook Token、Checkpoint ID、pi Session ID、Provider Credential或内部Tool幂等密钥。

`dshSessionId -> productSessionId`只是一条Adapter映射，不能合并两个对象，也不能替代认证、授权或CAS。

## 失败不变量

1. DSH页面关闭或刷新不取消Product Run。
2. DSH生成了轨迹不代表Chat已提交正式Message。
3. Workflow或pi成功不代表Product Run成功。
4. 网络超时不等于命令失败；恢复必须使用相同`commandId`查询或重试。
5. HITL先提交Chat Decision，再由后端私下恢复Workflow Hook。
6. code-server命令成功不自动成为Chat交付；需要产品事实时必须通过受治理Command/Evidence进入Chat。
7. 外部副作用结果未知时进入查询、对账或人工处置，不能普通重试。
8. Executor Tool执行前必须已有耐久意图事件；服务重启发现未闭合Tool时进入`outcome_unknown`，不能自动重放`edit/write/bash`。

## Workbench权限边界

当前code-server是本机可信用户的Hosted App，不是安全沙箱。隔离HOME、清洗环境、固定Workspace入口和不同Browser Origin用于减少意外耦合与凭据泄漏，但不能撤销当前OS用户本来拥有的文件、进程和网络权限。安装扩展等同于运行高权限本地代码；远程或多人使用前必须引入容器/独立UID、认证、Workspace grant和审计。
