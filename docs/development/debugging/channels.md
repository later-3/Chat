# NanoClaw、Telegram与微信场景调试

先完成 [Nano独立工作区准备](./environment.md)。本章命令只在`.data/debug/nanoclaw`执行；正常`nanoclaw/`仍可由原服务运行。两个Host的数据、Socket、端口、账号和服务Token必须分开。

## NanoClaw学习资料怎样读

Nano仓库有[文档索引](../../../nanoclaw/docs/README.md)、[架构草稿](../../../nanoclaw/docs/architecture.md)、[SDK深读](../../../nanoclaw/docs/SDK_DEEP_DIVE.md)等资料。但SDK深读讲的是Claude Agent SDK，架构草稿也包含原生容器Runtime；它们不能直接当作Chat当前执行链说明。

学习我们这个Fork，先读[Chat Pi Execution Driver](../../../nanoclaw/docs/chat-pi-execution-driver.md)确认当前边界，再沿`index.ts → channels → router.ts → session-manager.ts → modules/chat-integration → delivery.ts`阅读。结合本章Group/Wiring实验理解身份、权限、耐久消息和HTTP边界，模型与Tool循环转到[Pi章节](./pi.md)。这样能区分Nano保留的Host能力、Chat接管的执行能力和上游独立运行模式。

## LA-01前置：建立调试Group和Chat映射

先启动`Debug NanoClaw`。默认渠道关闭，Host仍应完成DB迁移和Gateway/CLI启动。日志找到`NanoClaw running`，不要把没有Bot输出当作Host失败。

在新终端进入调试工作区：

```bash
cd .data/debug/nanoclaw
pnpm ncl groups list --json
pnpm ncl groups create --name 'Debug Agent' --folder debug-agent --json
pnpm ncl groups list --json
pnpm ncl messaging-groups create --channel-type telegram --instance telegram \
  --platform-id debug-offline --name 'Offline debug placeholder' --is-group 0 --unknown-sender-policy strict --json
```

只创建一次，记录返回的真实Group ID；不要把示例ID当作可执行配置。ncl是当前Host本地运维CLI，允许人在调试实例中使用，但Chat Backend不能调用它代替窄HTTP API。Socket来自当前工作目录的`data/ncl.sock`。

当前Registry要求inbox。上面建立的Messaging Group仅作离线占位，不绑定真实账号、不配置Wiring、不投递平台消息。记录返回的`data.id`（不是请求帧顶层id）。在调试Home新建`long-agents.json`，按下面结构填写两个真实记录ID。渠道接入时替换为真实测试私聊的inbox。不要改正常Home。

```json
{
  "schemaVersion": 1,
  "instances": [{
    "id": "debug",
    "name": "Debug NanoClaw",
    "executionMode": "chat-pi",
    "gatewayBaseUrl": "http://127.0.0.1:45300/webhook/chat-backend"
  }],
  "agents": [{
    "id": "debug-agent",
    "name": "Debug Agent",
    "description": "仅用于隔离调试",
    "enabled": true,
    "instanceId": "debug",
    "nanoclawAgentGroupId": "替换为真实Group ID",
    "defaultProjectId": "daily",
    "inbox": {
      "messagingGroupId": "替换为离线Messaging Group的data.id",
      "channelType": "telegram",
      "instance": "telegram",
      "platformId": "debug-offline",
      "threadId": null
    }
  }]
}
```

精确必填字段以[Registry parser](../../../src/long-agents/types.ts)为准；当前格式和完整示例统一见[配置文档](../../configuration.md)。不要添加目标中的独立Daily/历史/任务字段。

刷新Chat长期同事列表，按Web章节发送DEBUG_HELLO；在公共装配确认模型是debug-local/debug-model。配置完成后也可从Chat根目录执行`pnpm debug:smoke -- --long-agent`，通过真实Gateway验证Web长期同事链路，不发送平台消息。无自定义Definition时使用系统默认工具策略；有显式Definition则保留用户选择。

## CLI-01：先用本地终端验证完整渠道链

完成LA-01的Group与Registry后，可以先用Nano原生CLI渠道验证入站、Chat执行和回程，不需要平台账号。以下仍只在调试Nano工作区执行；替换真实Group ID：

```bash
pnpm ncl messaging-groups create --channel-type cli --instance cli \
  --platform-id local --name 'Local debug terminal' --is-group 0 --unknown-sender-policy public --json
pnpm ncl wirings create --channel-type cli --instance cli --platform-id local \
  --agent-group-id '<Group ID>' --engage-mode pattern --engage-pattern '^DEBUG_' --sender-scope all --json
pnpm chat DEBUG_HELLO
```

这里只对权限为0600的本机Unix Socket使用public/all，不能照搬到Telegram或微信。当前私聊自动绑定会依据入站source建立cli/local对应绑定；无需把LA-01占位inbox改成CLI。`pnpm chat`应收到`DEBUG_OK`，Nano日志应出现Session created、Message routed、Message delivered，Backend应完成同一事件的Pi Turn。`pnpm chat`收到回复后会退出，下一条消息重新执行命令。

实际路径是`scripts/chat.ts → data/cli.sock → src/channels/cli.ts → routeInbound → chat-pi HTTP Event → Chat/Pi → Nano Delivery → CLI客户端`。它验证公共渠道链路，不能证明真实平台登录、轮询和发送API可用；这些继续做TG-01/WX-01。

## TG-01：独立测试Telegram Bot私聊

**必须使用测试Bot。** Telegram同一Bot的轮询不能靠换本机端口隔离；两个Host共享Token会抢消息/发生409。不要把正常Bot Token复制进调试`.env`。

1. 通过Bot管理流程获得独立测试Bot Token，私下写入调试Nano `.env` 的`TELEGRAM_BOT_TOKEN`，保持文件0600，不在命令行参数/日志中打印。
2. 保持`TELEGRAM_INSTANCES`为空，先用默认adapter instance `telegram`；如测试多Bot，按Nano命名实例规则逐一配置，不先引入额外变量。
3. 停止并重新启动调试Nano，确认适配器连接成功、Host仍为chat-pi。代理问题查启动日志和Node版本，不在浏览器Frontend配置Telegram Token。
4. 确定测试发送者的真实Telegram用户ID和私聊chat ID，建立User、成员权限、Messaging Group、Wiring。下面尖括号为必须替换的ID，不要原样执行。

```bash
# 以下均在 .data/debug/nanoclaw；先通过help核对当前固定版本支持的参数
pnpm ncl users help
pnpm ncl messaging-groups help
pnpm ncl wirings help
pnpm ncl users create --id 'telegram:<测试用户ID>' --kind telegram --display-name 'Debug user'
pnpm ncl members add --user 'telegram:<测试用户ID>' --group '<Group ID>'
pnpm ncl messaging-groups create --channel-type telegram --instance telegram \
  --platform-id '<测试私聊chat ID>' --name 'Debug DM' --is-group 0 --unknown-sender-policy strict
pnpm ncl wirings create --channel-type telegram --instance telegram \
  --platform-id '<测试私聊chat ID>' --agent-group-id '<Group ID>' \
  --engage-mode pattern --engage-pattern '^DEBUG_' --sender-scope known
pnpm ncl wirings list --json
```

Chat Registry Agent的inbox使用返回的真实Messaging Group ID、`channelType: "telegram"`、`instance: "telegram"`、platformId和`threadId: null`。保留服务instanceId为`debug`，不要把它与adapter instance `telegram`混为一谈。

5. 在测试Bot私聊发送`DEBUG_HELLO`，按下面的跨进程断点表观察一轮，最终由测试账号确认收到DEBUG_OK。

## WX-01：独立微信账号私聊

微信适配器已在当前Fork中安装；不要再运行add-wechat修改正常checkout。扫码身份属于具体账号，换目录不能保证同账号多登录互不影响；与正常使用并存时使用独立测试微信账号。

1. 在调试Nano `.env`设置`WECHAT_ENABLED=true`，重启调试Host。
2. 按终端提示完成登录，二维码入口保存在调试`data/wechat/qr.txt`，凭据保存在调试`data/wechat/auth.json`。不要复制正常auth.json，也不提交二维码或登录链接。
3. 观察`WeChat adapter ready`和Host启动；扫码完成不是消息收发完成。
4. 从适配器入站调试信息确认测试联系人真实平台标识，再用ncl建立`wechat:<实际sender ID>` User、Group成员、`channel-type wechat / instance wechat`的私聊Messaging Group与Wiring。参数结构同Telegram；platformId使用微信入站的实际值，不使用昵称或猜测手机号。若先收到未知发送者消息，用调试`dropped-messages list --json`定位，再授权测试联系人。
5. Wiring先使用`^DEBUG_`和known sender，未知发送者策略保持strict。用户发送DEBUG_HELLO并验收平台回复、Chat Session、Delivery和Ack。

一个微信账号可以通过Wiring连接多个Group，但本实验先只连Debug Agent。多Agent实验用互斥前缀，检查每条Wiring的匹配，避免所有Agent同时回复。当前Chat自动绑定面向私聊；群聊需要显式Project Binding，不能以适配器收到群消息作为端到端支持证据。

## 两个平台共用的断点路线

Nano断点全部放在调试worktree的对应文件；Backend断点放Chat原源码。

| 阶段 | 源码/函数 | 观察值与成功条件 |
|---|---|---|
| 平台接收 | Nano `src/channels/telegram.ts`或`wechat.ts` | message.id、sender、platformId、isGroup、threadId |
| 路由/权限 | `src/router.ts#routeInbound` | channelType、instance、Messaging Group、Wiring触发、sender_scope |
| Inbox | `src/session-manager.ts` | resolveSession生成的Nano sessionId、持久消息、唤醒参数 |
| HTTP Outbox | `src/modules/chat-integration/execution-driver.ts`及同目录 | eventId、instanceId=debug、目标45112、提交重试 |
| 接收/幂等 | Chat [events路由](../../../src/routes/api/internal/channel/v1/events.post.ts)、[acceptLongAgentEvents](../../../src/long-agents/bridge.ts) | 服务认证、agentGroup映射、accepted/duplicate；202前已持久化 |
| 绑定/执行 | `bridge.ts`、[runtime.ts](../../../src/long-agents/runtime.ts) | longAgentId、projectId、Chat sessionId、turnId、Snapshot revision |
| Pi | 公共装配与Pi源码 | 实际model、Prompt、Tool、原生消息 |
| Delivery/Ack | Chat [nanoclaw-client](../../../src/long-agents/nanoclaw-client.ts)、Nano chat-integration | 稳定deliveryId、ACK对应的入站消息，鉴权和HTTP状态 |
| 平台投递 | Nano `src/delivery.ts`与Adapter deliver | 精确adapter instance，最终平台发送成功 |

先暂停Nano入口，设置Backend接收断点后放行，再设置Pi断点。长时间暂停会引发HTTP超时/重试，这是预期调试效应；用条件断点按eventId过滤，不要把重试认成新消息。浏览器Web消息没有平台投递步骤，不能用于证明TG/WX收发。

## FAIL-01：失败与恢复实验

只在独立测试账号/假模型中操作：

- **Backend短暂离线**：停调试Backend，由测试账号发一条DEBUG消息；Nano保留耐久入站/Outbox。重启Backend后应继续处理同一eventId。
- **假模型离线**：停Debug Local Model，发送一条测试消息；确认Chat已接收但执行失败/待重试。恢复模型后检查原生Turn与结果，不重复追加相同User。
- **Gateway服务Token不一致**：修改调试配置后启动器应拒绝两侧Token不一致；修复同一私有Token后再启动，不关闭认证。
- **重复同一eventId**：通过已有合同测试验证duplicate和冲突处理；不要手工重发真实外部动作。
- **有Pi回复但平台无回复**：先看Delivery持久化/Adapter错误和Ack，不能重新运行模型来修投递。

当前Nano定时任务等直接写Mailbox的生产者尚未全部进入统一Chat执行事件；触发被拒绝时应定位到未接入合同，不改成原生容器执行。详情见 [chat-pi driver当前覆盖](../../../nanoclaw/docs/chat-pi-execution-driver.md)。

完成真实TG/WX验收后，在自己的私有记录保存测试时间、两侧Commit、脱敏ID、最后成功节点和结果；不要把测试账号、Token、二维码或正文存入公开手册。
