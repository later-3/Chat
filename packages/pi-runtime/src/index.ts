/**
 * @chat/pi-runtime
 *
 * pi适配与Agent节点层。
 *
 * 边界（P0仅固定依赖方向，实现属于P1）：
 * - Workflow通过`PiRuntimePort`调用pi；pi对象不泄漏到产品层。
 * - pi Runtime Session引用仅后端可见；pi成功不自动完成Product Run或Work。
 */
export {};
