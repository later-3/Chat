# Content Lab资源观察与上下文编译 As-built

> As-built：2026-08-24
>
> 范围：Content Lab只读Resource、Observation、Change Candidate、Artifact Manifest和Context Compiler。
>
> 跨Agent Opening Packet与DSH入口见Project管理as-built；外部Provider专项研究与历史导入不属于默认运行图。

## 1. 用户结果与事实所有权

P6让Chat能够理解Content Lab目录中的当前内容、交付证据、系列规则和方法案例，同时保持三条边界：

| 角色/系统 | 拥有什么 | P6怎样使用 |
|---|---|---|
| 用户 | 审核、发布确认、方法采用等高影响决定 | 目录变化只成为候选；不能自动变成`Published`或`Adopted` |
| 协作Agent | 读取当前Work所需的最小上下文，分析变化并提出下一步 | 通过Application Context Compiler取数，不递归扫描目录、不依赖Session记忆 |
| Chat Product Store | Project/Profile/Work/Decision/Evidence、Observation、候选和历史Provider投影 | 保存结构化摘要、Hash和稳定相对引用，不保存媒体正文 |
| Content Lab Git/Artifact目录 | `source.md`、`publish.md`、QC、Workflow分析、案例和真实媒体 | 仍是正文与工件事实源；P6只读，不写缓存或索引文件 |
| 外部项目Provider | 专项协作资源 | 默认不装配；编译器至多读取Store中已有历史Projection Snapshot，不调用Provider |

因此，`publish.md`表示“发布包”，不是平台已发布回执；`QC PASS`最多形成`review_ready`观察，不能替用户确认发布成功。

## 2. 已交付合同

### 2.1 Resource Adapter

`content-lab-resource.v1`加入`ProjectResourceAdapterKind`。Content Lab Root通常配置：

```json
{
  "rootId": "root_contentlab",
  "enabledAdapters": ["local-git-workspace.v1", "content-lab-resource.v1"]
}
```

Adapter只通过`git ls-files -- .`发现受管结构，识别：

- 根和系列`AGENTS.md`；
- `workflows/*.md`与各级`templates/*.md`；
- `series_registry.md`；
- `cases/*.md`；
- 小红书/B站普通Job和系列Job中的`source.md`、`publish.md`、`analysis/qc.md`、`analysis/*workflow*.md`。

未tracked文件不会被当成治理或历史事实；推荐上传媒体即使被`.gitignore`忽略，也只会按`publish.md`/QC中明确引用的相对路径做定点`stat`和受限Hash。

### 2.2 Observation与历史索引

`ProjectObservation.data.contentLab`使用`content-lab-observation.v1`，包含：

- 分类Catalog及每个文本的相对路径、大小和SHA-256；
- 按日期、平台、系列、来源URL、Workflow引用索引的Job；
- 每个Job的`source/publish/qc/workflowAnalysis`引用、状态信号和推荐工件；
- 扫描统计、截断标记与明确的`recommended_paths_only`工件策略。

观察态只有4种：

| 观察态 | 目录事实 | 不能推导什么 |
|---|---|---|
| `draft` | 缺少发布包，或已有发布包但尚无审核/通过信号 | 不能推导已完成 |
| `needs_review` | 文档明确等待审核 | 不能推导用户已同意 |
| `review_ready` | 发布包与QC存在，且QC有`PASS/质检通过/技术完成`信号 | 不能推导已发布 |
| `blocked` | 文档出现受管的环境阻塞信号 | 不能自动改变Chat Work状态 |

历史索引是定位入口，不是“把全部历史送给模型”。

### 2.3 Artifact Manifest

每个Job最多记录12个被发布包/QC明确推荐的工件：

- 稳定相对路径和媒体类型；
- 存在时的字节大小；
- 文本中可恢复的分辨率、时长、帧率、Codec；
- `computed | deferred_large | deferred_policy | missing` Hash政策；
- 哪些受管文档推荐了该工件。

单文件超过32MiB不读内容；一次Observation累计Hash最多128MiB，超过预算继续保存大小和`deferred_policy`，不偷偷扩大成全量媒体扫描。

### 2.4 Observation → Change Candidate

每次Application观察都会在同一`ProjectObservation.v1`上保存`content-lab-change-candidate.v1`：

- 首次为`baseline`；
- 无受管变化为`none`；
- 治理、Workflow、模板、系列、Work证据或案例变化为`review_required`，带最多200个变化路径。

合同固定`prohibitsAutomaticCompletion: true`。Application不会据此写`ProjectWorkOutcome`、创建`PracticeRevision`或推进Work终态。Snapshot Integrity校验Adapter/Data/Candidate一致性和基线前序关系。

## 3. Agent上下文编译

`compileContentLabProjectContext`先从Product Store恢复并校验：

1. Principal拥有Project；
2. Resource属于Project且活动；
3. Work是`content_delivery`或`workflow_improvement`；
4. Profile是`content-production.v1`且Context Map活动；
5. 使用该Resource最新的Content Lab Observation；
6. 历史Provider协调只取Store中该Work最近一次`providerSnapshot`，不在编译过程中调用外部Provider；
7. 同时附带与当前Work/Resource相关的活动Decision和Evidence引用。

Resource Compiler再按Work选择：

- 1个根`AGENTS.md`；
- 最多2个固定Workflow；
- 当前平台1个模板；
- 当前系列的AGENTS和Registry；
- 当前Job最多4个核心文档；
- 最多3个同平台、同系列或同类环境阻塞案例；
- 最多20条只含索引字段的相关历史。

每个正文最多40,000字符，总包最多160,000字符。读取时重新核对Observation的大小和Hash；文件漂移、符号链接、越界路径或疑似凭据都会失败关闭。媒体永远不进入`items[].content`。

## 4. 安全与资源上限

| 边界 | 固定上限/政策 |
|---|---|
| Git输出 | 8MiB、8秒 |
| 受管文本候选 | 1,000个 |
| 单个文本 | 512KiB |
| 单次观察文本总量 | 16MiB |
| Job | 500个 |
| 推荐工件 | 每Job 12个 |
| 单工件内容Hash | 32MiB |
| 单次观察工件Hash总量 | 128MiB |
| Context正文 | 单项40,000字符、总计160,000字符 |
| 案例正文 | 最多3个 |
| 历史索引 | 最多20条 |

文件名含`.env/secret/credential/token/private-key`的候选不会读取；绝对路径、`..`、反斜线、NUL、符号链接和Root外realpath均拒绝。URL含用户名、密码或敏感查询参数时不进入Observation。

## 5. 源码导航

| 责任 | 位置 |
|---|---|
| strict Schema | `packages/contracts/src/content-lab-project.ts`、`packages/contracts/src/project.ts` |
| 只读扫描、Manifest、Context选择 | `packages/project-runtime/src/content-lab-resource.ts` |
| Root授权和Adapter装配 | `packages/project-runtime/src/registry.ts` |
| Candidate生成与Observation事务 | `packages/application/src/project-use-cases/lifecycle.ts` |
| Project/Work/Decision/Evidence上下文 | `packages/application/src/project-content-context-use-cases.ts` |
| Store完整性 | `packages/product-store-json/src/snapshot-integrity/projects.ts` |
| 六类Fixture与安全测试 | `packages/project-runtime/src/content-lab-resource.test.ts` |
| Application纵向测试 | `packages/application/src/project-coordination-use-cases.test.ts` |
| 真实只读门 | `scripts/project/verify-real-content-lab-read.ts` |

## 6. 真实Content Lab只读证据

2026-08-24在真实Content Lab运行：

```bash
CHAT_CONTENT_LAB_REAL_ROOT=/private/absolute/path \
  pnpm test:project:content-lab-real-read
```

结果为917个tracked文件、200个受管文本、41个Job、39个案例和105个推荐工件；连续两次Observation Hash一致。小红书/B站开工上下文分别选择11/13个文本项，没有媒体正文，执行前后Git状态字节级一致，外部写入为0。个人绝对路径不写入合同、文档输出或Product Store。

## 7. 后续Agent怎样使用

P6提供“可观察、可判断、可裁剪”的基础能力；P7已经通过[Project Agent统一协作入口](./project-agent-coordination-as-built.md)复用这些Application用例。Codex Skill、Pi Prompt或DSH插件不得重新扫描Content Lab：

```text
确定Project/Work/Resource
  -> 读取最新Observation和Change Candidate
  -> compileContentLabProjectContext
  -> Agent执行/分析
  -> 通过统一Application命令提交Evidence、进度、阻塞或审核交接
```

这些观察结果不得自动批量写入外部系统；`review_required`首先是Chat中的审核输入，不是外部同步授权。
