export declare function resolveDshRealDataRoot(root: string): string;
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
