# Chat状态与运行时边界

## 对象所有权

| 对象 | 权威所有者 | DSH/浏览器能否成为真相 |
|---|---|---|
| Product Session、Message、Run | Chat Product Store | 否，只显示Query投影 |
| Plan、Approval、Decision | Chat Product Store | 否，只提交命令 |
| Project、Work、Memory、Rule、Evidence | Chat Product Store | 否 |
| Workflow Run、Checkpoint、Hook | Vercel Workflow与后端私有映射 | 否且不可见 |
| pi Runtime Session、模型调用 | pi Runtime/Provider | 否且不可作为产品身份 |
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
