# Chat Prompt 区域目录

这份目录定义 Chat 如何把“用户想表达的语义”和“Provider 实际请求结构”分开管理。

## 可编辑语义区域

- `workspace_instructions`：用户显式选择的Chat基础Workspace或当前目标Workspace指令文件；Chat只读取列出的精确文件，不递归发现。
- `user_context`：与当前用户有关、完成任务确实需要知道的资料。
- `background`：任务发生的背景、现状和边界。
- `objective`：本次运行希望达成的结果。
- `requirements`：必须满足的交付要求。
- `rules`：本次运行必须遵守的规则和规范。
- `experience`：可复用的方法、经验和注意事项。
- `examples`：希望模型仿照的正向案例。
- `counterexamples`：需要避免的错误做法或反例。
- `output_contract`：输出格式、结构和验收约定。
- `custom_context`：用户临时扩展的命名 Key/Value 上下文。

Direct V2把所有用户显式选择的Prompt组件编译为命名System Section；真实用户输入和正式会话历史只进入Messages。Region表达内容用途、来源、选择和预算，不等同于Provider Role。

## Agent配置区域

- `agent_identity`：独立Agent Profile的身份、长期职责和工作方式。它只在「设置 → Agent」中版本化管理，不属于会话Prompt，也不按Workflow节点名称创建Overlay。

Workflow节点只引用Agent；节点执行时，Application把该Agent的System Prompt与同一份会话上下文组合为冻结Assembly。工具定义由Runtime锁定，Prompt不能扩权。

## 运行时只读区域

- `runtime_contract`：Chat/Workflow/Agent Runtime 强制执行的节点边界。
- `current_input`：当前 Product Message 或前序节点传入的真实输入。
- `conversation`：本次明确选入的正式会话历史和 Tool Loop 消息。
- `platform_workspace`：Chat 自身的基础 Workspace 引用。只提供受权根、读取策略和入口文件信息，不预读或复制 `AGENTS.md` 正文。
- `target_workspace`：用户在 DSH 为当前工作选择的对象 Workspace。它是 Agent 的主要工作目录，模型通过受控工具自行发现并读取生效的 `AGENTS.md`。
- `memory`：未来由 Memory Provider 选择并冻结的内容。
- `tools`：本次可见的工具 Schema、说明和能力边界。
- `request_options`：Provider、Model、Thinking、Token 等非自然语言参数。

这些区域在 Prompt Studio 中可查看设计和来源，但不作为普通 Markdown 组件直接编辑。

两个 Workspace 区域保存的是引用和权限证据，不是浏览器提交的本机路径。DSH Workspace 身份必须在服务端映射为 Chat 已授权的 Workspace Root；若工作对象就是 Chat，本轮组装去重为一个 Root。Chat 基础 Workspace 默认只读，工作对象 Workspace 的写入能力由节点 Capability Profile 决定。
