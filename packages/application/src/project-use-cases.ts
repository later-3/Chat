/**
 * Project用例barrel。
 *
 * 实现按用例族拆分到project-use-cases/目录：intake（根注册与接收）、
 * management-candidates（管理Candidate生命周期）、candidate-review（审核与决定）、
 * queries（摘要/工作区/时间线）、actions（Action CRUD）、lifecycle（阶段转换/
 * 决定/贡献/资源观察）；shared.ts只承载族内共享helper，不作为包公开面。
 * 对外 import 路径保持 "./project-use-cases.js" 不变。
 */
export * from "./project-use-cases/intake.js";
export * from "./project-use-cases/management-candidates.js";
export * from "./project-use-cases/candidate-review.js";
export * from "./project-use-cases/queries.js";
export * from "./project-use-cases/actions.js";
export * from "./project-use-cases/lifecycle.js";
