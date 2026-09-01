import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const CHAT_TOOL_MANIFEST_SCHEMA_VERSION = 1;

export type ChatToolRisk = "read-only" | "write" | "destructive";

export interface ChatToolManifest {
  readonly schemaVersion: typeof CHAT_TOOL_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly implementationVersion: number;
  readonly risk: ChatToolRisk;
  readonly permissions: readonly string[];
}

export interface ChatToolRuntimeContext {
  readonly purpose: "execution" | "inspection";
  readonly projectId: string;
  readonly chatHome: string;
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly stageId: string;
  readonly agentId: string;
}

export interface ChatToolProvider {
  readonly manifest: ChatToolManifest;
  readonly address: string;
  readonly version: string;
  readonly create: (context: ChatToolRuntimeContext) => ToolDefinition;
}

export interface ChatToolIdentity {
  readonly address: string;
  readonly version: string;
}

export interface ResolvedChatTool {
  readonly manifest: ChatToolManifest;
  readonly address: string;
  readonly version: string;
  readonly definition: ToolDefinition;
}

export interface ChatSessionToolResource {
  readonly name: string;
  readonly address: string;
  readonly version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field}必须是字符串数组`);
  return [...new Set(value.map((item, index) => nonEmptyString(item, `${field}[${index}]`)))];
}

/** Strict manifest parser used by every Chat-owned executable Tool. */
export function parseChatToolManifest(value: unknown): ChatToolManifest {
  if (!isRecord(value) || value.schemaVersion !== CHAT_TOOL_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Tool Manifest必须使用schemaVersion ${CHAT_TOOL_MANIFEST_SCHEMA_VERSION}`);
  }
  const allowed = new Set([
    "schemaVersion",
    "id",
    "name",
    "label",
    "description",
    "implementationVersion",
    "risk",
    "permissions",
  ]);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`Tool Manifest包含未知字段: ${unknown.join(", ")}`);
  const id = nonEmptyString(value.id, "Tool id");
  const name = nonEmptyString(value.name, "Tool name");
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error(`Tool id格式无效: ${id}`);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Tool name格式无效: ${name}`);
  if (!Number.isSafeInteger(value.implementationVersion) || (value.implementationVersion as number) < 1) {
    throw new Error("Tool implementationVersion必须是正整数");
  }
  if (value.risk !== "read-only" && value.risk !== "write" && value.risk !== "destructive") {
    throw new Error(`Tool risk无效: ${String(value.risk)}`);
  }
  return {
    schemaVersion: CHAT_TOOL_MANIFEST_SCHEMA_VERSION,
    id,
    name,
    label: nonEmptyString(value.label, "Tool label"),
    description: nonEmptyString(value.description, "Tool description"),
    implementationVersion: value.implementationVersion as number,
    risk: value.risk,
    permissions: stringList(value.permissions, "Tool permissions"),
  };
}

export function systemToolAddress(name: string): string {
  return `system:tool/${encodeURIComponent(name)}`;
}

export function defineChatSystemTool(
  manifestValue: unknown,
  create: (context: ChatToolRuntimeContext, identity: ChatToolIdentity) => ToolDefinition,
): ChatToolProvider {
  const manifest = parseChatToolManifest(manifestValue);
  const identity = {
    address: systemToolAddress(manifest.name),
    version: `system:${manifest.id}@${String(manifest.implementationVersion)}`,
  };
  return {
    manifest,
    ...identity,
    create: (context) => create(context, identity),
  };
}
