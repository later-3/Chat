import {
  computeRunContextRequestSha256,
  computeWorkflowViewDefinitionSha256,
  computeWorkspaceInstructionItemSha256,
  computeWorkspaceInstructionsSha256,
  governedUserPromptLayer,
  hashCanonical,
  LEGACY_PLANNING_VIEW_ID,
  NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID,
  NOTE_LOW_RISK_AUTO_POLICY_REVISION,
  NOTE_LOW_RISK_AUTO_POLICY_SHA256,
  normalizeNoteTags,
  resolveNoteSourceText,
  sha256Hex,
  type WorkflowDiagnostic,
} from "@chat/domain";
import {
  contextRequestIdSchema,
  messageIdSchema,
  noteKindSchema,
  productRunIdSchema,
  productSessionIdSchema,
  promptTurnPreviewDtoSchema,
  workflowRunSpecIdSchema,
} from "@chat/contracts";
import type {
  NoteCaptureSubmitInput,
  NoteKind,
  NoteSourceRef,
  NoteTag,
  CreateSessionPayload,
  Message,
  PrincipalId,
  ProductRun,
  ProductSession,
  ProductSessionId,
  ProductSnapshot,
  PreviewPromptTurnPayload,
  SessionDto,
  SubmitMessagePayload,
  WorkflowRunConfiguration,
  WorkflowRunBusinessInput,
  WorkflowDefinitionRevision,
  WorkflowRunSpec,
} from "@chat/contracts";
import { DEFAULT_MAX_PLAN_REVISIONS, type ApplicationDeps } from "./deps.js";
import { toMessageDto, toRunDto, toSessionDto } from "./dto.js";
import {
  ApplicationError,
  CommandIdReusedError,
  forbidden,
  notFound,
  revisionConflict,
} from "./errors.js";
import { emitRunEvent } from "./trace-helpers.js";
import { readExactCommandReceipt } from "./product-store-port.js";
import type { MessageDto, RunDto } from "@chat/contracts";
import {
  compileWorkflowRunSpec,
  validateWorkflowRunSpecIntegrity,
  validateRunSpecResourcesCurrent,
} from "./workflow-run-spec-compiler.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  LEGACY_PLANNING_RUNNER_FAMILY,
  LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
  SYSTEM_NOTE_WORKFLOW_VIEW_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
} from "./workflow-system-definitions.js";
import { synchronizePlanningWorkflowProjection } from "./planning-workflow-projection.js";
import { listAuthorizedWorkflowResources } from "./workflow-resource-catalog.js";
import { assertWorkflowResourceSelectionsAuthorized } from "./workflow-resource-catalog.js";
import { createPublishedWorkflowView } from "./workflow-view-builder.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import {
  agentBindingForNode,
  assertPromptAssemblySourcesCurrent,
  compileDirectPromptAssembly,
  compileWorkflowPromptAssembly,
  promptBearingNodes,
} from "./prompt-assembly-use-cases.js";
import { getAgentProfile } from "./prompt-studio-use-cases.js";

/**
 * CreateProductSession / SubmitUserMessage用例。
 *
 * 事务边界（任务书§8.1、§9.2）：
 * - 一次Message Command原子提交User Message + Product Run + Command Receipt +
 *   Workflow Start Outbox；任一步失败三者都不提交。
 * - 一个Message Command最多创建一个User Message和一个Product Run。
 * - Workflow Start在事务外由Outbox派发（M2接入）；M1只形成pending Outbox事实。
 */

export interface CreateProductSessionInput {
  readonly principalId: PrincipalId;
  readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
  readonly payload: CreateSessionPayload;
}

export async function createProductSession(
  deps: ApplicationDeps,
  input: CreateProductSessionInput,
): Promise<{ session: SessionDto }> {
  const now = deps.now();
  const sessionId = deps.ids.session();
  const requestSha256 = hashCanonical("command.create-product-session.v1", {
    principalId: input.principalId,
    payload: input.payload,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateProductSession",
    requestSha256,
    traceContext: { productSessionId: sessionId },
    mutate: (draft) => {
      const session: ProductSession = {
        schemaVersion: "product-session.v1",
        sessionId,
        ownerPrincipalId: input.principalId,
        status: "active",
        ...(input.payload.title !== undefined ? { title: input.payload.title } : {}),
        lastMessageSequence: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.sessions[sessionId] = session;
      return { resultRefs: { sessionId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const session = snapshot.entities.sessions[result.resultRefs["sessionId"] ?? ""];
  if (session === undefined) throw notFound("Session不存在");
  return { session: toSessionDto(session) };
}

export interface SubmitUserMessageInput {
  readonly principalId: PrincipalId;
  /** 首轮留空；Application在Message事务内创建Product Session。 */
  readonly sessionId?: ProductSessionId;
  readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
  readonly payload: SubmitMessagePayload;
}

/**
 * Message命令身份只包含调用方请求与不可变Workflow Revision的默认规范化结果，不能包含
 * 当前Runtime或Prompt编译结果。这样原子提交后的Receipt即使跨进程/配置漂移，也能先于外部依赖重放。
 */
function submitUserMessageRequestSha256(
  input: SubmitUserMessageInput,
  snapshot: Readonly<ProductSnapshot>,
  submissionKind: MessageSubmissionKind,
): string {
  const submittedWorkflowSelection = input.payload.workflowSelection;
  const selectedRevisionId =
    submittedWorkflowSelection?.workflowDefinitionRevisionId ??
    SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID;
  const selectedRevision = snapshot.entities.workflowDefinitionRevisions[selectedRevisionId];
  const runConfiguration = submittedWorkflowSelection?.runConfiguration ?? {
    schemaVersion: "workflow-run-configuration.v1" as const,
    overrides: [],
  };
  const submittedBusinessInput = submittedWorkflowSelection?.businessInput;
  const requestBusinessInput =
    selectedRevision?.blueprintKey === "note"
      ? (() => {
          const defaults = noteExtractDefinitionDefaults(selectedRevision);
          const noteInput = submittedBusinessInput ?? { kind: "note_capture" as const };
          return {
            kind: "note_capture" as const,
            source: noteInput.source ?? { kind: "full_message" as const },
            defaultKind: noteInput.defaultKind ?? defaults.defaultKind,
            suggestedTagLabels: normalizeNoteTags(
              noteInput.suggestedTagLabels ?? defaults.suggestedTagLabels,
            ).map((tag) => tag.label),
          };
        })()
      : submittedBusinessInput;
  const normalizedPayload = {
    ...input.payload,
    workflowSelection: {
      kind: "published_revision" as const,
      workflowDefinitionRevisionId: selectedRevisionId,
      // 显式Workflow选择的Revision/Hash是调用方CAS身份，必须逐字进入Receipt Hash；
      // 只有整个选择缺省时，才用系统默认Revision的冻结Hash补全旧客户端语义。
      definitionSha256:
        submittedWorkflowSelection?.definitionSha256 ??
        selectedRevision?.definitionSha256 ??
        "missing",
      runConfiguration,
      ...(requestBusinessInput === undefined ? {} : { businessInput: requestBusinessInput }),
    },
  };
  return hashCanonical(messageCommandHashDomain(submissionKind, input.sessionId === undefined), {
    principalId: input.principalId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    payload: normalizedPayload,
  });
}

type MessageSubmissionKind = "ordinary" | "project_bootstrap_dedicated_entry";

function assertProjectBootstrapSubmissionAuthorized(
  submissionKind: MessageSubmissionKind,
  input: {
    readonly selectedRevision: WorkflowDefinitionRevision;
    readonly runConfiguration: WorkflowRunConfiguration;
    readonly runSpec: {
      readonly nodeResolutions: readonly {
        readonly definitionNodeId: string;
        readonly nodeType: string;
        readonly activation: string;
        readonly config: Readonly<Record<string, unknown>>;
      }[];
    };
  },
): void {
  const bootstrapNode = input.runSpec.nodeResolutions.find(
    (node) =>
      node.nodeType === "agent.direct" &&
      node.activation === "enabled" &&
      node.config["capabilityMode"] === "project_bootstrap",
  );
  if (bootstrapNode === undefined) {
    if (submissionKind === "project_bootstrap_dedicated_entry") {
      throw forbidden("项目初始化专用Message必须显式选择project_bootstrap能力");
    }
    return;
  }
  if (submissionKind !== "project_bootstrap_dedicated_entry") {
    throw forbidden("project_bootstrap只能通过项目初始化专用Product Command启用");
  }
  const explicitOverride = input.runConfiguration.overrides.some(
    (override) =>
      override.kind === "node_config" &&
      override.definitionNodeId === bootstrapNode.definitionNodeId &&
      override.field === "capabilityMode" &&
      override.value === "project_bootstrap",
  );
  if (
    input.selectedRevision.workflowDefinitionRevisionId !==
      SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID ||
    input.selectedRevision.blueprintKey !== "direct" ||
    !explicitOverride
  ) {
    throw forbidden("项目初始化专用Message只接受系统Direct Workflow的显式单轮能力授权");
  }
}

/** 会话标题是Chat产品策略；只从首条已提交User Message派生。 */
function productSessionTitleFromFirstMessage(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 200 ? normalized : `${characters.slice(0, 199).join("")}…`;
}

interface PreparePromptTurnInput {
  readonly principalId: PrincipalId;
  readonly payload: SubmitMessagePayload;
  readonly now: string;
  readonly snapshot: ProductSnapshot;
  readonly targetSessionId: ProductSessionId;
  readonly messageId: Message["messageId"];
  readonly productRunId: ProductRun["productRunId"];
  readonly workflowRunSpecId: ReturnType<typeof workflowRunSpecIdSchema.parse>;
  readonly sessionSequence: number;
  readonly sourceMessageSha256: string;
  readonly submissionAuthorization?: {
    readonly kind: MessageSubmissionKind;
  };
}

/**
 * 发送预览和正式提交共用的唯一预编译入口。
 *
 * 它只解析已发布Workflow、节点Agent绑定、Run覆盖和Prompt Assembly，不写产品事实、
 * 不启动Workflow。预览若能通过，提交仍会在事务内复核Session序号与所有Prompt来源，
 * 因而既不会产生第二套Prompt事实，也不会把只读预览误当作执行授权。
 */
async function preparePromptTurn(deps: ApplicationDeps, input: PreparePromptTurnInput) {
  const selectedRevision = resolvePublishedWorkflowRevision(
    input.snapshot,
    input.payload,
    input.principalId,
  );
  if (selectedRevision.blueprintKey === "direct" && input.payload.context !== undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Direct Agent上下文必须通过Prompt区域选择提交，不能同时提交旧Context字段",
      recoveryAction: "none",
    });
  }
  if (
    selectedRevision.blueprintKey !== "direct" &&
    input.payload.promptSelection !== undefined &&
    input.payload.context?.workspaceInstructions !== undefined
  ) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Workspace指令必须通过Prompt区域选择提交，不能同时提交旧Context字段",
      recoveryAction: "none",
    });
  }
  const selectedView =
    selectedRevision.workflowDefinitionRevisionId === SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID
      ? input.snapshot.entities.workflowViewDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID]
      : selectedRevision.workflowDefinitionRevisionId ===
          SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID
        ? input.snapshot.entities.workflowViewDefinitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID]
        : selectedRevision.workflowDefinitionRevisionId === SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID
          ? input.snapshot.entities.workflowViewDefinitions[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID]
          : selectedRevision.workflowDefinitionRevisionId === SYSTEM_PLANNING_WORKFLOW_REVISION_ID
            ? input.snapshot.entities.workflowViewDefinitions[SYSTEM_PLANNING_WORKFLOW_VIEW_ID]
            : selectedRevision.workflowDefinitionRevisionId === SYSTEM_NOTE_WORKFLOW_REVISION_ID
              ? input.snapshot.entities.workflowViewDefinitions[SYSTEM_NOTE_WORKFLOW_VIEW_ID]
              : createPublishedWorkflowView({ revision: selectedRevision, createdAt: input.now });
  if (selectedView === undefined) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Workflow View快照不存在",
      recoveryAction: "contact_support",
    });
  }
  const runConfiguration = input.payload.workflowSelection?.runConfiguration ?? {
    schemaVersion: "workflow-run-configuration.v1" as const,
    overrides: [],
  };
  const business = resolveSubmitBusinessInput({
    revision: selectedRevision,
    submitInput: input.payload.workflowSelection?.businessInput,
    messageId: input.messageId,
    sessionId: input.targetSessionId,
    sessionSequence: input.sessionSequence,
    text: input.payload.text,
    sourceMessageSha256: input.sourceMessageSha256,
  });
  const runner =
    selectedRevision.blueprintKey === "note"
      ? {
          runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
          runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
        }
      : selectedRevision.blueprintKey === "direct"
        ? {
            runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
            runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
          }
        : {
            runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
            runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
          };
  assertWorkflowResourceSelectionsAuthorized(input.snapshot, input.principalId, runConfiguration);
  const authorizedResources = listAuthorizedWorkflowResources(
    input.snapshot,
    input.principalId,
  ).map((resource) => resource.frozen);
  const noteAutoPolicyEnabled = selectedRevision.blueprintKey === "note";
  const availableResources = noteAutoPolicyEnabled
    ? [
        ...authorizedResources,
        {
          resourceKind: "rule" as const,
          resourceId: NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID,
          revision: NOTE_LOW_RISK_AUTO_POLICY_REVISION,
          sha256: NOTE_LOW_RISK_AUTO_POLICY_SHA256,
          status: "active" as const,
          allowedPrincipalIds: [input.principalId],
        },
      ]
    : authorizedResources;
  const compiled = compileWorkflowRunSpec({
    workflowRunSpecId: input.workflowRunSpecId,
    productRunId: input.productRunId,
    createdAt: input.now,
    definition: revisionToCompilerInput(selectedRevision),
    runConfiguration,
    principal: {
      principalId: input.principalId,
      capabilities: noteAutoPolicyEnabled ? ["workflow.review.auto"] : [],
    },
    availableResources,
    executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
    runner,
    businessInput: business.runSpecBusinessInput,
    ...(noteAutoPolicyEnabled
      ? {
          autoContinuePolicy: {
            resourceId: NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID,
            expectedRevision: NOTE_LOW_RISK_AUTO_POLICY_REVISION,
            expectedSha256: NOTE_LOW_RISK_AUTO_POLICY_SHA256,
          },
        }
      : {}),
  });
  if (!compiled.success) throw compilerDiagnosticsToError(compiled.diagnostics);
  if (input.submissionAuthorization !== undefined) {
    // 高影响能力检查位于纯Definition/RunSpec编译之后、任何Prompt或Runtime Adapter
    // 读取之前；普通入口在Runtime故障时仍稳定返回403。
    assertProjectBootstrapSubmissionAuthorized(input.submissionAuthorization.kind, {
      selectedRevision,
      runConfiguration,
      runSpec: compiled.runSpec,
    });
  }
  const promptSelection = input.payload.promptSelection ?? {
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    regions: [],
  };
  const promptAssembly =
    selectedRevision.blueprintKey === "direct"
      ? await compileDirectPromptAssembly(deps, {
          principalId: input.principalId,
          text: input.payload.text,
          selection: promptSelection,
          productSessionId: input.targetSessionId,
          productRunId: input.productRunId,
          sourceMessageId: input.messageId,
          sourceMessageSequence: input.sessionSequence,
          sourceMessageSha256: input.sourceMessageSha256,
          workflowDefinitionRevisionId: selectedRevision.workflowDefinitionRevisionId,
          nodeResolutions: compiled.runSpec.nodeResolutions,
          createdAt: input.now,
        })
      : deps.promptCatalog === undefined
        ? undefined
        : await compileWorkflowPromptAssembly(deps, {
            principalId: input.principalId,
            text: input.payload.text,
            selection: promptSelection,
            productSessionId: input.targetSessionId,
            productRunId: input.productRunId,
            sourceMessageId: input.messageId,
            workflowDefinitionRevisionId: selectedRevision.workflowDefinitionRevisionId,
            nodeResolutions: compiled.runSpec.nodeResolutions,
            createdAt: input.now,
          });
  return {
    selectedRevision,
    selectedView,
    runConfiguration,
    runner,
    compiled,
    promptAssembly,
  };
}

/**
 * 返回“此刻点击发送”将使用的完整Prompt读模型；不创建Session、Message或Run。
 * Preview ID仅用于让正式Prompt合同完成确定性编译，不是浏览器可复用的产品身份。
 */
export async function previewPromptTurn(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly payload: PreviewPromptTurnPayload },
) {
  const now = deps.now();
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const persistedSession =
    input.payload.sessionId === undefined
      ? undefined
      : snapshot.entities.sessions[input.payload.sessionId];
  if (input.payload.sessionId !== undefined && persistedSession === undefined) {
    throw notFound("Session不存在");
  }
  if (persistedSession !== undefined && persistedSession.ownerPrincipalId !== input.principalId) {
    throw forbidden("无权预览该Session的Prompt");
  }
  const previewIdentity = hashCanonical("prompt-turn-preview.v1", {
    principalId: input.principalId,
    ...(input.payload.sessionId === undefined ? {} : { sessionId: input.payload.sessionId }),
    message: input.payload.message,
  });
  const targetSessionId =
    input.payload.sessionId ??
    productSessionIdSchema.parse(`psn_preview${previewIdentity.slice(0, 28)}`);
  const messageId = messageIdSchema.parse(`msg_preview${previewIdentity.slice(0, 28)}`);
  const productRunId = productRunIdSchema.parse(`run_preview${previewIdentity.slice(0, 28)}`);
  const workflowRunSpecId = workflowRunSpecIdSchema.parse(
    `wrs_preview${previewIdentity.slice(0, 28)}`,
  );
  const sessionSequence = (persistedSession?.lastMessageSequence ?? 0) + 1;
  const sourceMessageSha256 = hashCanonical("message.v1", {
    messageId,
    sessionId: targetSessionId,
    sessionSequence,
    role: "user",
    content: { format: "markdown" as const, text: input.payload.message.text },
  });
  const prepared = await preparePromptTurn(deps, {
    principalId: input.principalId,
    payload: input.payload.message,
    now,
    snapshot,
    targetSessionId,
    messageId,
    productRunId,
    workflowRunSpecId,
    sessionSequence,
    sourceMessageSha256,
  });
  if (prepared.promptAssembly === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Prompt Catalog未配置，无法生成发送前预览",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
  const promptAssembly = prepared.promptAssembly;
  const nodes = await Promise.all(
    promptBearingNodes(prepared.compiled.runSpec.nodeResolutions).map(async (node) => {
      const binding = agentBindingForNode(node.nodeType, node.config);
      const directAssembly = promptAssembly.schemaVersion === "prompt-assembly.v4";
      const nodeAssembly = directAssembly
        ? promptAssembly
        : promptAssembly.schemaVersion === "prompt-assembly.v3"
          ? promptAssembly.nodes.find(
              (candidate) => candidate.definitionNodeId === node.definitionNodeId,
            )
          : undefined;
      if (nodeAssembly === undefined) throw new Error("Prompt节点Assembly不存在");
      const stage = directAssembly
        ? promptAssembly.tools.capabilityMode === "project_bootstrap"
          ? ("direct_pre_send_dynamic_extension" as const)
          : ("direct_pre_send" as const)
        : node.nodeType === "execute.plan"
          ? ("deferred_step_runtime" as const)
          : ("workflow_node_template" as const);
      return {
        definitionNodeId: node.definitionNodeId,
        nodeType: node.nodeType,
        agent: await getAgentProfile(deps, {
          principalId: input.principalId,
          agentKey: binding.agentKey,
          ...(promptAssembly.workspaceRootId === undefined
            ? {}
            : { workspaceRootId: promptAssembly.workspaceRootId }),
        }),
        runtimeResolution: {
          stage,
          governedSystemPromptAppend:
            governedUserPromptLayer(nodeAssembly.systemPromptAppend) ?? "",
          toolResolution: directAssembly ? ("frozen" as const) : ("runtime_deferred" as const),
          note:
            stage === "direct_pre_send"
              ? "Direct节点的能力与Chat层已经冻结；Workspace占位符会在Pi运行时填充，逐字节Provider请求以Prompt Review为准。"
              : stage === "direct_pre_send_dynamic_extension"
                ? "项目初始化复用Direct Pi AgentSession；基础能力已冻结，Plane/创建Root等动态合同会在执行授权后追加。"
                : stage === "deferred_step_runtime"
                  ? "Coding Executor的实际Pi System与Tools取决于用户批准计划中当前步骤的capabilityRefs，此时只能预览节点模板。"
                  : "这是Workflow节点发送前冻结的Chat管理层；节点固定Runtime System与最终Provider请求在执行时解析。",
        },
      };
    }),
  );
  return promptTurnPreviewDtoSchema.parse({
    schemaVersion: "chat-product-api.v1",
    status: "pre_send",
    currentInput: input.payload.message.text,
    assembly: prepared.promptAssembly,
    nodes,
  });
}

export async function submitUserMessage(
  deps: ApplicationDeps,
  input: SubmitUserMessageInput,
): Promise<{ session: SessionDto; message: MessageDto; run: RunDto }> {
  return submitUserMessageInternal(deps, input, "ordinary");
}

/**
 * 项目初始化专用Product Command。普通Message入口即使选择了默认值为bootstrap的
 * Workflow Definition也会失败；只有本用例能把显式的系统Direct单轮覆盖写入RunSpec。
 */
export async function submitProjectBootstrapUserMessage(
  deps: ApplicationDeps,
  input: SubmitUserMessageInput,
): Promise<{ session: SessionDto; message: MessageDto; run: RunDto }> {
  return submitUserMessageInternal(deps, input, "project_bootstrap_dedicated_entry");
}

function messageCommandHashDomain(
  submissionKind: MessageSubmissionKind,
  creatingProductSession: boolean,
): string {
  return submissionKind === "project_bootstrap_dedicated_entry"
    ? creatingProductSession
      ? "command.start-project-bootstrap-session-with-user-message.v1"
      : "command.submit-project-bootstrap-user-message.v1"
    : creatingProductSession
      ? "command.start-product-session-with-user-message.v1"
      : "command.submit-user-message.v1";
}

function computeMessageCommandRequestSha256(input: {
  readonly input: SubmitUserMessageInput;
  readonly submissionKind: MessageSubmissionKind;
  readonly creatingProductSession: boolean;
  readonly targetSessionId: ProductSessionId;
  readonly selectedRevision: WorkflowDefinitionRevision;
  readonly runConfiguration: WorkflowRunConfiguration;
  readonly requestBusinessInput: NoteCaptureSubmitInput | undefined;
}): string {
  return hashCanonical(
    messageCommandHashDomain(input.submissionKind, input.creatingProductSession),
    {
      principalId: input.input.principalId,
      ...(input.creatingProductSession ? {} : { sessionId: input.targetSessionId }),
      payload: {
        ...input.input.payload,
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: input.selectedRevision.workflowDefinitionRevisionId,
          // 显式CAS是Command payload的一部分，必须逐字进入Receipt Hash。只有调用方
          // 整个省略workflowSelection时，才能补系统默认Revision/Hash。
          definitionSha256:
            input.input.payload.workflowSelection?.definitionSha256 ??
            input.selectedRevision.definitionSha256,
          runConfiguration: input.runConfiguration,
          ...(input.requestBusinessInput === undefined
            ? {}
            : { businessInput: input.requestBusinessInput }),
        },
      },
    },
  );
}

function messageReceiptCorrupted(message: string): never {
  throw new ApplicationError({
    code: "store_corrupted",
    httpStatus: 500,
    message,
    recoveryAction: "contact_support",
  });
}

function readMessageReplayBase(
  snapshot: ProductSnapshot,
  resultRefs: Readonly<Record<string, string>>,
): { readonly session: ProductSession; readonly message: Message; readonly run: ProductRun } {
  const message = snapshot.entities.messages[resultRefs["messageId"] ?? ""];
  const run = snapshot.entities.runs[resultRefs["productRunId"] ?? ""];
  const session = run === undefined ? undefined : snapshot.entities.sessions[run.sessionId];
  if (
    message === undefined ||
    run === undefined ||
    session === undefined ||
    message.role !== "user" ||
    message.messageId !== run.sourceMessageId ||
    message.sessionId !== run.sessionId
  ) {
    return messageReceiptCorrupted("Message Command Receipt结果引用不完整");
  }
  return { session, message, run };
}

function submittedMessageResultFromReceipt(
  snapshot: ProductSnapshot,
  receipt: { readonly resultRefs: Readonly<Record<string, string>> },
  input: Pick<SubmitUserMessageInput, "principalId" | "sessionId">,
): { session: SessionDto; message: MessageDto; run: RunDto } {
  const facts = readMessageReplayBase(snapshot, receipt.resultRefs);
  if (facts.session.ownerPrincipalId !== input.principalId) {
    throw forbidden("无权读取该Message Receipt");
  }
  if (input.sessionId !== undefined && input.sessionId !== facts.session.sessionId) {
    return messageReceiptCorrupted("Message Receipt与请求Session身份不一致");
  }
  return {
    session: toSessionDto(facts.session),
    message: toMessageDto(facts.message),
    run: toRunDto(facts.run, undefined, undefined),
  };
}

function validateReplayRunSpec(
  snapshot: ProductSnapshot,
  run: ProductRun,
): {
  readonly selectedRevision: WorkflowDefinitionRevision;
  readonly runSpec: WorkflowRunSpec;
} {
  const runSpecId = run.workflowRunSpecId;
  const runSpec =
    runSpecId === undefined ? undefined : snapshot.entities.workflowRunSpecs[runSpecId];
  const selectedRevision =
    runSpec === undefined
      ? undefined
      : snapshot.entities.workflowDefinitionRevisions[
          runSpec.definitionRef.workflowDefinitionRevisionId
        ];
  const definition =
    selectedRevision === undefined
      ? undefined
      : snapshot.entities.workflowDefinitions[selectedRevision.workflowDefinitionId];
  const view = snapshot.entities.workflowViewDefinitions[run.workflowViewDefinitionId];
  const integrity = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
  if (
    runSpec === undefined ||
    selectedRevision === undefined ||
    definition === undefined ||
    view === undefined ||
    integrity?.success !== true ||
    runSpec.workflowRunSpecId !== runSpecId ||
    runSpec.productRunId !== run.productRunId ||
    runSpec.definitionRef.workflowDefinitionRevisionId !==
      selectedRevision.workflowDefinitionRevisionId ||
    runSpec.definitionRef.definitionRevision !== selectedRevision.definitionRevision ||
    runSpec.definitionRef.definitionSha256 !== selectedRevision.definitionSha256 ||
    runSpec.definitionRef.blueprintKey !== selectedRevision.blueprintKey ||
    runSpec.definitionRef.blueprintVersion !== selectedRevision.blueprintVersion ||
    runSpec.runner.runnerFamily !== run.runnerFamily ||
    runSpec.runner.runnerBundleVersion !== run.runnerBundleVersion ||
    hashCanonical("workflow-definition.v1", runSpec.semanticRoot) !==
      selectedRevision.definitionSha256 ||
    selectedRevision.workflowDefinitionId !== definition.workflowDefinitionId ||
    !["published", "superseded"].includes(selectedRevision.state) ||
    selectedRevision.publishedAt === undefined ||
    selectedRevision.definitionSha256 !==
      hashCanonical("workflow-definition.v1", selectedRevision.semanticRoot) ||
    view.sha256 !== computeWorkflowViewDefinitionSha256(view) ||
    view.source.kind !== "published_definition" ||
    view.source.workflowDefinitionId !== selectedRevision.workflowDefinitionId ||
    view.source.definitionRevision !== selectedRevision.definitionRevision ||
    view.source.definitionSha256 !== selectedRevision.definitionSha256 ||
    view.source.blueprintKey !== selectedRevision.blueprintKey ||
    view.source.blueprintVersion !== String(selectedRevision.blueprintVersion)
  ) {
    return messageReceiptCorrupted("Message Command RunSpec或Definition绑定不完整");
  }
  return { selectedRevision, runSpec };
}

function isDedicatedProjectBootstrapReplay(
  selectedRevision: WorkflowDefinitionRevision,
  runSpec: WorkflowRunSpec,
): boolean {
  return (
    selectedRevision.workflowDefinitionRevisionId === SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID &&
    selectedRevision.blueprintKey === "direct" &&
    runSpec.nodeResolutions.some(
      (node) =>
        node.nodeType === "agent.direct" &&
        node.activation === "enabled" &&
        node.config["capabilityMode"] === "project_bootstrap",
    )
  );
}

/**
 * 最老v1/v2 Message在Definition Kernel出现前提交，Run没有RunSpec，Receipt也只有
 * Message/Run引用。这里不伪造RunSpec，而是严格验证迁移冻结的legacy runner、View、
 * 退役Definition Revision/Hash和旧命令Hash；该分支只接受旧existing-session普通命令。
 */
function readLegacyPlanningMessageReplay(
  snapshot: ProductSnapshot,
  input: SubmitUserMessageInput,
  receipt: ProductSnapshot["commandReceipts"][string],
  facts: ReturnType<typeof readMessageReplayBase>,
): {
  readonly expectedRequestSha256: string;
  readonly result: { session: SessionDto; message: MessageDto; run: RunDto };
} {
  if (
    receipt.commandType !== "SubmitUserMessage" ||
    input.sessionId === undefined ||
    input.sessionId !== facts.session.sessionId ||
    facts.session.ownerPrincipalId !== input.principalId
  ) {
    throw new CommandIdReusedError(input.commandId);
  }
  const receiptRunSpecId = receipt.resultRefs["workflowRunSpecId"];
  if (
    (receiptRunSpecId !== undefined && receiptRunSpecId !== facts.run.workflowRunSpecId) ||
    facts.run.runnerBundleVersion !== LEGACY_PLANNING_RUNNER_BUNDLE_VERSION
  ) {
    return messageReceiptCorrupted("Legacy Message Receipt的RunSpec或Runner绑定不一致");
  }

  if (facts.run.workflowRunSpecId === undefined) {
    const view = snapshot.entities.workflowViewDefinitions[facts.run.workflowViewDefinitionId];
    const definition =
      snapshot.entities.workflowDefinitions[SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID];
    const revision =
      snapshot.entities.workflowDefinitionRevisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
    if (
      facts.run.runKind !== "planning" ||
      facts.run.workflowViewDefinitionId !== LEGACY_PLANNING_VIEW_ID ||
      view === undefined ||
      view.source.kind !== "legacy_code" ||
      view.sha256 !== computeWorkflowViewDefinitionSha256(view) ||
      definition === undefined ||
      revision === undefined ||
      revision.workflowDefinitionId !== definition.workflowDefinitionId ||
      revision.definitionSha256 !== hashCanonical("workflow-definition.v1", revision.semanticRoot)
    ) {
      return messageReceiptCorrupted("Legacy Message Run的View或Definition证据不完整");
    }
  } else {
    validateReplayRunSpec(snapshot, facts.run);
  }

  const requestSha256 = hashCanonical("command.submit-user-message.v1", {
    principalId: input.principalId,
    sessionId: facts.session.sessionId,
    payload: input.payload,
  });
  return {
    expectedRequestSha256: requestSha256,
    result: {
      session: toSessionDto(facts.session),
      message: toMessageDto(facts.message),
      run: toRunDto(facts.run, undefined, undefined),
    },
  };
}

interface MessageCommandReplayProbe {
  readonly commandType: "SubmitUserMessage" | "SubmitProjectBootstrapUserMessage";
  readonly expectedRequestSha256: string;
  readonly result: { session: SessionDto; message: MessageDto; run: RunDto };
}

/**
 * Receipt重放只能读取Product Store中已提交的不可变身份，不能先触达Prompt Catalog、
 * Agent Runtime或Provider。旧v1 Receipt的Hash包含规范化Workflow选择，因此这里从
 * 已提交RunSpec/Message和本次原始输入重建同一Hash，再返回首次resultRefs。
 */
function readMessageCommandReplay(
  snapshot: ProductSnapshot,
  input: SubmitUserMessageInput,
  currentSubmissionKind: MessageSubmissionKind,
): MessageCommandReplayProbe | undefined {
  const receipt = snapshot.commandReceipts[input.commandId];
  if (receipt === undefined) return undefined;
  const receiptSubmissionKind: MessageSubmissionKind =
    receipt.commandType === "SubmitUserMessage"
      ? "ordinary"
      : receipt.commandType === "SubmitProjectBootstrapUserMessage"
        ? "project_bootstrap_dedicated_entry"
        : (() => {
            throw new CommandIdReusedError(input.commandId);
          })();
  // 专用入口是一次性授权边界，不能消费任何普通Receipt，包括最老legacy Receipt。
  // 该矩阵判断只依赖已读取的Receipt，必须早于产品事实遍历和所有外部依赖。
  if (
    currentSubmissionKind === "project_bootstrap_dedicated_entry" &&
    receiptSubmissionKind === "ordinary"
  ) {
    throw new CommandIdReusedError(input.commandId);
  }
  const facts = readMessageReplayBase(snapshot, receipt.resultRefs);
  if (facts.run.runnerFamily === LEGACY_PLANNING_RUNNER_FAMILY) {
    const replay = readLegacyPlanningMessageReplay(snapshot, input, receipt, facts);
    return {
      commandType: "SubmitUserMessage",
      expectedRequestSha256: replay.expectedRequestSha256,
      result: replay.result,
    };
  }
  const persistedRunSpecId = facts.run.workflowRunSpecId;
  if (
    persistedRunSpecId === undefined ||
    receipt.resultRefs["workflowRunSpecId"] !== persistedRunSpecId
  ) {
    return messageReceiptCorrupted("Message Command Receipt缺少精确RunSpec引用");
  }
  const { selectedRevision, runSpec } = validateReplayRunSpec(snapshot, facts.run);
  if (
    currentSubmissionKind === "ordinary" &&
    receiptSubmissionKind === "project_bootstrap_dedicated_entry" &&
    (input.sessionId === undefined || !isDedicatedProjectBootstrapReplay(selectedRevision, runSpec))
  ) {
    // 唯一跨入口兼容是v12/v13半绑定恢复：当前必须已知Product Session，且Product
    // RunSpec必须证明原命令确实冻结了专用bootstrap能力。新Command没有Receipt，
    // 永远到不了此分支。
    throw new CommandIdReusedError(input.commandId);
  }
  const requestedRevisionId =
    input.payload.workflowSelection?.workflowDefinitionRevisionId ??
    SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID;
  if (
    requestedRevisionId !== selectedRevision.workflowDefinitionRevisionId ||
    (input.payload.workflowSelection?.definitionSha256 !== undefined &&
      input.payload.workflowSelection.definitionSha256 !== selectedRevision.definitionSha256) ||
    (input.sessionId !== undefined && input.sessionId !== facts.session.sessionId)
  ) {
    throw new CommandIdReusedError(input.commandId);
  }
  const creatingProductSession = input.sessionId === undefined;
  const sourceMessageSha256 = hashCanonical("message.v1", {
    messageId: facts.message.messageId,
    sessionId: facts.message.sessionId,
    sessionSequence: facts.message.sessionSequence,
    role: "user",
    content: { format: "markdown" as const, text: input.payload.text },
  });
  let business: ReturnType<typeof resolveSubmitBusinessInput>;
  try {
    business = resolveSubmitBusinessInput({
      revision: selectedRevision,
      submitInput: input.payload.workflowSelection?.businessInput,
      messageId: facts.message.messageId,
      sessionId: facts.session.sessionId,
      sessionSequence: facts.message.sessionSequence,
      text: input.payload.text,
      sourceMessageSha256,
    });
  } catch {
    throw new CommandIdReusedError(input.commandId);
  }
  const requestHashInput = {
    input,
    // v12无法仅凭Bridge状态证明旧Request是否来自专用入口。只有已提交的Product
    // Receipt能证明原Command种类；重放按该种类验Hash，不会给新命令开放授权旁路。
    submissionKind: receiptSubmissionKind,
    targetSessionId: facts.session.sessionId,
    selectedRevision,
    runConfiguration: input.payload.workflowSelection?.runConfiguration ?? {
      schemaVersion: "workflow-run-configuration.v1" as const,
      overrides: [],
    },
    requestBusinessInput: business.requestBusinessInput,
  };
  const possibleRequestHashes = [
    computeMessageCommandRequestSha256({
      ...requestHashInput,
      creatingProductSession,
    }),
  ];
  if (currentSubmissionKind === "ordinary" && input.sessionId !== undefined) {
    // v12/v13可能留下“Product Session已保存、Run尚未保存”的首轮半绑定。只允许
    // 当前普通existing-session恢复原首轮Hash；反方向和当前专用入口都不接受另一域。
    possibleRequestHashes.push(
      computeMessageCommandRequestSha256({
        ...requestHashInput,
        creatingProductSession: true,
      }),
    );
  }
  const expectedRequestSha256 =
    possibleRequestHashes.find((candidate) => candidate === receipt.requestSha256) ??
    possibleRequestHashes[0];
  if (expectedRequestSha256 === undefined) {
    return messageReceiptCorrupted("Message Command Receipt缺少可验证Hash域");
  }
  return {
    commandType:
      receiptSubmissionKind === "project_bootstrap_dedicated_entry"
        ? "SubmitProjectBootstrapUserMessage"
        : "SubmitUserMessage",
    expectedRequestSha256,
    result: {
      session: toSessionDto(facts.session),
      message: toMessageDto(facts.message),
      run: toRunDto(facts.run, undefined, undefined),
    },
  };
}

async function submitUserMessageInternal(
  deps: ApplicationDeps,
  input: SubmitUserMessageInput,
  submissionKind: MessageSubmissionKind,
): Promise<{ session: SessionDto; message: MessageDto; run: RunDto }> {
  let replayResult: MessageCommandReplayProbe["result"] | undefined;
  const {
    snapshot: preflightSnapshot,
    identity: { requestSha256 },
    receipt: priorReceipt,
  } = await readExactCommandReceipt(deps.store, (snapshot) => {
    const replay = readMessageCommandReplay(snapshot, input, submissionKind);
    if (replay !== undefined) {
      replayResult = replay.result;
      return {
        commandId: input.commandId,
        commandType: replay.commandType,
        requestSha256: replay.expectedRequestSha256,
      };
    }
    return {
      commandId: input.commandId,
      commandType:
        submissionKind === "project_bootstrap_dedicated_entry"
          ? "SubmitProjectBootstrapUserMessage"
          : "SubmitUserMessage",
      requestSha256: submitUserMessageRequestSha256(input, snapshot, submissionKind),
    };
  });
  if (priorReceipt !== undefined) {
    if (replayResult === undefined) {
      return messageReceiptCorrupted("Message Command Receipt未形成可恢复结果");
    }
    return replayResult;
  }

  const now = deps.now();
  const messageId = deps.ids.message();
  const creatingProductSession = input.sessionId === undefined;
  const targetSessionId = input.sessionId ?? deps.ids.session();
  const productRunId = deps.ids.run();
  const outboxId = deps.ids.outbox();
  const workflowAttemptId = deps.ids.attempt();
  const workflowRunSpecId = workflowRunSpecIdSchema.parse(
    `wrs_${hashCanonical("id.workflow-run-spec.v1", { productRunId }).slice(0, 32)}`,
  );
  const persistedPreflightSession = preflightSnapshot.entities.sessions[targetSessionId];
  if (!creatingProductSession && persistedPreflightSession === undefined) {
    throw notFound("Session不存在");
  }
  if (creatingProductSession && persistedPreflightSession !== undefined) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Product Session ID冲突",
      recoveryAction: "contact_support",
    });
  }
  const preflightSession: ProductSession = persistedPreflightSession ?? {
    schemaVersion: "product-session.v1",
    sessionId: targetSessionId,
    ownerPrincipalId: input.principalId,
    status: "active",
    title: productSessionTitleFromFirstMessage(input.payload.text),
    lastMessageSequence: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (preflightSession.ownerPrincipalId !== input.principalId) {
    throw forbidden("无权向该Session发送消息");
  }
  const preflightSessionSequence = preflightSession.lastMessageSequence + 1;
  const sourceMessageSha256 = hashCanonical("message.v1", {
    messageId,
    sessionId: targetSessionId,
    sessionSequence: preflightSessionSequence,
    role: "user",
    content: { format: "markdown" as const, text: input.payload.text },
  });
  const { selectedRevision, selectedView, runConfiguration, runner, compiled, promptAssembly } =
    await preparePromptTurn(deps, {
      principalId: input.principalId,
      payload: input.payload,
      now,
      snapshot: preflightSnapshot,
      targetSessionId,
      messageId,
      productRunId,
      workflowRunSpecId,
      sessionSequence: preflightSessionSequence,
      sourceMessageSha256,
      submissionAuthorization: { kind: submissionKind },
    });
  if (
    submissionKind === "project_bootstrap_dedicated_entry" &&
    (deps.projectBootstrapIds === undefined ||
      deps.projectManagementBootstrap === undefined ||
      deps.projectWorkspaceProvisioner === undefined)
  ) {
    throw new ApplicationError({
      code: "revision_conflict",
      httpStatus: 409,
      message: "Project Bootstrap能力未配置",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const contextRequestId = contextRequestIdSchema.parse(
    `ctxr_${hashCanonical("id.run-context-request.v1", { productRunId }).slice(0, 32)}`,
  );

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType:
      submissionKind === "project_bootstrap_dedicated_entry"
        ? "SubmitProjectBootstrapUserMessage"
        : "SubmitUserMessage",
    requestSha256,
    traceContext: { productRunId, productSessionId: targetSessionId },
    mutate: (draft) => {
      const persistedSession = draft.entities.sessions[targetSessionId];
      if (!creatingProductSession && persistedSession === undefined) {
        throw notFound("Session不存在");
      }
      if (creatingProductSession && persistedSession !== undefined) {
        throw new ApplicationError({
          code: "store_corrupted",
          httpStatus: 500,
          message: "Product Session ID冲突",
          recoveryAction: "contact_support",
        });
      }
      const session: ProductSession = persistedSession ?? {
        schemaVersion: "product-session.v1",
        sessionId: targetSessionId,
        ownerPrincipalId: input.principalId,
        status: "active",
        title: productSessionTitleFromFirstMessage(input.payload.text),
        lastMessageSequence: 0,
        // 该对象只是本事务的未提交基线；最终会话以revision 1与首条Message一起落盘。
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (session.ownerPrincipalId !== input.principalId) {
        throw forbidden("无权向该Session发送消息");
      }
      const sessionSequence = session.lastMessageSequence + 1;
      if (sessionSequence !== preflightSessionSequence) {
        throw revisionConflict("Session消息序号已变化，请刷新后重试");
      }
      // Message是用户输入的耐久会话事实；ProductRun是“围绕该消息推进一次工作”的生命周期事实。
      // 两者分开后，同一Session可保留完整消息历史，而每次工作有独立状态机和revision。
      const message: Message = {
        schemaVersion: "message.v1",
        messageId,
        sessionId: targetSessionId,
        sessionSequence,
        role: "user",
        content: { format: "markdown", text: input.payload.text },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const run: ProductRun =
        selectedRevision.blueprintKey === "note"
          ? {
              schemaVersion: "product-run.v3",
              runKind: "note_capture",
              productRunId,
              sessionId: targetSessionId,
              sourceMessageId: messageId,
              workflowViewDefinitionId: selectedView.workflowViewDefinitionId,
              workflowRunSpecId,
              runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
              runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
              status: "pending",
              phase: "queued",
              revision: 1,
              createdAt: now,
              updatedAt: now,
            }
          : selectedRevision.blueprintKey === "direct"
            ? {
                schemaVersion: "product-run.v3",
                runKind: "direct_agent",
                productRunId,
                sessionId: targetSessionId,
                sourceMessageId: messageId,
                workflowViewDefinitionId: selectedView.workflowViewDefinitionId,
                workflowRunSpecId,
                runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
                runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
                status: "pending",
                phase: "queued",
                revision: 1,
                createdAt: now,
                updatedAt: now,
              }
            : {
                schemaVersion: "product-run.v3",
                runKind: "planning",
                productRunId,
                sessionId: targetSessionId,
                sourceMessageId: messageId,
                workflowViewDefinitionId: selectedView.workflowViewDefinitionId,
                workflowRunSpecId,
                runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
                runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
                status: "pending",
                phase: "queued",
                maxPlanRevisions: DEFAULT_MAX_PLAN_REVISIONS,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              };
      const selectedMemory = input.payload.context?.memory;
      const normalizedMemory =
        selectedMemory === undefined
          ? undefined
          : {
              ...selectedMemory,
              tags: [...new Set(selectedMemory.tags.map((tag) => tag.trim().toLowerCase()))].sort(),
              layers: (["L1", "L2", "L3", "Skill"] as const).filter((layer) =>
                selectedMemory.layers.includes(layer),
              ),
            };
      const workspaceInstructions =
        input.payload.context?.workspaceInstructions === undefined
          ? undefined
          : (() => {
              const items = input.payload.context.workspaceInstructions.items.map((item) => ({
                content: item.content,
                sha256: computeWorkspaceInstructionItemSha256(item.content),
              }));
              const totalContentCharacters = items.reduce(
                (total, item) => total + item.content.length,
                0,
              );
              return {
                schemaVersion: "workspace-instructions-snapshot.v1" as const,
                items,
                totalContentCharacters,
                sha256: computeWorkspaceInstructionsSha256({
                  items,
                  totalContentCharacters,
                }),
              };
            })();
      // ContextRequest保存“本轮请求了什么”及来源Message Hash，不保存外部Memory查询结果；
      // Workspace指令也在这里冻结，避免同一请求重试或Plan修订时因文件变化而漂移。
      const contextRequestShape = {
        productRunId,
        requestedByPrincipalId: input.principalId,
        sourceMessageId: messageId,
        sourceMessageSha256,
        ...(normalizedMemory !== undefined ? { memory: normalizedMemory } : {}),
        ...(workspaceInstructions !== undefined ? { workspaceInstructions } : {}),
      };
      draft.entities.messages[messageId] = message;
      draft.entities.runs[productRunId] = run;
      if (promptAssembly !== undefined) {
        // RunSpec与Assembly在同一事务后半段才写入；来源复核必须使用本轮已经完成
        // Hash校验的编译结果，不能因Store里尚无新RunSpec而把Agent Version误判为漂移。
        assertPromptAssemblySourcesCurrent(
          draft,
          promptAssembly,
          input.principalId,
          compiled.runSpec,
        );
        draft.entities.promptAssemblies[promptAssembly.promptAssemblyId] = promptAssembly;
      }
      const currentRevision = resolvePublishedWorkflowRevision(
        draft,
        input.payload,
        input.principalId,
      );
      if (
        currentRevision.workflowDefinitionRevisionId !==
        selectedRevision.workflowDefinitionRevisionId
      ) {
        throw new ApplicationError({
          code: "definition_stale",
          httpStatus: 409,
          message: "Workflow Definition已变化，请刷新后重试",
          recoveryAction: "rehydrate_and_retry",
        });
      }
      const currentView =
        draft.entities.workflowViewDefinitions[selectedView.workflowViewDefinitionId];
      if (currentView !== undefined && currentView.sha256 !== selectedView.sha256) {
        throw new ApplicationError({
          code: "store_corrupted",
          httpStatus: 500,
          message: "Workflow View身份发生Hash冲突",
          recoveryAction: "contact_support",
        });
      }
      if (currentView === undefined) {
        draft.entities.workflowViewDefinitions[selectedView.workflowViewDefinitionId] =
          selectedView;
      }
      assertWorkflowResourceSelectionsAuthorized(draft, input.principalId, runConfiguration);
      const resourceDrift = validateRunSpecResourcesCurrent(
        compiled.runSpec,
        listAuthorizedWorkflowResources(draft, input.principalId).map(
          (resource) => resource.frozen,
        ),
      );
      if (resourceDrift.length > 0) throw compilerDiagnosticsToError(resourceDrift);
      draft.entities.workflowRunSpecs[workflowRunSpecId] = compiled.runSpec;
      // 即使本轮没有选择Memory也保存ContextRequest，明确区分“未选择”与事实丢失。
      const contextRequestSha256 = computeRunContextRequestSha256(contextRequestShape);
      draft.entities.contextRequests[contextRequestId] =
        workspaceInstructions === undefined
          ? {
              schemaVersion: "run-context-request.v1",
              contextRequestId,
              productRunId,
              requestedByPrincipalId: input.principalId,
              sourceMessageId: messageId,
              sourceMessageSha256,
              ...(normalizedMemory !== undefined ? { memory: normalizedMemory } : {}),
              sha256: contextRequestSha256,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            }
          : {
              schemaVersion: "run-context-request.v2",
              contextRequestId,
              productRunId,
              requestedByPrincipalId: input.principalId,
              sourceMessageId: messageId,
              sourceMessageSha256,
              ...(normalizedMemory !== undefined ? { memory: normalizedMemory } : {}),
              workspaceInstructions,
              sha256: contextRequestSha256,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            };
      // 一个Product Run对应一个Workflow执行Attempt（Trace关联与生命周期看护）
      draft.entities.attempts[workflowAttemptId] = {
        schemaVersion: "run-attempt.v1",
        attemptId: workflowAttemptId,
        productRunId,
        kind: "workflow",
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.sessions[targetSessionId] = {
        ...session,
        lastMessageSequence: sessionSequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      // 调试导航⑥：Workflow Start Outbox与产品事实同一次快照提交。
      // Outbox只保存Chat拥有的productRunId和派发状态，不保存Workflow Run ID/Hook Token；
      // 即使进程在事务提交后立即崩溃，Dispatcher仍能从pending事实恢复派发。
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "workflow_start",
        status: "pending",
        productRunId,
        workflowRunSpecId,
        runnerFamily: runner.runnerFamily,
        runnerBundleVersion: runner.runnerBundleVersion,
        dispatchAttempts: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (run.runKind === "planning")
        synchronizePlanningWorkflowProjection(draft, productRunId, now);
      return { resultRefs: { messageId, productRunId, workflowRunSpecId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const response = submittedMessageResultFromReceipt(
    snapshot,
    { resultRefs: result.resultRefs },
    input,
  );
  if (!result.replayed) {
    emitRunEvent(deps, response.run.productRunId, {
      level: "info",
      eventName: "product_run.created",
      outcome: "success",
      productRunId: response.run.productRunId,
      productSessionId: response.run.sessionId,
      runStatus: response.run.status,
      phase: response.run.phase,
      revision: response.run.revision,
    });
  }
  return response;
}

function resolveSubmitBusinessInput(input: {
  readonly revision: WorkflowDefinitionRevision;
  readonly submitInput: NoteCaptureSubmitInput | undefined;
  readonly messageId: Message["messageId"];
  readonly sessionId: ProductSessionId;
  readonly sessionSequence: number;
  readonly text: string;
  readonly sourceMessageSha256: string;
}): {
  readonly runSpecBusinessInput: WorkflowRunBusinessInput;
  readonly requestBusinessInput?: NoteCaptureSubmitInput | undefined;
} {
  if (input.revision.blueprintKey === "planning") {
    if (input.submitInput !== undefined) {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 422,
        message: "Planning Workflow不得携带Note Capture输入",
      });
    }
    return { runSpecBusinessInput: { kind: "planning_message" } };
  }

  if (input.revision.blueprintKey === "direct") {
    if (input.submitInput !== undefined) {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 422,
        message: "Direct Agent Workflow不得携带Note Capture输入",
      });
    }
    return { runSpecBusinessInput: { kind: "direct_agent_message" } };
  }

  if (input.revision.blueprintKey !== "note") {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "未知Workflow Blueprint",
    });
  }

  const noteInput = input.submitInput ?? { kind: "note_capture" as const };
  const definitionDefaults = noteExtractDefinitionDefaults(input.revision);
  const sourceIntent = noteInput.source ?? { kind: "full_message" as const };
  const source = resolveNoteSubmitSource({
    source: sourceIntent,
    messageId: input.messageId,
    sessionId: input.sessionId,
    sessionSequence: input.sessionSequence,
    text: input.text,
    sourceMessageSha256: input.sourceMessageSha256,
  });
  const defaultKind: NoteKind = noteInput.defaultKind ?? definitionDefaults.defaultKind;
  const suggestedTags: NoteTag[] = normalizeNoteTags(
    noteInput.suggestedTagLabels ?? definitionDefaults.suggestedTagLabels,
  );
  return {
    runSpecBusinessInput: {
      kind: "note_capture",
      source,
      defaultKind,
      suggestedTags,
    },
    requestBusinessInput: {
      kind: "note_capture",
      source:
        sourceIntent.kind === "full_message"
          ? { kind: "full_message" }
          : {
              kind: "selection",
              startUtf16: sourceIntent.startUtf16,
              endUtf16: sourceIntent.endUtf16,
              selectedTextSha256: sourceIntent.selectedTextSha256,
            },
      defaultKind,
      suggestedTagLabels: suggestedTags.map((tag) => tag.label),
    },
  };
}

/**
 * Definition默认值只从已验证、已规范化的note.extract节点读取；浏览器按字段覆盖。
 * 不能在Run开始后回读Catalog最新默认值，否则旧Published Revision会发生语义漂移。
 */
function noteExtractDefinitionDefaults(revision: WorkflowDefinitionRevision): {
  readonly defaultKind: NoteKind;
  readonly suggestedTagLabels: readonly string[];
} {
  const stack = [...revision.semanticRoot.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") {
      if (element.nodeType !== "note.extract") continue;
      const parsed = DEFAULT_NODE_CATALOG.parseConfig(
        element.nodeType,
        element.schemaVersion,
        element.config,
      );
      const defaultKind = parsed.success
        ? noteKindSchema.safeParse(parsed.data["defaultKind"])
        : undefined;
      const suggestedTagLabels = parsed.success ? parsed.data["suggestedTagLabels"] : undefined;
      if (
        defaultKind === undefined ||
        !defaultKind.success ||
        !Array.isArray(suggestedTagLabels) ||
        !suggestedTagLabels.every((item): item is string => typeof item === "string")
      ) {
        break;
      }
      return { defaultKind: defaultKind.data, suggestedTagLabels };
    }
    if (element.kind === "sequence") {
      stack.push(...element.elements);
    } else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else {
      stack.push(...element.body.elements);
    }
  }
  throw new ApplicationError({
    code: "store_corrupted",
    httpStatus: 500,
    message: "Note Definition缺少合法的note.extract默认配置",
    recoveryAction: "contact_support",
  });
}

function resolveNoteSubmitSource(input: {
  readonly source: NonNullable<NoteCaptureSubmitInput["source"]>;
  readonly messageId: Message["messageId"];
  readonly sessionId: ProductSessionId;
  readonly sessionSequence: number;
  readonly text: string;
  readonly sourceMessageSha256: string;
}): NoteSourceRef {
  const message = {
    messageId: input.messageId,
    sessionId: input.sessionId,
    sessionSequence: input.sessionSequence,
    role: "user" as const,
    content: { format: "markdown" as const, text: input.text },
  };
  const sourceRef: NoteSourceRef =
    input.source.kind === "full_message"
      ? {
          kind: "full_message",
          sourceMessageId: input.messageId,
          sourceMessageSha256: input.sourceMessageSha256,
        }
      : {
          kind: "utf16_range",
          sourceMessageId: input.messageId,
          sourceMessageSha256: input.sourceMessageSha256,
          startUtf16: input.source.startUtf16,
          endUtf16: input.source.endUtf16,
          selectedTextSha256: input.source.selectedTextSha256,
        };
  try {
    const selected = resolveNoteSourceText({ message, sourceRef });
    if (sourceRef.kind === "utf16_range" && sha256Hex(selected) !== sourceRef.selectedTextSha256) {
      throw new Error("selection_hash_mismatch");
    }
    return sourceRef;
  } catch {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Note来源选区与本次消息不一致",
    });
  }
}

function resolvePublishedWorkflowRevision(
  snapshot: ProductSnapshot,
  payload: SubmitMessagePayload,
  principalId: PrincipalId,
): WorkflowDefinitionRevision {
  const revisionId =
    payload.workflowSelection?.workflowDefinitionRevisionId ??
    SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID;
  const revision = snapshot.entities.workflowDefinitionRevisions[revisionId];
  if (revision === undefined || revision.state !== "published") {
    throw new ApplicationError({
      code: "definition_stale",
      httpStatus: 409,
      message: "Workflow Definition不存在或未发布",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const definition = snapshot.entities.workflowDefinitions[revision.workflowDefinitionId];
  if (
    definition === undefined ||
    definition.status !== "active" ||
    definition.publishedRevisionId !== revision.workflowDefinitionRevisionId
  ) {
    throw new ApplicationError({
      code: "definition_stale",
      httpStatus: 409,
      message: "Workflow Definition不存在、未激活或已被替换",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  if (definition.ownerKind === "principal" && definition.ownerPrincipalId !== principalId) {
    throw forbidden("无权使用该Workflow Definition");
  }
  const expected = payload.workflowSelection?.definitionSha256;
  if (expected !== undefined && expected !== revision.definitionSha256) {
    throw new ApplicationError({
      code: "definition_stale",
      httpStatus: 409,
      message: "Workflow Definition Hash已过期",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  return revision;
}

function revisionToCompilerInput(revision: WorkflowDefinitionRevision) {
  return {
    schemaVersion: "workflow-definition-revision-input.v1" as const,
    workflowDefinitionRevisionId: revision.workflowDefinitionRevisionId,
    definitionRevision: revision.definitionRevision,
    blueprintKey: revision.blueprintKey,
    blueprintVersion: revision.blueprintVersion,
    semanticRoot: revision.semanticRoot,
    expectedSha256: revision.definitionSha256,
  };
}

function compilerDiagnosticsToError(diagnostics: readonly WorkflowDiagnostic[]): ApplicationError {
  const first = diagnostics[0];
  const family = first?.family;
  if (family === "resource_stale") {
    return new ApplicationError({
      code: "resource_stale",
      httpStatus: 409,
      message: "运行资源已变化，请刷新后重试",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  if (family === "policy_denied") {
    return new ApplicationError({
      code: "policy_denied",
      httpStatus: 422,
      message: "当前Workflow配置被策略拒绝",
    });
  }
  if (first?.code === "definition.hash_stale") {
    return new ApplicationError({
      code: "definition_stale",
      httpStatus: 409,
      message: "Workflow Definition Hash已过期",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  return new ApplicationError({
    code: "validation_failed",
    httpStatus: 422,
    message: "Workflow配置不符合合同",
  });
}
