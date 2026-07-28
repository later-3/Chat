# LifeOS 解剖手册:一次输入到底怎么走完的

> 状态:**基于固定提交源码的运行机制逆向,不是产品介绍**
>
> 源码固定点:`danielmiessler/LifeOS@d1d6240ce884dd70f5fc8333279ee6bbc21b96b1`
>
> 本地只读检出:`/Users/xulater/Code/Chat/ref/LifeOS`
>
> 本文回答唯一一个问题:**假设用户在 Claude Code 里敲下一行字,从这行字到模型回复、到状态落盘,中间到底发生了什么、读了哪些文件、写了哪些文件、hook 和 skill 在哪里起作用**。每一步都附代码路径。

## 0. 先建立最关键的一个认知

**LifeOS 不是独立 App,它寄生在 Claude Code 上。** Claude Code 提供宿主能力:Session、Transcript、Tool 执行、Hook 事件分发、`settings.json` 权限。LifeOS 做的全部事情就是往这 5 个宿主能力里"塞料":

1. 往 **Session 启动**里塞 system prompt(Constitution)+ CLAUDE.md 的 `@import`。
2. 往 **Hook 事件**里塞 45 条 hook(读文件、算确定性逻辑、注入上下文或阻断)。
3. 往 **Tool 执行**里塞宽权限(`settings.json` 的 `auto` 模式让模型自动读写 `~/.claude/`)。
4. 往 **Transcript** 里塞格式约定(banner、🧠 MEMORY 行、🗣️ closer),hook 再回头解析这些格式。
5. 往 **文件系统**里塞状态(Markdown 协议 + JSON/JSONL 状态)。

所以理解 LifeOS 的唯一正确顺序是:**先看安装后 `~/.claude/` 长什么样,再看 Claude Code 的 11 类事件分别被塞了什么,最后跟着一次真实输入走完**。本文就按这个顺序写。

## 1. 安装后 `~/.claude/` 的完整目录结构

安装(`DeployCore` + `ScaffoldUser` + `LinkUser` + `InstallSettings` + `InstallHooks`)跑完后,`~/.claude/` 长这样。每一行的"谁写/谁读"是后续理解数据流的关键。

```
~/.claude/
├── settings.json              # InstallSettings 写入。权限模型 + hooks 注册表 + env + autoMode 规则
│                              #   读:Claude Code 启动时(权限/hook 接线)、各 hook(读 dynamicContext 等)
├── CLAUDE.md                  # ActivateImports 取消注释 @import 行。Claude Code 原生加载
├── LIFEOS_SYSTEM_PROMPT.md    # Constitution。仅 lifeos launcher 通过 --append-system-prompt-file 注入
├── package.json + node_modules/ # DeployCore 复制 + bun install。hook 脚本依赖 yaml 等包
├── .env                       # ElevenLabs/Telegram 等 key。settings.json 的 ask 规则要求读写时确认
│
├── hooks/                     # InstallHooks 复制的 72 个文件
│   ├── hooks.json             # 注册表副本(InstallHooks 合并进 settings.json 的源)
│   ├── *.hook.ts              # 38 个 hook 入口 + 1 个 .hook.sh
│   ├── lib/                   # 24 个共享逻辑(isa-utils、hook-io、identity、paths、transcript-evidence...)
│   └── handlers/              # 7 个子处理(DocCrossRefIntegrity、MemoryDirIntegrity...)
│
├── skills/                    # DeployCore 复制的 52 个 skill
│   ├── Research/SKILL.md      #   每个 skill 有 frontmatter(name/version/description/USE WHEN)
│   ├── ISA/SKILL.md           #   description 里的 USE WHEN 短语被 AlgorithmNudge 建索引
│   ├── Telos/SKILL.md         #   Workflows/ 子目录放可执行流程脚本
│   └── ...                    #   _ALLCAPS 的 skill(_LIFEOS/_ULWORK)在 release 时被 strip,公开版没有
│
├── LIFEOS/                    # DeployCore 复制的运行时(install/LIFEOS/*)
│   ├── ALGORITHM/             # Algorithm 规范
│   │   ├── LATEST             #   内容就一行:8.4.0。system prompt 让模型先读它拿版本号
│   │   ├── v8.4.0.md          #   Algorithm 完整规范(15 条 "run complete when")
│   │   └── modes/             #   ideate/optimize loop 规范
│   ├── RULES/                 # Philosophy/VerificationExpanded/SelfHealing 等扩展规则
│   ├── TOOLS/                 # 131 个 TypeScript 工具(algorithm/Memory*/ComputeGap/Pulse...)
│   ├── PULSE/                 # Pulse daemon 源码(见 §9)
│   ├── DOCUMENTATION/         # 作者文档(本文不当事实来源,只当"宣称什么")
│   ├── USER_TEMPLATES/        # ScaffoldUser 用的模板源
│   │
│   ├── USER/ -> ~/.config/LIFEOS/USER  # symlink!LinkUser 建的 system/user 分离
│   │   ├── PRINCIPAL/
│   │   │   ├── PRINCIPAL_IDENTITY.md    # 身份。@import 进 CLAUDE.md。proposal target_kind=identity
│   │   │   ├── PRINCIPAL_MEMORY.md     # 热层记忆,always 加载。MemorySystem set-overwrite 写
│   │   │   ├── WRITINGSTYLE.md         # proposal target_kind=style
│   │   │   └── RESUME.md               # proposal target_kind=resume
│   │   ├── DIGITAL_ASSISTANT/
│   │   │   ├── DA_IDENTITY.md          # DA 身份(名字/声音/关系)
│   │   │   └── DA_MEMORY.md            # DA 热层记忆
│   │   ├── TELOS/
│   │   │   ├── TELOS.md                 # 单一真相源
│   │   │   ├── PRINCIPAL_TELOS.md       # @import。GenerateTelosSummary 生成
│   │   │   ├── IDEAL_STATE/{HEALTH,MONEY,FREEDOM,CREATIVE,...}.md  # ComputeGap 数 TBD
│   │   │   ├── CURRENT_STATE/{...}.md   # UpdateLifeosState 读 status:have|partial|missing
│   │   │   ├── LIFEOS_STATE.json       # UpdateLifeosState 写。Pulse TELOS rings + statusline 读
│   │   │   ├── HEALTH/ FINANCES/       # 真实数据(可选)
│   │   │   └── ...
│   │   ├── PROJECTS.md                  # @import。proposal target_kind=projects
│   │   ├── CONTACTS.md                  # proposal target_kind=contacts
│   │   ├── DEFINITIONS.md               # proposal target_kind=definition
│   │   ├── CANONICAL_CONTENT.md         # proposal target_kind=canonical-content
│   │   └── CONFIG/
│   │       ├── OPERATIONAL_RULES.md     # @import。proposal target_kind=operational-rule
│   │       ├── memory-review.json       # MemoryReviewer 读 confidence_threshold(默认0.70)
│   │       └── settings.user.json       # MergeSettings 合并 system+user
│   │
│   └── MEMORY/                # DeployCore scaffold 的 6 个空状态目录(per-install 状态,不随 release)
│       ├── WORK/{YYYYMMDD-HHMMSS_slug}/  # 每次任务一个目录
│       │   └── ISA.md                    # Algorithm 的 ISA(见 §8)
│       ├── KNOWLEDGE/
│       │   ├── People/{slug}.md          # knowledge type,entity_type=person
│       │   ├── Companies/{slug}.md      # entity_type=company
│       │   ├── Research/{slug}.md       # entity_type=research
│       │   └── Ideas/{slug}.md          # idea type
│       ├── LEARNING/
│       │   ├── REFLECTIONS/algorithm-reflections.jsonl  # Algorithm claim 12 反思记录
│       │   └── (wisdom frames,LoadContext 读)
│       ├── STATE/
│       │   ├── work.json                # ★ ISA 注册表!ISASync 写,所有 hook 读(见 §8)
│       │   ├── session-names.json        # PromptProcessing 写(session 名)
│       │   ├── algorithms/{id}.json      # loop mode 状态
│       │   ├── isa-nudge/{session_id}.json       # AlgorithmNudge 的计数状态
│       │   ├── memory-inject/{session_id}.json   # MemoryTurnStart 的注入门控(hash+turns)
│       │   ├── isa-render-debounce/{session_id}.json  # ISASync 记录本回合编辑了哪些 ISA
│       │   ├── verification-gate-blocked.json    # VerificationGate 的 fingerprint 去重
│       │   ├── capabilities.json                # Doctor 写,AlgorithmNudge 读(broken/declined/live)
│       │   ├── skill-usewhen-index.json         # AlgorithmNudge 建的 skill USE WHEN 索引
│       │   └── progress/{project}-progress.json  # LoadContext 读的持久项目进度
│       ├── OBSERVABILITY/
│       │   ├── review-state.json          # MemoryReviewFire 写的 cadence 状态
│       │   ├── reviewer-fires.jsonl        # MemoryReviewFire 触发日志
│       │   ├── pending-proposals.jsonl     # ★ proposal 队列!MemorySystem.add enqueue
│       │   ├── tier-b-writes.jsonl         # Tier B 写审计
│       │   ├── verification-gate.jsonl     # VerificationGate 决策日志
│       │   ├── gap-history.jsonl           # ComputeGap --log 写的趋势
│       │   └── algo-nudge-routing.jsonl    # AlgorithmNudge skill-routing 触发遥测
│       └── SKILLS/                         # skill 运行时状态
│
└── projects/{session-hash}/
    └── *.jsonl                # ★ Claude Code 原生 transcript!hook 用 TranscriptParser 解析它
```

**三个要点**:

1. **`LIFEOS/USER` 是 symlink**,指向 `~/.config/LIFEOS/USER`。系统文件(release 可覆盖)和用户数据(永久保留)靠这个 symlink 分离。所有"身份/记忆/TELOS"都在 USER 下。
2. **状态不在数据库,散落在几十个文件里**。`work.json` 是最关键的--它是 ISA 注册表,几乎所有 hook 都读它判断"当前有没有活动 run"。
3. **`~/.claude/projects/{hash}/*.jsonl` 不是 LifeOS 建的**,是 Claude Code 原生的 transcript。LifeOS 的 hook 通过 `transcript_path` 字段拿到它,用 `TranscriptParser` 解析。这是 LifeOS "读模型做过什么"的唯一途径。

## 2. 模型上下文到底由哪四层组成

模型每轮收到的上下文是**四层叠加**,理解这四层就理解了"LifeOS 怎么让模型按协议行事":

| 层 | 来源 | 内容 | 谁控制 |
|---|---|---|---|
| ① system prompt | `lifeos` launcher 用 `--append-system-prompt-file` 注入 `LIFEOS_SYSTEM_PROMPT.md` | Constitution:输出格式、验证、安全、5 条 CONSTITUTIONAL | 一次性,启动时固定 |
| ② CLAUDE.md + `@import` | Claude Code 原生加载 `~/.claude/CLAUDE.md`,解析其中的 `@path` 行 | `ARCHITECTURE_SUMMARY.md` + 被 ActivateImports 取消注释的身份文件(PRINCIPAL_TELOS/PRINCIPAL_IDENTITY/DA_IDENTITY/PROJECTS/OPERATIONAL_RULES) | 启动时固定,但 `@import` 行可被 hook 改 |
| ③ `<system-reminder>` | `LoadContext.hook.ts`(SessionStart)输出到 stdout | 关系笔记 + wisdom frames + 活动工作摘要 | 每次开 session 动态生成 |
| ④ `additionalContext` | 各 hook 通过 `hookSpecificOutput.additionalContext` 返回 | AlgorithmNudge 建议行、MemoryTurnStart 的 `<pai-memory>` 块、各种 nudge | 每轮按事件动态注入 |

**关键**:①② 是"静态"层,③④ 是"动态"层。LifeOS 的"产品逻辑"大部分在 ④ 里--它是唯一能在每轮运行时根据当前状态变化的层。这就是为什么 72 个 hook 文件是核心:它们决定了"这一轮模型额外看到什么"。

`settings.json` 的 `postCompactRestore.fullFiles: ["USER/PROJECTS.md"]` 表示 compaction 后会把 PROJECTS.md 重新塞回(因为 compaction 会清掉 ③④)。

## 3. Claude Code transcript:LifeOS 的"眼睛"

LifeOS 自己不记录模型做了什么,它完全靠 Claude Code 原生的 transcript。`TranscriptParser.ts` 揭示了它的格式:

```
~/.claude/projects/{session-hash}/{uuid}.jsonl
```

**每行一个 JSON entry**,结构:

```jsonl
{"type":"human","message":{"content":"用户输入的文本"}}      // 真实用户消息
{"type":"assistant","message":{"content":[{"type":"text","text":"模型回复"},{"type":"tool_use","name":"Write","input":{...}}]}}  // 模型输出(可含 tool call)
{"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}  // tool 结果(Claude Code 用 user 类型包装)
```

`TranscriptParser.collectCurrentResponseText` 的关键逻辑:**找最后一个真实用户消息(有 text block 的 `type:human`,不是 `tool_result`),收集之后所有 assistant 文本**。这防止 Stop hook 把上一轮的陈旧行抓进来。

hook 拿到 transcript 后能提取:
- `lastMessage`:最后一条 assistant 消息(VerificationGate 用它检测 claim)。
- `currentResponseText`:本回合所有 assistant 文本(VoiceCompletion 提取 `🗣️` 行)。
- `responseState`:检测 `AskUserQuestion` tool_use -> `awaitingInput`(给 tab 染色)。
- `transcript-evidence.ts`:解析 tool 事件(hadDeploy/hadCodeEdit/hadFrontendEdit/flowExercised/pixelViewed/testPassedAfterEdit),VerificationGate 用它判"本回合真的做了变更吗"。

**这就是 VerificationGate 的核心机制**:它不读模型自评的文字(模型可以说"已验证"),它读 transcript 里真实的 tool 调用序列。模型说过什么不算,做过什么才算。

## 4. 11 类 Hook 事件:分别在什么时候、读什么、写什么、返回什么

这是 LifeOS 的"神经"。`hooks.json` 注册了 11 类 Claude Code 事件。下表是每一类的完整接线(全部 45 条):

### 4.1 SessionStart(开新 session 或 compaction 后)

| hook | 读 | 写 | 返回 |
|---|---|---|---|
| `HookHealer` | settings.json | 自愈 hook 注册 | 无(detached,10s) |
| `KittyEnvPersist` | tab 状态 | tab 颜色 | 副作用 |
| `LoadContext` | MEMORY/RELATIONSHIP + MEMORY/LEARNING + MEMORY/WORK + settings.json | recordSessionStart | **`<system-reminder>` 注入**③ |
| `FreshnessCache` | 文件 freshness | 缓存 | 无(detached) |
| `MergeSettings` | settings.system.json + settings.user.json | settings.json 合并 | 无(detached,15s) |

### 4.2 UserPromptSubmit(用户每次发消息)

| hook | 读 | 写 | 返回 |
|---|---|---|---|
| `PromptProcessing` | stdin prompt + session_names.json | session-names.json + tab | 副作用(用 Haiku 推理起 session 名,**不注入模型**) |
| `SatisfactionCapture` | stdin | 满意度采样 | 副作用(detached,20s) |
| `ReminderRouter` | 提醒配置 | 路由提醒 | additionalContext(detached,5s) |
| `MemoryTurnStart` | PRINCIPAL_MEMORY.md + DA_MEMORY.md 的 hash | memory-inject/{sid}.json | **`<pai-memory>` 块(有 hash 门控)+ `<pai-memory-delta>` 行**④ |
| `AlgorithmNudge`(UserPromptSubmit 分支) | skill-usewhen-index.json + work.json | isa-nudge/{sid}.json | **skill-routing 建议 + depth directive**④ |

**MemoryTurnStart 的 hash 门控**(关键省 token 设计):`<pai-memory>` 块约 1.5K tokens,每轮注入会重复几十次。所以它只在三种情况注入:session 首 prompt、memory 文件内容变了(SHA256 hash 变)、或距上次注入已 20 轮(`REFRESH_TURNS`)。`🧠` delta 行每轮都注入。

### 4.3 PreToolUse(模型要调 tool 前)

| matcher | hook | 作用 |
|---|---|---|
| `Bash` | `ContextReduction.hook.sh` | 上下文缩减 |
| `Skill` | HTTP -> `localhost:31337/hooks/skill-guard` | Pulse 校验 skill(Pulse 必须在跑) |
| `Agent` | HTTP -> `agent-guard` + `AgentInvocation.hook.ts` | Pulse 校验 + 记录 agent 调用 |
| `AskUserQuestion` | `TabState.hook.ts` | tab 状态 |
| `Bash\|Write\|Edit\|MultiEdit` | `PreToolGuard.hook.ts` | 路径守卫(防写到禁区) |

### 4.4 PostToolUse(tool 执行完)

| matcher | hook | 读 | 写 | 返回 |
|---|---|---|---|---|
| `Agent` | `AgentInvocation` | - | agent 调用记录 | 副作用 |
| `WebFetch`/`WebSearch` | `Safety` | URL/查询 | 安全日志 | 安全检查(timeout 5s) |
| `Write`/`Edit`/`MultiEdit` | `ISASync` | **MEMORY/WORK/*/ISA.md 的 frontmatter** | **work.json + phase tab** | `continue:true` |
| `Write`/`Edit`/`MultiEdit` | `CheckpointPerISC` | ISA checkbox | **git commit**(显式 allowlist,默认空) | `continue:true`(timeout 30s) |
| `AskUserQuestion` | `TabState` | tab | tab | - |
| (所有) | `EventLogger` | stdin | OBSERVABILITY 事件日志 | `async:true`(不阻塞) |

**ISASync 的触发条件**:文件路径必须含 `MEMORY/WORK/` 且以 `ISA.md`(或 legacy `PRD.md`)结尾。它读 frontmatter,调 `syncToWorkJson` 更新 `work.json` 的 `sessions[slug]`。这是"ISA 编辑 -> Pulse 可见"的桥。

### 4.5 PostToolUseFailure(tool 失败)

| hook | 读 | 返回 |
|---|---|---|
| `EventLogger` | stdin | 事件日志 |
| `AlgorithmNudge` | work.json(活动 phase)+ capabilities.json | **probe-fail nudge**(execute/verify phase 时)或 **capability nudge**(Doctor 标 broken 时) |

### 4.6 Stop(模型结束回复)

| hook | 读 | 写 | 返回 |
|---|---|---|---|
| `LastResponseCache` | transcript | 缓存最后回复 | 副作用 |
| `TabState` | tab | tab | - |
| `VoiceCompletion` | transcript(🗣️ 行) | 语音通知(curl 31337/notify) | 副作用 |
| `ISARenderOnStop` | isa-render-debounce/{sid}.json | ISA.html(若本回合编辑过) | 副作用 |
| `StopGates` | - | - | 可能 block |
| `VerificationGate` | **transcript 的 tool 事件 + last_assistant_message** | **verification-gate-blocked.json + .jsonl** | **`decision:block`(T1/T2/T3)** 或 pass |
| `MemoryReviewFire` | review-state.json + memory-review.json | review-state.json + reviewer-fires.jsonl | **spawn MemoryReviewer.ts detached** |

### 4.7 其他事件

- **SessionEnd**:`WorkCompletionLearning`、`SessionCleanup`、`UpdateCounts`、`MemoryHealthGate`、`DocIntegrity`、`IntegrityCheck`--全是清理和健康检查。
- **TaskCreated**:`TaskGovernance`。
- **ConfigChange**:`EventLogger`。
- **PermissionRequest**:`Safety` 检查 Write/Edit/Bash 和 mcp。

## 5. 一次完整输入的端到端追踪

把上面拼起来。假设用户已安装 LifeOS,在终端开了一个新 `claude` session,输入:`帮我研究一下 BM25 检索的优化方法,然后写个最小实现`。

### 步骤 1:SessionStart(Claude Code 启动)

1. `lifeos` launcher 用 `--append-system-prompt-file` 把 `LIFEOS_SYSTEM_PROMPT.md` 注入为 system prompt(层①)。
2. Claude Code 原生加载 `CLAUDE.md`,解析 `@import`,把 `ARCHITECTURE_SUMMARY.md` 和被 ActivateImports 取消注释的身份文件塞进上下文(层②)。
3. Claude Code 触发 `SessionStart` 事件,5 个 hook 跑:
   - `HookHealer` 自愈(detached)。
   - `KittyEnvPersist` 设 tab。
   - **`LoadContext`** 读 `MEMORY/RELATIONSHIP/{月}/{日}.md`(今天+昨天)、`MEMORY/LEARNING` 的 wisdom frames、`MEMORY/WORK/` 最近 48h 的目录(读每个 ISA.md frontmatter 的 status/title)、`MEMORY/STATE/progress/*.json`。组装成 `<system-reminder>` 输出到 stdout(层③)。
   - `FreshnessCache`、`MergeSettings`(detached)。

**此刻模型上下文** = ① Constitution + ② CLAUDE.md @import + ③ LoadContext 的 system-reminder。还没有用户输入。

### 步骤 2:UserPromptSubmit(用户敲下那行字)

Claude Code 把 prompt 通过 stdin 传给 4 个 hook(并行):

1. `PromptProcessing`:用 Haiku 推理起个 session 名(如"BM25 优化研究"),写 `session-names.json`,设 tab。**不注入模型上下文**。
2. `SatisfactionCapture`:采样满意度(detached)。
3. `ReminderRouter`:检查有没有到期的提醒要注入(detached)。
4. **`MemoryTurnStart`**:算 `PRINCIPAL_MEMORY.md` + `DA_MEMORY.md` 的 SHA256。这是 session 首 prompt,hash 状态为空 -> 注入 `<pai-memory>` 块(热层记忆)。再调 `MemoryDeltaSurface` 注入 `<pai-memory-delta>` 行(本回合没有新 delta,空)。输出到 stdout(层④的一部分)。
5. **`AlgorithmNudge`**(UserPromptSubmit 分支):prompt 含 "研究" -> 匹配 `skills/Research/SKILL.md` 的 USE WHEN "research,do research,deep investigation"。但这个 session 还没注册 Algorithm run(`work.json` 里没有匹配 sessionUUID 的记录),所以走 ALWAYS-ON 分支:注入 skill-routing 建议 `🧭 ALGO-NUDGE: This prompt matches USE WHEN of: Research - if the work lands there, invoke the skill rather than handrolling.`。同时检测 depth directive("研究一下"不算),不触发。

**此刻模型上下文** = ① + ② + ③ + ④(skill-routing 建议 + `<pai-memory>` 块)。

### 步骤 3:模型决策与 Tool 调用

模型看到上下文,决定:这是个研究任务,Research skill 匹配。模型调 `Skill("Research", ...)`。

Claude Code 触发 `PreToolUse` matcher=`Skill`:
- HTTP hook -> `localhost:31337/hooks/skill-guard`(Pulse 校验 skill 是否存在/允许)。**如果 Pulse 没跑,这条 hook 失败,fail-open 放行**。
- `AgentInvocation` 记录。

模型执行 Research skill(内部可能 spawn 多个 Agent 做 web 搜索)。每个 Agent 调用触发 `PreToolUse` matcher=`Agent` -> `agent-guard` + `AgentInvocation`。每个 WebFetch/WebSearch 触发 `PostToolUse` -> `Safety` 检查 URL。

### 步骤 4:模型决定跑 Algorithm(写 ISA)

模型按 Constitution 的 "First action for such work: Read ALGORITHM/LATEST" 读 `LIFEOS/ALGORITHM/LATEST`(内容 `8.4.0`),再读 `v8.4.0.md`。然后调 `algorithm new -t "BM25 优化研究" -e standard` 创建 ISA。

`algorithm.ts` 的 `curateTitle` 去掉填充词,生成 slug,`generateISATemplate` 写 `MEMORY/WORK/{YYYYMMDD-HHMMSS_slug}/ISA.md`,frontmatter 含 `phase:observe`、`progress:0/8`、`mode:interactive`。

模型接着 Write 这个 ISA.md。Claude Code 触发 `PostToolUse` matcher=`Write`,路径含 `MEMORY/WORK/` 且以 `ISA.md` 结尾:
- **`ISASync`**:读 frontmatter,调 `syncToWorkJson(fm, isaPath, content, sessionId)` 把 `sessions[slug] = {phase, sessionUUID, progress, currentMode:'algorithm', ...}` 写进 `work.json`。phase 从空变成 `OBSERVE`,调 `setPhaseTab` 给 tab 染色。
- **`CheckpointPerISC`**:默认 git allowlist 为空,不 commit。

**此刻 `work.json` 有了这个 run 的记录**。后续所有 hook 都能通过 `sessionUUID` 判断"这是活动 Algorithm run"。

### 步骤 5:模型执行(写代码、跑测试)

模型 Write 一个 `bm25.ts`。Claude Code 触发 `PostToolUse` matcher=`Write`,但路径不含 `MEMORY/WORK/ISA.md`,所以 ISASync 不触发,只有 `EventLogger` 记一笔(async)。

模型 Bash 跑 `bun test`。`PreToolUse` matcher=`Bash` -> `ContextReduction`。测试失败 -> `PostToolUseFailure`:
- `AlgorithmNudge`:active phase 是 `execute` -> 注入 `🧭 ALGO-NUDGE: That failure - was it a claim probe? If so: claim wrong or code wrong? A wrong claim means update the ISA`。

模型修复,Edit ISA.md 勾掉一个 ISC(`- [ ]` -> `- [x]`):
- `ISASync` 同步 work.json,`progress` 更新。
- `CheckpointPerISC`:如果该 ISC 在 git allowlist,自动 commit。
- `AlgorithmNudge` claim-close 分支:检测到 `Edit` 的 old_string/new_string 里 `[x]` 数量增加 -> 注入 `🧭 ALGO-NUDGE: A claim just closed. Did closing it reveal a neighbor...`。

### 步骤 6:Stop(模型回复完成)

模型输出最终回复,带 banner `════ LifeOS ════`、`🔧 CHANGE`、`✅ VERIFY`、`🧠 MEMORY:`(逐字 echo hook 注入的 delta 行)、`🗣️ <DA>:` closer。

Claude Code 触发 `Stop`,6 个 hook 跑:

1. `LastResponseCache`:缓存回复。
2. `TabState`:tab 状态。
3. `VoiceCompletion`:从 transcript 提取 `🗣️` 行,curl `localhost:31337/notify` 发语音。
4. `ISARenderOnStop`:检查 `isa-render-debounce/{sid}.json`,本回合编辑过 ISA -> spawn `ISARender.ts` 生成 `ISA.html`。
5. **`VerificationGate`**:这是关键门。
   - 读 `last_assistant_message`(模型的 ✅ VERIFY 部分)。
   - `classifyClaim` 检测有没有 T1/T2/T3/T4 claim。假设模型写了 "tests pass" -> T4(log-only,不 block)。假设没写 "site is live" -> 无 T1。
   - 如果模型写了 "the implementation works" 且 transcript 里没 `testPassedAfterEdit` -> 可能 T4,只记日志。
   - 假设模型写了 "deployed to production" 但 transcript 没 `probedAfterDeploy` -> **T1,`decision:block`**。Claude Code 把 block reason 返回模型,模型必须重新处理(去验证或诚实降级)。
6. **`MemoryReviewFire`**:`review-state.json` 的 `turn_count_since_last_review += 1`。如果 >=8 且距上次 review >=30min -> spawn `MemoryReviewer.ts review --turns N`(detached,删 API key)。

### 步骤 7:MemoryReviewer 后台跑(detached)

`MemoryReviewer.ts` 读最近 N 轮 transcript,用模型推理提取 typed items(memory/idea/knowledge/proposal)。然后 `dispatchItems`:

- 对每个 item,`MemorySystem.add(item)`:
  - `resolveStoragePath` 算目标文件。
  - `getTier(path)` 分类器验证(MutationTier)。若 tier 不匹配 -> `ETIER_MISMATCH` 拒绝。
  - memory -> `addMemoryItem`(set-overwrite,替换整个 `PRINCIPAL_MEMORY.md`)。
  - idea/knowledge -> `addNoteTypeItem`(append 到对应 .md)。
  - proposal -> `enqueueProposal`(写 `pending-proposals.jsonl`)。若 `confidence >= 0.70`(从 `memory-review.json` 读)-> **`applyProposalEdit(target_file, edit)` 直接编辑 Tier C 文件**(身份/风格/规则/项目/联系人),标 `auto-applied`。

**这就是"自动记忆"的完整路径**:Stop 触发 -> 后台 reviewer 读 transcript -> 模型推理提取 -> dispatch -> 写文件。全程用户看不见,直到下一轮 `MemoryTurnStart` 的 hash 变了才重新注入。

## 6. Skill 到底怎么被触发和执行

这是文档没讲清的另一个点。Skill 有两种触发路径:

### 6.1 被动触发:AlgorithmNudge skill-routing(建议)

`AlgorithmNudge.hook.ts` 的 `buildIndex()` 扫每个 `skills/*/SKILL.md` frontmatter 的 `description` 字段,提取 `USE WHEN ...` 后面的短语,建 `skill-usewhen-index.json`。用户发 prompt 时,`matchSkills` 用确定性短语匹配(多词≥7字符子串,单词≥6字符词边界,有 ROUTE_STOPWORDS 过滤通用词),匹配到 ≤3 个 skill 就注入一行建议。

**这只是建议**。模型可以采纳(调 `Skill` tool)也可以忽略。`Research/SKILL.md` 的 `description` 里 USE WHEN 列了 "research,do research,deep investigation,find information..." 等几十个短语。

### 6.2 主动触发:模型调 `Skill` tool

模型决定后调 `Skill("Research", ...)`。Claude Code 的 `Skill` tool 加载 `~/.claude/skills/Research/SKILL.md`,把它作为 subagent 上下文。skill 里的 `MANDATORY TRIGGER`、"send voice notification curl" 等都是给 subagent 读的指令。

**skill 的真实形态**:它就是一个 Markdown 文件,告诉 subagent "你该怎么做这类任务"。没有可执行代码(除非 skill 自带 `Workflows/*.mjs` 或 `Tools/*.ts`)。skill 的"执行"就是模型读了 SKILL.md 后按它的指示工作。

### 6.3 自定义覆盖

`Research/SKILL.md` 写明:执行前检查 `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Research/`,有 PREFERENCES.md 就加载覆盖。这是用户不改系统 skill 也能定制的机制。

## 7. 状态文件完整清单(谁写谁读)

这是理解"系统状态散在哪"的速查表:

| 文件 | 格式 | 写入者 | 读取者 | 含义 |
|---|---|---|---|---|
| `settings.json` | JSON | InstallSettings/InstallHooks/MergeSettings | Claude Code + 所有 hook | 权限 + hook 注册 + env + autoMode |
| `work.json` | JSON | ISASync(`syncToWorkJson`) | AlgorithmNudge/LoadContext/Pulse | ★ ISA 注册表(活动 run) |
| `session-names.json` | JSON | PromptProcessing | LoadContext | session UUID -> 可读名 |
| `review-state.json` | JSON | MemoryReviewFire | MemoryReviewFire/statusline | 记忆 cadence(turn 计数) |
| `isa-nudge/{sid}.json` | JSON | AlgorithmNudge | AlgorithmNudge | 每 session 的 tool call 计数 + nudge 时间 |
| `memory-inject/{sid}.json` | JSON | MemoryTurnStart | MemoryTurnStart | 注入门控(hash + turns) |
| `verification-gate-blocked.json` | JSON array | VerificationGate | VerificationGate | block 过的 claim fingerprint |
| `capabilities.json` | JSON | Doctor | AlgorithmNudge | capability 状态(broken/declined/live) |
| `skill-usewhen-index.json` | JSON | AlgorithmNudge(--rebuild-index) | AlgorithmNudge | skill USE WHEN 短语索引 |
| `LIFEOS_STATE.json` | JSON | UpdateLifeosState | Pulse TELOS rings + statusline | 维度百分比 |
| `pending-proposals.jsonl` | JSONL | MemorySystem.add(proposal) | Telegram surfacer | 待审批提案队列 |
| `*.jsonl`(OBSERVABILITY) | JSONL | 各 hook append | 调试/Pulse | 事件日志(reviewer-fires/verification-gate/algo-nudge-routing/gap-history) |
| `algorithm-reflections.jsonl` | JSONL | Algorithm claim 12 | Learning readback | run 反思 |
| `projects/{hash}/*.jsonl` | JSONL | **Claude Code 原生** | TranscriptParser | ★ transcript(模型做过什么) |

**关键认知**:LifeOS 没有数据库。所有"运行状态"都是文件。`work.json` 是最重要的--它替代了"数据库里的 session 表"。ISASync 每次编辑 ISA 就更新它,所有 hook 读它判断"现在有没有活动 run"。

## 8. ISA 的完整生命周期

ISA 是 Algorithm 的核心数据结构。从创建到结束:

### 8.1 创建

`algorithm new -t <title> -e <effort>`:
1. `curateTitle` 清洗标题(去填充词/脏话,截断 80 字符)。
2. `generateISAFilename` -> `ISA-{YYYYMMDD}-{slug}.md`(项目侧)或 `MEMORY/WORK/{YYYYMMDD-HHMMSS_slug}/ISA.md`(任务侧)。
3. `generateISATemplate` 写 frontmatter(`task/slug/project/effort/phase:observe/progress:0/N/mode/started/updated`)+ sections(Problem/Vision/Out of Scope/Principles/Constraints/Goal/Criteria)。
4. ISC 数量按 effort 层级:TRIVIAL=2,STANDARD=8,COMPREHENSIVE=64...

### 8.2 执行中

模型编辑 ISA.md(勾 ISC、改 phase)。每次 Edit/Write 触发 `ISASync`:
- `parseFrontmatter` 读 frontmatter。
- `syncToWorkJson` 更新 `work.json[sessions[slug]]`(phase/sessionUUID/progress/currentMode)。
- phase 变化(`OBSERVE`->`THINK`->`PLAN`->`BUILD`->`EXECUTE`->`VERIFY`->`LEARN`->`COMPLETE`)-> `setPhaseTab` 给 tab 染色。
- 转到 `COMPLETE` -> spawn `ISARender.ts` 生成 HTML mirror。

### 8.3 完成

phase=`COMPLETE`。`ISARenderOnStop` 在 Stop 时若本回合编辑过 ISA 且 `ISA.html` 不存在/过时,生成 HTML。

### 8.4 Resume(关键设计)

编辑一个 `phase:complete` 的 ISA.md(用户重新打开旧任务)触发 `ISASync`。`bumpLastToolActivityBySlug` 检测到 complete 的 ISA 被编辑 -> `syncToWorkJson` 内部 auto-rewind:phase 倒回 `learn`,`iteration+1`。注释:"an ISA body edit on a complete task rewinds to learn"。`frozen:true` frontmatter 可绕过。

这就是 deep research 文档说的"~27% of runs iterate"的机制--旧 ISA 被重新打开就自动复活。

### 8.5 loop mode 的自主迭代

`algorithm -m loop -p <ISA>`:
1. 读 ISA frontmatter(maxIterations/iteration/failing_criteria)。
2. 反复调 `claude -p`(SDK)让模型工作一轮。
3. 每轮后 `syncCriteriaStatus` 从 ISA checkbox 同步 ISC 状态到 `MEMORY/STATE/algorithms/{id}.json`。
4. 跑到所有 ISC 通过或 maxIterations。
5. voice notification 在关键节点 curl `localhost:31337/notify`。

## 9. Pulse 在整个体系里的位置

`pulse.ts`(976 行)是单进程 Bun daemon,端口 31337。它不是必需的(LifeOS 在终端对话里能跑),但补上"Claude Code 不在运行时也要发生的事":

| 模块 | 作用 | 和 hook 的关系 |
|---|---|---|
| `hooks`(startHooks) | 提供 `http://localhost:31337/hooks/skill-guard` 和 `agent-guard` | PreToolUse 的 Skill/Agent matcher 的 HTTP hook 目标 |
| `voice` | ElevenLabs TTS | VoiceCompletion hook curl `/notify` |
| `observability` | Next.js 静态 dashboard + JSON API | 读 `work.json`/`review-state.json` 等文件投影 |
| `telegram`/`imessage` | 移动入口 + claude-agent-sdk | proposal 审批 surface |
| `work` | GitHub Issue 轮询 | WorkSweep 把 TELOS Goal 匹配 Issue(私有 `_ULWORK` skill) |
| `telos` | TELOS 投影 | 读 `LIFEOS_STATE.json` |
| `memory` | memory 状态 | 读 `review-state.json`/`pending-proposals.jsonl` |
| `doctor` | capability 检查 | 写 `capabilities.json` |
| cron 调度 | heartbeat loop | 跑 scheduled jobs |

**关键**:Pulse 不持有权威状态,只读文件投影。`pulse.ts` 注释自己写明:"没有队列、没有 AI triage、没有 Channel abstraction;只是运行 Job 并路由输出"。如果 Pulse 没跑,HTTP hook fail-open,skill-guard/agent-guard 失效但对话继续。

## 10. 这套设计为什么"能跑",以及它的代价

### 10.1 为什么能跑

1. **Claude Code 提供了完整的 hook 事件系统**:11 类事件覆盖了 session 生命周期的每个节点。LifeOS 只要在每个事件挂确定性脚本,就能在不改 Claude Code 一行代码的情况下"注入行为"。
2. **Markdown + JSON + JSONL 是可读可 Git 的**:用户能看懂、能改、能回滚。模型也能读写(它是天然擅长处理文本的)。
3. **`settings.json` 的 auto 模式让模型自动写文件**:没有这个,72 个 hook 的自动写入(ISA 同步、memory、状态)全会被权限提示打断。
4. **确定性 hook 不调模型**:`AlgorithmNudge` 等纯文件+正则+计数,<20ms,不花钱,不依赖模型。只有 `PromptProcessing`(起 session 名)、`MemoryReviewer`(提取记忆)调 Haiku。
5. **transcript 是现成的证据源**:Claude Code 原生记 JSONL,LifeOS 用 `TranscriptParser` 解析,就能"读模型做过什么"做验证门。

### 10.2 代价(全部有代码证据)

1. **状态散落在几十个文件里,没有事务**。`work.json` 写失败不会回滚 ISA.md 的编辑;`MemorySystem.add` 的 set-overwrite 和 ISA edit 是两次独立文件操作。半提交风险真实存在。
2. **路径合同没有成为统一依赖**。`MemoryTypes.ts` 顶部硬编码 `homedir()/.claude`,`pulse.ts` 顶部硬编码 `join(HOME,".claude","LIFEOS")`。自定义 `CLAUDE_CONFIG_DIR` 时 Memory/Pulse 仍读 `$HOME/.claude`。每个工具开头都要自己修 `$HOME` 字面量(Issue #1404/#1451/#1584)。
3. **hook 普遍 fail-open**。`AlgorithmNudge` 的 `try/catch` 返回 null,`VerificationGate` 的 `try/catch` pass,`MemoryReviewFire` 的错误 exit 0。只有 VerificationGate/StopGates 主动 block。高影响操作(自动改身份)没有 fail-closed 保护。
4. **置信度自动写身份**。`MemoryReviewer.ts:445-479` 的 `applyProposalEdit`,confidence≥0.70 直接编辑身份文件。置信度由同一推理调用产生,不是用户批准。
5. **auto 权限面极大**。`Write/Edit(~/.claude/**)` + `Bash(git push/curl/ssh)` + autoMode 自然语言开绿灯("Skip Self-Modification soft-block")。安全依赖高权限 Agent + Prompt 规则。
6. **公开版与作者私有版不一致**。`_ULWORK`/`_LIFEOS` 私有 skill 在 release 时 strip(`InstallEngine.ts:detectDevTree` 靠 `skills/_LIFEOS` 存在判断源码树)。Work 闭环公开用户拿不到完整版。
7. **没有常规测试体系**。无 `.test.ts`,`bun test` 返回 No tests found。只有内置 smoke check。

## 11. 给 Chat 的工程启发(基于代码事实,不是概念)

从"它怎么跑的"出发,Chat 应该吸收 3 个工程模式,避免 6 个代价:

**吸收**:
1. **确定性 hook 注入 > 巨型 system prompt**:在事件发生时用确定性脚本(<20ms、不调模型)注入一行建议,比一个 196 行 prompt 有效。但必须区分建议(exit 0)和强制门(block),高影响门 fail-closed。
2. **ISA 可证伪合同**:把"完成"写成带 probe 的 ISC checkbox,状态和证据绑定。但权威状态必须在 Product DB,不能是 Markdown checkbox。
3. **写入分级 + 召回合同**:MemoryTypes 的 tier(A/B/C)+ write_mode(set/append/queue)+ load_timing(always/on-relevance/surface)是好模型。但每种写入必须有召回/消费合同(防 Discussion #884 的 28 Writer/2 Reader)。

**避免**:
1. 状态散落文件无事务 -> 用 Product DB + Outbox。
2. 路径硬编码 -> 配置根作为统一依赖。
3. hook fail-open -> 高影响门 fail-closed。
4. 置信度自动写身份 -> 先生成候选,HITL 批准。
5. auto 权限面 -> 按风险分级授权。
6. 公开/私有不一致 -> Declared/Registered/Observed 三方 Doctor。

## 12. 证据索引

固定提交 `d1d6240`。路径相对 `ref/LifeOS/`。

| 机制 | 代码路径 | 关键事实 |
|---|---|---|
| 目录结构 | `Tools/DeployCore.ts`、`Tools/ScaffoldUser.ts`、`Tools/LinkUser.ts` | USER symlink 到 ~/.config/LIFEOS/USER |
| 四层上下文 | `LIFEOS_SYSTEM_PROMPT.md`、`CLAUDE.template.md`、`hooks/LoadContext.hook.ts`、`hooks.json` | ①system ②@import ③system-reminder ④additionalContext |
| transcript 解析 | `LIFEOS/TOOLS/TranscriptParser.ts`(418 行) | JSONL,collectCurrentResponseText 找最后真实 user |
| hook IO 协议 | `hooks/lib/hook-io.ts` | stdin JSON + stdout `hookSpecificOutput.additionalContext` |
| SessionStart 注入 | `hooks/LoadContext.hook.ts`(477 行) | 读 RELATIONSHIP/LEARNING/WORK 组装 system-reminder |
| UserPromptSubmit 记忆 | `hooks/MemoryTurnStart.hook.ts` | hash 门控(REFRESH_TURNS=20)防重复注入 |
| UserPromptSubmit 命名 | `hooks/PromptProcessing.hook.ts`(1119 行) | 只做 tab title + session name,Haiku 推理,**不注入模型** |
| skill-routing | `hooks/AlgorithmNudge.hook.ts:matchSkills/buildIndex` | 扫 SKILL.md USE WHEN,确定性短语匹配 |
| 验证门 | `hooks/VerificationGate.hook.ts`(420 行) | 读 transcript tool 事件,T1-T3 `decision:block` |
| ISA 同步 | `hooks/ISASync.hook.ts` + `hooks/lib/isa-utils.ts:syncToWorkJson` | frontmatter -> work.json,phase 变化染色 |
| work.json 结构 | `hooks/lib/isa-utils.ts`(1458 行) | `sessions[slug]={phase,sessionUUID,progress,currentMode}` |
| Memory 写入分级 | `LIFEOS/TOOLS/MemorySystem.ts:add`(行 488-560) | `getTier` 验证,ETIER_MISMATCH 拒绝 |
| Memory 自动 apply | `LIFEOS/TOOLS/MemoryReviewer.ts:dispatchItems`(行 417-479) | confidence≥threshold -> `applyProposalEdit` |
| Memory 触发 | `hooks/MemoryReviewFire.hook.ts` | 8 turns + 30min,spawn detached |
| Gap 引擎 | `LIFEOS/TOOLS/ComputeGap.ts` | `// v1: only count TBD` |
| 状态百分比 | `LIFEOS/TOOLS/UpdateLifeosState.ts` | fallback = `100 - TBD×10` |
| Algorithm CLI | `LIFEOS/TOOLS/algorithm.ts`(1826 行) | loop/interactive/ideate/optimize,`claude -p` SDK |
| Algorithm 规范 | `LIFEOS/ALGORITHM/v8.4.0.md` | 15 条 "run complete when" |
| ISA 模板 | `hooks/lib/isa-template.ts` | 7 effort 层级,ISC 最小数量 |
| Pulse daemon | `LIFEOS/PULSE/pulse.ts`(976 行) | 25 模块,端口 31337,billing guard |
| 权限模型 | `install/settings.system.json` | auto 模式 + autoMode 自然语言开绿灯 |

## 13. 最终判断

LifeOS 在代码层面真正跑通了一件事:**用 Claude Code 的 hook 事件系统 + 文件系统状态 + auto 权限,把一套 Markdown 协议变成会被强制执行的行为**。它不需要自己写 Agent runtime、模型调用循环或数据库--Claude Code 全提供了,LifeOS 只负责"在什么事件、读什么文件、算什么、注入什么或阻断什么"。

它的"产品能力"几乎全在 ④ 层(additionalContext)和几个 `decision:block` 门里。system prompt 和 CLAUDE.md 是"告诉模型规矩",真正执行规矩的是 hook。状态散落在 `work.json` + 几十个 json/jsonl 里,没有事务,靠"每次编辑就同步"维持一致性。

对 Chat 最有价值的认知:**这套"确定性 hook 注入 + 文件状态 + auto 权限"的工程模式是可行的、在跑的、有 454 个 TypeScript 支撑的**。但它的每一个代价(文件无事务、路径硬编码、fail-open、置信度自动写身份、auto 权限面、公开/私有不一致)都必须用 Product DB、统一配置、fail-closed、候选/HITL、分级授权和三方 Doctor 来替代。Chat 不是复刻 LifeOS,而是用它的工程模式 + Chat 的权威边界,做出 LifeOS 证明可行但没做到的可信闭环。
