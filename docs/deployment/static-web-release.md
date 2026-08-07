# Web 静态产物发布与回滚（P1.2）

> 适用范围：Chat Web（`apps/web`）静态站点发布到现有弱服务器。
> 核心原则：**服务器不是构建机**。编译、测试、打包全部在开发机或 CI 完成，服务器只校验、解压、原子切换、回滚。

## 1. 发布顺序

```text
审核通过的 Git 提交
-> 开发机或 CI：pnpm install --frozen-lockfile
-> pnpm build / lint / format:check / typecheck / test / test:e2e:pwa / audit --prod
-> 打包 apps/web/dist 为 release 压缩包
-> 写入版本元数据（Git SHA）与 SHA-256 校验文件
-> 上传到服务器新的 releases/<git-sha> 目录
-> 服务器校验 SHA-256 并解压
-> 原子切换 current 符号链接
-> HTTPS / 缓存头 / 离线 Smoke
-> 保留上一份 release 供回滚
```

## 2. 本地打包命令（开发机）

```bash
# 仓库根目录，基于审核通过的提交
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @chat/web test:e2e:pwa
pnpm audit --prod

# 打包（产物与校验文件一律放仓库外的独立产物目录，不进入 Git）
GIT_SHA=$(git rev-parse HEAD)
ARTIFACT_DIR=$(mktemp -d)/chat-web-$GIT_SHA
mkdir -p "$ARTIFACT_DIR"
cp -R apps/web/dist "$ARTIFACT_DIR/dist"
echo "$GIT_SHA" > "$ARTIFACT_DIR/GIT_SHA"
tar -C "$ARTIFACT_DIR" -czf "$ARTIFACT_DIR/chat-web-$GIT_SHA.tar.gz" dist GIT_SHA
# 校验文件必须记录相对路径：在产物目录内生成，服务器上 sha256sum -c 才能找到文件
(
  cd "$ARTIFACT_DIR"
  shasum -a 256 "chat-web-$GIT_SHA.tar.gz" > "chat-web-$GIT_SHA.tar.gz.sha256"
)
echo "产物目录：$ARTIFACT_DIR"
```

## 3. 服务器硬要求

1. 禁止在服务器运行 `pnpm install`、`npm install`、`pnpm build`、`vite`、`tsc`、Playwright。
2. 不上传源码、`.git`、`node_modules`、测试缓存或本地配置；只上传压缩包与校验文件。
3. 每次发布使用新目录 `releases/<git-sha>/`，校验成功后原子切换 `current` 符号链接；不得在正在服务的目录内逐个覆盖文件。
4. 至少保留上一份已验证 release；Smoke 失败立即把 `current` 指回上一目录，不在服务器现场修代码或重新编译。
5. 服务器地址、账号、路径和密钥只来自私有配置或显式环境参数，不进入仓库、文档、日志或 PR。
6. 与 `pi-web` 共用物理服务器时，Chat 必须使用独立 Origin 或不重叠的静态根；Service Worker scope 只覆盖自己的路径，不得接管 `pi-web`。

服务器侧参考步骤（路径仅为示例）：

```bash
# 上传后
cd /srv/chat-web
mkdir -p releases/<git-sha>
sha256sum -c chat-web-<git-sha>.tar.gz.sha256
tar -C releases/<git-sha> -xzf chat-web-<git-sha>.tar.gz
ln -sfn releases/<git-sha>/dist current.tmp && mv -T current.tmp current
# Smoke 通过后删除更旧 release，仅保留 current 与上一份
```

回滚：

```bash
ln -sfn releases/<previous-sha>/dist current.tmp && mv -T current.tmp current
```

## 4. 静态服务配置（Nginx 参考）

```nginx
server {
    listen 443 ssl;
    server_name chat.example.invalid;  # 实际值来自私有配置
    root /srv/chat-web/current;
    index index.html;

    # 入口、Service Worker 与 Manifest 每次重验证
    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }
    location = /sw.js {
        add_header Cache-Control "no-cache" always;
    }
    location = /manifest.webmanifest {
        add_header Cache-Control "no-cache" always;
        default_type application/manifest+json;
    }

    # 带内容 Hash 的构建产物长期缓存
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # SPA 导航回退
    location / {
        try_files $uri $uri/ /index.html;
    }

    # /api 永不进入静态 fallback：try_files 最后一项是内部重定向，
    # 没有独立 location 时，不存在的 /api/** 会被回退成 HTML 外壳（假在线）。
    # 拓扑A：API 已部署到本机上游时，使用代理（上游地址来自私有部署配置）：
    # location /api/ {
    #     proxy_pass http://127.0.0.1:3000;
    #     proxy_set_header Host $host;
    #     proxy_set_header X-Forwarded-Proto $scheme;
    # }
    # 拓扑B：当前阶段静态站点未同机部署 API 时，必须明确失败：
    location = /api {
        return 503;
    }
    location /api/ {
        return 503;
    }
}

# HTTP 一律重定向 HTTPS
server {
    listen 80;
    server_name chat.example.invalid;
    return 301 https://$host$request_uri;
}
```

注意 Content-Type：`manifest.webmanifest` 为 `application/manifest+json`，`sw.js` 为 `text/javascript`，SVG 为 `image/svg+xml`，PNG 为 `image/png`。

## 5. 发布后 Smoke

1. `curl -sI https://<origin>/`：200，`Cache-Control: no-cache`。
2. `curl -sI https://<origin>/sw.js` 与 `/manifest.webmanifest`：200、正确 MIME、`no-cache`。
3. `curl -sI https://<origin>/assets/<hashed>.js`：`immutable` 长期缓存。
4. `curl -fsS https://<origin>/GIT_SHA`（如选择公开该文件）或查看解压目录内 `GIT_SHA`：与批准的提交一致。
5. 浏览器在线打开一次 → 断网重新打开：外壳渲染、显示“未连接”，草稿仍在。
6. 确认同服务器 `pi-web` 仍可访问，未被 Chat 的静态根或 Service Worker 覆盖。

## 6. 版本更新语义

Service Worker 由 `vite-plugin-pwa` 生成并使用内容寻址预缓存。新版本部署后，浏览器拿到新 `sw.js` 会安装并等待；页面显示“新版本可用”提示，只有用户点击“刷新更新”才激活。草稿在输入时已写入 `localStorage`（`chat:draft:v1:<sessionId>`），用户确认刷新不丢草稿；系统不会强制刷新，也不存在后台自动重放。
