export interface RealTestChildAuthorization {
  readonly mode: "paid" | "external";
  readonly commandName: string;
  readonly serviceSwitch?: string;
  readonly credentials?: readonly string[];
}

export function assertRealTestChildAuthorization(
  input: RealTestChildAuthorization,
  environment?: NodeJS.ProcessEnv,
): void;
