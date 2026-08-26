import { describe, expect, it } from "vitest";
import {
  compileBuiltInProjectProfileRevision,
  compileProjectProfileRevision,
  getBuiltInProjectProfileDefinition,
  type ProjectProfileDefinition,
} from "./project-management.js";

const NOW = "2026-08-25T10:00:00.000Z";

describe("全项目生命周期Profile编译", () => {
  it("四种内置Profile通过同一个纯编译器且冻结不同对象、时间、View和Evidence", () => {
    const software = compileBuiltInProjectProfileRevision({
      profileKey: "software-delivery",
      now: NOW,
    });
    const content = compileBuiltInProjectProfileRevision({
      profileKey: "content-production",
      now: NOW,
    });
    const learning = compileBuiltInProjectProfileRevision({
      profileKey: "learning",
      now: NOW,
    });
    const journal = compileBuiltInProjectProfileRevision({
      profileKey: "personal-journal",
      now: NOW,
    });

    expect(software.viewRequirements.map((view) => view.capability)).toContain("code");
    expect(content.viewRequirements.map((view) => view.capability)).toContain("media");
    expect(learning.objectCatalog.map((object) => object.kind)).toContain("competency");
    expect(journal.objectCatalog.map((object) => object.kind)).toContain("daily_entry");
    expect(journal.defaultTimePolicy.mode).toBe("continuous");
    expect(learning.evidencePolicy.evidenceKinds).toContain("assessment");
    expect(content.authorityPolicy.humanDecisionActions).toContain("publication");
    expect(software.contextPolicies).toHaveLength(6);
    expect(new Set([software.sha256, content.sha256, learning.sha256, journal.sha256]).size).toBe(
      4,
    );
  });

  it("通用Profile不携带具体项目名称、目标、期限或执行Cadence", () => {
    const learning = compileBuiltInProjectProfileRevision({ profileKey: "learning", now: NOW });
    const journal = compileBuiltInProjectProfileRevision({
      profileKey: "personal-journal",
      now: NOW,
    });
    const serialized = JSON.stringify([learning, journal]);
    expect(serialized).not.toContain("AI学习");
    expect(serialized).not.toContain("四个月");
    expect(serialized).not.toContain("涨薪");
    expect(serialized).not.toContain("weekly-learning-review");
    expect(serialized).not.toContain("daily-close");
    expect(learning.defaultTimePolicy).not.toHaveProperty("defaultTimezone");
    expect(learning.defaultTimePolicy).not.toHaveProperty("cadences");
    expect(journal.defaultTimePolicy).not.toHaveProperty("defaultTimezone");
    expect(journal.defaultTimePolicy).not.toHaveProperty("cadences");
  });

  it("Profile编译确定且不把Plane、Obsidian、VS Code或DSH写入核心定义", () => {
    const first = compileBuiltInProjectProfileRevision({
      profileKey: "content-production",
      now: NOW,
    });
    const second = compileBuiltInProjectProfileRevision({
      profileKey: "content-production",
      now: NOW,
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first).toLowerCase()).not.toMatch(/plane|obsidian|vs code|deepseek/u);
  });

  it("合成第五Profile复用同一编译函数，不需要增加核心类型分支", () => {
    const base = getBuiltInProjectProfileDefinition("learning");
    const research: ProjectProfileDefinition = {
      ...base,
      profileKey: "research-goal.fixture.v1",
      title: "研究目标Fixture",
      purpose: "只验证新增Profile不需要修改核心编译器。",
      objectCatalog: [
        ...base.objectCatalog,
        {
          kind: "case",
          required: false,
          description: "研究案例与反例。",
        },
      ],
    };
    const compiled = compileProjectProfileRevision({
      projectProfileRevisionId: "pfr_researchfixture1",
      version: 1,
      definition: research,
      now: NOW,
    });
    expect(compiled.profileKey).toBe("research-goal.fixture.v1");
    expect(compiled.viewRequirements).toEqual(research.viewRequirements);
  });

  it("拒绝重复View、缺少必需对象和不完整Context", () => {
    const base = getBuiltInProjectProfileDefinition("software-delivery");
    expect(() =>
      compileProjectProfileRevision({
        projectProfileRevisionId: "pfr_duplicateview1",
        version: 1,
        definition: {
          ...base,
          viewRequirements: [...base.viewRequirements, base.viewRequirements[0]!],
        },
        now: NOW,
      }),
    ).toThrow("View Requirement不能重复");
    expect(() =>
      compileProjectProfileRevision({
        projectProfileRevisionId: "pfr_missingevent1",
        version: 1,
        definition: {
          ...base,
          objectCatalog: base.objectCatalog.filter((object) => object.kind !== "event"),
        },
        now: NOW,
      }),
    ).toThrow("Profile缺少必需对象:event");
    expect(() =>
      compileProjectProfileRevision({
        projectProfileRevisionId: "pfr_missingcontext1",
        version: 1,
        definition: { ...base, contextPolicies: base.contextPolicies.slice(0, 5) },
        now: NOW,
      }),
    ).toThrow("六类Context不完整");
  });
});
