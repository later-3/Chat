import { describe, expect, it } from "vitest";
import {
  assertPromptFragmentRevision,
  computePromptFragmentRevisionV2Sha256,
} from "./prompt-fragment.js";

describe("Prompt Fragment Revision v2", () => {
  it("正文只以受管Markdown引用进入版本Hash", () => {
    const body = {
      promptFragmentId: "pfg_promptv2",
      revision: 1,
      regionKey: "rules",
      title: "证据规则",
      contentRef: {
        kind: "managed_markdown" as const,
        contentKind: "markdown" as const,
        contentSha256: "a".repeat(64),
        sourceRelativePath: ".data/prompts/global/rules/pfg_promptv2/pfr_promptv2.md",
        sourceSha256: "b".repeat(64),
      },
      authoredByPrincipalId: "usr_promptv2",
    };
    const revision = {
      schemaVersion: "prompt-fragment-revision.v2" as const,
      promptFragmentRevisionId: "pfr_promptv2",
      ...body,
      sha256: computePromptFragmentRevisionV2Sha256(body),
    };
    expect(() => assertPromptFragmentRevision(revision)).not.toThrow();
    expect(JSON.stringify(revision)).not.toContain("证据规则正文");
    expect(() =>
      assertPromptFragmentRevision({
        ...revision,
        contentRef: { ...revision.contentRef, sourceSha256: "c".repeat(64) },
      }),
    ).toThrow("Hash不一致");
  });
});
