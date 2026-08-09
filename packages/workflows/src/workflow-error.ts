/** pi/Provider失败与非法候选：由Workflow提交明确失败终态，不自动重试。 */
export class PiStepFailure extends Error {
  readonly stableCode: string;

  constructor(stableCode: string, _safeSummary: string) {
    // Step与Workflow运行在不同耐久隔离边界；自定义prototype/字段不保证随SDK错误
    // 序列化保留，因此Error.message必须只携带可审计稳定码，不能依赖instanceof恢复根因。
    super(stableCode);
    this.name = "PiStepFailure";
    this.stableCode = stableCode;
  }
}
