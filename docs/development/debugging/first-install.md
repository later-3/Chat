# 新环境初始化与部署Agent交付

本页给负责搭建新环境的Agent和接手运行的人使用。生产入口以[部署文档](../../deployment.md)为准，调试以[环境章节](./environment.md)为准。安装依赖、启动Host和创建可工作的长期Agent是不同阶段；不能只看到健康接口就交付“全部初始化完成”。

## 哪些内容自动创建

| 内容 | 创建时机与拥有者 | 重复执行的行为 |
|---|---|---|
| Linux生产chat.env、随机签名/服务Token、模型settings模板 | `chatctl install`缺失时生成，首次等待用户配置 | 保留已有文件；用户密码、模型与账号不能猜测 |
| macOS生产chat.env和服务模板 | 部署Agent按部署文档在目标用户下准备 | 保留私有值，服务模板必须填写真实路径 |
| Chat Home基础目录、Daily Project、内置管理Skill | Chat运行时初始化 | 复用稳定身份；内置受管Skill可按版本刷新，用户资源不是空模板覆盖对象 |
| Project/Session/Workflow/Memory数据 | 对应服务首次访问或执行时按需建立 | 原生持久化恢复；初始化不恢复另一台机器的历史 |
| Nano `.env`及服务定义 | 部署Agent准备模式、服务认证与渠道账号，原生service步骤安装 | 更新服务定义不应重新生成密钥、清空数据 |
| Nano数据库、迁移和CLI Socket | Host启动 | 运行迁移、重新建Socket，保留实体与消息 |
| Nano Group记录及Workspace、plugins目录 | `ncl groups create`调用原生初始化 | 先list查已有Group，再决定create，不能每次开机创建新ID |
| Group Standing Instructions | 明确填写职责/通过Group管理接口保存 | 不应在普通重启时覆盖；没填职责不等于安装失败 |
| Group Memory的3个基础Markdown文件 | 首次读取Group Profile/Memory资源时由Nano Gateway补齐 | 仅创建缺失文件，已有正文保留 |
| Group↔Messaging Group Wiring、用户成员权限 | 部署Agent依据实际Bot/用户/渠道创建 | 先查询复用真实ID；不自动授权陌生联系人 |
| 生产`long-agents.json` | 部署Agent按配置合同登记实例、Group、inbox与Project | 不由chatctl/Host猜测；重启不重建映射 |
| Telegram Token、微信登录凭据、模型认证 | 用户提供或交互登录 | 不复制调试凭据或其他机器身份来冒充已完成登录 |
| 调试Lab上述基础Group/CLI Wiring/Memory/Registry | Nano调试启动器自动初始化 | 原生接口复用已有实体，保留Memory和已编辑Registry；冲突明确报错 |

Nano的Workspace位于其稳定checkout的`groups/<folder>`，不是Chat Project源码。Chat Personal/Project Memory与Nano Group Memory分别维护。空白安装会生成结构，不会凭空生成长期记忆内容、真实项目或历史Session；迁移历史需另走停机备份与恢复。

## 部署Agent必须完成的6项交付

1. **确认目标环境和版本。** 记录OS/架构、运行用户、稳定源码根、4个仓库Commit；按父仓库固定版本准备依赖。生产路径不能是临时debug worktree。
2. **准备私有配置。** 填写实际端口、Chat Home、Provider/模型、网页登录、Nano chat-pi及双方服务Token。缺少密码、模型凭据、Bot或扫码时列出等待项，不能假称部署完成。
3. **启动并完成实体初始化。** Nano先完成service/Host启动，用目标工作区`pnpm ncl groups list --json`查询；没有目标Group才create。根据实际渠道建立User、成员、Messaging Group和Wiring，并将返回的真实ID写入生产Registry。参考[配置文档](../../configuration.md)和[渠道场景](./channels.md)，不复制debug-agent或示例ID进生产。
4. **触发资源初始化并检查。** 在已登录Chat中打开长期同事的Group/Memory页面，对应`GET /api/long-agents/:id/agent-group`与`agent-memory`；Gateway会初始化缺失的核心Memory。确认Workspace存在、Memory可读、职责内容和所属Group正确。不要让Chat直接读取Nano数据库或手写其ACK。
5. **执行启动/重启验收。** 检查实际端口所有者、服务状态和日志；至少2次启动/重启后Group ID、Registry、Memory和一个Session仍保持。正常退出不删除数据，启动失败必须说明剩余进程。部署授权不等于无限制按端口杀其他服务。
6. **交付运行入口。** 留下目标机器准确的start/restart/stop命令、服务名、数据目录和日志位置；完成一次Web及所需真实渠道收发。仅本地CLI通过时应标注“平台账号尚未验收”。

## 生产重复拉起：交给实际服务管理器

Linux由系统级Chat service和运行用户的Nano user service管理；先由安装输出取得带checkout标识的Nano Unit名称，再以相同用户操作：

```bash
sudo systemctl start chat.service                # 已运行时不重复创建Chat
systemctl --user start '<安装输出的Nano Unit>'
# 需要替换已有进程时，用实际服务管理器重启：
sudo systemctl restart chat.service
systemctl --user restart '<安装输出的Nano Unit>'
```

以上示例假设安装时沿用默认Chat服务名；自定义名用安装记录替换。不要在root的user manager操作另一个用户的Nano服务。macOS使用已安装的准确LaunchAgent label执行`launchctl kickstart`；显式重启才加`-k`。现在可用`pnpm chat:stop -- --normal`让实际管理器卸载/停止正常Backend与Nano，追加`--check`只检查；开发/调试使用`--debug`。macOS已bootout后需bootstrap恢复，准确命令见[关闭手册](./stopping.md)；当前整套业务排空仍是[生命周期待实现合同](../../architecture/chat-system-lifecycle.md)。

启动前用`lsof -nP -iTCP:<实际端口> -sTCP:LISTEN`核对占用；已有正确服务用start/restart管理。若端口属于旧的本实例手工进程，先核对用户、启动命令、cwd和服务归属，再TERM并等待释放；超时只KILL已确认属于该实例的PID/进程组。若属于其他实例，报告冲突并协调其端口或服务，不能为了把检查变绿误杀它。生产端口来自私有配置，不照抄本手册调试端口。

## 调试重复拉起：直接使用统一脚本

首次准备完成后：

```bash
pnpm debug:start -- --nanoclaw
pnpm debug:smoke -- --long-agent
pnpm debug:stop
# 再运行同一个start；或者stop之后切换VS Code的Debug Chat + NanoClaw
```

`debug:start`和F5各模块共用归属检查、端口检查和清理逻辑；重复启动替换已确认的旧调试进程，未知占用报错。出现`lab ready`表示Group/Workspace/Memory/Registry已经初始化；随后smoke验证实际执行。新环境的Agent应完成这条检查再交给用户，而不让用户首次F5时逐项猜缺失配置。
