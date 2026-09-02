import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import {
  collectChatWorkflowAgentInputs,
  collectChatWorkflowStageEntryIds,
  collectChatWorkflowStageMarkers,
} from "./workflows/workflow-stage.js";
import { collectChatToolExecutions } from "./tools/execution-record.js";
import {
  collectPlanReviewDecisions,
  planReviewDecisionMessage,
} from "./workflows/planning-execution/review-state.js";

const execFileAsync = promisify(execFile);

export interface ChatSessionHtmlExport {
  readonly fileName: string;
  readonly html: string;
}

function piCliCandidates(): string[] {
  const candidates = new Set<string>([join(getPackageDir(), "dist", "cli.js")]);
  try {
    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    candidates.add(join(dirname(fileURLToPath(indexUrl)), "cli.js"));
  } catch {
    // getPackageDir() remains the primary package-owned resolution path.
  }
  return [...candidates];
}

function requirePiCliPath(): string {
  const cliPath = piCliCandidates().find(existsSync);
  if (cliPath === undefined) throw new Error("找不到Pi Coding Agent CLI");
  return cliPath;
}

function replaceOnce(source: string, name: string, expected: string, replacement: string): string {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const normalizedExpected = expected.replace(/\r\n/g, "\n");
  const matches = normalizedSource.split(normalizedExpected).length - 1;
  if (matches !== 1) {
    throw new Error(`无法修补Pi Session HTML中的${name}: 预期匹配1处，实际匹配${matches}处`);
  }
  return normalizedSource.replace(normalizedExpected, replacement.replace(/\r\n/g, "\n"));
}

/**
 * Pi's exported page recursively traverses the Session tree in three places.
 * Replacing those traversals with explicit stacks keeps long linear Sessions
 * usable without changing the exported Session data.
 */
export function patchDeepSessionTraversal(html: string): string {
  let patched = replaceOnce(
    html,
    "sortChildren",
    `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`,
  );
  patched = replaceOnce(
    patched,
    "mapNodes",
    `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`,
  );
  return replaceOnce(
    patched,
    "markActive",
    `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
    `        function markActive(root) {
          const pending = [root];
          const ordered = [];
          while (pending.length) {
            const node = pending.pop();
            ordered.push(node);
            for (const child of node.children) pending.push(child);
          }
          while (ordered.length) {
            const node = ordered.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function embedChatWorkflowStages(html: string): string {
  const pattern = /(<script id="session-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const match = pattern.exec(html);
  if (match === null) throw new Error("Pi Session HTML缺少session-data");
  const encodedSessionData = match[2];
  if (encodedSessionData === undefined) throw new Error("Pi Session HTML包含空session-data");

  const decoded = JSON.parse(Buffer.from(encodedSessionData.trim(), "base64").toString("utf8")) as unknown;
  if (!isRecord(decoded) || !Array.isArray(decoded.entries)) {
    throw new Error("Pi Session HTML包含无效session-data");
  }
  const chatWorkflowAgentInputs = collectChatWorkflowAgentInputs(decoded.entries);
  const chatPlanReviewDecisions = collectPlanReviewDecisions(decoded.entries);
  const legacyReviewDecisionByEntryId = new Map(
    chatPlanReviewDecisions
      .filter((decision) => decision.messageEntryId === undefined && decision.feedbackEntryId === undefined)
      .map((decision) => [decision.entryId, decision]),
  );
  // Pi's tree hides CustomEntry values in its default and User filters. For
  // legacy Sessions only, project the decision entry as a User Message inside
  // the standalone export so its navigation matches Chat's conversation view.
  // The source Session remains unchanged and the structured decision remains
  // available through chatPlanReviewDecisions for the Review Stage renderer.
  const projectedEntries = decoded.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return entry;
    const decision = legacyReviewDecisionByEntryId.get(entry.id);
    if (decision === undefined) return entry;
    const decidedAt = Date.parse(decision.decidedAt);
    return {
      ...entry,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: planReviewDecisionMessage(decision) }],
        timestamp: Number.isFinite(decidedAt) ? decidedAt : 0,
      },
    };
  });
  const enriched = {
    ...decoded,
    entries: projectedEntries,
    chatWorkflowAgentInputs,
    chatWorkflowStageEntryIds: collectChatWorkflowStageEntryIds(decoded.entries),
    chatWorkflowStages: collectChatWorkflowStageMarkers(decoded.entries),
    chatToolExecutions: collectChatToolExecutions(decoded.entries),
    chatPlanReviewDecisions,
  };
  const encoded = Buffer.from(JSON.stringify(enriched), "utf8").toString("base64");
  return html.replace(pattern, `$1${encoded}$3`);
}

const CHAT_WORKFLOW_HISTORY_CSS = `
  <style id="chat-workflow-history-styles">
    .chat-workflow-group {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--container-bg) 82%, transparent);
      overflow: hidden;
    }
    .chat-workflow-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px var(--line-height);
      border-bottom: 1px solid var(--border);
      background: var(--container-bg);
    }
    .chat-workflow-kind {
      color: var(--accent);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .chat-workflow-title {
      color: var(--text);
      font-size: 12px;
      font-weight: 700;
    }
    .chat-workflow-id {
      margin-left: auto;
      color: var(--dim);
      font-size: 9px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .chat-workflow-stages {
      display: flex;
      flex-direction: column;
    }
    .chat-agent-stage + .chat-agent-stage {
      border-top: 1px solid var(--border);
    }
    .chat-agent-stage-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 8px var(--line-height);
      color: var(--muted);
      background: color-mix(in srgb, var(--container-bg) 55%, transparent);
      font-size: 10px;
    }
    .chat-stage-name {
      color: var(--text);
      font-weight: 650;
    }
    .chat-stage-separator {
      color: var(--dim);
    }
    .chat-agent-role {
      color: var(--accent);
      font-weight: 650;
    }
    .chat-agent-stage-content {
      display: flex;
      flex-direction: column;
      gap: var(--line-height);
      padding: var(--line-height);
    }
    .chat-agent-stage[data-stage-id="review"] .chat-agent-stage-header {
      background: color-mix(in srgb, var(--accent) 9%, var(--container-bg));
    }
    .chat-agent-input {
      border: 1px solid var(--border);
      border-radius: 5px;
      overflow: hidden;
    }
    .chat-agent-input-header {
      padding: 7px 10px;
      color: var(--accent);
      background: var(--container-bg);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .chat-agent-input-source {
      padding: 9px 10px;
      border-top: 1px solid var(--border);
    }
    .chat-agent-input-label {
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 650;
    }
    .chat-agent-input-content {
      margin: 0;
      color: var(--text);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
      line-height: 1.5;
    }
    .chat-history-region {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .chat-history-region-label {
      color: var(--muted);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .chat-session-configuration {
      display: grid;
      gap: 6px;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--container-bg);
    }
    .chat-session-configuration-row {
      display: grid;
      grid-template-columns: minmax(150px, auto) 1fr auto;
      gap: 10px;
      align-items: baseline;
    }
    .chat-session-configuration-name {
      color: var(--muted);
      font-size: 10px;
    }
    .chat-session-configuration-value {
      color: var(--accent);
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .chat-session-configuration-time {
      color: var(--dim);
      font-size: 9px;
    }
    .chat-review-decision {
      display: grid;
      gap: 6px;
      padding: 10px 12px;
      border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
      border-radius: 7px;
      background: color-mix(in srgb, var(--accent) 7%, var(--container-bg));
    }
    .chat-review-decision .chat-session-configuration-value {
      font-size: 12px;
    }
    .chat-tool-execution {
      display: grid;
      gap: 6px;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--container-bg);
    }
    .chat-tool-execution-header {
      display: flex;
      gap: 8px;
      align-items: baseline;
    }
    .chat-tool-execution-name {
      color: var(--accent);
      font-weight: 700;
    }
    .chat-tool-execution-status {
      color: var(--muted);
      font-size: 10px;
    }
    .chat-tool-execution-address,
    .chat-tool-execution-context {
      color: var(--dim);
      overflow-wrap: anywhere;
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  </style>`;

const CHAT_WORKFLOW_HISTORY_RUNTIME = `
      const chatWorkflowAgentInputByEntryId = new Map(
        (Array.isArray(data.chatWorkflowAgentInputs) ? data.chatWorkflowAgentInputs : [])
          .map((agentInput) => [agentInput.entryId, agentInput])
      );
      const chatWorkflowAgentInputByStage = new Map(
        (Array.isArray(data.chatWorkflowAgentInputs) ? data.chatWorkflowAgentInputs : [])
          .map((agentInput) => [
            agentInput.invocationId + "\u0000" + agentInput.stageId + "\u0000" + agentInput.agentId,
            agentInput
          ])
      );
      const chatWorkflowStageByEntryId = new Map(
        (Array.isArray(data.chatWorkflowStages) ? data.chatWorkflowStages : [])
          .map((stage) => [stage.entryId, stage])
      );
      const chatWorkflowStageEntryIds = new Set(
        Array.isArray(data.chatWorkflowStageEntryIds) ? data.chatWorkflowStageEntryIds : []
      );
      const chatToolExecutionByEntryId = new Map(
        (Array.isArray(data.chatToolExecutions) ? data.chatToolExecutions : [])
          .map((execution) => [execution.entryId, execution])
      );
      const chatPlanReviewDecisionByEntryId = new Map(
        (Array.isArray(data.chatPlanReviewDecisions) ? data.chatPlanReviewDecisions : [])
          .map((decision) => [decision.entryId, decision])
      );
      const chatWorkflowLabels = {
        "minimal-pi-coding-agent": "Minimal Pi Coding Agent Workflow",
        "planning-execution": "Planning Execution Workflow"
      };
      const chatStageLabels = { plan: "Plan", review: "Review", execute: "Execute" };
      const chatAgentLabels = {
        planner: "Planner Agent",
        "pi-coding-agent": "Pi Coding Agent"
      };

      function chatHistoryLabel(labels, id) {
        return labels[id] || id;
      }

      function createChatWorkflowGroup(stage) {
        const group = document.createElement("section");
        group.className = "chat-workflow-group";
        group.dataset.workflowInvocationId = stage.invocationId;

        const header = document.createElement("div");
        header.className = "chat-workflow-header";
        const kind = document.createElement("span");
        kind.className = "chat-workflow-kind";
        kind.textContent = "Workflow";
        const title = document.createElement("span");
        title.className = "chat-workflow-title";
        title.textContent = chatHistoryLabel(chatWorkflowLabels, stage.workflowId);
        const id = document.createElement("span");
        id.className = "chat-workflow-id";
        id.textContent = stage.workflowId + " · " + stage.invocationId.slice(0, 8);
        header.append(kind, title, id);

        const stages = document.createElement("div");
        stages.className = "chat-workflow-stages";
        group.append(header, stages);
        return { group, stages };
      }

      function createChatAgentStage(stage) {
        const section = document.createElement("section");
        section.className = "chat-agent-stage";
        section.dataset.stageId = stage.stageId;
        section.dataset.agentId = stage.agentId || "";

        const header = document.createElement("div");
        header.className = "chat-agent-stage-header";
        const stageName = document.createElement("span");
        stageName.className = "chat-stage-name";
        stageName.textContent = chatHistoryLabel(chatStageLabels, stage.stageId);
        const separator = document.createElement("span");
        separator.className = "chat-stage-separator";
        separator.textContent = "·";
        const agentRole = document.createElement("span");
        agentRole.className = "chat-agent-role";
        agentRole.textContent = stage.nodeKind === "human"
          ? "Human reviewer"
          : chatHistoryLabel(chatAgentLabels, stage.agentId || stage.nodeKind || "Stage");
        header.append(stageName, separator, agentRole);

        const content = document.createElement("div");
        content.className = "chat-agent-stage-content";
        section.append(header, content);
        return { section, content };
      }

      function createChatAgentInput(input) {
        const container = document.createElement("section");
        container.className = "chat-agent-input";

        const header = document.createElement("div");
        header.className = "chat-agent-input-header";
        header.textContent = "Input received by " + chatHistoryLabel(chatAgentLabels, input.agentId);
        container.appendChild(header);

        const sources = [
          { label: "Native Session message references", content: input.inputEntryIds.join("\\n") }
        ];
        for (const source of sources) {
          const section = document.createElement("div");
          section.className = "chat-agent-input-source";
          const label = document.createElement("div");
          label.className = "chat-agent-input-label";
          label.textContent = source.label;
          const content = document.createElement("pre");
          content.className = "chat-agent-input-content";
          content.textContent = source.content;
          section.append(label, content);
          container.appendChild(section);
        }
        return container;
      }

      function createChatHistoryRegion(label, node) {
        const region = document.createElement("section");
        region.className = "chat-history-region";
        const title = document.createElement("div");
        title.className = "chat-history-region-label";
        title.textContent = label;
        region.append(title, node);
        return region;
      }

      function createChatToolExecution(execution) {
        const container = document.createElement("div");
        container.className = "chat-tool-execution";
        const header = document.createElement("div");
        header.className = "chat-tool-execution-header";
        const name = document.createElement("span");
        name.className = "chat-tool-execution-name";
        name.textContent = execution.toolName;
        const status = document.createElement("span");
        status.className = "chat-tool-execution-status";
        status.textContent = execution.status + " · " + execution.startedAt + " → " + execution.completedAt;
        const address = document.createElement("div");
        address.className = "chat-tool-execution-address";
        address.textContent = execution.toolAddress + (execution.toolVersion ? " · " + execution.toolVersion : "");
        const context = document.createElement("div");
        context.className = "chat-tool-execution-context";
        context.textContent = execution.workflowId + "/" + execution.stageId
          + (execution.agentId ? " · " + execution.agentId : "")
          + " · call " + execution.toolCallId;
        header.append(name, status);
        container.append(header, address, context);
        return createChatHistoryRegion("Tool execution record", container);
      }

      function createChatPlanReviewDecision(decision) {
        const container = document.createElement("div");
        container.className = "chat-review-decision";
        const row = document.createElement("div");
        row.className = "chat-session-configuration-row";
        const name = document.createElement("span");
        name.className = "chat-session-configuration-name";
        name.textContent = decision.kind === "approve" ? "Approved" : "Changes requested";
        const value = document.createElement("span");
        value.className = "chat-session-configuration-value";
        value.textContent = decision.kind === "approve"
          ? "已通过执行计划 v" + decision.planRevision + "，开始执行。"
          : decision.feedback;
        const time = document.createElement("span");
        time.className = "chat-session-configuration-time";
        time.textContent = formatTimestamp(decision.decidedAt);
        row.append(name, value, time);
        container.appendChild(row);
        const region = createChatHistoryRegion("Human review decision", container);
        region.id = "entry-" + decision.entryId;
        return region;
      }

      function renderChatHistoryRegionEntry(entry) {
        // Pi caches rendered nodes by entry.id. One Assistant entry is rendered
        // once per region here, so these partial views must bypass that cache.
        const html = renderEntry(entry);
        if (!html) return null;
        const template = document.createElement("template");
        template.innerHTML = html;
        const node = template.content.firstElementChild;
        if (node) {
          node.removeAttribute("id");
          node.querySelector(".copy-link-btn")?.remove();
        }
        return node;
      }

      function appendChatSessionConfiguration(target, entry, agentId) {
        let region = target.lastElementChild;
        let configuration = region?.querySelector(".chat-session-configuration");
        if (!configuration) {
          configuration = document.createElement("div");
          configuration.className = "chat-session-configuration";
          region = createChatHistoryRegion("Session configuration", configuration);
          target.appendChild(region);
        }

        const agentLabel = agentId ? chatHistoryLabel(chatAgentLabels, agentId) : "Agent";
        const row = document.createElement("div");
        row.className = "chat-session-configuration-row";
        const name = document.createElement("span");
        name.className = "chat-session-configuration-name";
        const value = document.createElement("span");
        value.className = "chat-session-configuration-value";
        const time = document.createElement("span");
        time.className = "chat-session-configuration-time";
        time.textContent = formatTimestamp(entry.timestamp);
        if (entry.type === "model_change") {
          name.textContent = agentLabel + " effective model";
          value.textContent = entry.provider + "/" + entry.modelId;
        } else {
          name.textContent = agentLabel + " effective thinking level";
          value.textContent = entry.thinkingLevel;
        }
        row.append(name, value, time);
        configuration.appendChild(row);
      }

      function appendChatAgentEntry(target, entry, agentId) {
        if (entry.type === "model_change" || entry.type === "thinking_level_change") {
          appendChatSessionConfiguration(target, entry, agentId);
          return;
        }
        if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
          const message = entry.message;
          const agentLabel = agentId ? chatHistoryLabel(chatAgentLabels, agentId) : "Assistant";
          const groups = [
            [agentLabel + " thinking", message.content.filter((block) => block.type === "thinking")],
            ["Tool call and output", message.content.filter((block) => block.type === "toolCall")],
            [agentLabel + " output", message.content.filter((block) => block.type !== "thinking" && block.type !== "toolCall")]
          ];
          let rendered = false;
          for (const [label, content] of groups) {
            if (!content.length) continue;
            const node = renderChatHistoryRegionEntry({
              ...entry,
              message: { ...message, content, usage: label.endsWith(" output") ? message.usage : undefined }
            });
            if (node) {
              target.appendChild(createChatHistoryRegion(label, node));
              rendered = true;
            }
          }
          if (rendered) return;
        }

        const node = renderEntryToNode(entry);
        if (!node) return;
        const label = entry.type === "message" && entry.message && entry.message.role === "toolResult"
          ? "Tool output"
          : entry.type === "message" && entry.message && entry.message.role === "user"
            ? "Input"
            : "Session event";
        target.appendChild(createChatHistoryRegion(label, node));
      }
`;

/** Adds Chat-only Workflow and Agent grouping without changing the Session file. */
export function patchChatWorkflowHistory(html: string): string {
  let patched = embedChatWorkflowStages(html);
  patched = replaceOnce(
    patched,
    "Chat Workflow history styles",
    "</head>",
    `${CHAT_WORKFLOW_HISTORY_CSS}\n</head>`,
  );
  patched = replaceOnce(
    patched,
    "Chat Workflow history runtime",
    "      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {",
    `${CHAT_WORKFLOW_HISTORY_RUNTIME}\n      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {`,
  );
  return replaceOnce(
    patched,
    "Chat Workflow history grouping",
    `        const fragment = document.createDocumentFragment();

        for (const entry of path) {
          const node = renderEntryToNode(entry);
          if (node) {
            fragment.appendChild(node);
          }
        }`,
    `        const fragment = document.createDocumentFragment();
        let activeInvocationId = null;
        let activeWorkflowStages = null;
        let activeStageContent = null;
        let activeAgentId = null;
        const renderedAgentInputEntryIds = new Set();

        for (const entry of path) {
          const workflowStage = chatWorkflowStageByEntryId.get(entry.id);
          if (workflowStage) {
            if (workflowStage.invocationId !== activeInvocationId) {
              const workflowView = createChatWorkflowGroup(workflowStage);
              fragment.appendChild(workflowView.group);
              activeInvocationId = workflowStage.invocationId;
              activeWorkflowStages = workflowView.stages;
            }
            const stageView = createChatAgentStage(workflowStage);
            activeWorkflowStages.appendChild(stageView.section);
            activeStageContent = stageView.content;
            activeAgentId = workflowStage.agentId;
            const stageInputKey = workflowStage.invocationId + "\u0000" + workflowStage.stageId + "\u0000" + workflowStage.agentId;
            const stageInput = chatWorkflowAgentInputByStage.get(stageInputKey);
            if (stageInput) {
              activeStageContent.appendChild(createChatAgentInput(stageInput));
              renderedAgentInputEntryIds.add(stageInput.entryId);
            }
            continue;
          }
          if (chatWorkflowStageEntryIds.has(entry.id)) {
            activeInvocationId = null;
            activeWorkflowStages = null;
            activeStageContent = null;
            activeAgentId = null;
            continue;
          }

          const workflowAgentInput = chatWorkflowAgentInputByEntryId.get(entry.id);
          if (workflowAgentInput) {
            if (!renderedAgentInputEntryIds.has(workflowAgentInput.entryId)) {
              (activeStageContent || fragment).appendChild(createChatAgentInput(workflowAgentInput));
              renderedAgentInputEntryIds.add(workflowAgentInput.entryId);
            }
            continue;
          }

          const toolExecution = chatToolExecutionByEntryId.get(entry.id);
          if (toolExecution) {
            (activeStageContent || fragment).appendChild(createChatToolExecution(toolExecution));
            continue;
          }

          const reviewDecision = chatPlanReviewDecisionByEntryId.get(entry.id);
          if (reviewDecision) {
            (activeStageContent || fragment).appendChild(createChatPlanReviewDecision(reviewDecision));
            continue;
          }

          appendChatAgentEntry(activeStageContent || fragment, entry, activeAgentId);
        }`,
  );
}

/** Uses Pi's supported CLI export command and returns the standalone HTML. */
export async function exportChatSessionHtml(sessionFile: string): Promise<ChatSessionHtmlExport> {
  const exportDir = await mkdtemp(join(tmpdir(), "chat-session-export-"));
  const outputPath = join(exportDir, "session.html");
  try {
    await execFileAsync(process.execPath, [requirePiCliPath(), "--export", sessionFile, outputPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    const html = patchChatWorkflowHistory(
      patchDeepSessionTraversal(await readFile(outputPath, "utf8")),
    );
    return {
      fileName: `pi-session-${basename(sessionFile, ".jsonl")}.html`,
      html,
    };
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
}
