import { useEffect, useState } from "react";
import type { ProjectWorkspaceDto } from "@chat/contracts/public";
import type { ProjectManagementOperation } from "../real/use-project-chain.js";

interface ProjectManagementControlsProps {
  readonly workspace: ProjectWorkspaceDto;
  readonly disabled: boolean;
  readonly onManage: (operation: ProjectManagementOperation) => void;
}

const ACTION_STATUS_OPTIONS = ["todo", "doing", "blocked", "done", "cancelled"] as const;

function ActionControl({
  action,
  participants,
  disabled,
  onManage,
}: {
  readonly action: ProjectWorkspaceDto["works"][number]["actions"][number];
  readonly participants: ProjectWorkspaceDto["participants"];
  readonly disabled: boolean;
  readonly onManage: (operation: ProjectManagementOperation) => void;
}) {
  const [nextStatus, setNextStatus] = useState<(typeof ACTION_STATUS_OPTIONS)[number]>(
    action.status,
  );
  const [blockedReason, setBlockedReason] = useState("");
  useEffect(() => setNextStatus(action.status), [action.status]);

  return (
    <div className="project-action-control">
      <strong>{action.title}</strong>
      <div className="project-inline-fields">
        <select
          aria-label={`分派待办：${action.title}`}
          value={action.ownerParticipantId}
          disabled={disabled}
          onChange={(event) =>
            onManage({
              kind: "assign_action",
              actionId: action.projectActionId,
              expectedRevision: action.revision,
              ownerParticipantId: event.target.value,
            })
          }
        >
          {participants
            .filter((participant) => participant.status === "active")
            .map((participant) => (
              <option
                key={participant.projectParticipantId}
                value={participant.projectParticipantId}
              >
                {participant.displayName}
              </option>
            ))}
        </select>
        <select
          aria-label={`待办状态：${action.title}`}
          value={nextStatus}
          disabled={disabled || action.status === "done" || action.status === "cancelled"}
          onChange={(event) =>
            setNextStatus(event.target.value as (typeof ACTION_STATUS_OPTIONS)[number])
          }
        >
          {ACTION_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      {nextStatus === "blocked" && (
        <input
          aria-label={`阻塞原因：${action.title}`}
          value={blockedReason}
          placeholder="说明阻塞原因"
          onChange={(event) => setBlockedReason(event.target.value)}
        />
      )}
      <button
        className="small-button"
        disabled={
          disabled ||
          nextStatus === action.status ||
          (nextStatus === "blocked" && blockedReason.trim() === "")
        }
        onClick={() =>
          onManage({
            kind: "transition_action",
            actionId: action.projectActionId,
            expectedRevision: action.revision,
            payload: {
              status: nextStatus,
              ...(nextStatus === "blocked" ? { blockedReason: blockedReason.trim() } : {}),
            },
          })
        }
      >
        确认更新状态
      </button>
    </div>
  );
}

/**
 * PS1的最小项目控制面：所有输入先在本地编辑，点击“确认”才提交产品Command。
 * 服务端仍拥有revision、状态机、参与者归属和时间线事实。
 */
export function ProjectManagementControls({
  workspace,
  disabled,
  onManage,
}: ProjectManagementControlsProps) {
  const firstWork = workspace.works[0];
  const firstParticipant = workspace.participants.find((item) => item.status === "active");
  const [actionTitle, setActionTitle] = useState("");
  const [actionWorkId, setActionWorkId] = useState(firstWork?.projectWorkId ?? "");
  const [actionOwnerId, setActionOwnerId] = useState(firstParticipant?.projectParticipantId ?? "");
  const [decisionQuestion, setDecisionQuestion] = useState("");
  const [decisionChoice, setDecisionChoice] = useState("");
  const [decisionRationale, setDecisionRationale] = useState("");
  const [contributionSummary, setContributionSummary] = useState("");

  useEffect(() => {
    if (actionWorkId === "" && firstWork !== undefined) setActionWorkId(firstWork.projectWorkId);
    if (actionOwnerId === "" && firstParticipant !== undefined) {
      setActionOwnerId(firstParticipant.projectParticipantId);
    }
  }, [actionOwnerId, actionWorkId, firstParticipant, firstWork]);

  return (
    <div className="project-management-controls">
      <section>
        <h4>资源</h4>
        <ul className="project-resource-list">
          {workspace.resources.map((resource) => (
            <li key={resource.projectResourceId}>
              <span>
                {resource.displayName}
                {resource.latestObservationAt !== undefined
                  ? ` · ${new Date(resource.latestObservationAt).toLocaleString()}`
                  : " · 尚未观察"}
              </span>
              <button
                className="small-button"
                disabled={disabled || workspace.project.status === "archived"}
                onClick={() =>
                  onManage({ kind: "observe", resourceId: resource.projectResourceId })
                }
              >
                刷新观察
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>当前工作与待办</h4>
        <div className="project-form-grid">
          <input
            aria-label="新待办标题"
            placeholder="新增待办"
            value={actionTitle}
            onChange={(event) => setActionTitle(event.target.value)}
          />
          <select
            aria-label="新待办所属工作"
            value={actionWorkId}
            onChange={(event) => setActionWorkId(event.target.value)}
          >
            {workspace.works.map((work) => (
              <option key={work.projectWorkId} value={work.projectWorkId}>
                {work.title}
              </option>
            ))}
          </select>
          <select
            aria-label="新待办负责人"
            value={actionOwnerId}
            onChange={(event) => setActionOwnerId(event.target.value)}
          >
            {workspace.participants
              .filter((participant) => participant.status === "active")
              .map((participant) => (
                <option
                  key={participant.projectParticipantId}
                  value={participant.projectParticipantId}
                >
                  {participant.displayName}
                </option>
              ))}
          </select>
          <button
            className="small-button"
            disabled={
              disabled ||
              workspace.project.status === "archived" ||
              actionTitle.trim() === "" ||
              actionWorkId === "" ||
              actionOwnerId === ""
            }
            onClick={() => {
              onManage({
                kind: "create_action",
                payload: {
                  workId: actionWorkId as never,
                  ownerParticipantId: actionOwnerId as never,
                  title: actionTitle.trim(),
                },
              });
              setActionTitle("");
            }}
          >
            确认新增待办
          </button>
        </div>
        <div className="project-action-list">
          {workspace.works.flatMap((work) =>
            work.actions.map((action) => (
              <ActionControl
                key={action.projectActionId}
                action={action}
                participants={workspace.participants}
                disabled={disabled || workspace.project.status === "archived"}
                onManage={onManage}
              />
            )),
          )}
        </div>
      </section>

      <section>
        <h4>记录决定</h4>
        <div className="project-form-grid">
          <input
            aria-label="决定问题"
            placeholder="要决定什么？"
            value={decisionQuestion}
            onChange={(event) => setDecisionQuestion(event.target.value)}
          />
          <textarea
            aria-label="决定选择"
            rows={2}
            placeholder="最终选择"
            value={decisionChoice}
            onChange={(event) => setDecisionChoice(event.target.value)}
          />
          <textarea
            aria-label="决定理由"
            rows={2}
            placeholder="为什么这样决定？"
            value={decisionRationale}
            onChange={(event) => setDecisionRationale(event.target.value)}
          />
          <button
            className="small-button"
            disabled={
              disabled ||
              workspace.project.status === "archived" ||
              firstParticipant === undefined ||
              decisionQuestion.trim() === "" ||
              decisionChoice.trim() === "" ||
              decisionRationale.trim() === ""
            }
            onClick={() => {
              if (firstParticipant === undefined) return;
              onManage({
                kind: "decision",
                payload: {
                  question: decisionQuestion.trim(),
                  options: [decisionChoice.trim()],
                  choice: decisionChoice.trim(),
                  rationale: decisionRationale.trim(),
                  decidedByParticipantId: firstParticipant.projectParticipantId,
                },
              });
              setDecisionQuestion("");
              setDecisionChoice("");
              setDecisionRationale("");
            }}
          >
            确认记录决定
          </button>
        </div>
      </section>

      <section>
        <h4>记录贡献</h4>
        <div className="project-form-grid">
          <textarea
            aria-label="贡献摘要"
            rows={2}
            placeholder="谁实际完成了什么？无Evidence时会标记为reported。"
            value={contributionSummary}
            onChange={(event) => setContributionSummary(event.target.value)}
          />
          <button
            className="small-button"
            disabled={
              disabled ||
              workspace.project.status === "archived" ||
              firstParticipant === undefined ||
              contributionSummary.trim() === ""
            }
            onClick={() => {
              if (firstParticipant === undefined) return;
              onManage({
                kind: "contribution",
                payload: {
                  participantId: firstParticipant.projectParticipantId,
                  kind: "coordination",
                  summary: contributionSummary.trim(),
                  evidenceIds: [],
                  occurredAt: new Date().toISOString(),
                },
              });
              setContributionSummary("");
            }}
          >
            确认记录贡献
          </button>
        </div>
      </section>

      <button
        className="small-button"
        disabled={disabled}
        onClick={() =>
          onManage({
            kind: "archive",
            status: workspace.project.status === "archived" ? "active" : "archived",
          })
        }
      >
        {workspace.project.status === "archived" ? "恢复项目" : "归档项目"}
      </button>
    </div>
  );
}
