# OpenCodex 安装、配置与使用指南

## 1. 文档用途

本文是交给本机执行 Agent 的操作手册，用于在 Later 的 macOS 开发机上：

1. 安装固定版本的 OpenCodex。
2. 接入一个或多个第三方 Coding Plan。
3. 让 Codex App 和 Codex CLI 使用这些模型。
4. 完成安全、功能、常驻和回滚验证。

本文不属于 Chat 产品的 Provider 配置方案，也不授权读取或复用
`/Users/xulater/Code/Chat/backend/config.json`、`backend/.env` 或其他项目密钥。
OpenCodex 使用自己的全局配置目录 `/Users/xulater/.opencodex`。

## 2. 固定基线

本文于 2026-07-25 按以下版本编写：

| 项目 | 固定值 |
|---|---|
| OpenCodex 仓库 | `lidge-jun/opencodex` |
| OpenCodex 版本 | `2.7.39` |
| Git 提交 | `357acee62458684bc027e9d524e95bd066df3a43` |
| npm 包 | `@bitkyc08/opencodex@2.7.39` |
| Node.js | `24.8.0` |
| npm | `11.6.0` |
| Codex CLI | 当前已安装版本 |
| 默认监听 | `127.0.0.1:10100` |
| macOS 服务 | `launchd` |

除非用户明确要求评估升级，否则执行时必须安装固定的 `2.7.39`，不得直接安装浮动的
`latest`、`preview` 或运行无版本审查的 `ocx update`。

固定版本证据：

- [OpenCodex v2.7.39 Release](https://github.com/lidge-jun/opencodex/releases/tag/v2.7.39)
- [OpenCodex v2.7.39 中文说明](https://github.com/lidge-jun/opencodex/blob/v2.7.39/README.zh-CN.md)

## 3. 用户需要提供什么

每个 Coding Plan 通常只需要用户提供：

1. API Base URL。
2. API Key。

如果服务商的 `/v1/models` 接口不能自动发现模型，还需要用户补充：

3. 至少一个准确的模型 ID。

Provider 显示名称、Provider ID、协议 Adapter 和模型发现由执行 Agent 负责确定。

### 3.1 密钥交付规则

1. API Base URL 可以通过聊天提供。
2. API Key 不写入本文、项目文件、命令参数、Shell 历史、日志、Git 或执行总结。
3. 首选由用户在本机 `ocx gui` 打开的浏览器表单中粘贴 API Key。
4. Agent 不得读取 Chat 项目的私有配置来“自动找到”现有 API Key。
5. 执行总结只允许报告“凭据已配置/未配置”，不得显示完整密钥或可恢复的密钥片段。

## 4. 执行边界

执行 Agent 可以：

1. 检查 Node、npm、Codex、端口、配置文件和服务状态。
2. 备份 Codex 配置。
3. 安装固定版本 OpenCodex。
4. 运行 OpenCodex 初始化、Provider 配置和本机验证。
5. 安装或移除当前用户的 launchd 服务。
6. 在测试目录运行 Codex CLI 验证。

执行 Agent 不可以：

1. 使用 `sudo npm install -g`。
2. 把 OpenCodex 绑定到 `0.0.0.0`、局域网地址或公网。
3. 开启未审核的本地原生命令执行、请求正文调试记录或远程管理。
4. 修改 Chat 项目的 `backend/config.json`、数据库、Provider 配置或运行服务。
5. 在真实项目工作区执行写入测试。
6. 因安装失败而删除用户现有的 Codex 配置或历史。

## 5. 当前 Node/npm 基线

本机已经把 nvm 默认版本、登录 Shell、交互 Shell和 `/usr/local/bin` 兼容入口统一到
Node `24.8.0`。

执行前运行：

```bash
command -v node
node -v
command -v npm
npm -v
command -v npx
npm config get prefix
nvm current
nvm version default
```

预期结果：

```text
node: /Users/xulater/.nvm/versions/node/v24.8.0/bin/node
node version: v24.8.0
npm: /Users/xulater/.nvm/versions/node/v24.8.0/bin/npm
npm version: 11.6.0
npx: /Users/xulater/.nvm/versions/node/v24.8.0/bin/npx
npm prefix: /Users/xulater/.nvm/versions/node/v24.8.0
nvm current/default: v24.8.0
```

若当前终端尚未刷新，执行：

```bash
exec zsh -l
```

如果刷新后仍不一致，停止安装并先修复 Node 环境；不要把 OpenCodex 安装到另一套 Node 全局目录。

## 6. 安装前检查和备份

### 6.1 关闭客户端

1. 退出 Codex App。
2. 结束正在运行的 Codex CLI 会话。
3. 不结束 Chat 项目的后端、前端或 Worker。

### 6.2 检查现状

```bash
command -v codex
codex --version
command -v ocx || true
command -v opencodex || true
lsof -nP -iTCP:10100 -sTCP:LISTEN || true
```

如果 `10100` 已被无关进程监听，先记录 PID、命令和归属，不得直接终止。

### 6.3 创建只读回滚备份

```bash
backup_stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="/Users/xulater/.codex/backups/opencodex-${backup_stamp}"
install -d -m 700 "${backup_dir}"

if [[ -f /Users/xulater/.codex/config.toml ]]; then
  cp -p /Users/xulater/.codex/config.toml "${backup_dir}/config.toml"
fi

if [[ -f /Users/xulater/.codex/auth.json ]]; then
  cp -p /Users/xulater/.codex/auth.json "${backup_dir}/auth.json"
fi

printf '%s\n' "${backup_dir}"
```

执行 Agent必须记录实际备份目录，但不得输出备份文件内容。

## 7. 安装固定版本

### 7.1 核对 npm 发布信息

```bash
npm view @bitkyc08/opencodex@2.7.39 \
  version engines dist.integrity dist.tarball
```

预期：

```text
version = 2.7.39
engines.node = >=18
dist.integrity = sha512-Vy9DBmXw27x7RNKrlWhIMD0kD0qhamJ9LCBctW+lepac2+rL1gKqEXBCSIfsMCqCGUk5kFKSakEYXUyMpbYD6w==
```

版本或完整性不一致时停止，不继续安装。

### 7.2 安装

```bash
npm install -g @bitkyc08/opencodex@2.7.39
```

不得使用 `sudo`，不得加入 `--ignore-scripts` 或 `--omit=optional`。

如果出现 `bundled Bun runtime is missing`，按官方说明重装：

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex@2.7.39
```

### 7.3 验证安装位置

```bash
command -v ocx
ocx --version
npm list -g --depth=0 @bitkyc08/opencodex
```

`ocx` 必须位于 Node 24 的 nvm 目录：

```text
/Users/xulater/.nvm/versions/node/v24.8.0/bin/ocx
```

## 8. 初始化 OpenCodex

执行：

```bash
ocx init
```

初始化过程中：

1. 选择第一个Coding Plan对应的内置Provider；没有内置项时选择最后的`custom`。
2. 自定义Provider依次填写Provider ID、Base URL和正确Adapter。
3. API Key可以由用户在当前本机终端粘贴；如果计划改在浏览器页面输入，这一步留空。
4. 不确定模型ID时暂时留空，之后从服务商模型目录自动发现。
5. 保持默认本机端口`10100`。
6. 在`Inject into Codex config.toml? [Y/n]`处回答`Y`或直接回车。
7. 在`Install Codex autostart shim? [Y/n]`处明确回答`n`。

`ocx init`一定会要求建立第一个Provider。它会重新生成OpenCodex配置，因此只用于首次初始化；
后续新增Provider使用仪表盘或`ocx provider`，不得再次运行`ocx init`覆盖已有Provider。

初始化后，不直接输出下列文件内容：

```text
/Users/xulater/.opencodex/config.json
/Users/xulater/.opencodex/auth.json
/Users/xulater/.codex/auth.json
```

只检查权限：

```bash
stat -f '%Sp %N' /Users/xulater/.opencodex
stat -f '%Sp %N' /Users/xulater/.opencodex/config.json
```

期望目录至少不允许其他用户写入，配置文件应为仅当前用户可读写。若权限过宽，先修复为：

```bash
chmod 700 /Users/xulater/.opencodex
chmod 600 /Users/xulater/.opencodex/config.json
```

## 9. 配置 Coding Plan

### 9.1 打开本机管理页面

先启动 OpenCodex：

```bash
ocx start
```

在另一个终端打开管理页面：

```bash
ocx gui
```

管理页面必须是：

```text
http://127.0.0.1:10100
```

或等价的：

```text
http://localhost:10100
```

### 9.2 为每个 Coding Plan 添加 Provider

对每组用户提供的 Base URL 和 API Key：

1. 点击 `Add Provider`。
2. 有内置 Provider 时优先选内置项。
3. 没有内置项时选择自定义 Provider。
4. 使用不含空格、含义稳定的 Provider ID，例如 `ark-plan`、`dashscope-plan`。
5. 填写 API Base URL。
6. 由用户在本机页面中粘贴 API Key。
7. 选择协议 Adapter。
8. 自动发现模型；失败时手工添加模型 ID。
9. 保存后确认 Provider 状态健康。

### 9.3 Adapter 选择

| 服务商实际接口 | Adapter |
|---|---|
| OpenAI Chat Completions，通常为 `/v1/chat/completions` | `openai-chat` |
| OpenAI Responses，通常为 `/v1/responses` | `openai-responses` |
| Anthropic Messages，通常为 `/v1/messages` | `anthropic` |
| Google Gemini 原生接口 | Google 对应 Adapter |
| Azure OpenAI | Azure 对应 Adapter |

判断规则：

1. 不根据模型名称猜协议。
2. 优先依据服务商官方接口文档。
3. Base URL 通常填到版本根路径，例如 `https://example.com/v1`，不填完整的
   `/chat/completions`。
4. 服务商声称“OpenAI兼容”但只实现 Chat Completions 时必须选 `openai-chat`，不能选
   `openai-responses`。
5. 若协议仍不明确，Agent应先查看无密钥的官方文档；不得用真实Key进行多协议盲发测试。

### 9.4 多 Provider

多个 Coding Plan 分别建立 Provider，不共用同一个 Provider ID，也不覆盖彼此的 Base URL 或 Key。
完成后选择一个作为默认 Provider，其余通过 `provider/model` 显式调用。

## 10. 安全验证

### 10.1 进程与监听

```bash
ocx status
ocx health --json
ocx provider list
ocx models list
lsof -nP -iTCP:10100 -sTCP:LISTEN
```

必须满足：

1. 只有预期的 OpenCodex 进程监听。
2. 监听地址是 `127.0.0.1:10100` 或 `[::1]:10100`。
3. 不得出现 `*:10100`、`0.0.0.0:10100` 或局域网IP。

### 10.2 Codex 注入

只搜索安全标识，不打印整个配置：

```bash
rg -n 'opencodex|127\.0\.0\.1|localhost|10100' \
  /Users/xulater/.codex/config.toml
```

不得把 `/Users/xulater/.codex/config.toml` 整体输出到聊天。

### 10.3 禁止项

确认没有主动启用：

1. 非回环 `hostname`。
2. 请求正文或敏感内容调试记录。
3. 未审核的原生命令执行能力。
4. 公网反向代理、端口映射或远程仪表盘。
5. 自动安装 preview 版本。

## 11. 功能验证

### 11.1 Provider和模型目录

在 OpenCodex 页面确认：

1. 每个 Provider 状态健康。
2. 能看到至少一个模型。
3. 默认 Provider 和默认模型正确。
4. Provider之间的模型没有错误混用。

### 11.2 Codex CLI最小问答

在临时目录验证，不进入真实项目：

```bash
test_dir="$(mktemp -d /tmp/opencodex-smoke.XXXXXX)"
cd "${test_dir}"
git init --quiet
printf '%s\n' '# OpenCodex smoke test' > README.md

codex -m "provider-id/model-id" \
  "只回复 OPENCODEX_ROUTE_OK，不要修改文件，不要执行命令。"
```

必须得到明确成功响应，且 OpenCodex 仪表盘能看到对应请求和正确 Provider。

### 11.3 只读工具验证

仍在测试目录执行：

```bash
codex -m "provider-id/model-id" \
  "读取 README.md，只告诉我第一行内容，不要修改任何文件。"
```

检查：

1. 模型能正确读取第一行。
2. 没有新增或修改文件。
3. 请求只发送1次，失败时不做未知副作用重放。

### 11.4 临时写入验证

仅在测试目录执行：

```bash
codex -m "provider-id/model-id" \
  "新建 result.txt，内容只能是 OPENCODEX_WRITE_OK，然后停止。"
```

验证：

```bash
git status --short
test "$(cat result.txt)" = "OPENCODEX_WRITE_OK"
```

不得在 `/Users/xulater/Code/Chat` 或其他真实仓库做首次写入测试。

### 11.5 Codex App验证

1. 完全退出并重新打开 Codex App。
2. 打开模型选择器。
3. 确认路由模型以对应 Provider/模型身份出现。
4. 新建临时任务完成一次普通问答。
5. 确认 OpenCodex 仪表盘记录到同一请求。

旧Codex任务可能固定在原Provider；验证路由时优先新建任务。

## 12. 安装为macOS常驻服务

Later主要使用 Codex App，因此在手工验证通过后使用 launchd 常驻服务，不使用
`codex-shim` 作为主要启动方式。

先停止手工启动的实例：

```bash
ocx stop
```

安装并启动服务：

```bash
ocx service install
ocx service status
ocx ensure
ocx sync
```

再次验证：

```bash
ocx status
ocx health --json
lsof -nP -iTCP:10100 -sTCP:LISTEN
```

然后重新打开 Codex App，重复一次最小问答。

不得同时安装两套不必要的自动启动机制。只有用户明确改为纯CLI按需使用时，才考虑：

```bash
ocx codex-shim install
```

## 13. 日常使用

### 13.1 Codex App

1. 保持 OpenCodex 服务运行。
2. 在模型选择器中选择目标路由模型。
3. 新任务会按所选 Provider 路由。
4. Provider、模型或默认值变化后运行 `ocx sync` 并重新打开 Codex App。

### 13.2 Codex CLI

显式选择：

```bash
codex -m "provider-id/model-id" "任务内容"
```

使用默认 Provider：

```bash
codex "任务内容"
```

### 13.3 常用管理命令

```bash
ocx status
ocx gui
ocx sync
ocx service status
ocx stop
ocx restore
```

## 14. 失败处理

### 14.1 找不到 `ocx`

```bash
exec zsh -l
command -v node
command -v npm
npm config get prefix
npm list -g --depth=0 @bitkyc08/opencodex
```

必须先确认当前 Node 为 `24.8.0`，不得在另一个npm前缀重复安装。

### 14.2 Bun运行时缺失

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex@2.7.39
```

### 14.3 Provider 401/403

1. 不输出Key。
2. 让用户在本机页面重新输入Key。
3. 检查服务商是否要求专用Coding Plan端点。
4. 检查Key是否有模型权限、是否过期、是否限制来源IP。
5. 不自动把失败请求切到其他Provider。

### 14.4 Provider 404

1. 检查Base URL是否错误包含完整方法路径。
2. 检查Adapter是否与服务商协议一致。
3. 检查服务商是Chat Completions还是Responses。
4. 不通过多次真实请求盲猜端点。

### 14.5 找不到模型

1. 检查服务商是否支持 `/v1/models`。
2. 使用服务商文档中的精确模型ID。
3. 必要时只向用户追加询问模型ID。
4. 不根据产品宣传名称自行创造模型ID。

### 14.6 Codex App没有显示模型

```bash
ocx ensure
ocx sync
ocx status
```

然后完全退出并重新打开 Codex App。

## 15. 停用、恢复与卸载

### 15.1 临时停用

```bash
ocx stop
```

该命令应停止OpenCodex并恢复原生Codex配置。

只恢复Codex配置但不停止代理：

```bash
ocx restore
```

### 15.2 完全卸载

必须先让 OpenCodex 自己清理服务、shim、配置和Codex注入：

```bash
ocx uninstall
```

再卸载npm包：

```bash
npm uninstall -g @bitkyc08/opencodex
```

最后验证：

```bash
command -v ocx || true
lsof -nP -iTCP:10100 -sTCP:LISTEN || true
codex --version
```

如果 OpenCodex 的恢复流程失败，使用第6.3节记录的备份目录人工恢复
`config.toml`；`auth.json`只在确认现有认证已损坏时恢复，不能无条件覆盖较新的登录状态。

## 16. 完成门

执行 Agent只有在以下全部成立时才能报告“安装完成”：

1. Node、npm、npx和npm prefix全部属于Node 24.8.0。
2. OpenCodex准确安装为2.7.39。
3. `ocx`来自Node 24全局目录。
4. Codex原配置已经备份。
5. OpenCodex只监听本机回环地址。
6. 每个Coding Plan都有独立Provider。
7. 每个Provider至少有1个准确模型ID。
8. CLI普通问答通过。
9. CLI只读工具测试通过。
10. 临时目录写入测试通过。
11. Codex App新任务路由通过。
12. launchd服务重启后仍通过最小问答。
13. 没有读取、输出、提交或泄漏任何API Key。
14. 回滚路径和备份目录已记录。

## 17. 执行总结模板

执行 Agent最终只报告以下脱敏信息：

```text
OpenCodex版本：
Node/npm版本：
ocx路径：
Codex CLI版本：
备份目录：
服务状态：
监听地址：

Provider 1：
- ID：
- 协议：
- Base URL主机（脱敏，不含查询参数）：
- 模型数量：
- 默认模型：
- 凭据状态：已配置/未配置

验证：
- CLI普通问答：通过/失败
- CLI只读工具：通过/失败
- 临时目录写入：通过/失败
- Codex App：通过/失败
- launchd重启：通过/失败

未完成项：
回滚命令：
```

总结中不得包含完整API Key、Authorization Header、私有配置正文或真实Provider请求正文。
