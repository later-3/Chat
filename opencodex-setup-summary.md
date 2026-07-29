# OpenCodex 安装与配置总结

> 安装日期：2026-07-25  
> 安装版本：OpenCodex 2.7.39  
> Node 版本：v24.8.0  
> 文档作者：AI Assistant

## 一、安装前准备

### 1.1 Node 环境检查
- **要求**：Node 24.8.0（通过 nvm 管理）
- **检查命令**：
  ```bash
  exec zsh -l  # 刷新 shell，确保加载 nvm
  node -v      # 应显示 v24.8.0
  npm -v       # 应显示 11.6.0
  ```
- **注意**：如果 `node -v` 显示其他版本，需要检查 `~/.zshrc` 中 nvm 的加载顺序，确保 nvm 的 PATH 优先级高于 `~/.local/bin` 等其他工具

### 1.2 Codex 配置备份
```bash
backup_dir="/Users/xulater/.codex/backups/opencodex-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -p /Users/xulater/.codex/config.toml "$backup_dir/"
cp -p /Users/xulater/.codex/auth.json "$backup_dir/"
echo "备份目录：$backup_dir"
```

## 二、OpenCodex 安装

### 2.1 安装命令
```bash
npm install -g @bitkyc08/opencodex@2.7.39
```

### 2.2 验证安装
```bash
command -v ocx                    # 应显示 /Users/xulater/.nvm/versions/node/v24.8.0/bin/ocx
ocx --version                     # 应显示 opencodex 2.7.39
```

## 三、Provider 配置

### 3.1 初始化 kimi-code（默认 Provider）
```bash
ocx init
# 选择 48（Kimi (coding)）
# API Key：留空（稍后通过 GUI 粘贴）
# 默认模型：kimi-k2.7-code
# 端口：10100
# 注入 Codex config.toml：Y
# 安装 Codex autostart shim：n
```

### 3.2 添加 ark-plan（火山方舟）
```bash
ocx provider add ark-plan \
  --adapter openai-chat \
  --base-url "https://ark.cn-beijing.volces.com/api/coding/v3" \
  --default-model "glm-5.2"
```

### 3.3 添加 dashscope-plan（阿里云百炼）
```bash
ocx provider add dashscope-plan \
  --adapter openai-chat \
  --base-url "https://coding.dashscope.aliyuncs.com/v1" \
  --default-model "qwen3.7-plus"
```

### 3.4 启用 openai 透传（ChatGPT 登录）
```bash
ocx provider add openai --set-default
```
- **说明**：复用 Codex 的 ChatGPT 登录（`~/.codex/auth.json` 中的 token），无需 OpenAI API Key
- **用途**：支持 gpt-5.6-sol 等 OpenAI 原生模型

### 3.5 配置 API Key
**方式 1：通过 GUI**
```bash
ocx gui  # 打开 http://localhost:10100
# 在浏览器中为每个 Provider 粘贴 API Key
```

**方式 2：通过 API（推荐，避免 Key 进入 shell 历史）**
```bash
# 创建临时脚本
cat > /tmp/ocx-setkey.mjs <<'EOF'
import * as fs from "node:fs";
const name = process.argv[2];
let raw = fs.readFileSync(0, "utf8");
const idx = raw.lastIndexOf("|");
const key = raw.slice(idx + 1).trim();
const res = await fetch("http://127.0.0.1:10100/api/providers/keys", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name, key }),
});
const text = await res.text();
console.log(JSON.stringify({ provider: name, status: res.status, ok: res.ok }));
EOF

# 设置 Key（通过 stdin 管道，不进入命令行参数）
printf "%s|%s\n" "kimi-code" "你的kimi-key" | node /tmp/ocx-setkey.mjs kimi-code
printf "%s|%s\n" "ark-plan" "你的ark-key" | node /tmp/ocx-setkey.mjs ark-plan
printf "%s|%s\n" "dashscope-plan" "你的dashscope-key" | node /tmp/ocx-setkey.mjs dashscope-plan

rm /tmp/ocx-setkey.mjs
```

### 3.6 验证 Provider
```bash
ocx provider list
# 应显示 4 个 configured provider：
#   openai (default)  adapter=openai-responses
#   kimi-code         adapter=openai-chat  model=kimi-k2.7-code
#   ark-plan          adapter=openai-chat  model=glm-5.2
#   dashscope-plan    adapter=openai-chat  model=qwen3.7-plus
```

## 四、网络配置（VPN 代理）

### 4.1 问题背景
- OpenAI 模型（gpt-5.6-sol 等）需要走 VPN 才能访问
- 本机 VPN 代理：verge-mihomo，监听 `127.0.0.1:7897`

### 4.2 配置 OpenCodex 出站代理
```bash
# 编辑 ~/.opencodex/config.json，添加 proxy 字段
/usr/bin/python3 <<'PYEOF'
import json, os, tempfile

p = "/Users/xulater/.opencodex/config.json"
with open(p) as f:
    cfg = json.load(f)

cfg["proxy"] = "http://127.0.0.1:7897"

fd, tmp = tempfile.mkstemp(dir="/Users/xulater/.opencodex", prefix=".config.tmp.")
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, p)
PYEOF
```

### 4.3 重启服务让配置生效
```bash
launchctl kickstart -k "gui/$(id -u)/com.opencodex.proxy"
```

### 4.4 原理
- OpenCodex 启动时调用 `applyProxyEnv()`，把 `config.proxy` 镜像到进程的 `HTTP_PROXY`/`HTTPS_PROXY`
- 所有出站请求（OpenAI 透传、Provider API 调用）都走 VPN
- `localhost/127.0.0.1` 自动加入 `NO_PROXY`，保证本机健康检查不走代理

### 4.5 验证
```bash
# 通过代理访问外网
curl -x http://127.0.0.1:7897 -s -o /dev/null -w "HTTP %{http_code}\n" https://www.google.com
# 应返回 HTTP 200
```

## 五、模型精简（ark-plan）

### 5.1 问题
- ark-plan 从火山方舟实时发现 118 个模型（包含大量视觉/嵌入/语音/3D 生成模型）
- 大部分不适合 coding，需要精简

### 5.2 解决方案
```bash
# 1. 设置 liveModels: false，不再实时发现
/usr/bin/python3 <<'PYEOF'
import json, os, tempfile

p = "/Users/xulater/.opencodex/config.json"
with open(p) as f:
    cfg = json.load(f)

cfg["providers"]["ark-plan"]["liveModels"] = False

fd, tmp = tempfile.mkstemp(dir="/Users/xulater/.opencodex", prefix=".config.tmp.")
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, p)
PYEOF

# 2. 手动注册 10 个 coding 模型
models=(
  "deepseek-v4-pro-260425"
  "deepseek-v4-flash-260425"
  "doubao-seed-2-1-pro-260628"
  "doubao-seed-2-1-turbo-260628"
  "doubao-seed-2-0-pro-260215"
  "doubao-seed-2-0-lite-260428"
  "doubao-seed-2-0-mini-260428"
  "glm-5-2-260617"
  "kimi-k2-250905"
  "kimi-k2-thinking-251104"
)

for m in "${models[@]}"; do
  ocx models add ark-plan "$m"
done

# 3. 重启服务
launchctl kickstart -k "gui/$(id -u)/com.opencodex.proxy"
```

### 5.3 保留的 10 个模型
| 模型 | 说明 |
|---|---|
| deepseek-v4-pro-260425 | DeepSeek V4 Pro（最强） |
| deepseek-v4-flash-260425 | DeepSeek V4 Flash（轻量） |
| doubao-seed-2-1-pro-260628 | 豆包 Seed 2.1 Pro |
| doubao-seed-2-1-turbo-260628 | 豆包 Seed 2.1 Turbo |
| doubao-seed-2-0-pro-260215 | 豆包 Seed 2.0 Pro |
| doubao-seed-2-0-lite-260428 | 豆包 Seed 2.0 Lite |
| doubao-seed-2-0-mini-260428 | 豆包 Seed 2.0 Mini |
| glm-5-2-260617 | GLM 5.2（智谱） |
| kimi-k2-250905 | Kimi K2 最新 |
| kimi-k2-thinking-251104 | Kimi K2 Thinking |

## 六、安装为 launchd 常驻服务

```bash
# 停止手动启动的实例
ocx stop

# 安装并启动服务
ocx service install
ocx service status

# 验证
ocx status
ocx health --json
lsof -nP -iTCP:10100 -sTCP:LISTEN
# 应显示仅监听 127.0.0.1:10100
```

## 七、当前配置状态

### 7.1 Provider 列表
| Provider | 类型 | 模型数 | 默认模型 | 说明 |
|---|---|---|---|---|
| openai | forward | 7 | gpt-5.6-sol | ChatGPT 登录透传，走 VPN |
| kimi-code | key | 4 | kimi-k2.7-code | Kimi Coding Plan |
| ark-plan | key | 10 | glm-5.2 | 火山方舟，已精简 |
| dashscope-plan | key | 10 | qwen3.7-plus | 阿里云百炼 |

### 7.2 网络配置
- **OpenCodex 出站代理**：`http://127.0.0.1:7897`（verge-mihomo VPN）
- **监听地址**：`127.0.0.1:10100`（仅回环，无公网暴露）

### 7.3 配置文件位置
- **OpenCodex 配置**：`~/.opencodex/config.json`（权限 600）
- **Codex 配置**：`~/.codex/config.toml`
- **模型目录**：`~/.codex/opencodex-catalog.json`
- **备份目录**：`~/.codex/backups/opencodex-20260725-102622/`

## 八、常用命令

### 8.1 服务管理
```bash
ocx status              # 查看服务状态
ocx health --json       # 健康检查
ocx stop                # 停止服务
ocx start               # 手动启动（不推荐，用 launchd）
ocx service status      # 查看 launchd 服务状态
```

### 8.2 Provider 管理
```bash
ocx provider list       # 列出所有 Provider
ocx provider show <name>  # 查看 Provider 详情
ocx provider set-default <name>  # 设置默认 Provider
```

### 8.3 模型管理
```bash
ocx models list         # 列出所有模型
ocx models list --provider <name>  # 列出某 Provider 的模型
ocx models list-custom  # 列出自定义模型
ocx sync                # 重新同步模型到 Codex
```

### 8.4 GUI 管理
```bash
ocx gui                 # 打开管理页面（http://localhost:10100）
```

## 九、使用方式

### 9.1 Codex CLI
```bash
# 使用默认 Provider（当前是 openai）
codex "你的任务"

# 显式指定模型
codex -m "gpt-5.6-sol" "任务"
codex -m "kimi-code/kimi-k2.7-code" "任务"
codex -m "ark-plan/glm-5-2-260617" "任务"
codex -m "dashscope-plan/qwen3.7-plus" "任务"

# 非交互模式
codex exec -m "ark-plan/glm-5-2-260617" "任务"
```

### 9.2 Codex App（ChatGPT.app）
- 打开 Codex App
- 在模型选择器中选择路由模型（如 `ark-plan/glm-5-2-260617`）
- 新建任务即可使用对应 Provider

**注意**：如果模型选择器看不到某些 Provider 的模型，完全退出 ChatGPT.app 再重开，让它重新加载 catalog。

## 十、故障排查

### 10.1 找不到 ocx
```bash
exec zsh -l  # 刷新 shell
command -v ocx
# 应显示 /Users/xulater/.nvm/versions/node/v24.8.0/bin/ocx
```

### 10.2 Provider 401/403
- 检查 API Key 是否正确
- 通过 `ocx gui` 重新粘贴 Key
- 检查服务商是否要求专用 Coding Plan 端点

### 10.3 OpenAI 模型 404
- 检查是否配置了 `openai` provider（forward 模式）
- 检查 VPN 是否在运行（7897 端口是否监听）
- 检查 `config.json` 中是否有 `proxy` 字段

### 10.4 Codex App 看不到某些模型
- 完全退出 ChatGPT.app 再重开
- 运行 `ocx sync` 重新同步模型
- 检查 `~/.codex/opencodex-catalog.json` 中是否有对应模型

## 十一、安全注意事项

1. **API Key 不要出现在**：
   - 命令行参数
   - Shell 历史记录
   - 聊天消息
   - 日志文件

2. **推荐方式**：
   - 通过 `ocx gui` 在浏览器中粘贴
   - 或通过 stdin 管道喂给 API（见 3.6 节）

3. **Key 轮换**：
   - 如果 Key 曾明文出现在聊天中，建议到服务商控制台 revoke 后重发

4. **文件权限**：
   - `~/.opencodex/config.json`：600
   - `~/.opencodex/` 目录：700

## 十二、回滚命令

```bash
# 临时停用 OpenCodex
ocx stop

# 仅恢复 Codex 配置（不停止代理）
ocx restore

# 完全卸载
ocx uninstall
npm uninstall -g @bitkyc08/opencodex

# 人工恢复 Codex 配置
cp ~/.codex/backups/opencodex-20260725-102622/config.toml ~/.codex/config.toml
```

---

**文档完成时间**：2026-07-25  
**最后更新**：2026-07-25
