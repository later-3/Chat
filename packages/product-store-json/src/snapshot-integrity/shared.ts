/**
 * 快照完整性校验共享类型。fail由orchestrator注入，任何不一致都失败关闭。
 */
export type Fail = (detail: string) => never;
