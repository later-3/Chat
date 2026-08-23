import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type ApprovalRequestId,
  type MemoryImportIntentId,
  type MemoryImportResultId,
  type MemoryWriteIntentId,
  type MemoryWriteResultId,
  type NoteCandidateId,
  type OutboxEntryId,
  type ProductRunId,
  type ProjectCandidateId,
  type PromptReviewDecisionId,
  type PromptReviewRequestId,
} from "@chat/contracts";
import {
  DIRECT_AGENT_RUNNER_FAMILY,
  MEMORY_DIRECT_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_FAMILY,
  type ProductWorkflowRunnerFamily,
} from "./definition-kernel-executor-registry.js";
import {
  RuntimeBindingError,
  assertRuntimeBindingsIntegrity,
  emptyBindings,
  normalizeProductRunnerEvidence,
  parseRuntimeBindingsFile,
  runtimeBindingsFileSchema,
  type HookBinding,
  type MemoryImportWorkflowBinding,
  type MemoryWriteWorkflowBinding,
  type NoteHookBinding,
  type PromptReviewHookBinding,
  type ProjectIntakeWorkflowBinding,
  type RuntimeBindingsFile,
  type WorkflowBinding,
} from "./runtime-bindings-schema.js";

export {
  RuntimeBindingError,
  runtimeBindingsFileSchema,
  type HookBinding,
  type MemoryImportWorkflowBinding,
  type MemoryWriteWorkflowBinding,
  type NoteHookBinding,
  type PromptReviewHookBinding,
  type ProjectIntakeWorkflowBinding,
  type RuntimeBindingsFile,
  type WorkflowBinding,
} from "./runtime-bindings-schema.js";
export {
  readSafeMemoryImportRuntimeEvidence,
  readSafePromptReviewRuntimeEvidence,
  type SafeMemoryImportRuntimeEvidence,
  type SafePromptReviewRuntimeEvidence,
} from "./runtime-bindings-evidence.js";

export type PromptReviewResumeDispatchClaim =
  "claimed" | "already_dispatched" | "outcome_unknown" | "failed_terminal";

/**
 * Runtime Binding Store：产品身份到Workflow私有身份的单机映射与派发栅栏。
 *
 * startIntent/dispatching必须先于不可逆Runtime调用落盘。若调用后无法确认结果，
 * 状态保持outcome_unknown并禁止盲重试，从而保证“宁可人工对账，也不重复启动/
 * 恢复”。文件本身使用克隆提交与atomic rename；rename后目录fsync不确定时实例
 * 立即熔断，避免旧内存覆盖已提交映射。
 */

export class RuntimeBindingStore {
  private readonly filePath: string;
  private bindings: RuntimeBindingsFile;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailable: RuntimeBindingError | undefined;

  private constructor(filePath: string, bindings: RuntimeBindingsFile) {
    this.filePath = filePath;
    this.bindings = bindings;
  }

  static async open(
    filePath: string,
    options: { readonly allowCreate?: boolean } = {},
  ): Promise<RuntimeBindingStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        if (options.allowCreate === false) {
          throw new RuntimeBindingError(
            "Runtime已有耐久运行数据但Binding Store缺失，拒绝创建空映射",
          );
        }
        await mkdir(dirname(filePath), { recursive: true });
        const store = new RuntimeBindingStore(filePath, emptyBindings());
        await store.persist(store.bindings);
        return store;
      }
      throw new RuntimeBindingError("无法读取Runtime Binding Store");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RuntimeBindingError("Runtime Binding Store不是合法JSON，已保留原文件");
    }
    const loaded = parseRuntimeBindingsFile(parsed);
    if (!loaded.migrationRequired) {
      return new RuntimeBindingStore(filePath, loaded.bindings);
    }
    const store = new RuntimeBindingStore(filePath, loaded.bindings);
    await store.persist(loaded.bindings);
    return store;
  }

  hasDurableBindings(): boolean {
    this.assertAvailable();
    return (
      Object.keys(this.bindings.startIntents).length > 0 ||
      Object.keys(this.bindings.workflows).length > 0 ||
      Object.keys(this.bindings.hooks).length > 0 ||
      Object.keys(this.bindings.noteHooks).length > 0 ||
      Object.keys(this.bindings.promptReviewHooks).length > 0 ||
      Object.keys(this.bindings.memoryImportStartIntents).length > 0 ||
      Object.keys(this.bindings.memoryImportWorkflows).length > 0 ||
      Object.keys(this.bindings.memoryWriteStartIntents).length > 0 ||
      Object.keys(this.bindings.memoryWriteWorkflows).length > 0 ||
      Object.keys(this.bindings.projectIntakeStartIntents).length > 0 ||
      Object.keys(this.bindings.projectIntakeWorkflows).length > 0
    );
  }

  listWorkflowBindings(): readonly {
    productRunId: ProductRunId;
    binding: WorkflowBinding;
  }[] {
    this.assertAvailable();
    return Object.entries(this.bindings.workflows).map(([productRunId, binding]) => ({
      productRunId: productRunId as ProductRunId,
      binding: structuredClone(binding),
    }));
  }

  getWorkflowBinding(productRunId: ProductRunId): WorkflowBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.workflows[productRunId];
    return value === undefined ? undefined : structuredClone(value);
  }

  getHookBinding(approvalRequestId: ApprovalRequestId): HookBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.hooks[approvalRequestId];
    return value === undefined ? undefined : structuredClone(value);
  }

  getNoteHookBinding(noteCandidateId: NoteCandidateId): NoteHookBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.noteHooks[noteCandidateId];
    return value === undefined ? undefined : structuredClone(value);
  }

  getPromptReviewHookBinding(
    promptReviewRequestId: PromptReviewRequestId,
  ): PromptReviewHookBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.promptReviewHooks[promptReviewRequestId];
    return value === undefined ? undefined : structuredClone(value);
  }

  getStartState(productRunId: ProductRunId): "missing" | "outcome_unknown" | "exists" {
    this.assertAvailable();
    if (this.bindings.workflows[productRunId] !== undefined) return "exists";
    return this.bindings.startIntents[productRunId] !== undefined ? "outcome_unknown" : "missing";
  }

  listMemoryImportBindings(): readonly {
    outboxId: OutboxEntryId;
    binding: MemoryImportWorkflowBinding;
  }[] {
    this.assertAvailable();
    return Object.entries(this.bindings.memoryImportWorkflows).map(([outboxId, binding]) => ({
      outboxId: outboxId as OutboxEntryId,
      binding: structuredClone(binding),
    }));
  }

  getMemoryImportStartState(outboxId: OutboxEntryId): "missing" | "outcome_unknown" | "exists" {
    this.assertAvailable();
    if (this.bindings.memoryImportWorkflows[outboxId] !== undefined) return "exists";
    return this.bindings.memoryImportStartIntents[outboxId] !== undefined
      ? "outcome_unknown"
      : "missing";
  }

  getMemoryImportWorkflowBinding(outboxId: OutboxEntryId): MemoryImportWorkflowBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.memoryImportWorkflows[outboxId];
    return value === undefined ? undefined : structuredClone(value);
  }

  /** Import每个Outbox只允许启动一个私有Workflow Run；对账使用新的Outbox身份。 */
  async claimMemoryImportStartIntent(input: {
    outboxId: OutboxEntryId;
    memoryImportIntentId: MemoryImportIntentId;
    memoryImportResultId: MemoryImportResultId;
    mode: "import" | "reconcile";
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<"claimed" | "already_started" | "outcome_unknown"> {
    return this.enqueue(async () => {
      this.assertAvailable();
      if (this.bindings.memoryImportWorkflows[input.outboxId] !== undefined) {
        return "already_started";
      }
      const existing = this.bindings.memoryImportStartIntents[input.outboxId];
      if (existing !== undefined) {
        if (
          existing.memoryImportIntentId !== input.memoryImportIntentId ||
          existing.memoryImportResultId !== input.memoryImportResultId ||
          existing.mode !== input.mode ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion
        ) {
          throw new RuntimeBindingError("Memory Import Workflow start意图冲突");
        }
        return "outcome_unknown";
      }
      const next = structuredClone(this.bindings);
      next.memoryImportStartIntents[input.outboxId] = {
        memoryImportIntentId: input.memoryImportIntentId,
        memoryImportResultId: input.memoryImportResultId,
        mode: input.mode,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        state: "starting",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
      return "claimed";
    });
  }

  async claimMemoryImportWorkflowBinding(input: {
    outboxId: OutboxEntryId;
    memoryImportIntentId: MemoryImportIntentId;
    memoryImportResultId: MemoryImportResultId;
    mode: "import" | "reconcile";
    workflowRunId: string;
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<{ alreadyExisted: boolean }> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.memoryImportWorkflows[input.outboxId];
      if (existing !== undefined) {
        if (
          existing.workflowRunId !== input.workflowRunId ||
          existing.memoryImportIntentId !== input.memoryImportIntentId ||
          existing.memoryImportResultId !== input.memoryImportResultId ||
          existing.mode !== input.mode
        ) {
          throw new RuntimeBindingError("Memory Import Workflow映射冲突");
        }
        return { alreadyExisted: true };
      }
      const intent = this.bindings.memoryImportStartIntents[input.outboxId];
      if (
        intent === undefined ||
        intent.memoryImportIntentId !== input.memoryImportIntentId ||
        intent.memoryImportResultId !== input.memoryImportResultId ||
        intent.mode !== input.mode ||
        intent.workflowDefinitionVersion !== input.workflowDefinitionVersion
      ) {
        throw new RuntimeBindingError("Memory Import Workflow结果缺少匹配的持久化意图");
      }
      const next = structuredClone(this.bindings);
      next.memoryImportWorkflows[input.outboxId] = {
        memoryImportIntentId: input.memoryImportIntentId,
        memoryImportResultId: input.memoryImportResultId,
        mode: input.mode,
        workflowRunId: input.workflowRunId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        startDispatchState: "started",
        createdAt: input.now,
      };
      delete next.memoryImportStartIntents[input.outboxId];
      await this.commit(next);
      return { alreadyExisted: false };
    });
  }

  async markMemoryImportStartOutcomeUnknown(outboxId: OutboxEntryId, now: string): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.memoryImportStartIntents[outboxId];
      if (existing === undefined) {
        if (this.bindings.memoryImportWorkflows[outboxId] !== undefined) return;
        throw new RuntimeBindingError("Memory Import start结果未知但意图缺失");
      }
      if (existing.state === "outcome_unknown") return;
      const next = structuredClone(this.bindings);
      next.memoryImportStartIntents[outboxId] = {
        ...existing,
        state: "outcome_unknown",
        updatedAt: now,
      };
      await this.commit(next);
    });
  }

  listMemoryWriteBindings(): readonly {
    outboxId: OutboxEntryId;
    binding: MemoryWriteWorkflowBinding;
  }[] {
    this.assertAvailable();
    return Object.entries(this.bindings.memoryWriteWorkflows).map(([outboxId, binding]) => ({
      outboxId: outboxId as OutboxEntryId,
      binding: structuredClone(binding),
    }));
  }

  getMemoryWriteStartState(outboxId: OutboxEntryId): "missing" | "outcome_unknown" | "exists" {
    this.assertAvailable();
    if (this.bindings.memoryWriteWorkflows[outboxId] !== undefined) return "exists";
    return this.bindings.memoryWriteStartIntents[outboxId] !== undefined
      ? "outcome_unknown"
      : "missing";
  }

  getMemoryWriteWorkflowBinding(outboxId: OutboxEntryId): MemoryWriteWorkflowBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.memoryWriteWorkflows[outboxId];
    return value === undefined ? undefined : structuredClone(value);
  }

  async claimMemoryWriteStartIntent(input: {
    outboxId: OutboxEntryId;
    memoryWriteIntentId: MemoryWriteIntentId;
    memoryWriteResultId: MemoryWriteResultId;
    mode: "write" | "reconcile";
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<"claimed" | "already_started" | "outcome_unknown"> {
    return this.enqueue(async () => {
      this.assertAvailable();
      if (this.bindings.memoryWriteWorkflows[input.outboxId] !== undefined) {
        return "already_started";
      }
      const existing = this.bindings.memoryWriteStartIntents[input.outboxId];
      if (existing !== undefined) {
        if (
          existing.memoryWriteIntentId !== input.memoryWriteIntentId ||
          existing.memoryWriteResultId !== input.memoryWriteResultId ||
          existing.mode !== input.mode ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion
        ) {
          throw new RuntimeBindingError("Memory Write Workflow start意图冲突");
        }
        return "outcome_unknown";
      }
      const next = structuredClone(this.bindings);
      next.memoryWriteStartIntents[input.outboxId] = {
        memoryWriteIntentId: input.memoryWriteIntentId,
        memoryWriteResultId: input.memoryWriteResultId,
        mode: input.mode,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        state: "starting",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
      return "claimed";
    });
  }

  async claimMemoryWriteWorkflowBinding(input: {
    outboxId: OutboxEntryId;
    memoryWriteIntentId: MemoryWriteIntentId;
    memoryWriteResultId: MemoryWriteResultId;
    mode: "write" | "reconcile";
    workflowRunId: string;
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<{ alreadyExisted: boolean }> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.memoryWriteWorkflows[input.outboxId];
      if (existing !== undefined) {
        if (
          existing.workflowRunId !== input.workflowRunId ||
          existing.memoryWriteIntentId !== input.memoryWriteIntentId ||
          existing.memoryWriteResultId !== input.memoryWriteResultId ||
          existing.mode !== input.mode
        ) {
          throw new RuntimeBindingError("Memory Write Workflow映射冲突");
        }
        return { alreadyExisted: true };
      }
      const intent = this.bindings.memoryWriteStartIntents[input.outboxId];
      if (
        intent === undefined ||
        intent.memoryWriteIntentId !== input.memoryWriteIntentId ||
        intent.memoryWriteResultId !== input.memoryWriteResultId ||
        intent.mode !== input.mode ||
        intent.workflowDefinitionVersion !== input.workflowDefinitionVersion
      ) {
        throw new RuntimeBindingError("Memory Write Workflow结果缺少匹配的持久化意图");
      }
      const next = structuredClone(this.bindings);
      next.memoryWriteWorkflows[input.outboxId] = {
        memoryWriteIntentId: input.memoryWriteIntentId,
        memoryWriteResultId: input.memoryWriteResultId,
        mode: input.mode,
        workflowRunId: input.workflowRunId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        startDispatchState: "started",
        createdAt: input.now,
      };
      delete next.memoryWriteStartIntents[input.outboxId];
      await this.commit(next);
      return { alreadyExisted: false };
    });
  }

  async markMemoryWriteStartOutcomeUnknown(outboxId: OutboxEntryId, now: string): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.memoryWriteStartIntents[outboxId];
      if (existing === undefined) {
        if (this.bindings.memoryWriteWorkflows[outboxId] !== undefined) return;
        throw new RuntimeBindingError("Memory Write start结果未知但意图缺失");
      }
      if (existing.state === "outcome_unknown") return;
      const next = structuredClone(this.bindings);
      next.memoryWriteStartIntents[outboxId] = {
        ...existing,
        state: "outcome_unknown",
        updatedAt: now,
      };
      await this.commit(next);
    });
  }

  listProjectIntakeBindings(): readonly {
    projectCandidateId: ProjectCandidateId;
    binding: ProjectIntakeWorkflowBinding;
  }[] {
    this.assertAvailable();
    return Object.entries(this.bindings.projectIntakeWorkflows).map(
      ([projectCandidateId, binding]) => ({
        projectCandidateId: projectCandidateId as ProjectCandidateId,
        binding: structuredClone(binding),
      }),
    );
  }

  getProjectIntakeBinding(
    projectCandidateId: ProjectCandidateId,
  ): ProjectIntakeWorkflowBinding | undefined {
    this.assertAvailable();
    const binding = this.bindings.projectIntakeWorkflows[projectCandidateId];
    return binding === undefined ? undefined : structuredClone(binding);
  }

  getProjectIntakeStartState(
    projectCandidateId: ProjectCandidateId,
  ): "missing" | "outcome_unknown" | "exists" {
    this.assertAvailable();
    if (this.bindings.projectIntakeWorkflows[projectCandidateId] !== undefined) return "exists";
    if (this.bindings.projectIntakeStartIntents[projectCandidateId] !== undefined) {
      return "outcome_unknown";
    }
    return "missing";
  }

  async claimProjectIntakeStartIntent(input: {
    projectCandidateId: ProjectCandidateId;
    outboxId: OutboxEntryId;
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<"claimed" | "already_started" | "outcome_unknown"> {
    return this.enqueue(async () => {
      this.assertAvailable();
      if (this.bindings.projectIntakeWorkflows[input.projectCandidateId] !== undefined) {
        return "already_started";
      }
      const existing = this.bindings.projectIntakeStartIntents[input.projectCandidateId];
      if (existing !== undefined) {
        if (
          existing.outboxId !== input.outboxId ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion
        ) {
          throw new RuntimeBindingError("Project Intake start意图冲突");
        }
        return "outcome_unknown";
      }
      const next = structuredClone(this.bindings);
      next.projectIntakeStartIntents[input.projectCandidateId] = {
        outboxId: input.outboxId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        state: "starting",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
      return "claimed";
    });
  }

  async claimProjectIntakeWorkflowBinding(input: {
    projectCandidateId: ProjectCandidateId;
    outboxId: OutboxEntryId;
    workflowRunId: string;
    workflowDefinitionVersion: string;
    hookToken: string;
    now: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.projectIntakeWorkflows[input.projectCandidateId];
      if (existing !== undefined) {
        if (
          existing.startOutboxId !== input.outboxId ||
          existing.workflowRunId !== input.workflowRunId ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion ||
          existing.hookToken !== input.hookToken
        ) {
          throw new RuntimeBindingError("Project Intake Workflow映射冲突");
        }
        return;
      }
      const intent = this.bindings.projectIntakeStartIntents[input.projectCandidateId];
      if (
        intent === undefined ||
        intent.outboxId !== input.outboxId ||
        intent.workflowDefinitionVersion !== input.workflowDefinitionVersion
      ) {
        throw new RuntimeBindingError("Project Intake Workflow缺少匹配的start意图");
      }
      const next = structuredClone(this.bindings);
      next.projectIntakeWorkflows[input.projectCandidateId] = {
        startOutboxId: input.outboxId,
        workflowRunId: input.workflowRunId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        hookToken: input.hookToken,
        resumeDispatchState: "none",
        createdAt: input.now,
        updatedAt: input.now,
      };
      delete next.projectIntakeStartIntents[input.projectCandidateId];
      await this.commit(next);
    });
  }

  async markProjectIntakeStartOutcomeUnknown(
    projectCandidateId: ProjectCandidateId,
    now: string,
  ): Promise<void> {
    await this.enqueue(async () => {
      const existing = this.bindings.projectIntakeStartIntents[projectCandidateId];
      if (existing === undefined) {
        if (this.bindings.projectIntakeWorkflows[projectCandidateId] !== undefined) return;
        throw new RuntimeBindingError("Project Intake start结果未知但意图缺失");
      }
      const next = structuredClone(this.bindings);
      next.projectIntakeStartIntents[projectCandidateId] = {
        ...existing,
        state: "outcome_unknown",
        updatedAt: now,
      };
      await this.commit(next);
    });
  }

  async markProjectIntakeResumeDispatching(
    projectCandidateId: ProjectCandidateId,
    now: string,
  ): Promise<void> {
    await this.setProjectIntakeResumeState(projectCandidateId, "dispatching", now, ["none"]);
  }

  async markProjectIntakeResumeDispatched(
    projectCandidateId: ProjectCandidateId,
    now: string,
  ): Promise<void> {
    await this.setProjectIntakeResumeState(projectCandidateId, "dispatched", now, [
      "dispatching",
      "dispatched",
    ]);
  }

  async markProjectIntakeResumeOutcomeUnknown(
    projectCandidateId: ProjectCandidateId,
    now: string,
  ): Promise<void> {
    await this.setProjectIntakeResumeState(projectCandidateId, "outcome_unknown", now, [
      "dispatching",
      "outcome_unknown",
    ]);
  }

  private async setProjectIntakeResumeState(
    projectCandidateId: ProjectCandidateId,
    state: ProjectIntakeWorkflowBinding["resumeDispatchState"],
    now: string,
    allowedFrom: readonly ProjectIntakeWorkflowBinding["resumeDispatchState"][],
  ): Promise<void> {
    await this.enqueue(async () => {
      const existing = this.bindings.projectIntakeWorkflows[projectCandidateId];
      if (existing === undefined) throw new RuntimeBindingError("Project Intake Workflow映射缺失");
      if (!allowedFrom.includes(existing.resumeDispatchState)) {
        throw new RuntimeBindingError(`Project Intake Resume状态不允许转换到${state}`);
      }
      if (existing.resumeDispatchState === state) return;
      const next = structuredClone(this.bindings);
      next.projectIntakeWorkflows[projectCandidateId] = {
        ...existing,
        resumeDispatchState: state,
        updatedAt: now,
      };
      await this.commit(next);
    });
  }

  /** 先落盘start意图；已有未决意图时绝不再次调用Workflow start。 */
  async claimStartIntent(input: {
    productRunId: ProductRunId;
    outboxId: OutboxEntryId;
    workflowDefinitionVersion: string;
    runnerFamily?: ProductWorkflowRunnerFamily;
    runnerBundleVersion?: string;
    workflowRunSpecId?: string;
    now: string;
  }): Promise<"claimed" | "already_started" | "outcome_unknown"> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const runner = normalizeProductRunnerEvidence(input);
      const started = this.bindings.workflows[input.productRunId];
      if (started !== undefined) {
        if (
          started.runnerFamily !== runner.runnerFamily ||
          started.runnerBundleVersion !== runner.runnerBundleVersion ||
          started.workflowRunSpecId !== runner.workflowRunSpecId
        ) {
          throw new RuntimeBindingError("已启动Product Run的Runner绑定与重复请求冲突");
        }
        return "already_started";
      }
      const existing = this.bindings.startIntents[input.productRunId];
      if (existing !== undefined) {
        if (
          existing.outboxId !== input.outboxId ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion ||
          existing.runnerFamily !== runner.runnerFamily ||
          existing.runnerBundleVersion !== runner.runnerBundleVersion ||
          existing.workflowRunSpecId !== runner.workflowRunSpecId
        ) {
          throw new RuntimeBindingError("productRunId的Workflow start意图冲突，失败关闭");
        }
        return "outcome_unknown";
      }
      const next = structuredClone(this.bindings);
      next.startIntents[input.productRunId] = {
        outboxId: input.outboxId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        ...runner,
        state: "starting",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
      return "claimed";
    });
  }

  /** start成功后一次提交Workflow映射并清除意图；同runId重放幂等。 */
  async claimWorkflowBinding(input: {
    productRunId: ProductRunId;
    outboxId: OutboxEntryId;
    workflowRunId: string;
    workflowDefinitionVersion: string;
    runnerFamily?: ProductWorkflowRunnerFamily;
    runnerBundleVersion?: string;
    workflowRunSpecId?: string;
    now: string;
  }): Promise<{ alreadyExisted: boolean }> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const runner = normalizeProductRunnerEvidence(input);
      const existing = this.bindings.workflows[input.productRunId];
      if (existing !== undefined) {
        if (
          existing.workflowRunId !== input.workflowRunId ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion ||
          existing.runnerFamily !== runner.runnerFamily ||
          existing.runnerBundleVersion !== runner.runnerBundleVersion ||
          existing.workflowRunSpecId !== runner.workflowRunSpecId
        ) {
          throw new RuntimeBindingError("productRunId的Workflow映射冲突，失败关闭");
        }
        return { alreadyExisted: true };
      }
      const intent = this.bindings.startIntents[input.productRunId];
      if (
        intent === undefined ||
        intent.outboxId !== input.outboxId ||
        intent.workflowDefinitionVersion !== input.workflowDefinitionVersion ||
        intent.runnerFamily !== runner.runnerFamily ||
        intent.runnerBundleVersion !== runner.runnerBundleVersion ||
        intent.workflowRunSpecId !== runner.workflowRunSpecId
      ) {
        throw new RuntimeBindingError("Workflow start结果缺少匹配的持久化意图");
      }
      const next = structuredClone(this.bindings);
      next.workflows[input.productRunId] = {
        workflowRunId: input.workflowRunId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        ...runner,
        startDispatchState: "started",
        createdAt: input.now,
      };
      delete next.startIntents[input.productRunId];
      await this.commit(next);
      return { alreadyExisted: false };
    });
  }

  async markStartOutcomeUnknown(productRunId: ProductRunId, now: string): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const intent = this.bindings.startIntents[productRunId];
      if (intent === undefined) throw new RuntimeBindingError("缺少Workflow start意图");
      const next = structuredClone(this.bindings);
      next.startIntents[productRunId] = { ...intent, state: "outcome_unknown", updatedAt: now };
      await this.commit(next);
    });
  }

  async claimHookBinding(input: {
    approvalRequestId: ApprovalRequestId;
    productRunId: ProductRunId;
    planRevision: number;
    hookToken: string;
    now: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.hooks[input.approvalRequestId];
      if (existing !== undefined) {
        if (
          existing.hookToken !== input.hookToken ||
          existing.productRunId !== input.productRunId ||
          existing.planRevision !== input.planRevision
        ) {
          throw new RuntimeBindingError("approvalRequestId的Hook映射冲突，失败关闭");
        }
        return;
      }
      const next = structuredClone(this.bindings);
      next.hooks[input.approvalRequestId] = {
        hookToken: input.hookToken,
        productRunId: input.productRunId,
        planRevision: input.planRevision,
        hookClaimState: "claimed",
        resumeDispatchState: "none",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
    });
  }

  async claimNoteHookBinding(input: {
    noteCandidateId: NoteCandidateId;
    productRunId: ProductRunId;
    candidateSequence: number;
    hookToken: string;
    now: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.noteHooks[input.noteCandidateId];
      if (existing !== undefined) {
        if (
          existing.hookToken !== input.hookToken ||
          existing.productRunId !== input.productRunId ||
          existing.candidateSequence !== input.candidateSequence
        ) {
          throw new RuntimeBindingError("noteCandidateId的Hook映射冲突，失败关闭");
        }
        return;
      }
      const workflow = this.bindings.workflows[input.productRunId];
      if (workflow?.runnerFamily !== NOTE_CAPTURE_RUNNER_FAMILY) {
        throw new RuntimeBindingError("Note Hook缺少对应Note Workflow映射");
      }
      const next = structuredClone(this.bindings);
      next.noteHooks[input.noteCandidateId] = {
        hookToken: input.hookToken,
        productRunId: input.productRunId,
        candidateSequence: input.candidateSequence,
        hookClaimState: "claimed",
        resumeDispatchState: "none",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
    });
  }

  /**
   * 每个Prompt Review Request只能认领自己的Hook；相同Request完整重放幂等，
   * 任一Workflow、revision、Hash或Token漂移都失败关闭。
   */
  async claimPromptReviewHookBinding(input: {
    promptReviewRequestId: PromptReviewRequestId;
    productRunId: ProductRunId;
    startWorkflowRunId: string;
    requestRevision: number;
    reviewSha256: string;
    hookToken: string;
    now: string;
  }): Promise<{ readonly alreadyExisted: boolean }> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.promptReviewHooks[input.promptReviewRequestId];
      if (existing !== undefined) {
        if (
          existing.hookToken !== input.hookToken ||
          existing.productRunId !== input.productRunId ||
          existing.startWorkflowRunId !== input.startWorkflowRunId ||
          existing.requestRevision !== input.requestRevision ||
          existing.reviewSha256 !== input.reviewSha256
        ) {
          throw new RuntimeBindingError("promptReviewRequestId的Hook映射冲突，失败关闭");
        }
        this.assertPromptReviewStartBinding(existing);
        return { alreadyExisted: true };
      }
      const workflow = this.bindings.workflows[input.productRunId];
      if (
        workflow === undefined ||
        (workflow.runnerFamily !== DIRECT_AGENT_RUNNER_FAMILY &&
          workflow.runnerFamily !== MEMORY_DIRECT_RUNNER_FAMILY) ||
        workflow.workflowRunId !== input.startWorkflowRunId
      ) {
        throw new RuntimeBindingError("Prompt Review Hook缺少对应Direct Agent Workflow start映射");
      }
      const next = structuredClone(this.bindings);
      next.promptReviewHooks[input.promptReviewRequestId] = {
        hookToken: input.hookToken,
        productRunId: input.productRunId,
        startWorkflowRunId: input.startWorkflowRunId,
        requestRevision: input.requestRevision,
        reviewSha256: input.reviewSha256,
        hookClaimState: "claimed",
        resumeDispatchState: "none",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
      return { alreadyExisted: false };
    });
  }

  /**
   * Decision身份与Resume派发栅栏在一次原子提交中绑定。并发重复调用只会有一个
   * claimed；看到dispatching的一方按结果未知处理，绝不再次调用Workflow Hook。
   */
  async claimPromptReviewResumeDispatch(input: {
    promptReviewRequestId: PromptReviewRequestId;
    promptReviewDecisionId: PromptReviewDecisionId;
    requestRevision: number;
    reviewSha256: string;
    now: string;
  }): Promise<PromptReviewResumeDispatchClaim> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.promptReviewHooks[input.promptReviewRequestId];
      if (existing === undefined) {
        throw new RuntimeBindingError("Prompt Review Resume的Hook映射缺失，失败关闭");
      }
      this.assertPromptReviewStartBinding(existing);
      if (
        existing.requestRevision !== input.requestRevision ||
        existing.reviewSha256 !== input.reviewSha256 ||
        (existing.promptReviewDecisionId !== undefined &&
          existing.promptReviewDecisionId !== input.promptReviewDecisionId)
      ) {
        throw new RuntimeBindingError("Prompt Review Resume的Decision或审核Hash冲突，失败关闭");
      }
      switch (existing.resumeDispatchState) {
        case "none": {
          const next = structuredClone(this.bindings);
          next.promptReviewHooks[input.promptReviewRequestId] = {
            ...existing,
            promptReviewDecisionId: input.promptReviewDecisionId,
            resumeDispatchState: "dispatching",
            updatedAt: input.now,
          };
          await this.commit(next);
          return "claimed";
        }
        case "dispatched":
          return "already_dispatched";
        case "dispatching":
        case "outcome_unknown":
          return "outcome_unknown";
        case "failed_terminal":
          return "failed_terminal";
      }
    });
  }

  async markPromptReviewResumeDispatched(input: {
    promptReviewRequestId: PromptReviewRequestId;
    promptReviewDecisionId: PromptReviewDecisionId;
    now: string;
  }): Promise<void> {
    await this.setPromptReviewResumeState(input, "dispatched", ["dispatching", "dispatched"]);
  }

  async markPromptReviewResumeOutcomeUnknown(input: {
    promptReviewRequestId: PromptReviewRequestId;
    promptReviewDecisionId: PromptReviewDecisionId;
    now: string;
  }): Promise<void> {
    await this.setPromptReviewResumeState(input, "outcome_unknown", [
      "dispatching",
      "outcome_unknown",
    ]);
  }

  async markPromptReviewResumeFailedTerminal(input: {
    promptReviewRequestId: PromptReviewRequestId;
    promptReviewDecisionId: PromptReviewDecisionId;
    now: string;
  }): Promise<void> {
    await this.setPromptReviewResumeState(input, "failed_terminal", [
      "dispatching",
      "failed_terminal",
    ]);
  }

  private async setPromptReviewResumeState(
    input: {
      readonly promptReviewRequestId: PromptReviewRequestId;
      readonly promptReviewDecisionId: PromptReviewDecisionId;
      readonly now: string;
    },
    state: PromptReviewHookBinding["resumeDispatchState"],
    allowedFrom: readonly PromptReviewHookBinding["resumeDispatchState"][],
  ): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.promptReviewHooks[input.promptReviewRequestId];
      if (existing === undefined) {
        throw new RuntimeBindingError("Prompt Review Resume的Hook映射缺失，失败关闭");
      }
      this.assertPromptReviewStartBinding(existing);
      if (existing.promptReviewDecisionId !== input.promptReviewDecisionId) {
        throw new RuntimeBindingError("Prompt Review Resume的Decision绑定冲突，失败关闭");
      }
      if (!allowedFrom.includes(existing.resumeDispatchState)) {
        throw new RuntimeBindingError(`Prompt Review Hook Resume状态不允许转换到${state}`);
      }
      if (existing.resumeDispatchState === state) return;
      const next = structuredClone(this.bindings);
      next.promptReviewHooks[input.promptReviewRequestId] = {
        ...existing,
        resumeDispatchState: state,
        updatedAt: input.now,
      };
      await this.commit(next);
    });
  }

  private assertPromptReviewStartBinding(binding: PromptReviewHookBinding): void {
    const workflow = this.bindings.workflows[binding.productRunId];
    if (
      workflow === undefined ||
      (workflow.runnerFamily !== DIRECT_AGENT_RUNNER_FAMILY &&
        workflow.runnerFamily !== MEMORY_DIRECT_RUNNER_FAMILY) ||
      workflow.workflowRunId !== binding.startWorkflowRunId
    ) {
      throw new RuntimeBindingError("Prompt Review Hook对应的Direct Agent Workflow不再有效");
    }
  }

  async markNoteResumeDispatching(noteCandidateId: NoteCandidateId, now: string): Promise<void> {
    await this.setNoteResumeState(noteCandidateId, "dispatching", now, ["none"]);
  }

  async markNoteResumeDispatched(noteCandidateId: NoteCandidateId, now: string): Promise<void> {
    await this.setNoteResumeState(noteCandidateId, "dispatched", now, [
      "dispatching",
      "dispatched",
    ]);
  }

  async markNoteResumeOutcomeUnknown(noteCandidateId: NoteCandidateId, now: string): Promise<void> {
    await this.setNoteResumeState(noteCandidateId, "outcome_unknown", now, [
      "dispatching",
      "outcome_unknown",
    ]);
  }

  async markNoteResumeFailedTerminal(noteCandidateId: NoteCandidateId, now: string): Promise<void> {
    await this.setNoteResumeState(noteCandidateId, "failed_terminal", now, ["none", "dispatching"]);
  }

  private async setNoteResumeState(
    noteCandidateId: NoteCandidateId,
    state: NoteHookBinding["resumeDispatchState"],
    now: string,
    allowedFrom: readonly NoteHookBinding["resumeDispatchState"][],
  ): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.noteHooks[noteCandidateId];
      if (existing === undefined)
        throw new RuntimeBindingError("Note Resume的Hook映射缺失，失败关闭");
      if (!allowedFrom.includes(existing.resumeDispatchState)) {
        throw new RuntimeBindingError(`Note Hook Resume状态不允许转换到${state}`);
      }
      if (existing.resumeDispatchState === state) return;
      const next = structuredClone(this.bindings);
      next.noteHooks[noteCandidateId] = {
        ...existing,
        resumeDispatchState: state,
        updatedAt: now,
      };
      await this.commit(next);
    });
  }

  async markResumeDispatching(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "dispatching", now, ["none"]);
  }

  async markResumeDispatched(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "dispatched", now, ["dispatching", "dispatched"]);
  }

  async markResumeOutcomeUnknown(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "outcome_unknown", now, [
      "dispatching",
      "outcome_unknown",
    ]);
  }

  async markResumeFailedTerminal(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "failed_terminal", now, ["none", "dispatching"]);
  }

  private async setResumeState(
    approvalRequestId: ApprovalRequestId,
    state: HookBinding["resumeDispatchState"],
    now: string,
    allowedFrom: readonly HookBinding["resumeDispatchState"][],
  ): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.hooks[approvalRequestId];
      if (existing === undefined) throw new RuntimeBindingError("Resume的Hook映射缺失，失败关闭");
      if (!allowedFrom.includes(existing.resumeDispatchState)) {
        throw new RuntimeBindingError(`Hook Resume状态不允许转换到${state}`);
      }
      if (existing.resumeDispatchState === state) return;
      const next = structuredClone(this.bindings);
      next.hooks[approvalRequestId] = { ...existing, resumeDispatchState: state, updatedAt: now };
      await this.commit(next);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(next: RuntimeBindingsFile): Promise<void> {
    const validated = runtimeBindingsFileSchema.parse(next);
    assertRuntimeBindingsIntegrity(validated);
    await this.persist(validated);
    this.bindings = validated;
  }

  private async persist(bindings: RuntimeBindingsFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.${basename(this.filePath)}.tmp-${randomUUID()}`);
    let renamed = false;
    try {
      await writeFile(tempPath, JSON.stringify(bindings, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const temp = await open(tempPath, "r");
      try {
        await temp.sync();
      } finally {
        await temp.close();
      }
      const beforeRenameDirectory = await open(directory, "r");
      try {
        await beforeRenameDirectory.sync();
      } finally {
        await beforeRenameDirectory.close();
      }
      await rename(tempPath, this.filePath);
      renamed = true;
      const afterRenameDirectory = await open(directory, "r");
      try {
        await afterRenameDirectory.sync();
      } finally {
        await afterRenameDirectory.close();
      }
    } catch (error) {
      if (renamed) {
        this.unavailable = new RuntimeBindingError(
          "Runtime Binding在rename后无法确认目录持久化，实例已熔断；必须重启恢复",
        );
        throw this.unavailable;
      }
      throw error;
    }
  }

  private assertAvailable(): void {
    if (this.unavailable !== undefined) throw this.unavailable;
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
