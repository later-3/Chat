import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CommandId,
  ProjectCandidateDecisionPayload,
  ProjectIntakeProposal,
  CreateProjectActionPayload,
  RecordProjectDecisionPayload,
  RecordProjectContributionPayload,
  TransitionProjectActionPayload,
} from "@chat/contracts/public";
import {
  apiBeginProjectIntake,
  apiDecideProjectCandidate,
  apiGetProject,
  apiGetProjectCandidate,
  apiGetCurrentProjectCandidate,
  apiGetProjectRoots,
  apiGetProjectTimeline,
  apiListProjects,
  apiCreateProjectAction,
  apiAssignProjectAction,
  apiTransitionProjectAction,
  apiObserveProjectResource,
  apiRecordProjectDecision,
  apiRecordProjectContribution,
  apiSetProjectArchiveStatus,
} from "../api/client.js";

const CANDIDATE_KEY = "chat.project.activeCandidate.v1";
const PROJECT_KEY = "chat.project.activeProject.v1";

function commandId(): CommandId {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}` as CommandId;
}

export type ProjectManagementOperation =
  | { kind: "create_action"; payload: CreateProjectActionPayload }
  | {
      kind: "assign_action";
      actionId: string;
      expectedRevision: number;
      ownerParticipantId: string;
    }
  | {
      kind: "transition_action";
      actionId: string;
      expectedRevision: number;
      payload: TransitionProjectActionPayload;
    }
  | { kind: "observe"; resourceId: string }
  | { kind: "decision"; payload: RecordProjectDecisionPayload }
  | { kind: "contribution"; payload: RecordProjectContributionPayload }
  | { kind: "archive"; status: "active" | "archived" };

export function useProjectChain(storage: Storage, sessionId: string | null) {
  const queryClient = useQueryClient();
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(() =>
    storage.getItem(CANDIDATE_KEY),
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() =>
    storage.getItem(PROJECT_KEY),
  );
  const roots = useQuery({ queryKey: ["project-roots"], queryFn: apiGetProjectRoots });
  const serverCandidate = useQuery({
    queryKey: ["current-project-candidate", sessionId],
    enabled: sessionId !== null && activeCandidateId === null,
    queryFn: () => apiGetCurrentProjectCandidate(sessionId ?? ""),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: apiListProjects });
  const candidate = useQuery({
    queryKey: ["project-candidate", activeCandidateId],
    enabled: activeCandidateId !== null,
    queryFn: () => apiGetProjectCandidate(activeCandidateId ?? ""),
    refetchInterval: (query) => (query.state.data?.status === "queued" ? 1_000 : false),
  });
  const project = useQuery({
    queryKey: ["project", activeProjectId],
    enabled: activeProjectId !== null,
    queryFn: () => apiGetProject(activeProjectId ?? ""),
  });
  const timeline = useQuery({
    queryKey: ["project-timeline", activeProjectId],
    enabled: activeProjectId !== null,
    queryFn: () => apiGetProjectTimeline(activeProjectId ?? ""),
  });

  useEffect(() => {
    const candidateId = serverCandidate.data?.candidate?.projectCandidateId;
    if (activeCandidateId !== null || candidateId === undefined) return;
    storage.setItem(CANDIDATE_KEY, candidateId);
    setActiveCandidateId(candidateId);
  }, [activeCandidateId, serverCandidate.data, storage]);

  useEffect(() => {
    if (activeProjectId !== null || projects.data?.[0] === undefined) return;
    const projectId = projects.data[0].projectId;
    storage.setItem(PROJECT_KEY, projectId);
    setActiveProjectId(projectId);
  }, [activeProjectId, projects.data, storage]);

  const begin = useMutation({
    mutationFn: (input: { text: string; rootId: string }) => {
      if (sessionId === null) throw new Error("session not ready");
      return apiBeginProjectIntake({
        commandId: commandId(),
        payload: { sessionId: sessionId as never, text: input.text, rootId: input.rootId },
      });
    },
    onSuccess: (next) => {
      storage.setItem(CANDIDATE_KEY, next.projectCandidateId);
      setActiveCandidateId(next.projectCandidateId);
      void queryClient.invalidateQueries({ queryKey: ["project-candidate"] });
    },
  });

  const decide = useMutation({
    mutationFn: (payload: ProjectCandidateDecisionPayload) => {
      const current = candidate.data;
      if (current === undefined || current.status !== "under_review") {
        throw new Error("candidate not ready");
      }
      return apiDecideProjectCandidate({
        projectCandidateId: current.projectCandidateId,
        commandId: commandId(),
        expectedRevision: current.revision,
        payload,
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["project-candidate"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (result.project !== undefined) {
        const projectId = result.project.project.projectId;
        storage.setItem(PROJECT_KEY, projectId);
        setActiveProjectId(projectId);
        void queryClient.setQueryData(["project", projectId], result.project);
      }
    },
  });

  const manage = useMutation({
    mutationFn: async (operation: ProjectManagementOperation) => {
      const current = project.data;
      if (current === undefined) throw new Error("project not ready");
      const projectId = current.project.projectId;
      if (operation.kind === "create_action") {
        return apiCreateProjectAction({
          projectId,
          commandId: commandId(),
          payload: operation.payload,
        });
      }
      if (operation.kind === "assign_action") {
        return apiAssignProjectAction({
          actionId: operation.actionId,
          commandId: commandId(),
          expectedRevision: operation.expectedRevision,
          payload: { ownerParticipantId: operation.ownerParticipantId as never },
        });
      }
      if (operation.kind === "transition_action") {
        return apiTransitionProjectAction({
          actionId: operation.actionId,
          commandId: commandId(),
          expectedRevision: operation.expectedRevision,
          payload: operation.payload,
        });
      }
      if (operation.kind === "observe") {
        return apiObserveProjectResource({
          projectId,
          resourceId: operation.resourceId,
          commandId: commandId(),
        });
      }
      if (operation.kind === "decision") {
        return apiRecordProjectDecision({
          projectId,
          commandId: commandId(),
          expectedRevision: current.project.revision,
          payload: operation.payload,
        });
      }
      if (operation.kind === "contribution") {
        return apiRecordProjectContribution({
          projectId,
          commandId: commandId(),
          payload: operation.payload,
        });
      }
      return apiSetProjectArchiveStatus({
        projectId,
        commandId: commandId(),
        expectedRevision: current.project.revision,
        payload: { status: operation.status },
      });
    },
    onSuccess: (next) => {
      void queryClient.setQueryData(["project", next.project.projectId], next);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({
        queryKey: ["project-timeline", next.project.projectId],
      });
    },
  });

  const chooseProject = (projectId: string) => {
    storage.setItem(PROJECT_KEY, projectId);
    setActiveProjectId(projectId);
  };

  const confirm = () => {
    const current = candidate.data;
    if (current?.status !== "under_review") return;
    decide.mutate({ kind: "confirm", candidateSha256: current.candidateSha256 });
  };
  const reject = (reason?: string) => {
    const current = candidate.data;
    if (current?.status !== "under_review") return;
    decide.mutate({
      kind: "reject",
      candidateSha256: current.candidateSha256,
      ...(reason !== undefined && reason.trim() !== "" ? { reason: reason.trim() } : {}),
    });
  };
  const revise = (proposal: ProjectIntakeProposal) => {
    const current = candidate.data;
    if (current?.status !== "under_review") return;
    decide.mutate({ kind: "revise", candidateSha256: current.candidateSha256, proposal });
  };

  return {
    roots,
    projects,
    candidate,
    project,
    timeline,
    activeProjectId,
    chooseProject,
    begin: begin.mutate,
    beginning: begin.isPending,
    beginError: begin.error,
    deciding: decide.isPending,
    decisionError: decide.error,
    confirm,
    reject,
    revise,
    manage: manage.mutate,
    managing: manage.isPending,
    manageError: manage.error,
  };
}
