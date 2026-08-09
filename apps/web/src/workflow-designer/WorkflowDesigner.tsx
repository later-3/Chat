import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkflowDefinitionDetailDto,
  WorkflowDesignerDiagnosticDto,
  WorkflowDesignerSlotDto,
} from "@chat/contracts/public";
import {
  ApiProblemError,
  apiChangeWorkflowDefinitionArchiveStatus,
  apiCreateWorkflowDefinitionCopy,
  apiGetWorkflowDefinition,
  apiPublishWorkflowDefinition,
  apiSaveWorkflowDefinitionDraft,
  apiValidateWorkflowDefinition,
} from "../api/client.js";
import {
  useWorkflowBlueprints,
  useWorkflowCatalog,
  useWorkflowDefinitions,
  workflowComposerQueryKey,
} from "../workflow/use-workflow-composer.js";
import { DesignerSurface } from "./DesignerSurface.js";
import {
  quickDesignerDiagnostics,
  reapplyDesignerOperations,
  type DesignerOperation,
  type DesignerOperationContext,
} from "./structure-operations.js";
import {
  applyHistoryOperation,
  clearDesignerWorkingCopy,
  createDesignerHistory,
  isDesignerHistoryDirty,
  readDesignerWorkingCopy,
  redoDesignerHistory,
  resetDesignerHistory,
  undoDesignerHistory,
  writeDesignerWorkingCopy,
  type DesignerHistory,
} from "./working-copy.js";
import {
  designerDetailQueryKey,
  designerDropOperation,
  designerOperationClearsSelection,
  designerOperationContext,
  focusDesignerDiagnostic,
  nextDesignerCommandId,
  operationErrorText,
  selectedDesignerElement,
  type DesignerConflictState,
  type DesignerSelection,
} from "./designer-utils.js";
import { isEditableWorkflowDefinition } from "./types.js";

const DESIGNER_VALIDATE_DELAY_MS = 450;

export function WorkflowDesigner({
  storage = window.localStorage,
}: {
  readonly storage?: Storage;
}) {
  const queryClient = useQueryClient();
  const definitions = useWorkflowDefinitions();
  const catalogQuery = useWorkflowCatalog();
  const blueprints = useWorkflowBlueprints();
  const [definitionId, setDefinitionId] = useState("");
  const detail = useQuery({
    queryKey: designerDetailQueryKey(definitionId),
    enabled: definitionId !== "",
    queryFn: ({ signal }) => apiGetWorkflowDefinition(definitionId, signal),
  });
  const [history, setHistory] = useState<DesignerHistory | null>(null);
  const [selected, setSelected] = useState<DesignerSelection | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [copyDescription, setCopyDescription] = useState("");
  const [serverDiagnostics, setServerDiagnostics] = useState<
    readonly WorkflowDesignerDiagnosticDto[]
  >([]);
  const [serverValid, setServerValid] = useState(false);
  const [validationPending, setValidationPending] = useState(false);
  const [conflict, setConflict] = useState<DesignerConflictState | null>(null);
  const validationAbort = useRef<AbortController | null>(null);
  const validationSequence = useRef(0);

  useEffect(() => {
    if (definitionId !== "" || definitions.data?.definitions[0] === undefined) return;
    const preferred =
      definitions.data.definitions.find(
        (candidate) => candidate.ownerKind === "system" && candidate.blueprintKey === "planning",
      ) ?? definitions.data.definitions[0];
    setDefinitionId(preferred.workflowDefinitionId);
  }, [definitionId, definitions.data]);

  useEffect(() => {
    const value = detail.data;
    if (value === undefined) return;
    setCopyTitle(`${value.title} 副本`);
    setCopyDescription(value.description);
    setSelected(null);
    setConflict(null);
    setServerDiagnostics([]);
    setServerValid(false);
    if (!isEditableWorkflowDefinition(value)) {
      setHistory(null);
      return;
    }
    setHistory((current) => {
      if (
        current?.workflowDefinitionId === value.workflowDefinitionId &&
        current.baseDefinitionSha256 === value.baseDefinitionSha256
      ) {
        return current;
      }
      return createDesignerHistory(value, readDesignerWorkingCopy(storage, value) ?? undefined);
    });
  }, [detail.data, storage]);

  const detailValue = detail.data;
  const editableDetail = isEditableWorkflowDefinition(detailValue) ? detailValue : undefined;
  const blueprint = blueprints.data?.blueprints.find(
    (candidate) =>
      candidate.blueprintKey === detailValue?.blueprintKey &&
      candidate.blueprintVersion === detailValue.blueprintVersion,
  );
  const catalog = catalogQuery.data?.nodes ?? [];
  const optionalNodeTypes = blueprint?.optionalNodeTypes ?? [];
  const context = useMemo<DesignerOperationContext | undefined>(
    () =>
      editableDetail === undefined
        ? undefined
        : designerOperationContext(editableDetail, catalog, blueprint),
    [blueprint, catalog, editableDetail],
  );
  const editing =
    editableDetail?.ownerKind === "principal" && editableDetail.allowedActions.includes("save");
  const dirty = history !== null && isDesignerHistoryDirty(history);
  const localDiagnostics = useMemo(
    () => (history === null ? [] : quickDesignerDiagnostics(history.present)),
    [history],
  );
  const diagnostics = [...localDiagnostics, ...serverDiagnostics];

  useEffect(() => {
    if (history !== null && dirty) writeDesignerWorkingCopy(storage, history);
  }, [dirty, history, storage]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const validateCurrent = useCallback(
    async (root: DesignerHistory["present"] | undefined, explicit = false) => {
      if (root === undefined || editableDetail === undefined || !editing) return;
      validationAbort.current?.abort();
      const abort = new AbortController();
      validationAbort.current = abort;
      const sequence = ++validationSequence.current;
      setValidationPending(true);
      if (explicit) setNotice("正在由服务端校验…");
      try {
        const validation = await apiValidateWorkflowDefinition(
          {
            workflowDefinitionId: editableDetail.workflowDefinitionId,
            baseRevisionId: editableDetail.baseRevisionId,
            baseDefinitionSha256: editableDetail.baseDefinitionSha256,
            blueprintKey: editableDetail.blueprintKey,
            blueprintVersion: editableDetail.blueprintVersion,
            semanticRoot: root,
          },
          abort.signal,
        );
        if (sequence !== validationSequence.current) return;
        setServerDiagnostics(validation.diagnostics);
        setServerValid(validation.valid);
        setNotice(
          validation.valid
            ? `服务端校验通过 · 预览 Hash ${validation.normalized?.definitionSha256.slice(0, 12) ?? "未知"}`
            : "服务端发现需要修复的问题。",
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (sequence !== validationSequence.current) return;
        setServerValid(false);
        setNotice("服务端校验暂不可用；本地草稿仍保留，不能据此宣称可发布。");
      } finally {
        if (sequence === validationSequence.current) setValidationPending(false);
      }
    },
    [editableDetail, editing],
  );

  useEffect(() => {
    if (!editing || history === null) return;
    const timer = window.setTimeout(
      () => void validateCurrent(history.present),
      DESIGNER_VALIDATE_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      validationAbort.current?.abort();
    };
  }, [editing, history?.present, validateCurrent]);

  function applyOperation(operation: DesignerOperation) {
    if (history === null || context === undefined || !editing) return;
    const result = applyHistoryOperation(history, operation, context);
    if (!result.ok) {
      setOperationError(operationErrorText(result.code));
      return;
    }
    setHistory(result.history);
    if (designerOperationClearsSelection(operation)) setSelected(null);
    setOperationError(null);
    setServerValid(false);
    setServerDiagnostics([]);
  }

  function handleDrop(slot: WorkflowDesignerSlotDto, payload: unknown, index: number) {
    if (history === null) return;
    const operation = designerDropOperation(slot, payload, index, history.present);
    if (operation !== undefined) applyOperation(operation);
  }

  function acceptServerDefinition(
    next: WorkflowDefinitionDetailDto,
    message: string,
    clearWorkingCopy = true,
  ) {
    queryClient.setQueryData(designerDetailQueryKey(next.workflowDefinitionId), next);
    setDefinitionId(next.workflowDefinitionId);
    if (isEditableWorkflowDefinition(next)) {
      if (clearWorkingCopy && history !== null) clearDesignerWorkingCopy(storage, history);
      setHistory(createDesignerHistory(next));
    } else setHistory(null);
    setConflict(null);
    setServerDiagnostics([]);
    setServerValid(false);
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: workflowComposerQueryKey("definitions") });
  }

  async function handleWrite(action: "save" | "publish" | "archive") {
    if (editableDetail === undefined || history === null) return;
    const draftRevision = editableDetail.currentDraftRevision;
    const publishedRevision = editableDetail.publishedRevision;
    if (action === "publish" && draftRevision === undefined) return;
    if (action === "archive" && publishedRevision === undefined) return;
    setBusy(action);
    setNotice(null);
    try {
      const result =
        action === "save"
          ? await apiSaveWorkflowDefinitionDraft({
              workflowDefinitionId: editableDetail.workflowDefinitionId,
              commandId: nextDesignerCommandId(),
              expectedDefinitionRevision: editableDetail.revision,
              payload: {
                baseRevisionId: editableDetail.baseRevisionId,
                baseDefinitionSha256: editableDetail.baseDefinitionSha256,
                semanticRoot: history.present,
              },
            })
          : action === "publish"
            ? await apiPublishWorkflowDefinition({
                workflowDefinitionId: editableDetail.workflowDefinitionId,
                commandId: nextDesignerCommandId(),
                expectedDefinitionRevision: editableDetail.revision,
                payload: {
                  draftRevisionId: draftRevision!.workflowDefinitionRevisionId,
                  draftDefinitionSha256: draftRevision!.definitionSha256,
                },
              })
            : await apiChangeWorkflowDefinitionArchiveStatus({
                workflowDefinitionId: editableDetail.workflowDefinitionId,
                commandId: nextDesignerCommandId(),
                expectedDefinitionRevision: editableDetail.revision,
                payload: {
                  targetStatus: editableDetail.status === "active" ? "archived" : "active",
                  publishedRevisionId: publishedRevision!.workflowDefinitionRevisionId,
                  publishedDefinitionSha256: publishedRevision!.definitionSha256,
                },
              });
      acceptServerDefinition(
        result.definition,
        action === "save"
          ? "草稿已保存。"
          : action === "publish"
            ? "新版本已发布。"
            : "状态已更新。",
      );
    } catch (error) {
      if (error instanceof ApiProblemError && error.httpStatus === 409) {
        try {
          const latest = await apiGetWorkflowDefinition(editableDetail.workflowDefinitionId);
          setConflict({ latest, operations: history.operations });
          setNotice("服务器版本已变化；本地操作仍保留，没有覆盖远端。");
        } catch {
          setNotice("检测到版本冲突，但最新版本暂时读取失败；本地操作仍保留。");
        }
      } else {
        setNotice(
          error instanceof ApiProblemError && error.recoveryAction === "retry_same_command"
            ? "命令结果未知；本地草稿已保留，请重试同一操作。"
            : "操作未完成；本地草稿已保留。",
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function copyDefinition(
    source = detailValue,
    operations: readonly DesignerOperation[] = [],
  ) {
    const published = source?.publishedRevision;
    if (source === undefined || published === undefined) return;
    setBusy("copy");
    try {
      const result = await apiCreateWorkflowDefinitionCopy({
        commandId: nextDesignerCommandId(),
        payload: {
          sourceWorkflowDefinitionRevisionId: published.workflowDefinitionRevisionId,
          sourceDefinitionSha256: published.definitionSha256,
          title: copyTitle.trim(),
          description: copyDescription.trim(),
        },
      });
      const next = result.definition;
      if (isEditableWorkflowDefinition(next) && operations.length > 0) {
        const nextBlueprint = blueprints.data?.blueprints.find(
          (candidate) =>
            candidate.blueprintKey === next.blueprintKey &&
            candidate.blueprintVersion === next.blueprintVersion,
        );
        const reapplied = reapplyDesignerOperations(
          next.semanticRoot,
          operations,
          designerOperationContext(next, catalog, nextBlueprint),
        );
        queryClient.setQueryData(designerDetailQueryKey(next.workflowDefinitionId), next);
        setDefinitionId(next.workflowDefinitionId);
        setHistory(
          resetDesignerHistory(
            next,
            reapplied.semanticRoot,
            operations.slice(0, reapplied.ok ? undefined : reapplied.failedIndex),
          ),
        );
        setConflict(
          reapplied.ok
            ? null
            : {
                latest: next,
                operations,
                failedOperation: { index: reapplied.failedIndex, code: reapplied.code },
              },
        );
        setNotice(
          reapplied.ok ? "副本已创建，并重新应用本地操作。" : "副本已创建；部分操作需要处理。",
        );
      } else acceptServerDefinition(next, "已创建可编辑副本。");
    } catch {
      setNotice("创建副本未完成；原 Definition 和本地草稿未改变。");
    } finally {
      setBusy(null);
    }
  }

  function resolveConflict(mode: "reload" | "reapply") {
    if (conflict === null || !isEditableWorkflowDefinition(conflict.latest)) return;
    const latest = conflict.latest;
    if (mode === "reload") {
      acceptServerDefinition(
        latest,
        "已加载服务器最新版本；旧本地草稿仍按旧 baseHash 隔离保存。",
        false,
      );
      return;
    }
    const latestBlueprint = blueprints.data?.blueprints.find(
      (candidate) =>
        candidate.blueprintKey === latest.blueprintKey &&
        candidate.blueprintVersion === latest.blueprintVersion,
    );
    const reapplied = reapplyDesignerOperations(
      latest.semanticRoot,
      conflict.operations,
      designerOperationContext(latest, catalog, latestBlueprint),
    );
    setHistory(
      resetDesignerHistory(
        latest,
        reapplied.semanticRoot,
        conflict.operations.slice(0, reapplied.ok ? undefined : reapplied.failedIndex),
      ),
    );
    queryClient.setQueryData(designerDetailQueryKey(latest.workflowDefinitionId), latest);
    setConflict(
      reapplied.ok
        ? null
        : {
            latest,
            operations: conflict.operations,
            failedOperation: { index: reapplied.failedIndex, code: reapplied.code },
          },
    );
    setNotice(
      reapplied.ok
        ? "本地语义操作已基于最新版本重新应用；请重新校验后保存。"
        : `第 ${String(reapplied.failedIndex + 1)} 个操作无法重放：${operationErrorText(reapplied.code)}`,
    );
  }

  function locateDiagnostic(diagnostic: WorkflowDesignerDiagnosticDto) {
    if (history === null) return;
    focusDesignerDiagnostic(diagnostic, history.present);
  }

  if (definitions.isPending || catalogQuery.isPending || blueprints.isPending) {
    return <p className="loading-note">正在读取 Definition、Catalog 与 Blueprint…</p>;
  }
  if (
    definitions.isError ||
    catalogQuery.isError ||
    blueprints.isError ||
    definitions.data === undefined
  ) {
    return <p className="error-note">设计器资料读取失败；没有进入可编辑状态。</p>;
  }

  const selectedValue =
    history === null ? undefined : selectedDesignerElement(history.present, selected);
  const selectedDescriptor =
    selectedValue?.kind === "task" || selectedValue?.kind === "composite"
      ? catalog.find((candidate) => candidate.nodeType === selectedValue.nodeType)
      : undefined;

  return (
    <DesignerSurface
      detail={detailValue}
      editableDetail={editableDetail}
      definitions={definitions.data.definitions}
      definitionId={definitionId}
      detailPending={detail.isPending}
      detailError={detail.isError}
      history={history}
      selected={selected}
      selectedValue={selectedValue}
      selectedDescriptor={selectedDescriptor}
      catalog={catalog}
      optionalNodeTypes={optionalNodeTypes}
      allowedChoiceSourceTypes={editableDetail?.allowedChoiceSourceTypes ?? []}
      loopRules={blueprint?.loopRules ?? []}
      editing={editing}
      dirty={dirty}
      saveBlocked={localDiagnostics.some((diagnostic) => diagnostic.severity === "error")}
      validationPending={validationPending}
      serverValid={serverValid}
      busy={busy}
      notice={notice}
      copyTitle={copyTitle}
      copyDescription={copyDescription}
      operationError={operationError}
      conflict={conflict}
      diagnostics={diagnostics}
      onDefinitionChange={(next) => {
        if (dirty && !window.confirm("当前有未保存语义修改，仍要切换吗？")) return;
        setDefinitionId(next);
      }}
      onUndo={() => history && setHistory(undoDesignerHistory(history))}
      onRedo={() => history && setHistory(redoDesignerHistory(history))}
      onValidate={() => void validateCurrent(history?.present, true)}
      onSave={() => void handleWrite("save")}
      onPublish={() => void handleWrite("publish")}
      onArchive={() => void handleWrite("archive")}
      onCopyTitleChange={setCopyTitle}
      onCopyDescriptionChange={setCopyDescription}
      onCopy={() => void copyDefinition()}
      onConflictReload={() => resolveConflict("reload")}
      onConflictReapply={() => resolveConflict("reapply")}
      onConflictCopy={() => void copyDefinition(conflict?.latest, conflict?.operations)}
      onSelect={setSelected}
      onOperation={applyOperation}
      onDropPayload={handleDrop}
      onLocateDiagnostic={locateDiagnostic}
    />
  );
}
