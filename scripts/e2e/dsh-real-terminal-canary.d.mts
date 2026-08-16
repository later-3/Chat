export interface DshRealTerminalCanaryEvidence {
  readonly schemaVersion: "chat-dsh-terminal-canary.v1";
  readonly pid: number;
  readonly startedAt: string;
  readonly command: string;
  readonly commandFragments: readonly [string];
  readonly canary: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly codeServerChildPid: number;
  readonly codeServerInstanceId: string;
  readonly recordedAt: string;
  readonly evidencePath: string;
}

export declare const DSH_REAL_TERMINAL_CANARY_SCHEMA = "chat-dsh-terminal-canary.v1";
export declare function resolveDshRealTerminalCanaryEvidencePath(root: string): string;
export declare function assertDshRealTerminalCanaryProcessIdentity(
  evidence: DshRealTerminalCanaryEvidence,
  dependencies?: {
    isAlive?: (pid: number) => boolean;
    describe?: (pid: number) => { startedAtMs: number; command: string } | null;
    workingDirectory?: (pid: number) => string | null;
    findGitCommonDir?: (path: string | null) => string | null;
    findParentPid?: (pid: number) => number | null;
  },
): DshRealTerminalCanaryEvidence;
export declare function readDshRealTerminalCanaryEvidence(
  root: string,
): DshRealTerminalCanaryEvidence | undefined;
export declare function assertDshRealTerminalCanaryAlive(
  root: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    requireRunningWorkbench?: boolean;
  },
): DshRealTerminalCanaryEvidence;
export declare function assertDshRealTerminalCanaryStopped(
  root: string,
): DshRealTerminalCanaryEvidence | undefined;
export declare function waitForAndRecordDshRealTerminalCanary(
  root: string,
  canary: string,
  options?: { environment?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<DshRealTerminalCanaryEvidence>;
