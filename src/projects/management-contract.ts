import { Type, type Static } from "@earendil-works/pi-ai";

const strict = { additionalProperties: false } as const;
const projectId = Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 160 });
const id = Type.String({ minLength: 1, maxLength: 120 });
const revision = Type.String({ pattern: "^(absent|sha256:[a-f0-9]{64})$" });
const requestId = Type.String({ minLength: 1, maxLength: 160 });
export const projectSearchSchema = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 160 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, strict);
export const projectReadSchema = Type.Object({
  projectId: Type.Optional(projectId),
  view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("configuration"), Type.Literal("capabilities")])),
  workflowId: Type.Optional(id),
  agentId: Type.Optional(id),
  cursor: Type.Optional(Type.String({ maxLength: 160 })),
}, strict);
export const projectCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  requestId,
}, strict);
export const projectOpenSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), requestId }, strict);
export const projectUpdateSchema = Type.Object({
  projectId: Type.Optional(projectId), expectedRevision: revision,
  changes: Type.Object({
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
  }, { ...strict, minProperties: 1 }),
}, strict);
const fieldPath = Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 6 });
export const projectConfigureSchema = Type.Object({
  projectId: Type.Optional(projectId), expectedRevision: revision,
  target: Type.Union([
    Type.Object({ kind: Type.Literal("project") }, strict),
    Type.Object({ kind: Type.Literal("workflow-agent"), workflowId: id, agentId: id }, strict),
  ]),
  operations: Type.Array(Type.Union([
    Type.Object({ op: Type.Literal("set"), path: fieldPath, value: Type.Unknown() }, strict),
    Type.Object({ op: Type.Literal("unset"), path: fieldPath }, strict),
  ]), { minItems: 1, maxItems: 20 }),
  validateOnly: Type.Optional(Type.Boolean()),
}, strict);
export type ProjectSearchInput = Static<typeof projectSearchSchema>;
export type ProjectReadInput = Static<typeof projectReadSchema>;
export type ProjectCreateInput = Static<typeof projectCreateSchema>;
export type ProjectOpenInput = Static<typeof projectOpenSchema>;
export type ProjectUpdateInput = Static<typeof projectUpdateSchema>;
export type ProjectConfigureInput = Static<typeof projectConfigureSchema>;

export class ProjectManagementError extends Error {
  readonly code: string;
  readonly applied: boolean;
  constructor(code: string, message: string, applied = false) { super(message); this.code = code; this.applied = applied; }
}
