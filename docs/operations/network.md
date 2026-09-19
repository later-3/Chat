# 网络访问与代理

先完成[本机启动和健康检查](./running.md)。以下是可选网络拓扑，不是从零安装的前提。Chat 没有产品登录；远程访问优先使用受控 SSH 转发或已有访问网关。

## 远程本机访问

```bash
ssh -L 43110:127.0.0.1:43110 <用户>@<Linux主机>
```

连接后在客户端浏览器访问 `http://127.0.0.1:43110`。Nano 的原生 webhook 监听为 `0.0.0.0:3000`，不要为 Chat 的 Web 访问开放该端口；服务认证仍必须保持。

## Chat域名

生产公开入口只指向生产Backend。VS Code使用的35145/45112/45300/45401、`.data/debug`和独立浏览器资料仅供调试，不加入Tunnel或生产服务配置；并存规则见[调试环境](../development/debugging/environment.md)。调试准备命令不代替本文的生产安装/升级步骤。

公开入口由`CHAT_PUBLIC_URL`配置，例如：

```text
https://chat.example.com
```

Mac直连Cloudflare示例见[deploy/cloudflared/config.example.yml](../../deploy/cloudflared/config.example.yml)。所有`example.com`值都必须在部署机的私有副本中替换，关键映射是：

```yaml
- hostname: chat.example.com
  service: http://127.0.0.1:43110
```

同一个Cloudflare Tunnel如果还有云服务器连接器，云端必须从
[Nginx配置模板](../../deploy/nginx/chat.conf)和
[云端Cloudflare配置模板](../../deploy/cloudflared/cloud-relay.example.yml)生成不跟踪的本地配置，并保持Mac上的
`com.later.chat.cloud-relay`常驻。云端链路的端口关系固定为：

```text
Cloudflare → 127.0.0.1:33052 Nginx → 127.0.0.1:33051 Relay → Mac:43110
```

同一个Tunnel的不同连接器各自读取本机ingress；任何一个连接器缺少Relay都会导致公网请求间歇性503，因此发布验收至少连续检查5次健康接口。

将示例域名替换为当前环境的`CHAT_PUBLIC_URL`后做公网验收：

```bash
curl --fail https://chat.example.com/api/health
```

健康接口应返回`{"ok":true,"service":"chat"}`。随后用浏览器完成以下验收：打开工作区、创建Session、运行直接执行和规划执行，并让Planner Orchestrator在计划批准后调用多个子Workflow；观察Thinking/工具过程、父子Session、刷新恢复和“完整历史”中的`Workflow → Stage · Agent → 输入/模型思考/工具调用与输出/Agent输出`结构。

浏览器打开该域名后应直接进入工作区，可以安装为PWA。Android Chrome使用“安装应用”，iOS Safari使用“添加到主屏幕”。

## 认证边界

- Chat 产品页面及 Session、文件、设备、Workflow API 不使用产品登录或 Cookie；部署环境决定谁能连接。
- Provider OAuth/API Key 保留，用于模型连接。
- NanoClaw 内部 Channel API 继续要求服务 Token，未提供或错误凭据返回 401。
- Workflow 内部回调继续按其原合同处理，不受浏览器登录影响。
