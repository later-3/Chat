# Chat 产品飞轮

## 循环

```text
真实对话与工作
-> 形成可审核的Plan/Decision
-> Workflow与Agent执行
-> 产生结果、Evidence与失败事实
-> 用户反馈与修订
-> 沉淀Project、Memory、Rule和方法
-> 改善下一次上下文与执行
```

## 每轮必须留下什么

1. 用户原始意图和正式Message。
2. 被采用/排除的Context与来源。
3. 高影响动作对应的Plan版本和Decision。
4. Agent/Tool结果、验证、Evidence与明确终态。
5. 可复用内容先成为候选，经过接受门才进入Memory、Rule或项目事实。

## 产品开发也遵守同一飞轮

1. 从真实用户场景开始，不从技术组件开始。
2. 优先选择成熟、持续维护的开源能力；先做Provider/Adapter PoC。
3. 一次只交付一个可体验纵向，并定义失败/恢复场景。
4. 用真实服务、真实浏览器和权威Store事实验收。
5. 把稳定边界写回当前架构文档；历史由Git保存，不在当前树累积档案。

## 质量信号

- 用户能够说明系统现在在做什么、为什么暂停、下一步会发生什么。
- 刷新、断网、进程退出和重复点击不会产生假成功或重复副作用。
- 上游能力升级不需要重写Chat核心；Adapter合同和E2E能快速证明兼容。
- 核心代码集中在Chat差异，Files/Editor/Terminal/Browser/Memory等成熟能力由外部项目持续维护。
