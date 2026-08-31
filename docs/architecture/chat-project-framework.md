# Chat Project架构设计

## 1. 目的与状态

本文定义并记录Chat采用的用户级目录、Project发现、Project配置、Session分区、项目资源、信任和Memory隔离规则。它直接参考Pi现有实现，再加入Chat的Workflow、Pi Web、多工作区和长期记忆场景。所有Context、Target、Owner、Resource Address和跨Project规则以[Chat Context与Resource统一模型](./chat-context-resource-model.md)为基础。

核心目录、Registry、Context、分层配置、Session分区、Project资源加载、Memory独立Store、前端项目发现和可恢复迁移已经实现。尚未提供的可选管理接口会在对应章节明确说明，实际源码状态见[Chat当前架构](./chat-current-architecture.md)。

## 2. Pi提供的设计基线

Pi当前实现提供以下事实：

| 领域 | Pi行为 | Chat采用的原则 |
|---|---|---|
| 用户级配置 | `~/.pi/agent/settings.json` | 用户级状态不依赖某个源码仓库 |
| 项目级配置 | `<cwd>/.pi/settings.json`覆盖全局配置 | 每个Project拥有自己的声明目录并覆盖全局默认 |
| 用户级资源 | `~/.pi/agent/{skills,extensions,prompts,themes}` | 全局资源对所有可信Project可见 |
| 项目级资源 | `<cwd>/.pi/{skills,extensions,prompts,themes}` | 项目资源只对当前Project可见 |
| Session | `~/.pi/agent/sessions/<encoded-cwd>/` | Session属于用户运行数据，不写入项目仓库 |
| Session格式 | Pi `SessionManager`维护JSONL、分支、压缩和恢复 | Chat不修改Pi Session消息和树结构 |
| Project Trust | 规范化路径写入`~/.chat/agent/trust.json`；项目可执行资源在信任后加载 | 打开Project和信任Project是两个独立动作 |
| Tool | Extension通过`registerTool()`注册，SDK通过`customTools`注入 | Chat不定义第二套可执行Tool类型 |

Pi的Session目录按cwd编码，适合CLI直接进入一个目录的场景。Chat还需要处理项目简介、路径迁移、嵌套项目和浏览器项目切换，因此不能继续把绝对路径当作长期Project身份。

以上结论对应的Pi源码与文档证据：

1. [`SessionManager`与`getDefaultSessionDirPath()`](../../pi/packages/coding-agent/src/core/session-manager.ts)：Session默认进入用户级`agentDir/sessions/<encoded-cwd>`。
2. [`SettingsManager`](../../pi/packages/coding-agent/src/core/settings-manager.ts)：用户级Settings与`cwd/.pi/settings.json`按作用域加载和合并。
3. [`DefaultResourceLoader`](../../pi/packages/coding-agent/src/core/resource-loader.ts)：发现用户级、Project级和额外路径资源，最终交给Pi AgentSession。
4. [`trust-manager.ts`](../../pi/packages/coding-agent/src/core/trust-manager.ts)与[Security文档](../../pi/packages/coding-agent/docs/security.md)：按规范化目录保存Project Trust，未信任时跳过项目可执行资源。
5. [Pi Sessions文档](../../pi/packages/coding-agent/docs/sessions.md)、[Settings文档](../../pi/packages/coding-agent/docs/settings.md)、[Skills文档](../../pi/packages/coding-agent/docs/skills.md)和[Extensions文档](../../pi/packages/coding-agent/docs/extensions.md)：用户级/项目级目录和资源合同。

## 3. 核心模型

Chat新增Project平台对象，但不改变Workflow和Pi Agent的职责：

```text
Project
  ├── 稳定projectId、名称和简介
  ├── 当前机器上的规范化绝对路径
  ├── Project级Chat配置和资源
  ├── Project级Session集合
  └── Project级Memory命名空间

Session
  ├── 属于一个Project
  ├── 继续保存Pi原生JSONL
  └── 每轮可以选择不同Workflow

Workflow
  ├── 决定本轮由哪些Node和Agent执行
  └── 不拥有Project或Session
```

Project和Workflow是两个正交入口：

1. Project回答“Agent正在维护哪个项目、使用哪组项目配置和资源”。
2. Workflow回答“当前这一轮如何处理用户输入”。
3. Session回答“这段连续对话和Pi上下文是什么”。
4. Agent回答“某个Workflow Node实际使用什么模型、Tool、Skill和Prompt”。

## 4. 统一目录

### 4.1 用户级Chat Home

Chat Home默认是`~/.chat`，测试、迁移和部署可以通过`CHAT_HOME`显式覆盖。业务代码只能通过统一的`resolveChatHome()`和派生路径对象访问它，不允许继续使用`process.cwd()`推断用户级数据位置。

```text
~/.chat/
  ├── config.json                       # 用户级Workflow和Agent默认覆盖
  ├── agent/                            # Pi agentDir
  │   ├── auth.json
  │   ├── models.json
  │   ├── models-store.json
  │   ├── settings.json
  │   ├── trust.json
  │   ├── skills/
  │   ├── extensions/
  │   └── prompts/
  ├── memory/
  │   └── personal/                    # Personal Memory事实源和Mem0索引
  ├── prompt-resources/                # Personal规则与经验
  ├── projects/
      ├── registry.json                 # 本机Project登记
      ├── chat/
      │   ├── sessions/
      │   ├── memory/
      │   └── prompt-resources/
      └── ziji-content-lab/
          ├── sessions/
          ├── memory/
          └── prompt-resources/
  ├── runtime/
  │   ├── workflow-data/               # 进程级Workflow Run、Step和Event
  │   └── skills/                      # 构建资源物化结果
  ├── cache/
  │   └── fastembed/                   # 可重新下载的Embedding模型
  └── logs/
```

`~/.chat`只属于当前用户和Chat运行时，不进入任何业务项目Git仓库。

### 4.2 Project本地目录

每个由Chat维护的项目在项目根目录拥有自己的`.chat/`：

```text
<project-root>/.chat/
  ├── project.json                      # 可移植Project身份和说明
  ├── config.json                       # Project级Workflow和Agent覆盖
  ├── skills/                           # Project私有Pi Skill
  ├── extensions/                       # Project私有Pi Extension与Tool
  ├── prompts/                          # Project私有Prompt
  └── instructions/                     # Project可选择的追加规则
```

Project本地目录只保存声明和项目能力，不保存Credential、Session、Memory数据库、向量索引或Workflow运行状态。`project.json`和需要共享的配置、Skill、Extension可以由项目决定是否进入版本控制。

Chat自身也是普通Project：

```text
/Users/xulater/Code/Chat/.chat/
```

Content Lab同样是普通Project：

```text
/Users/xulater/Code/ziji/ziji-content-lab/.chat/
```

## 5. Project身份与发现

### 5.1 Project Manifest

`<project-root>/.chat/project.json`是可移植Project身份的事实源，不保存本机绝对路径和打开时间：

```json
{
  "schemaVersion": 1,
  "id": "ziji-content-lab",
  "name": "Ziji Content Lab",
  "description": "小红书和B站内容起号与持续生产项目"
}
```

规则：

1. `id`使用小写字母、数字和连字符；默认由目录名加短唯一ID生成，创建后保持稳定。
2. 项目移动或重新克隆时不修改`id`。
3. Manifest不包含Session目录、Memory目录或Credential路径。
4. 用户选择哪个目录，哪个目录就是Project根；后端不向上查找父目录Manifest，也不向下扫描子Project。
5. `A`与`A/B/C`可以各自拥有`.chat/project.json`，两者是并列、隔离的Project，不建立继承关系。

### 5.2 本机Registry

`~/.chat/projects/registry.json`保存当前机器见过的Project：

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "projectId": "ziji-content-lab",
      "cachedName": "Ziji Content Lab",
      "cachedDescription": "小红书和B站内容起号与持续生产项目",
      "path": "/Users/xulater/Code/ziji/ziji-content-lab",
      "firstOpenedAt": "2026-08-30T10:00:00.000Z",
      "lastOpenedAt": "2026-08-30T10:00:00.000Z"
    }
  ]
}
```

Manifest和Registry没有重复事实：

1. Manifest拥有Project身份、名称和简介。
2. Registry拥有本机路径和打开时间。
3. `cachedName`和`cachedDescription`只是项目暂时不可访问时的显示快照，不反向覆盖Manifest。
4. Project路径在写入前必须经过`realpath`规范化；同一路径不能属于两个不同Project。

### 5.3 打开和切换

首次打开目录：

```text
用户选择目录
  ↓
后端用realpath规范化该目录，它就是Project根
  ├── 本目录已有Manifest：校验并登记/刷新Project路径
  └── 本目录没有Manifest：直接在本目录初始化Project Manifest
  ↓
返回projectId + cwd
  ↓
前端切换Project并恢复该Project最后使用的Session
```

项目切换器必须来自`GET /api/projects`，不能继续从Session列表反推。没有Session的Project也必须可见；路径暂时不可用的Project保留登记并显示不可用状态。

### 5.4 决策场景与验证映射

| 讨论场景 | 必须行为 | 代码入口 | 测试证据 |
|---|---|---|---|
| 首次打开目录`X` | `X`成为根并创建`X/.chat/project.json` | `openProject()` | `first open initializes the selected directory...` |
| `A`已是Project，再打开`A/B/C` | `A/B/C`成为新Project，不归属`A` | `openProject()` | `the directory selected by the user is the exact Project root...` |
| 同时打开两个同名`app`目录 | 生成不同`projectId`，两者均保留 | `createProjectId()` | `first open initializes the selected directory...` |
| 重新打开或移动已有Project | 读取Manifest中原`projectId`，Session和Memory归属不变 | `openProject()` / Registry | `the same registered project survives a local path move` |
| `A`已信任，`A/B/C`是独立Project | `A/B/C`不继承`A`的Trust | `getProjectTrust()` | `nested Projects keep exact independent trust decisions` |
| Project根外有`AGENTS.md` | 不读取；只读用户级和当前Project根文件 | `loadChatAgentContextFiles()` | `Chat loads only global and the exact opened Project context` |
| 从其他Project使用文件浏览 | 只允许Registry中已打开且可用的Project，不无条件放行Chat进程cwd | `getAllowedFileRoots()` | `file access comes from registered Projects...` |
| 前端选择一个目录 | 调用`POST /api/projects/open`并完整校验返回结构 | `openChatProject()` | `opening a directory sends that exact path...` |
| 打开Chat源码目录 | 走与其他Project相同的Manifest、Registry、Session和Trust路径 | 通用Project API | `the browser has no Chat-specific Project fallback...` |

## 6. 配置分层

配置合并采用Pi“Project覆盖Global”的原则，并加入Chat源码默认和本次Run：

```text
Workflow源码内workflow.json / agent.json
  ↓
~/.chat/config.json用户级默认覆盖
  ↓
<project-root>/.chat/config.json Project级覆盖
  ↓
本次Run请求覆盖
```

用户级配置必须是完整配置；Project配置是允许省略字段的覆盖配置。一次Run在启动时解析并冻结最终结果，文件变化从下一次Run开始生效。

Project配置示例：

```json
{
  "schemaVersion": 1,
  "defaultWorkflowId": "minimal-pi-coding-agent",
  "workflows": {
    "minimal-pi-coding-agent": {
      "agents": {
        "pi-coding-agent": {
          "resources": {
            "mode": "inherit"
          }
        }
      }
    }
  }
}
```

浏览器不直接读取或解析这两份配置。后端负责合并、Schema校验、路径授权和原子写入；前端只消费API返回的安全投影。

## 7. Skill、Extension和Tool

### 7.1 三种资源作用域

```text
用户级：~/.chat/agent/{skills,extensions,prompts}
Project级：<project-root>/.chat/{skills,extensions,prompts}
Workflow Agent私有：src/workflows/<workflow>/agents/<agent>/...
```

当前cwd中的Pi原生`.pi/{skills,extensions,prompts}`和`.agents/skills`仍可由Pi发现，用于兼容同一项目直接通过Pi CLI工作。它们与Chat Project`.chat`资源都属于当前Project可见来源，但前端必须保留真实来源标记，不能合并成无法追踪的单一列表。

Agent的资源策略继续使用现有语义：

1. `inherit`：继承可信用户级资源、当前Project资源和Pi默认资源。
2. `explicit`：只加载Agent配置明确声明的资源和Workflow运行时注入能力。
3. Workflow私有资源不能因为复用方便复制到用户级或Project级目录。

### 7.2 保持Pi执行模型

Chat可以发现固定的`.chat/skills`、`.chat/extensions`和`.chat/prompts`目录，但不能直接执行这些文件：

1. Skill必须是符合Pi/Agent Skills格式的真实`SKILL.md`。
2. Extension必须交给Pi Extension Loader，并通过`registerTool()`注册Tool。
3. 依赖Chat领域服务的Tool继续通过Pi SDK `customTools`注入。
4. 前端从真实`ResourceLoader`和`AgentSession`读取`sourceInfo`、全部Tool和活动Tool，不根据目录猜测。

第一阶段可以把可信Project目录作为Pi `additionalSkillPaths`、`additionalExtensionPaths`和Prompt路径传入。若后续需要完整复用Pi的Project Settings与PackageManager语义，应优先在Pi SDK增加通用的`projectConfigDir`装配能力，不能在Chat复制一套Pi Settings或Package安装器。

### 7.3 Project Trust

Project已打开不等于Project可执行。参考Pi，以下内容存在时必须经过Project Trust：

```text
.chat/config.json
.chat/extensions/
.chat/skills/
.chat/prompts/
```

规则：

1. 信任决定按规范化Project根路径保存到`~/.chat/agent/trust.json`。
2. Chat只接受当前Project根路径上的精确决定；目录嵌套的其他Project不继承父目录Trust。
3. 未信任时仍可读取安全的Project Manifest和Project根目录的`AGENTS.md`，但不能加载Project Extension或会改变Agent能力的配置。
4. Extension与项目Tool以当前Chat进程的用户权限执行；Project Trust不是沙箱。
5. Pi Web必须在首次需要加载受保护资源前明确展示信任选择，不能把“出现在项目列表”当成自动信任。

## 8. Session分区

Chat继续使用Pi `SessionManager`和JSONL格式，只改变传入的`sessionDir`：

```text
~/.chat/projects/<projectId>/sessions/*.jsonl
```

规则：

1. Session目录由服务端`ProjectContext`解析，浏览器只能提交Session ID。
2. Run请求携带`projectId + cwd`，后端必须验证二者来自同一Registry记录。
3. Session头继续保存实际cwd；Project身份由受控目录与Registry提供，不修改Pi Session Header Schema。
4. Session不能跨Project直接继续；需要复用历史时使用Pi fork/clone语义创建目标Project的新Session。
5. Project路径变化只更新Registry路径，不改变`projectId`或Session目录。

Pi按cwd编码Session目录；Chat使用稳定Project ID替代路径编码，是为了满足浏览器项目管理和路径迁移，不改变Pi的Session生命周期。未来确有多个worktree需求时，只扩展Registry路径映射，不提前增加运行数据目录层级。

## 9. Memory命名空间

Memory私有数据仍只位于Chat Home，但Personal和每个Project使用独立事实库与Mem0索引：

```text
~/.chat/memory/personal/{catalog.db,vector-store.db}
~/.chat/projects/chat/memory/{catalog.db,vector-store.db}
~/.chat/projects/ziji-content-lab/memory/{catalog.db,vector-store.db}
```

规则：

1. `MemoryStoreManager`按Target解析Personal或Project Store，不从cwd推导数据库路径。
2. 默认搜索Personal与当前Project；显式请求可以搜索任意已登记Project集合。
3. 默认新增到当前Project；用户可以明确新增到Personal、当前Project、其他Project或多个Target。
4. 正常Agent不能自行伪造Project身份；Target Project必须由Registry解析，跨Project操作保留Source Context。
5. Memory管理页可以选择Personal或任意已登记Project，并显示记录真实Owner和来源。
6. 项目移动或源码暂时不可用不影响Memory；单个Project索引可以独立重建、备份和删除。
7. 每个Store的Chat Catalog是事实源，Mem0只作为该Store可重建的语义索引。

## 10. 后端合同

Project基础接口：

```text
GET   /api/projects
POST  /api/projects/open
GET   /api/projects/:projectId
POST  /api/projects/:projectId/trust
GET   /api/chat-config?projectId=<id>
PUT   /api/chat-config?scope=project&projectId=<id>
GET   /api/sessions?projectId=<id>
```

Run请求增加稳定身份：

```json
{
  "projectId": "ziji-content-lab",
  "cwd": "/Users/xulater/Code/ziji/ziji-content-lab",
  "workflow": "minimal-pi-coding-agent",
  "prompt": "继续维护Content Lab"
}
```

所有依赖项目的后端路径都先解析同一个`ChatProjectContext`：

```ts
interface ChatProjectContext {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly projectConfigDir: string;
  readonly projectDataDir: string;
  readonly sessionDir: string;
  readonly memoryDir: string;
  readonly promptResourceDir: string;
}
```

Session、Workflow、Agent Resolve、资源Catalog、文件访问和Memory Tool不能各自重新从cwd推导Project身份。

## 11. Pi Web交互

前端交互顺序：

1. 启动时读取`GET /api/projects`，展示已登记Project，不依赖Session存在。
2. 选择Project后恢复该Project最后使用的Session；没有Session时展示空白新会话。
3. 选择目录走`POST /api/projects/open`，由后端把该精确目录登记或初始化为Project并做安全校验。
4. Workflow和Agent配置页面同时显示用户级默认、Project覆盖和本轮临时选择的来源。
5. Skill、Extension和Tool显示`user / project / workflow / runtime`来源及“已发现/已启用/本轮活动”状态。
6. 切换Project时，文件浏览器、Session列表、Workflow Resolve、Memory筛选和运行请求一起切换到新的`ProjectContext`。

前端不能维护Project白名单或针对`ziji-content-lab`增加专用分支。新增符合Manifest规则的Project不修改前端代码。

## 12. Content Lab对接实例

Content Lab的项目根是：

```text
/Users/xulater/Code/ziji/ziji-content-lab
```

用户明确打开该目录时，它自身就是Project根；外层`ziji` Git仓库不参与身份判定：

```text
/Users/xulater/Code/ziji/ziji-content-lab/.chat/project.json
  id = ziji-content-lab
```

对接完成后的预期行为：

1. 在Pi Web打开该目录时，Chat登记或恢复`ziji-content-lab` Project。
2. Agent实际cwd仍是外部项目目录，源码不移动到Chat仓库。
3. 项目`AGENTS.md`继续进入Pi标准项目上下文区域，但Chat只读取`ziji-content-lab/AGENTS.md`，不继承外层`ziji`仓库或其他父目录文件。
4. Content Lab的Project Skill、Extension、Prompt和Workflow/Agent覆盖不影响Chat Project。
5. Session保存到`~/.chat/projects/ziji-content-lab/sessions`。
6. Memory Agent默认看到Personal与`ziji-content-lab`记忆，也可以按用户明确目标访问其他已登记Project。

## 13. 迁移实现

当前迁移由`migrateLegacyProjectLayout()`执行，写入`~/.chat/migrations/project-layout-v1/<projectId>.json`标记；它可恢复、可重试且不删除旧目录：

1. 引入`resolveChatHome()`、Project Manifest/Registry Schema和`ChatProjectContext`，先增加测试。
2. 创建`chat`与`ziji-content-lab` Manifest并登记Project路径。
3. 复制当前Chat项目`.chat/agent`到`~/.chat/agent`；旧Memory Catalog按记录Target导入新Store，不复制旧向量索引；旧`.workflow-data`归入`~/.chat/runtime/workflow-data`。
4. 把当前Chat Session复制到`~/.chat/projects/chat/sessions`并验证Session ID、cwd、消息数和恢复结果。
5. 把旧版Global Memory迁移到Personal Store，把cwd Project Memory映射到对应Project Store；新索引从各自Catalog修复或重建。
6. 后端Run、Session、Resource、File和Memory入口统一改用`ChatProjectContext`。
7. 前端项目列表改为Registry API，完成切换与不可用状态交互。
8. 完整验证后保留一次明确的旧目录归档或迁移标记；不长期维护两套读写事实源。

## 14. 验收标准

1. `ziji-content-lab`源码保持在原目录，Chat不复制项目源码。
2. 新Project即使没有Session，也能在重启后自动出现在Pi Web项目列表。
3. Chat与Content Lab拥有独立Project配置、资源、Session和Project Memory。
4. 个人Skill、Tool和Memory按规则对两个Project可见。
5. 未信任Project不会执行`.chat/extensions`或应用受保护配置。
6. Project路径迁移后，原Session与Memory仍由稳定`projectId`关联。
7. Content Lab不会因为上层Git根目录是`ziji`而与其他子项目混为一个Project。
8. 前端不硬编码Project ID；新增Project不修改前端。
9. Pi Session树、分支、压缩、恢复和Tool执行语义保持不变。
10. 迁移前现有Chat Session与Memory原文均可完整恢复。

## 15. 明确不做

1. 不把业务项目移动到Chat仓库。
2. 不把Session、Credential、Memory数据库或索引写进业务项目`.chat`。
3. 不用绝对路径作为长期Project ID。
4. 不从Session列表反推Project Registry。
5. 不为Project复制Pi Agent Runtime、Tool类型、Skill格式或PackageManager。
6. 不把Project Trust描述成进程沙箱。
