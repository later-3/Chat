import { useState } from "react";
import type { PromptCompositionMode, PromptConfigurationPreviewDto } from "@chat/contracts/public";
import type { DshBridgeSendPreview } from "../contracts.ts";
import {
  exactSectionsFromJson,
  lastDshUserInputMapping,
  type DshUserInputMapping,
  type ExactJsonSection,
} from "../dsh-bridge-readable.ts";

const MODE_LABEL: Record<PromptCompositionMode, string> = {
  default: "默认",
  replace: "覆盖",
  append: "追加",
};

function shortHash(value: string): string {
  return value.slice(0, 8);
}

function SourceNote({
  addedBy,
  explanation,
  files,
}: {
  addedBy: string;
  explanation: string;
  files: readonly string[];
}) {
  return (
    <aside aria-label={`${addedBy}来源定位`}>
      <strong>来源定位 · 仅界面注释，不发送</strong>
      <div>
        <span>{addedBy}</span>
        <p>{explanation}</p>
        <div>
          {files.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </div>
      </div>
    </aside>
  );
}

function promptSourceFiles(preview: PromptConfigurationPreviewDto): string[] {
  return [
    "packages/application/src/prompt-assembly-use-cases.ts",
    ...preview.regions.flatMap((region) =>
      region.fragments.flatMap((fragment) =>
        fragment.sourceRelativePath === undefined
          ? [`Product Store · ${fragment.promptFragmentRevisionId} · v${fragment.revision}`]
          : [fragment.sourceRelativePath],
      ),
    ),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

interface SectionSource {
  readonly addedBy: string;
  readonly explanation: string;
  readonly files: readonly string[];
}

function dshSectionSource(section: ExactJsonSection): SectionSource {
  const assembledAt = "dsh/packages/core/agent-loop/src/agent.ts";
  if (section.kind === "system") {
    return {
      addedBy: "DSH System Prompt → Agent Loop",
      explanation: `正文只取自原始请求 ${section.jsonPointer}；System Prompt服务组装文本，Agent Loop把它写入GenerateOptions.system。`,
      files: ["dsh/packages/core/system-prompt/src/index.ts", assembledAt],
    };
  }
  if (section.kind === "tool") {
    return {
      addedBy: "DSH Tool Registry → Agent Loop",
      explanation: `正文只取自原始请求 ${section.jsonPointer}；工具注册表提供Schema，Agent Loop保持数组顺序写入GenerateOptions.tools。`,
      files: ["dsh/packages/core/tools/src/index.ts", assembledAt],
    };
  }
  if (section.kind === "message") {
    const source = section.messageSource;
    const sourceIdentity = [
      source?.kind === undefined ? null : `kind=${source.kind}`,
      source?.plugin === undefined ? null : `plugin=${source.plugin}`,
      source?.name === undefined ? null : `name=${source.name}`,
      source?.form === undefined ? null : `form=${source.form}`,
    ]
      .filter((value): value is string => value !== null)
      .join(" · ");
    const files = [assembledAt];
    if (source?.kind === "user") {
      files.unshift("dsh/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx");
    }
    if (source?.kind === "agent-instructions") {
      files.unshift("dsh/packages/context/agent-instructions/src/index.ts");
    }
    if (source?.plugin === "@deepseek-ai/dsh-system-prompt") {
      files.unshift("dsh/packages/core/system-prompt/src/index.ts");
    }
    return {
      addedBy: `DSH Message Producer${sourceIdentity === "" ? "" : ` · ${sourceIdentity}`}`,
      explanation: `正文只取自原始请求 ${section.jsonPointer}，包括role、source和content；界面没有再次读取Session。`,
      files,
    };
  }
  return {
    addedBy: "DSH Agent Loop请求组装",
    explanation: `该值只取自原始请求 ${section.jsonPointer}；Agent Loop在调用LLM Adapter前冻结完整GenerateOptions。`,
    files: [assembledAt, "packages/dsh-lifeos-bridge/src/adapter.ts"],
  };
}

function bridgeSectionSource(
  section: ExactJsonSection,
  preview: DshBridgeSendPreview,
  dshUserInput: DshUserInputMapping | null,
): SectionSource {
  const common = [
    "packages/dsh-lifeos-bridge/src/bridge-service.ts",
    "packages/dsh-lifeos-bridge/src/chat-client.ts",
  ];
  if (section.jsonPointer === "/text") {
    const bridgeText: unknown = JSON.parse(section.valueJson);
    const matches = dshUserInput !== null && bridgeText === dshUserInput.text;
    return {
      addedBy: "LifeOS Adapter用户输入提取",
      explanation:
        dshUserInput === null
          ? "当前手动预览还没有DSH原始请求；/text来自输入框草稿，实际发送审核时才建立原始Pointer映射。"
          : `Bridge /text 直接对应DSH原始请求 ${dshUserInput.textJsonPointers.join(" + ")}；逐值比较：${matches ? "一致" : "不一致，发送已失败关闭"}。`,
      files: ["packages/dsh-lifeos-bridge/src/adapter.ts", ...common],
    };
  }
  if (section.jsonPointer === "/promptSelection") {
    return {
      addedBy: "Prompt Composer会话选择",
      explanation:
        "该值只取自Bridge→Chat原始Payload /promptSelection；组件正文不会伪装成命令字段，Chat后端稍后按Revision ID与Hash解析。",
      files:
        preview.promptConfiguration === null
          ? common
          : [...common, ...promptSourceFiles(preview.promptConfiguration)],
    };
  }
  if (section.jsonPointer === "/context") {
    return {
      addedBy: "DSH Workspace Instructions提取",
      explanation:
        "该值只取自Bridge→Chat原始Payload /context；仅非Direct工作流按真实发送政策携带。",
      files: ["packages/dsh-lifeos-bridge/src/context-injection-reader.ts", ...common],
    };
  }
  return {
    addedBy: "LifeOS Bridge发送策略",
    explanation: `该值只取自Bridge→Chat原始Payload ${section.jsonPointer}；没有从UI投影补写正文。`,
    files: common,
  };
}

function ExactSectionView({
  section,
  source,
}: {
  section: ExactJsonSection;
  source: SectionSource;
}) {
  return (
    <section className="lifeos-prompt-section" data-json-pointer={section.jsonPointer}>
      <header>
        <strong>{section.title}</strong>
        <code>{section.jsonPointer}</code>
      </header>
      <SourceNote {...source} />
      <div className="lifeos-prompt-real-label">该Pointer对应的完整原始JSON值</div>
      <pre>{section.valueJson}</pre>
    </section>
  );
}

export function PromptConfigurationDetails({
  preview,
}: {
  preview: PromptConfigurationPreviewDto;
}) {
  return (
    <>
      <div className="lifeos-prompt-preview-regions">
        {preview.regions.map((region) => (
          <details key={region.regionKey} open={region.fragments.length > 0}>
            <summary>
              <span>
                <strong>{region.title}</strong>
                <code>{region.regionKey}</code>
              </span>
              <small>
                {MODE_LABEL[region.mode]} · {region.fragments.length} 个组件
              </small>
            </summary>
            <div className="lifeos-prompt-preview-sources">
              {region.fragments.length === 0 ? (
                <span>这个区域最终为空。</span>
              ) : (
                region.fragments.map((fragment) => (
                  <span key={fragment.promptFragmentRevisionId}>
                    {fragment.title} · v{fragment.revision} · {shortHash(fragment.sha256)}
                    {fragment.sourceRelativePath === undefined
                      ? ` · Product Store/${fragment.promptFragmentRevisionId}`
                      : ` · ${fragment.sourceRelativePath}`}
                  </span>
                ))
              )}
            </div>
            <pre>{region.renderedText === "" ? "（空）" : region.renderedText}</pre>
          </details>
        ))}
      </div>
      {preview.systemPromptAppend === "" ? null : (
        <details className="lifeos-prompt-preview-final">
          <summary>查看组装后的 System 区域</summary>
          <pre>{preview.systemPromptAppend}</pre>
        </details>
      )}
      {preview.messageContext === "" ? null : (
        <details className="lifeos-prompt-preview-final">
          <summary>查看组装后的 Messages 区域</summary>
          <pre>{preview.messageContext}</pre>
        </details>
      )}
    </>
  );
}

function FriendlyPreview({ preview }: { preview: DshBridgeSendPreview }) {
  const captured = preview.dshToBridge.adapterRequest;
  const dshSections =
    captured.status === "captured" ? exactSectionsFromJson(captured.requestJson) : [];
  const dshUserInput =
    captured.status === "captured" ? lastDshUserInputMapping(captured.requestJson) : null;
  const bridgeSections = exactSectionsFromJson(preview.bridgeToChat.payloadJson);
  const bridgePayload = JSON.parse(preview.bridgeToChat.payloadJson) as { readonly text?: unknown };
  return (
    <div className="lifeos-prompt-sections" data-testid="lifeos-dsh-bridge-readable">
      <section className="lifeos-prompt-section">
        <header>
          <strong>一一对应证据</strong>
          <code>JSON Pointer</code>
        </header>
        <SourceNote
          addedBy="Bridge边界Trace"
          explanation="友好视图不再读取Prompt配置正文或Session上下文正文。下方每个区域都只从同一份原始JSON按唯一Pointer取得；Bridge日志记录同一个整体Hash和各Pointer值Hash。"
          files={[
            "dsh/packages/core/agent-loop/src/agent.ts",
            "packages/dsh-lifeos-bridge/src/adapter.ts",
            "packages/dsh-lifeos-bridge/src/dsh-bridge-readable.ts",
            "packages/dsh-lifeos-bridge/src/bridge-service.ts",
          ]}
        />
        <div className="lifeos-prompt-real-label">可与Bridge日志核对的整体Hash</div>
        <pre>
          {[
            `DSH → Bridge: ${captured.status === "captured" ? captured.requestSha256 : "尚未捕获"}`,
            `Bridge → Chat: ${preview.bridgeToChat.payloadSha256}`,
            ...(dshUserInput === null
              ? []
              : [
                  `用户输入映射: ${dshUserInput.textJsonPointers.join(" + ")} → /text`,
                  `逐值比较: ${bridgePayload.text === dshUserInput.text ? "一致" : "不一致（已失败关闭）"}`,
                ]),
          ].join("\n")}
        </pre>
      </section>
      {captured.status === "captured" ? (
        <>
          <div className="lifeos-prompt-section-divider">
            DSH → Bridge · 同一原始请求逐Pointer解析
          </div>
          {dshSections.map((section) => (
            <ExactSectionView
              key={`dsh-${section.sectionId}`}
              section={section}
              source={dshSectionSource(section)}
            />
          ))}
        </>
      ) : (
        <section className="lifeos-prompt-section">
          <header>
            <strong>DSH → Bridge</strong>
            <code>尚未捕获</code>
          </header>
          <p className="lifeos-bridge-preview-note">
            手动预览尚未进入Agent Loop，不能生成友好映射；实际发送审核时才从真实原始JSON解析。
          </p>
        </section>
      )}
      <div className="lifeos-prompt-section-divider">Bridge → Chat · 同一Payload逐Pointer解析</div>
      {bridgeSections.map((section) => (
        <ExactSectionView
          key={`bridge-${section.sectionId}`}
          section={section}
          source={bridgeSectionSource(section, preview, dshUserInput)}
        />
      ))}
    </div>
  );
}

function RawPreview({ preview }: { preview: DshBridgeSendPreview }) {
  const captured = preview.dshToBridge.adapterRequest;
  return (
    <div className="lifeos-prompt-sections" data-testid="lifeos-dsh-bridge-raw">
      <section className="lifeos-prompt-section">
        <header>
          <strong>DSH → Bridge 原始请求</strong>
          <code>
            {captured.status === "captured" ? shortHash(captured.requestSha256) : "未捕获"}
          </code>
        </header>
        <SourceNote
          addedBy="LifeOS LLM Adapter入口"
          explanation="这是Adapter实际收到的GenerateOptions JSON。AbortSignal只控制本地取消且不可序列化，明确不属于正文。"
          files={[
            "dsh/packages/core/agent-loop/src/agent.ts",
            "packages/dsh-lifeos-bridge/src/adapter.ts",
          ]}
        />
        {captured.status === "captured" ? (
          <pre data-testid="lifeos-dsh-adapter-request-raw">{captured.requestJson}</pre>
        ) : (
          <p
            className="lifeos-bridge-preview-note"
            data-testid="lifeos-dsh-adapter-request-pending"
          >
            手动预览发生在点击DSH原生发送之前，System、Messages、Tools等尚未被Agent
            Loop组装。开启“发送审核”并实际点击发送后，这里才会展示真实原始请求。
          </p>
        )}
      </section>
      <section className="lifeos-prompt-section">
        <header>
          <strong>Bridge → Chat 原始命令Payload</strong>
          <code>{shortHash(preview.bridgeToChat.payloadSha256)}</code>
        </header>
        <SourceNote
          addedBy="LifeOS Bridge发送策略"
          explanation="这是本次预览按当前Workflow政策形成的完整Chat命令Payload JSON；来源注释不在JSON正文内。"
          files={[
            "packages/dsh-lifeos-bridge/src/bridge-service.ts",
            "packages/dsh-lifeos-bridge/src/chat-client.ts",
          ]}
        />
        <pre data-testid="lifeos-bridge-chat-payload-raw">{preview.bridgeToChat.payloadJson}</pre>
      </section>
    </div>
  );
}

export function BridgeSendPreview({ preview }: { preview: DshBridgeSendPreview }) {
  const [view, setView] = useState<"readable" | "raw">("readable");
  return (
    <section
      className="lifeos-prompt-compose-preview lifeos-bridge-send-preview"
      data-testid="lifeos-dsh-bridge-send-preview"
    >
      <header>
        <div>
          <strong>DSH 前端发送预览</strong>
          <span>DSH → Bridge 与 Bridge → Chat 两段边界；不是最终Provider HTTP请求。</span>
        </div>
        <code>{shortHash(preview.dshToBridge.userInput.sha256)}</code>
      </header>
      <div className="lifeos-bridge-preview-facts">
        <span>
          Workspace：<strong>{preview.workspace?.title ?? "未映射"}</strong>
        </span>
        <span>
          Workflow：<strong>{preview.workflowSelection?.title ?? "系统默认规划工作流"}</strong>
        </span>
        <span>
          转发政策：
          <strong>
            {preview.bridgeToChat.policy === "direct_prompt_selection"
              ? "Direct · 发送Prompt Selection，不转发DSH Workspace指令"
              : "非Direct · 转发DSH Workspace指令，不发送Prompt Selection"}
          </strong>
        </span>
      </div>
      <div className="lifeos-prompt-tabs" role="tablist" aria-label="DSH发送预览展示方式">
        <button
          type="button"
          role="tab"
          aria-selected={view === "readable"}
          className={view === "readable" ? "lifeos-prompt-tab-active" : undefined}
          onClick={() => setView("readable")}
        >
          友好展示
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "raw"}
          className={view === "raw" ? "lifeos-prompt-tab-active" : undefined}
          onClick={() => setView("raw")}
        >
          原始请求
        </button>
      </div>
      <div className="lifeos-prompt-body" role="tabpanel">
        <div className="lifeos-prompt-caption">
          {view === "raw"
            ? "原始JSON与来源注释分开显示；注释不会进入任何发送正文"
            : "所有正文均来自本次边界事实；来源定位只帮助审核，不会发送"}
        </div>
        {view === "raw" ? <RawPreview preview={preview} /> : <FriendlyPreview preview={preview} />}
      </div>
    </section>
  );
}
