/** pi/Provider失败与非法候选：由Workflow提交明确失败终态，不自动重试。 */
export class PiStepFailure extends Error {
  readonly stableCode: string;

  constructor(stableCode: string, message: string) {
    super(message);
    this.name = "PiStepFailure";
    this.stableCode = stableCode;
  }
}
