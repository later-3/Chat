export declare const DSH_PROMPT_STUDIO_E2E_PORTS: Readonly<{
  web: number;
  api: number;
  workflowPlaceholder: number;
  webInternal: number;
  piExecutor: number;
}>;
export declare const DSH_PROMPT_THREE_GATES_E2E_PORTS: Readonly<{
  web: number;
  api: number;
  workflow: number;
  webInternal: number;
  piExecutor: number;
}>;
export declare const DSH_REAL_E2E_PORTS: Readonly<{
  web: number;
  api: number;
  workflow: number;
  webInternal: number;
  piExecutor: number;
  workbenchLease: number;
}>;
export declare const DSH_CAPABILITY_GOVERNANCE_E2E_PORTS: Readonly<{
  web: number;
  api: number;
  workflow: number;
  webInternal: number;
  piExecutor: number;
  piControl: number;
}>;
export declare const DSH_PLANNING_FAUX_E2E_PORTS: Readonly<{
  web: number;
  api: number;
  workflow: number;
  webInternal: number;
  piExecutor: number;
}>;
export declare const DSH_BROWSER_FORBIDDEN_ENV_NAMES: readonly string[];

export declare function deterministicBrowserProcessEnvironment(
  environment?: NodeJS.ProcessEnv,
): Record<string, string>;
export declare function assertDeterministicBrowserEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void;
export declare function planningE2eTemporaryRoot(path: string, temporaryParent?: string): boolean;
export declare function managedDshE2eTemporaryRoot(path: string, temporaryParent?: string): boolean;

export declare function resolveDshRealDataRoot(
  root: string,
  environment?: NodeJS.ProcessEnv,
): string;
export declare function resolveDshRealWorkbenchFixtureRoot(root: string): string;
export declare function resolveDshRealWorkbenchRunRoot(root: string): string;
export declare function resolveDshRealSharedCacheRoot(root: string): string;
export declare function resolveDshRealWorkbenchTempParent(environment?: NodeJS.ProcessEnv): string;

export declare function dshRealWebEnvironment(
  root: string,
  environment?: NodeJS.ProcessEnv,
): Record<string, string>;

export declare function dshRealWorkbenchEnvironment(
  root: string,
  environment?: NodeJS.ProcessEnv,
): Record<string, string>;
