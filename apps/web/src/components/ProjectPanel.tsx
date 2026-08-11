import { useEffect, useState } from "react";
import {
  projectAdvancementCandidateDecisionPayloadSchema,
  type ProjectAdvancementProposal,
  type ProjectIntakeProposal,
  type ProjectManagementProposal,
} from "@chat/contracts/public";
import { useProjectChain } from "../real/use-project-chain.js";
import { ProjectManagementControls } from "./ProjectManagementControls.js";

type ProjectChain = ReturnType<typeof useProjectChain>;

function nonEmptyLines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function LineListField({
  label,
  value,
  onChange,
  rows = 2,
}: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  rows?: number;
}) {
  return (
    <label>
      {label}
      <textarea
        rows={rows}
        value={value.join("\n")}
        onChange={(event) => onChange(nonEmptyLines(event.target.value))}
      />
    </label>
  );
}

export function ProjectPanel({ projects }: { projects: ProjectChain }) {
  const candidate = projects.candidate.data;
  const workspace = projects.project.data;
  const [proposal, setProposal] = useState<ProjectIntakeProposal | null>(null);
  const [managementProposal, setManagementProposal] = useState<ProjectManagementProposal | null>(
    null,
  );
  const [advancementProposal, setAdvancementProposal] = useState<ProjectAdvancementProposal | null>(
    null,
  );
  useEffect(() => {
    if (candidate?.candidateKind === "intake" && candidate.status === "under_review") {
      setProposal(candidate.proposal);
    }
    if (candidate?.candidateKind === "management" && candidate.status === "under_review") {
      setManagementProposal(candidate.proposal);
    }
    if (candidate?.candidateKind === "advancement" && candidate.status === "under_review") {
      setAdvancementProposal(candidate.proposal);
    }
  }, [candidate]);
  const advancementProposalValid =
    advancementProposal !== null &&
    projectAdvancementCandidateDecisionPayloadSchema.safeParse({
      kind: "revise",
      candidateSha256: "0".repeat(64),
      proposal: advancementProposal,
    }).success;
  const advancementProposalDirty =
    candidate?.candidateKind === "advancement" &&
    candidate.status === "under_review" &&
    advancementProposal !== null &&
    JSON.stringify(advancementProposal) !== JSON.stringify(candidate.proposal);

  return (
    <section className="project-panel" aria-label="项目管理">
      <header className="project-panel-header">
        <div>
          <h3>项目</h3>
          <p>真实资源、参与者、工作、决定与证据</p>
        </div>
        <select
          aria-label="选择项目"
          value={projects.activeProjectId ?? ""}
          onChange={(event) => projects.chooseProject(event.target.value)}
        >
          <option value="">选择项目</option>
          {(projects.projects.data ?? []).map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
      </header>
      {projects.beginError !== null && (
        <p className="error-note">建项请求未能提交，请刷新后重试。</p>
      )}
      {projects.managementBeginError !== null && (
        <p className="error-note">项目管理消息未能生成Candidate，请刷新后重试。</p>
      )}
      {projects.advancementBeginError !== null && (
        <p className="error-note">项目推进消息未能提交，请刷新后重试。</p>
      )}
      {candidate?.candidateKind === "advancement" && candidate.status === "queued" && (
        <p className="loading-note">正在理解阶段目标、关键结果和负责人更新…</p>
      )}
      {candidate?.candidateKind === "advancement" && candidate.status === "failed" && (
        <p className="error-note" role="alert">
          项目推进理解失败（{candidate.failureCode}）。原消息已保留，请修复配置后重新发起。
        </p>
      )}
      {candidate?.candidateKind === "intake" && candidate.status === "queued" && (
        <p className="loading-note">正在理解诉求并观察真实项目资源…</p>
      )}
      {candidate?.candidateKind === "intake" && candidate.status === "failed" && (
        <p className="error-note" role="alert">
          建项理解或资源观察失败（{candidate.failureCode}）。原消息已保留，请修复配置后重新发起。
        </p>
      )}
      {candidate?.candidateKind === "intake" &&
        candidate.status === "under_review" &&
        proposal !== null && (
          <div className="project-candidate-card">
            <span className="eyebrow">建项方案 · 等待你的确认</span>
            <label>
              项目名称
              <input
                value={proposal.name}
                onChange={(event) => setProposal({ ...proposal, name: event.target.value })}
              />
            </label>
            <label>
              项目目标
              <textarea
                rows={3}
                value={proposal.goal}
                onChange={(event) => setProposal({ ...proposal, goal: event.target.value })}
              />
            </label>
            <p>{proposal.method.rationale}</p>
            <dl className="project-evidence-grid">
              <div>
                <dt>分支</dt>
                <dd>{candidate.resource.branch}</dd>
              </div>
              <div>
                <dt>提交</dt>
                <dd>{candidate.resource.headSha.slice(0, 8)}</dd>
              </div>
              <div>
                <dt>文档</dt>
                <dd>{candidate.resource.documentCount}</dd>
              </div>
              <div>
                <dt>脚本</dt>
                <dd>{candidate.resource.scriptCount}</dd>
              </div>
            </dl>
            <div className="project-candidate-actions">
              <button
                className="small-button"
                disabled={projects.deciding}
                onClick={() => projects.revise(proposal)}
              >
                保存修改
              </button>
              <button
                className="small-button"
                disabled={projects.deciding}
                onClick={() => projects.reject("用户拒绝建项方案")}
              >
                拒绝
              </button>
              <button
                className="send-button"
                disabled={projects.deciding}
                onClick={projects.confirm}
              >
                确认建立项目
              </button>
            </div>
          </div>
        )}
      {candidate?.candidateKind === "management" &&
        candidate.status === "under_review" &&
        managementProposal !== null && (
          <div className="project-candidate-card" aria-label="项目管理方案">
            <span className="eyebrow">项目管理方案 · 等待你的确认</span>
            {managementProposal.kind === "decision" ? (
              <>
                <label>
                  决定问题
                  <input
                    value={managementProposal.question}
                    onChange={(event) =>
                      setManagementProposal({
                        ...managementProposal,
                        question: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  最终选择
                  <textarea
                    rows={2}
                    value={managementProposal.choice}
                    onChange={(event) =>
                      setManagementProposal({
                        ...managementProposal,
                        options: [event.target.value],
                        choice: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  决定理由
                  <textarea
                    rows={2}
                    value={managementProposal.rationale}
                    onChange={(event) =>
                      setManagementProposal({
                        ...managementProposal,
                        rationale: event.target.value,
                      })
                    }
                  />
                </label>
              </>
            ) : managementProposal.kind === "action" ? (
              <label>
                待办标题
                <input
                  value={managementProposal.title}
                  onChange={(event) =>
                    setManagementProposal({ ...managementProposal, title: event.target.value })
                  }
                />
              </label>
            ) : (
              <label>
                贡献摘要
                <textarea
                  rows={2}
                  value={managementProposal.summary}
                  onChange={(event) =>
                    setManagementProposal({ ...managementProposal, summary: event.target.value })
                  }
                />
              </label>
            )}
            {projects.managementDecisionError !== null && (
              <p className="error-note">Candidate状态已变化，请刷新后重新确认。</p>
            )}
            <div className="project-candidate-actions">
              <button
                className="small-button"
                disabled={projects.decidingManagement}
                onClick={() => projects.reviseManagement(managementProposal)}
              >
                保存管理方案
              </button>
              <button
                className="small-button"
                disabled={projects.decidingManagement}
                onClick={() => projects.rejectManagement("用户拒绝项目管理方案")}
              >
                拒绝管理方案
              </button>
              <button
                className="send-button"
                disabled={projects.decidingManagement}
                onClick={projects.confirmManagement}
              >
                确认写入项目账本
              </button>
            </div>
          </div>
        )}
      {candidate?.candidateKind === "advancement" &&
        candidate.status === "under_review" &&
        advancementProposal !== null && (
          <div className="project-candidate-card" aria-label="项目推进方案">
            <span className="eyebrow">Stage、Milestone 与负责人更新 · 等待你的确认</span>
            <label>
              当前阶段名称
              <input
                value={advancementProposal.stage.name}
                onChange={(event) =>
                  setAdvancementProposal({
                    ...advancementProposal,
                    stage: { ...advancementProposal.stage, name: event.target.value },
                  })
                }
              />
            </label>
            <label>
              阶段目标
              <textarea
                rows={3}
                value={advancementProposal.stage.goal}
                onChange={(event) =>
                  setAdvancementProposal({
                    ...advancementProposal,
                    stage: { ...advancementProposal.stage, goal: event.target.value },
                  })
                }
              />
            </label>
            <LineListField
              label="成功标准（每行一项）"
              rows={3}
              value={advancementProposal.stage.successCriteria}
              onChange={(successCriteria) =>
                setAdvancementProposal({
                  ...advancementProposal,
                  stage: { ...advancementProposal.stage, successCriteria },
                })
              }
            />
            <label>
              健康判断
              <select
                value={advancementProposal.update.health}
                onChange={(event) =>
                  setAdvancementProposal({
                    ...advancementProposal,
                    update: {
                      ...advancementProposal.update,
                      health: event.target.value as ProjectAdvancementProposal["update"]["health"],
                    },
                  })
                }
              >
                <option value="unknown">尚不判断</option>
                <option value="on_track">正常</option>
                <option value="at_risk">有风险</option>
                <option value="off_track">偏离</option>
              </select>
            </label>
            <label>
              负责人更新
              <textarea
                rows={3}
                value={advancementProposal.update.narrative}
                onChange={(event) =>
                  setAdvancementProposal({
                    ...advancementProposal,
                    update: { ...advancementProposal.update, narrative: event.target.value },
                  })
                }
              />
            </label>
            <LineListField
              label="已观察变化（每行一项）"
              value={advancementProposal.update.observedChanges}
              onChange={(observedChanges) =>
                setAdvancementProposal({
                  ...advancementProposal,
                  update: { ...advancementProposal.update, observedChanges },
                })
              }
            />
            <LineListField
              label="阻塞项（每行一项）"
              value={advancementProposal.update.blockers}
              onChange={(blockers) =>
                setAdvancementProposal({
                  ...advancementProposal,
                  update: { ...advancementProposal.update, blockers },
                })
              }
            />
            <LineListField
              label="下一步重点（每行一项）"
              value={advancementProposal.update.nextFocus}
              onChange={(nextFocus) =>
                setAdvancementProposal({
                  ...advancementProposal,
                  update: { ...advancementProposal.update, nextFocus },
                })
              }
            />
            <div>
              <strong>关键结果</strong>
              <ul className="project-decision-list">
                {advancementProposal.milestones.map((milestone, index) => (
                  <li key={`milestone-${String(index)}`}>
                    <label>
                      关键结果{String(index + 1)}
                      <textarea
                        rows={2}
                        value={milestone.outcome}
                        onChange={(event) =>
                          setAdvancementProposal({
                            ...advancementProposal,
                            milestones: advancementProposal.milestones.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, outcome: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <LineListField
                      label={`验收标准${String(index + 1)}（每行一项）`}
                      value={milestone.acceptanceCriteria}
                      onChange={(acceptanceCriteria) =>
                        setAdvancementProposal({
                          ...advancementProposal,
                          milestones: advancementProposal.milestones.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, acceptanceCriteria } : item,
                          ),
                        })
                      }
                    />
                    <label>
                      目标时间{String(index + 1)}（RFC3339，可选）
                      <input
                        value={milestone.targetAt ?? ""}
                        onChange={(event) =>
                          setAdvancementProposal({
                            ...advancementProposal,
                            milestones: advancementProposal.milestones.map((item, itemIndex) => {
                              if (itemIndex !== index) return item;
                              const targetAt = event.target.value.trim();
                              return {
                                outcome: item.outcome,
                                acceptanceCriteria: item.acceptanceCriteria,
                                ...(targetAt === "" ? {} : { targetAt }),
                              };
                            }),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="small-button"
                      onClick={() =>
                        setAdvancementProposal({
                          ...advancementProposal,
                          milestones: advancementProposal.milestones.filter(
                            (_item, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      删除关键结果{String(index + 1)}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="small-button"
                disabled={advancementProposal.milestones.length >= 8}
                onClick={() =>
                  setAdvancementProposal({
                    ...advancementProposal,
                    milestones: [
                      ...advancementProposal.milestones,
                      { outcome: "", acceptanceCriteria: [] },
                    ],
                  })
                }
              >
                新增关键结果
              </button>
            </div>
            {!advancementProposalValid && (
              <p className="error-note" role="alert">
                请补齐阶段目标、成功标准、下一步重点以及每个关键结果的验收标准。
              </p>
            )}
            {projects.advancementDecisionError !== null && (
              <p className="error-note">推进方案版本已变化，请刷新后重新确认。</p>
            )}
            <div className="project-candidate-actions">
              <button
                className="small-button"
                disabled={
                  projects.decidingAdvancement ||
                  !advancementProposalValid ||
                  !advancementProposalDirty
                }
                onClick={() => projects.reviseAdvancement(advancementProposal)}
              >
                保存推进方案
              </button>
              <button
                className="small-button"
                disabled={projects.decidingAdvancement}
                onClick={() => projects.rejectAdvancement("用户拒绝项目推进方案")}
              >
                拒绝
              </button>
              <button
                className="send-button"
                disabled={
                  projects.decidingAdvancement ||
                  !advancementProposalValid ||
                  advancementProposalDirty
                }
                onClick={projects.confirmAdvancement}
              >
                确认阶段与发布更新
              </button>
            </div>
          </div>
        )}
      {workspace !== undefined && (
        <div className="project-workspace-card">
          <span className="eyebrow">{workspace.project.stageName}</span>
          <h3>{workspace.project.name}</h3>
          <p>{workspace.project.goal}</p>
          <section className="project-stage-summary" aria-label="当前阶段">
            <h4>{workspace.stage.name}</h4>
            <p>{workspace.stage.goal}</p>
            <ul>
              {workspace.stage.successCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </section>
          {workspace.milestones.length > 0 && (
            <section aria-label="阶段关键结果">
              <h4>关键结果</h4>
              <ul className="project-decision-list">
                {workspace.milestones.map((milestone) => (
                  <li key={milestone.projectMilestoneId}>
                    <strong>{milestone.outcome}</strong>
                    <span>{milestone.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {workspace.latestUpdate !== null && (
            <section className="project-update-card" aria-label="最新项目更新">
              <h4>负责人更新 · {workspace.latestUpdate.health}</h4>
              <p>{workspace.latestUpdate.narrative}</p>
              <small>{new Date(workspace.latestUpdate.publishedAt).toLocaleString()}</small>
            </section>
          )}
          <div className="project-metrics">
            <span>{workspace.project.participantCount} 位参与者</span>
            <span>{workspace.project.activeWorkCount} 项工作</span>
            <span>{workspace.project.openActionCount} 个待办</span>
          </div>
          {projects.manageError !== null && (
            <p className="error-note" role="alert">
              项目操作未提交；服务端状态可能已变化，请刷新后重试。
            </p>
          )}
          <ProjectManagementControls
            workspace={workspace}
            disabled={projects.managing}
            onManage={projects.manage}
          />
          <h4>最近决定</h4>
          <ul className="project-decision-list">
            {workspace.decisions.slice(0, 5).map((decision) => (
              <li key={decision.projectDecisionId}>
                <strong>{decision.question}</strong>
                <span>{decision.choice}</span>
              </li>
            ))}
          </ul>
          <h4>最近贡献</h4>
          <ul className="project-decision-list">
            {workspace.contributions.slice(0, 5).map((contribution) => (
              <li key={contribution.projectContributionId}>
                <strong>{contribution.summary}</strong>
                <span>{contribution.evidenceStatus}</span>
              </li>
            ))}
          </ul>
          <h4>时间线</h4>
          <ul className="project-decision-list">
            {(projects.timeline.data ?? []).slice(0, 8).map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <span>{item.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
