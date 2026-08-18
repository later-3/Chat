# DSH 插件治理与版本采用合同

> 本文定义 Chat 如何登记、采用、二次开发、升级和退出 DSH 插件。机器可读事实见
> [`config/dsh-plugins.json`](../../config/dsh-plugins.json)，实际安装真相仍由 workspace
> `package.json`、`pnpm-lock.yaml` 与安装工件共同证明。

## 1. 用户结果

无论开发从当前 Mac 迁移到另一台 Mac、Linux，还是用户只通过手机 PWA 交互，仓库都必须
能够回答并重建：

1. 当前启用了哪些 DSH 插件，各自由谁维护。
2. 实际运行的包、版本、来源、integrity、上游提交和许可证是什么。
3. Chat 是否基于它做了增量开发；代码、patch、fork、分支和上游基点在哪里。
4. 它依赖哪些 DSH Service、Slot、DOM 或网络能力，升级会影响哪些表面。
5. 新版怎样被发现、审核、测试、采用和回滚。

登记表不是插件运行时事实源，也不允许浏览器据此获得额外权限。它是仓库治理入口；DSH
profile仍只是从已锁工件生成的可重建运行投影。

## 2. 所有权分类

### 2.1 DSH 上游本体

`@deepseek-ai/dsh`是固定前端Host，不是Chat插件。Chat固定发布版本与完整锁文件闭包；只有
公开接缝无法表达已授权结果时，才允许维护窄package patch或可追溯派生分支。

核心patch必须登记上游基点、Chat派生提交、patch hash、未上游化原因、兼容测试和退出条件；
不得直接修改`node_modules`，也不得把完整DSH源码复制进Chat。

### 2.2 第三方通用插件

通用布局、交互或工具能力由其上游维护。Chat默认直接采用正式发布工件：

- 精确版本进入受跟踪workspace依赖与`pnpm-lock.yaml`；
- 登记npm integrity、shasum、gitHead、tag、仓库和许可证；
- DSH profile只`link:`仓库已安装并验证的包，不在`.data`中重新解析裸npm版本；
- 新版本只通过人工触发产生候选，不自动修改运行profile、不自动合并。

### 2.3 Chat 自有 DSH 插件

Workflow、Plan/HITL、Product Run、Decision、Evidence等Chat产品语义只能由Chat workspace包
拥有。目前唯一入口是`@chat/dsh-lifeos-bridge`；未来确需拆分时使用独立
`@chat/dsh-plugin-*`包，并保持公开Query/Command和Product Store边界。

Chat特有功能即使只在手机显示，也不得因此写入第三方移动插件。

### 2.4 Chat 私有部署

PWA manifest/Service Worker、认证、Gateway、Cloudflare/Nginx、LaunchAgent和未来Linux
systemd/容器Adapter由Chat维护，不属于第三方插件更新链。非秘密拓扑与操作合同进入仓库；
密码散列、会话密钥、Provider Key和机器私有配置永不登记进Git。

## 3. 登记表合同

每个启用插件必须有且只有一条登记，至少包含：

- `id`、`packageName`、启用状态；
- `ownership`与`adoption`（直接采用、Chat自有、fork或patch）；
- workspace/npm来源；npm来源还必须有版本、integrity、gitHead、tag、仓库和许可证；
- 兼容的DSH版本与客户端平台；
- 注入的Client/Host Service、网络外发和私有DOM依赖；
- Chat增量代码、fork/patch或明确的`null`；
- 人工更新策略、禁止自动合并；
- 真实验收与合同测试入口。

`pnpm dsh:plugins:verify`会复核登记表、DSH版本、workspace身份、安装包身份、许可证、运行
依赖、生命周期脚本、`apps/dsh-web`精确依赖与lock integrity。构建、profile准备和真实E2E
preflight都复用同一校验。

## 4. 新插件采用顺序

1. 用普通话写清用户结果、高风险动作、离线/失败/回滚场景。
2. 判断是Chat产品责任、第三方通用能力，还是缺失的DSH核心接缝。
3. 审核上游源码与发布工件：维护者、许可证、依赖、生命周期脚本、网络行为、注入服务、
   私有DOM耦合、版本兼容和退出路径。
4. 选择`直接采用 / Chat自有插件 / 临时窄patch / 受管fork / 拒绝`。
5. 先更新登记表、精确依赖与测试，再生成profile；不得先在个人`~/.dsh`试装后把偶然状态
   当成交付。

DSH插件运行在同一Host或浏览器Origin内，不是安全沙箱。Client插件即使读不到HttpOnly
Cookie，也能调用同源接口；因此新增插件默认视为高信任代码，必须审查网络与注入能力。

## 5. 二次开发决策

### 5.1 通用改进

其他DSH用户也受益的修复优先提交上游。上游发布后，Chat采用新正式版本。等待期间：

- 小且短期：精确package patch，并关联上游issue/PR；
- 大或长期：建立`later-3`受管fork，登记上游基点、Chat分支和固定发布工件；
- 上游吸收后：回到官方包并删除patch/fork依赖。

### 5.2 Chat私有增量

进入LifeOS Bridge或新的Chat自有插件。不得修改第三方包的`node_modules`，不得为了移动端
展示把Workflow、Decision等产品语义交给移动外壳。

### 5.3 DSH原生语义缺少接缝

先提出可上游的最小公开合同；Chat只维护缺失接缝的窄patch。轨迹等需要改变原生派生和
语义标签的能力不能用DOM重写冒充稳定插件API。

## 6. 人工更新流程

本阶段不配置定时任务、自动升级或自动合并。用户或Agent明确触发时执行：

```bash
pnpm dsh:plugins:list
pnpm dsh:plugins:check-updates
```

发现新版本后单独创建升级PR，并依次完成：

1. 对比上游tag、gitHead与npm tarball；更新精确版本和lock integrity。
2. 复核许可证、依赖、生命周期脚本、网络行为和能力声明。
3. 评估私有DOM、哈希CSS类和DSH版本兼容漂移。
4. 运行插件合同、真实DSH Host、手机/桌面浏览器E2E以及与Chat自有Slot的共存测试。
5. 人工确认后合入；运行中的生产profile不会自行漂移。

直接采用的插件只跟踪正式release，不持续回合上游`main`。只有存在Chat fork时，才需要将
上游tag/主线同步到独立候选分支并解决我们的未上游化提交。

## 7. 平台与恢复

- Mac和Linux从同一仓库lock安装同一插件字节；profile使用仓库相对解析结果，不依赖个人
  全局`~/.dsh`或固定绝对路径。
- macOS LaunchAgent与未来Linux supervisor是部署Adapter，不改变插件登记与版本。
- 手机只消费受管PWA；插件安装、Product Store与凭据仍由运行Host拥有。
- 插件升级失败时回退仓库提交/lock并重新运行`pnpm run setup`；不得手改`.data`中的包。

## 8. 当前登记

1. `@chat/dsh-lifeos-bridge@0.1.0`：Chat自有，承载唯一公开产品前端集成。
2. `dsh-mobile-hanui@0.2.4`：直接采用上游MIT包；没有Chat fork或二次开发；依赖DSH私有
   DOM/CSS，必须通过手机与桌面真实E2E升级。

PWA、认证和远程部署是Chat自有能力，不登记成`dsh-mobile-hanui`的一部分。
