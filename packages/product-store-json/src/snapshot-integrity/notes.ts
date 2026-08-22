import { type ProductSnapshot } from "@chat/contracts";
import {
  hashCanonical,
  assertNoteAggregateIntegrity,
  assertNoteCandidateIntegrity,
  assertNoteDecisionBinding,
  assertNoteRevisionIntegrity,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertNotes(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const noteIdBySourceCandidateId = new Map<string, string>();
  for (const note of Object.values(entities.notes)) {
    const revisions = Object.values(entities.noteRevisions).filter(
      (revision) => revision.noteId === note.noteId,
    );
    try {
      assertNoteAggregateIntegrity({ note, revisions });
    } catch (error) {
      fail(`note ${note.noteId} ${error instanceof Error ? error.message : String(error)}`);
    }
    if (entities.sessions[note.ownerPrincipalId] !== undefined) {
      fail(`note ${note.noteId} ownerPrincipalId误用Session身份`);
    }
    const sourceCandidate = entities.noteCandidates[note.sourceCandidateId];
    if (sourceCandidate === undefined) {
      fail(`note ${note.noteId} 悬空sourceCandidateId`);
    }
    const previousNoteId = noteIdBySourceCandidateId.get(note.sourceCandidateId);
    if (previousNoteId !== undefined) {
      fail(`note ${note.noteId} 与 ${previousNoteId} 重复绑定同一Note Candidate`);
    }
    noteIdBySourceCandidateId.set(note.sourceCandidateId, note.noteId);
    if (sourceCandidate !== undefined) {
      if (sourceCandidate.status !== "confirmed") {
        fail(`note ${note.noteId} sourceCandidate未确认`);
      }
      const run = entities.runs[sourceCandidate.productRunId];
      const session = run === undefined ? undefined : entities.sessions[run.sessionId];
      if (run === undefined || run.runKind !== "note_capture") {
        fail(`note ${note.noteId} sourceCandidate未绑定Note Capture Run`);
      }
      if (session === undefined || session.ownerPrincipalId !== note.ownerPrincipalId) {
        fail(`note ${note.noteId} ownerPrincipalId与sourceCandidate Run owner不一致`);
      }
      const initialRevision = revisions.find((revision) => revision.noteRevision === 1);
      if (initialRevision === undefined) {
        fail(`note ${note.noteId} 缺少首个Revision`);
      } else {
        const revisionSourceHash = hashCanonical("note.initial-revision-source.v1", {
          title: initialRevision.title,
          kind: initialRevision.kind,
          contentMarkdown: initialRevision.contentMarkdown,
          tags: initialRevision.tags,
          sourceRefs: initialRevision.sourceRefs,
        });
        const candidateSourceHash = hashCanonical("note.initial-revision-source.v1", {
          title: sourceCandidate.proposed.title,
          kind: sourceCandidate.proposed.kind,
          contentMarkdown: sourceCandidate.proposed.contentMarkdown,
          tags: sourceCandidate.proposed.tags,
          sourceRefs: sourceCandidate.sourceRefs,
        });
        if (revisionSourceHash !== candidateSourceHash) {
          fail(`note ${note.noteId} 首版Revision与sourceCandidate内容或来源不一致`);
        }
      }
    }
  }
  for (const revision of Object.values(entities.noteRevisions)) {
    try {
      assertNoteRevisionIntegrity(revision);
    } catch (error) {
      fail(
        `noteRevision ${revision.noteRevisionId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const note = entities.notes[revision.noteId];
    if (note === undefined) fail(`noteRevision ${revision.noteRevisionId} 悬空noteId`);
    if (note !== undefined && note.ownerPrincipalId !== revision.createdByPrincipalId) {
      fail(`noteRevision ${revision.noteRevisionId} createdByPrincipalId与Note owner不一致`);
    }
    for (const sourceRef of revision.sourceRefs) {
      const message = entities.messages[sourceRef.sourceMessageId];
      if (message === undefined)
        fail(`noteRevision ${revision.noteRevisionId} 悬空sourceMessageId`);
    }
  }
  for (const candidate of Object.values(entities.noteCandidates)) {
    try {
      assertNoteCandidateIntegrity(candidate);
    } catch (error) {
      fail(
        `noteCandidate ${candidate.noteCandidateId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const run = entities.runs[candidate.productRunId];
    if (run === undefined || run.runKind !== "note_capture") {
      fail(`noteCandidate ${candidate.noteCandidateId} 未绑定Note Capture Run`);
    }
    if (
      candidate.supersedesCandidateId !== undefined &&
      entities.noteCandidates[candidate.supersedesCandidateId]?.productRunId !==
        candidate.productRunId
    ) {
      fail(`noteCandidate ${candidate.noteCandidateId} successor链跨Run或悬空`);
    }
    for (const sourceRef of candidate.sourceRefs) {
      if (entities.messages[sourceRef.sourceMessageId] === undefined) {
        fail(`noteCandidate ${candidate.noteCandidateId} 悬空sourceMessageId`);
      }
    }
  }
  for (const decision of Object.values(entities.noteDecisions)) {
    const candidate = entities.noteCandidates[decision.noteCandidateId];
    if (candidate === undefined) fail(`noteDecision ${decision.noteDecisionId} 悬空candidate`);
    if (candidate !== undefined) {
      try {
        const decisionCandidate = {
          ...candidate,
          status: "under_review" as const,
          revision: decision.candidateRevision,
        };
        assertNoteDecisionBinding({ candidate: decisionCandidate, decision });
      } catch (error) {
        fail(
          `noteDecision ${decision.noteDecisionId} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (candidate.productRunId !== decision.productRunId) {
        fail(`noteDecision ${decision.noteDecisionId} productRunId与Candidate不一致`);
      }
    }
  }
}
