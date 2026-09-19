# Linux / WSL2：从零安装

目标：准备软件、固定依赖、私有配置和服务定义，**不启动服务，也不启用开机自启**。日常拉起见[运行手册](./running.md)，不要为启动重复安装。

## 1. 系统前提

使用有 sudo 权限的账号。推荐 Ubuntu 24.04 或 Debian 的 WSL2/Linux；脚本也识别 dnf/yum。机器需为 x86_64/aarch64，具有运行中的 systemd 和可运行 Node 22 官方二进制的 glibc。需要网络访问 GitHub、nodejs.org、npm Registry 和依赖下载地址；离线安装未提供。

WSL 用户先在 **Windows PowerShell** 安装或检查 WSL2：

```powershell
wsl --install -d Ubuntu-24.04
wsl --version
wsl -l -v
```

在 **WSL Linux 终端** 检查：

```bash
ps -p 1 -o comm=
systemctl status --no-pager
```

PID 1 应为 systemd。尚未启用时，编辑 `/etc/wsl.conf`，保留原有配置并加入：

```ini
[boot]
systemd=true
```

然后在 PowerShell 执行 `wsl --shutdown` 并重新进入发行版；这会关闭所有 WSL 发行版。参见 [Microsoft systemd 说明](https://learn.microsoft.com/windows/wsl/systemd)。服务自启指 Linux 启动后执行，不代表脚本已配置 Windows 登录时自动启动 WSL。源码与数据放 Linux 文件系统，例如 `/opt/chat`、`/home/chat`，不要复制 Windows 的 node_modules 或放到 `/mnt/c` 复用。

## 2. 获取脚本并安装

Ubuntu/Debian 的空系统先准备下载工具：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl --fail --location https://raw.githubusercontent.com/later-3/Chat/main/deploy/chatctl -o /tmp/chatctl
sudo bash /tmp/chatctl install --with-nanoclaw
```

`--with-nanoclaw` 安装 Friend Host；只使用普通 Web/Workflow 时去掉该参数。已有本次源码包时，可直接 `sudo bash deploy/chatctl install --with-nanoclaw --ref <已发布提交>`。安装脚本仍按 `--ref` 从 Git 获取构建输入，**本机未提交代码不会因此出现在另一台机器**。默认 main；Frontend、Pi、Nano 的版本固定到该父提交，禁止子模块自行追踪远端。

自动完成：

1. 系统依赖：Git、curl、SSH 客户端、xz、C/C++/make、Python、pkg-config、util-linux、lsof。
2. 专用 `chat` 系统用户、`/opt/chat` 源码及固定 Submodule。
3. 固定 Node 22.19.0（官方 SHA256 校验）、Chat pnpm 10.13.1；Nano 使用自身 packageManager 锁定版本。
4. Pi 离线模型目录恢复、锁定安装、Chat `pnpm verify`、版本化构建。
5. 私有环境与随机服务 Token，仅创建缺失配置；不覆盖已有模型、渠道、Session 或 Memory。
6. 可选 Nano 的安装、格式/类型/构建/测试、原生升级收据、私有 chat-pi 连接配置和 `nanoclaw-chat.service`。

Nano 已有连接配置若与本次 Backend 不一致会明确失败，不自动改 Token、切运行模式或接管其他 Host。不要对同一 Nano checkout 再执行原生 Setup service 装第二个服务。

成功后服务仍停止。安装中断可重复运行，锁防止并发安装；构建失败不会启动半成品。已有服务运行时 install/update 会拒绝，先按运行手册停机，避免更新正在消费的 Pi/Nano 文件。

## 3. 单独启动与配置

```bash
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl status
```

在本机浏览器访问 `http://127.0.0.1:43110`。WSL 的 Windows 浏览器通常可通过 localhost 访问 Linux 服务，见 [Microsoft 网络说明](https://learn.microsoft.com/windows/wsl/networking)。远程 Linux 使用[SSH 转发](./network.md)，无需为安装开放公网端口。

在设置中选择可用 Provider、模型并配置认证，然后创建自己的 Project。Friend 页面点击启用默认助手或“＋”，只填名称和可选简介；Backend 通过 Nano 管理接口创建 Group、独立资源和会话，不需要手工写 Registry。仅 Web 交流不要求 Telegram/微信，渠道账号稍后连接。没有模型凭据可以浏览配置页面，不能据此声称模型已能工作。

也可以手动配置 `/etc/chat/chat.env` 的 Provider 环境变量，或 `/home/chat/.chat/agent/settings.json`、`models.json`、`auth.json`；格式以[配置合同](../configuration/README.md)为准。环境文件修改后需 restart，密钥不打印或提交。

## 4. 目录与迁移边界

```text
/opt/chat/                              稳定源码；Pi / Frontend / Nano 固定版本
/opt/chat/nanoclaw/{.env,data,groups}    Nano 私有连接、数据库、Workspace / Memory
/etc/chat/chat.env                      Chat 私有进程环境
/home/chat/.chat/                       Chat 模型、认证、Project、Session、Memory
/var/lib/chat/runtime/toolchains/       固定工具链
/var/lib/chat/runtime/releases/         构建产物与 4 个仓库 Commit 记录
/var/lib/chat/runtime/current           本次选定 Release
/etc/systemd/system/chat.service
/etc/systemd/system/nanoclaw-chat.service  可选
```

所有原生依赖在目标机器安装和构建，**不能从其他机器复制** `.output`、dist 或 node_modules。新装不迁移旧电脑历史；迁移前停止两个服务，备份 Chat Home、chat.env、Nano 的 .env/data/groups，SQLite 不漏 WAL/SHM。Project 源码和历史绝对路径也需要单独处理，不只复制数据库。

可选多设备目录是 `$CHAT_HOME/devices.json`，格式参考 [devices 示例](../../deploy/devices.json.example)。它只保存公开实例的 id/name/url，不保存凭据。装机与实际模型调用、外部渠道收发的验收分别记录。
