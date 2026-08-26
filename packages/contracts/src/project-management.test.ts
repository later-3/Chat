import { describe, expect, it } from "vitest";
import {
  projectArtifactRefSchema,
  projectConfigurationSchedulePolicySchema,
  projectConfigurationRevisionSchema,
  projectEventSchema,
  projectNeedSchema,
  projectViewRequirementSchema,
} from "./project-management.js";

const NOW = "2026-08-25T10:00:00.000Z";

describe("全项目生命周期网络合同", () => {
  it("Project Event严格区分发生、观察、记录时间和连续Revision", () => {
    const event = {
      schemaVersion: "project-event.v1",
      projectEventId: "pev_timeline1",
      projectId: "prj_timeline1",
      eventType: "artifact.revised",
      subject: { kind: "artifact", objectId: "paf_artifact1", revision: 2 },
      source: { kind: "agent", participantId: "ppt_agent1" },
      occurredAt: "2026-08-25T09:00:00.000Z",
      observedAt: "2026-08-25T09:01:00.000Z",
      recordedAt: NOW,
      beforeRevision: 1,
      afterRevision: 2,
      payloadSha256: "a".repeat(64),
      evidenceIds: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    expect(projectEventSchema.parse(event)).toMatchObject({ afterRevision: 2 });
    expect(
      projectEventSchema.safeParse({ ...event, observedAt: "2026-08-25T08:59:00.000Z" }).success,
    ).toBe(false);
    expect(projectEventSchema.safeParse({ ...event, afterRevision: 3 }).success).toBe(false);
  });

  it("Need被记录不等于Commitment，只有Committed状态绑定Decision", () => {
    const need = {
      schemaVersion: "project-need.v1",
      projectNeedId: "pnd_browser1",
      projectId: "prj_chat1",
      statement: "Chat需要受治理的Browser Provider。",
      origin: "user",
      status: "captured",
      occurredAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    expect(projectNeedSchema.parse(need).commitmentDecisionId).toBeUndefined();
    expect(projectNeedSchema.safeParse({ ...need, status: "committed" }).success).toBe(false);
    expect(
      projectNeedSchema.safeParse({
        ...need,
        status: "committed",
        commitmentDecisionId: "pdc_needcommit1",
      }).success,
    ).toBe(true);
  });

  it("Configuration绑定View Capability而不是固定Viewer，并守住采用事实", () => {
    const candidate = {
      schemaVersion: "project-configuration-revision.v1",
      projectConfigurationRevisionId: "pcf_contentlab1",
      projectId: "prj_contentlab1",
      version: 1,
      profileRevisionId: "pfr_contentproduction1",
      profileRevisionSha256: "b".repeat(64),
      status: "candidate",
      objective: "持续生产、发布并改进中文内容工作流。",
      scopeIn: ["中文内容生产"],
      scopeOut: ["自动公开发布"],
      successCriteria: ["用户审核并验证发布回执"],
      timezone: "Asia/Shanghai",
      schedulePolicy: {
        mode: "continuous",
        plannedActualComparison: true,
        recurrenceEnabled: true,
        cadences: [
          {
            key: "publication-review",
            trigger: "weekly",
            action: "review",
            required: true,
          },
        ],
      },
      participantIds: ["ppt_user1"],
      resourceBindings: [
        {
          projectResourceId: "prs_content1",
          role: "content",
          required: true,
          capabilities: ["read", "write", "version", "render"],
        },
      ],
      presentationBindings: [
        {
          capability: "document",
          providerKind: "dsh-document-view.v1",
          bindingRef: "project:content-lab:documents",
          mode: "primary",
        },
      ],
      terminology: { publication: "发布" },
      requiredReads: ["AGENTS.md"],
      sha256: "c".repeat(64),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    expect(projectConfigurationRevisionSchema.parse(candidate).status).toBe("candidate");
    expect(
      projectConfigurationSchedulePolicySchema.safeParse({
        ...candidate.schedulePolicy,
        mode: "deadline",
      }).success,
    ).toBe(false);
    expect(
      projectConfigurationSchedulePolicySchema.safeParse({
        ...candidate.schedulePolicy,
        targetAt: NOW,
      }).success,
    ).toBe(false);
    expect(
      projectConfigurationSchedulePolicySchema.safeParse({
        ...candidate.schedulePolicy,
        recurrenceEnabled: false,
      }).success,
    ).toBe(false);
    expect(
      projectConfigurationRevisionSchema.safeParse({ ...candidate, status: "adopted" }).success,
    ).toBe(false);
    expect(
      projectConfigurationRevisionSchema.safeParse({
        ...candidate,
        status: "adopted",
        adoptedByDecisionId: "pdc_config1",
        effectiveFrom: NOW,
      }).success,
    ).toBe(true);
  });

  it("View Requirement拒绝把providerKind写进Profile，Artifact只保存引用和来源", () => {
    const view = {
      capability: "document",
      required: true,
      objectKinds: ["requirement", "artifact", "knowledge"],
      fields: ["body", "revision", "source"],
      actions: ["open_resource"],
      freshness: "snapshot",
      fallbackIntent: "open_resource",
    } as const;
    expect(projectViewRequirementSchema.parse(view).capability).toBe("document");
    expect(
      projectViewRequirementSchema.safeParse({ ...view, providerKind: "obsidian" }).success,
    ).toBe(false);

    expect(
      projectArtifactRefSchema.parse({
        schemaVersion: "project-artifact-ref.v1",
        projectArtifactRefId: "paf_copy1",
        projectId: "prj_contentlab1",
        resourceId: "prs_content1",
        role: "published-copy",
        locator: "content/2026-08-25/copy.md",
        revisionRef: "git:abc123",
        contentSha256: "d".repeat(64),
        mediaType: "text/markdown",
        status: "current",
        provenanceEventIds: ["pev_copy1"],
        observedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ locator: "content/2026-08-25/copy.md" });
  });
});
