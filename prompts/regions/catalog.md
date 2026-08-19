# Chat Prompt 区域目录

这份目录定义 Chat 如何把“用户想表达的语义”和“Provider 实际请求结构”分开管理。

## 可编辑语义区域

- `agent_identity`：模型在当前节点扮演的身份。未来组装到 System。
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

只有 `agent_identity` 进入 System。背景、目标、要求、规则、经验和案例属于带来源的上下文，不能因为它们“很重要”就全部塞进 System。

## 运行时只读区域

- `runtime_contract`：Chat/Workflow/Agent Runtime 强制执行的节点边界。
- `current_input`：当前 Product Message 或前序节点传入的真实输入。
- `conversation`：本次明确选入的正式会话历史和 Tool Loop 消息。
- `memory`：未来由 Memory Provider 选择并冻结的内容。
- `tools`：本次可见的工具 Schema、说明和能力边界。
- `request_options`：Provider、Model、Thinking、Token 等非自然语言参数。

这些区域在 Prompt Studio 中可查看设计和来源，但不作为普通 Markdown 组件直接编辑。
