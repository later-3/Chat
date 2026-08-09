import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandId, RuleDetailDto, RuleScopeInput } from "@chat/contracts/public";
import {
  ApiProblemError,
  apiArchiveRuleTag,
  apiCreateRule,
  apiCreateRuleTag,
  apiGetRule,
  apiListRuleTags,
  apiListRules,
  apiReviseRule,
  apiTransitionRule,
} from "../api/client.js";

type RuleLifecycle = RuleDetailDto["lifecycle"];

const LIFECYCLE_LABEL: Record<RuleLifecycle, string> = {
  candidate: "候选",
  trial: "试用中",
  active: "已启用",
  weakened: "已弱化",
  disabled: "已停用",
  rejected: "已拒绝",
};

function commandId(): CommandId {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}` as CommandId;
}

function detailScopes(rule: RuleDetailDto): RuleScopeInput[] {
  return rule.currentRevision.scopes.map((scope) =>
    scope.kind === "global"
      ? { kind: "global" }
      : {
          kind: "contextual",
          scenario: scope.scenario,
          ...(scope.projectMethodProfileId !== undefined
            ? { projectMethodProfileId: scope.projectMethodProfileId }
            : {}),
          ...(scope.projectStageKey !== undefined
            ? { projectStageKey: scope.projectStageKey }
            : {}),
          ...(scope.workflowNodeKey !== undefined
            ? { workflowNodeKey: scope.workflowNodeKey }
            : {}),
          ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
        },
  );
}

export function RulesPanel() {
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["chat-rules-api.v1", "rules"],
    queryFn: ({ signal }) => apiListRules(signal),
  });
  const tags = useQuery({
    queryKey: ["chat-rules-api.v1", "tags"],
    queryFn: ({ signal }) => apiListRuleTags(signal),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useQuery({
    queryKey: ["chat-rules-api.v1", "rule", selectedId],
    queryFn: ({ signal }) => apiGetRule(selectedId!, signal),
    enabled: selectedId !== null,
  });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [rationale, setRationale] = useState("");
  const [tagName, setTagName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["chat-rules-api.v1"] });
  }

  async function create() {
    if (busy || title.trim() === "" || body.trim() === "" || rationale.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiCreateRule({
        commandId: commandId(),
        payload: {
          title: title.trim(),
          priority: 500,
          revision: {
            body: body.trim(),
            rationale: rationale.trim(),
            appliesWhen: [],
            doesNotApplyWhen: [],
            positiveExamples: [],
            negativeExamples: [],
            scopes: [{ kind: "global" }],
            tagIds: [],
            conflictsWithRuleIds: [],
            risk: "low",
            sourceCases: [],
          },
        },
      });
      setSelectedId(result.rule.ruleId);
      setTitle("");
      setBody("");
      setRationale("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiProblemError ? caught : null);
    } finally {
      setBusy(false);
    }
  }

  async function revise() {
    const rule = selected.data?.rule;
    if (rule === undefined || busy || body.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const current = rule.currentRevision;
      await apiReviseRule({
        ruleId: rule.ruleId,
        commandId: commandId(),
        expectedRevision: rule.revision,
        payload: {
          currentRevisionId: current.ruleRevisionId,
          currentRevisionSha256: current.sha256,
          revision: {
            body: body.trim(),
            rationale: rationale.trim() || current.rationale,
            appliesWhen: current.appliesWhen,
            doesNotApplyWhen: current.doesNotApplyWhen,
            positiveExamples: current.positiveExamples,
            negativeExamples: current.negativeExamples,
            scopes: detailScopes(rule),
            tagIds: current.tagIds,
            conflictsWithRuleIds: current.conflictsWithRuleIds,
            risk: current.risk,
            sourceCases: current.sourceCases,
          },
        },
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiProblemError ? caught : null);
    } finally {
      setBusy(false);
    }
  }

  async function transition(toLifecycle: RuleLifecycle) {
    const rule = selected.data?.rule;
    if (rule === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiTransitionRule({
        ruleId: rule.ruleId,
        commandId: commandId(),
        expectedRevision: rule.revision,
        payload: {
          boundRevisionId: rule.currentRevision.ruleRevisionId,
          boundRevisionSha256: rule.currentRevision.sha256,
          toLifecycle,
          reason: `用户在Rules管理界面选择${LIFECYCLE_LABEL[toLifecycle]}`,
        },
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiProblemError ? caught : null);
    } finally {
      setBusy(false);
    }
  }

  async function createTag() {
    if (tagName.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiCreateRuleTag({ commandId: commandId(), payload: { name: tagName.trim() } });
      setTagName("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiProblemError ? caught : null);
    } finally {
      setBusy(false);
    }
  }

  async function archiveTag(ruleTagId: string, revision: number) {
    setBusy(true);
    setError(null);
    try {
      await apiArchiveRuleTag({ ruleTagId, expectedRevision: revision, commandId: commandId() });
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiProblemError ? caught : null);
    } finally {
      setBusy(false);
    }
  }

  const detail = selected.data?.rule;
  return (
    <section className="rules-panel" aria-label="用户规则">
      <header>
        <span className="eyebrow">Rules</span>
        <h3>用户规则</h3>
        <p>规则正文按Revision保存；只有试用或启用的Revision可加入运行配置。</p>
      </header>
      {error !== null && (
        <p className="error-note" role="alert">
          操作未完成（{error.code}）。
          {error.recoveryAction === "rehydrate_and_retry" ? "请刷新后重试。" : ""}
        </p>
      )}
      <section className="rules-create" aria-label="创建规则">
        <h4>创建候选规则</h4>
        <label>
          标题
          <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          规则正文
          <textarea
            rows={4}
            value={body}
            maxLength={8000}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <label>
          为什么需要它
          <textarea
            rows={2}
            value={rationale}
            maxLength={4000}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <button
          className="send-button"
          disabled={busy || !title.trim() || !body.trim() || !rationale.trim()}
          onClick={() => void create()}
        >
          保存候选
        </button>
      </section>
      <section aria-label="规则标签">
        <h4>标签</h4>
        <div className="rules-tag-create">
          <input
            aria-label="新标签名称"
            value={tagName}
            onChange={(event) => setTagName(event.target.value)}
          />
          <button
            className="small-button"
            disabled={busy || !tagName.trim()}
            onClick={() => void createTag()}
          >
            新增标签
          </button>
        </div>
        <ul className="rules-tags">
          {(tags.data?.items ?? []).map((tag) => (
            <li key={tag.ruleTagId}>
              <span>
                #{tag.name} · {tag.status === "active" ? "可用" : "已归档"}
              </span>
              {tag.status === "active" && (
                <button
                  className="small-button"
                  disabled={busy}
                  onClick={() => void archiveTag(tag.ruleTagId, tag.revision)}
                >
                  归档
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {rules.isPending ? (
        <p className="loading-note">正在读取规则…</p>
      ) : rules.isError ? (
        <p className="error-note" role="alert">
          规则列表读取失败。
        </p>
      ) : (
        <ol className="rules-list">
          {(rules.data?.items ?? []).map((rule) => (
            <li key={rule.ruleId}>
              <button
                className="rule-card"
                onClick={() => {
                  setSelectedId(rule.ruleId);
                  setBody("");
                  setRationale("");
                }}
              >
                <strong>{rule.title}</strong>
                <span>
                  {LIFECYCLE_LABEL[rule.lifecycle]} · Revision {rule.currentRevision.revision}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {detail !== undefined && (
        <section className="rule-detail" aria-label="规则详情">
          <h4>{detail.title}</h4>
          <p className="rule-body">{detail.currentRevision.body}</p>
          <p>{detail.currentRevision.rationale}</p>
          <div className="project-candidate-actions">
            {detail.allowedActions.includes("start_trial") && (
              <button
                className="small-button"
                disabled={busy}
                onClick={() => void transition("trial")}
              >
                开始试用
              </button>
            )}
            {detail.allowedActions.includes("activate") && (
              <button
                className="send-button"
                disabled={busy}
                onClick={() => void transition("active")}
              >
                启用
              </button>
            )}
            {detail.allowedActions.includes("weaken") && (
              <button
                className="small-button"
                disabled={busy}
                onClick={() => void transition("weakened")}
              >
                弱化
              </button>
            )}
            {detail.allowedActions.includes("disable") && (
              <button
                className="small-button"
                disabled={busy}
                onClick={() => void transition("disabled")}
              >
                停用
              </button>
            )}
            {detail.allowedActions.includes("reject") && (
              <button
                className="small-button"
                disabled={busy}
                onClick={() => void transition("rejected")}
              >
                拒绝
              </button>
            )}
          </div>
          <label>
            新Revision正文
            <textarea
              rows={5}
              value={body}
              placeholder={detail.currentRevision.body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label>
            修订理由
            <textarea
              rows={2}
              value={rationale}
              placeholder={detail.currentRevision.rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          <button
            className="small-button"
            disabled={busy || !body.trim()}
            onClick={() => void revise()}
          >
            保存新Revision
          </button>
        </section>
      )}
    </section>
  );
}
