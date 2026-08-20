import { useState } from "react";
import type { PromptCompositionMode, PromptConfigurationPreviewDto } from "@chat/contracts/public";
import type { DshBridgeSendPreview } from "../contracts.ts";

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
  const context = preview.dshToBridge.contextInjections;
  const captured = preview.dshToBridge.adapterRequest;
  return (
    <div className="lifeos-prompt-sections" data-testid="lifeos-dsh-bridge-readable">
      <section className="lifeos-prompt-section">
        <header>
          <strong>DSH Agent 请求边界</strong>
          <code>GenerateOptions</code>
        </header>
        <SourceNote
          addedBy="DSH Agent Loop → LifeOS LLM Adapter"
          explanation="DSH 在原生发送流程中组装模型路由、System、Messages、Tools 和模型参数；Bridge Adapter 在 stream(options) 入口捕获同一对象。"
          files={[
            "dsh/packages/core/agent-loop/src/index.ts",
            "packages/dsh-lifeos-bridge/src/adapter.ts",
          ]}
        />
        <div className="lifeos-prompt-real-label">真实边界状态</div>
        <pre>
          {captured.status === "captured"
            ? ["已捕获", `SHA-256: ${captured.requestSha256}`].join("\n")
            : "尚未进入DSH原生发送流程，因此还没有真实GenerateOptions；这里不会伪造原始请求。"}
        </pre>
      </section>

      <section className="lifeos-prompt-section">
        <header>
          <strong>本轮提示词配置</strong>
          <code>Prompt Selection → Chat Compiler</code>
        </header>
        <SourceNote
          addedBy="Chat Prompt Studio / Prompt Assembly Compiler"
          explanation="用户选择只传精确Revision ID与Hash；正文由Chat后端从Git内置文件或Product Store用户版本解析、按Region编译。"
          files={
            preview.promptConfiguration === null
              ? ["packages/application/src/prompt-assembly-use-cases.ts"]
              : promptSourceFiles(preview.promptConfiguration)
          }
        />
        <div className="lifeos-prompt-real-label">真实配置内容</div>
        {preview.promptConfiguration === null ? (
          <p className="lifeos-bridge-preview-note">
            当前不是 Direct 工作流；会话保存的 Prompt Region 配置不会进入本次Chat命令。
          </p>
        ) : (
          <PromptConfigurationDetails preview={preview.promptConfiguration} />
        )}
      </section>

      <section className="lifeos-prompt-section">
        <header>
          <strong>用户当前输入</strong>
          <code>messages[user]</code>
        </header>
        <SourceNote
          addedBy="DSH Composer / Agent Loop"
          explanation="来自当前对话框的用户输入；Adapter只提取最后一条source.kind=user的真实文本作为Chat命令正文。"
          files={[
            "dsh/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx",
            "dsh/packages/core/agent-loop/src/index.ts",
            "packages/dsh-lifeos-bridge/src/adapter.ts",
          ]}
        />
        <div className="lifeos-prompt-real-label">真实输入内容</div>
        <pre>{preview.dshToBridge.userInput.text}</pre>
      </section>

      <section className="lifeos-prompt-section">
        <header>
          <strong>DSH 上下文注入</strong>
          <code>{context.status === "not_assembled" ? "尚未组装" : `${context.totalItems}项`}</code>
        </header>
        <SourceNote
          addedBy="DSH Context Producers / Bridge只读投影"
          explanation="这些消息由DSH在模型前组装阶段产生；每项下方保留其真实source kind、名称、form与message id。"
          files={[
            "dsh/packages/core/system-prompt/src/index.ts",
            "dsh/packages/core/agent-loop/src/index.ts",
            "packages/dsh-lifeos-bridge/src/context-injection-reader.ts",
          ]}
        />
        {context.status === "not_assembled" ? (
          <p className="lifeos-bridge-preview-note">
            当前会话尚未完成过模型前组装；实际发送审核会以捕获的GenerateOptions为准。
          </p>
        ) : context.items.length === 0 ? (
          <p className="lifeos-bridge-preview-note">当前没有额外的DSH生产者上下文。</p>
        ) : (
          <div className="lifeos-bridge-context-list">
            {context.items.map((item) => (
              <details key={item.messageId} open>
                <summary>
                  {item.sourceName ?? item.sourceKind} · {item.form} · {item.contentCharacters}字符
                </summary>
                <p className="lifeos-bridge-preview-note">
                  source.kind={item.sourceKind} · messageId={item.messageId}
                  {item.sourceDetails === undefined
                    ? ""
                    : ` · ${JSON.stringify(item.sourceDetails)}`}
                </p>
                <pre>{item.text === "" ? "（没有文本内容）" : item.text}</pre>
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="lifeos-prompt-section">
        <header>
          <strong>Bridge → Chat 命令</strong>
          <code>{shortHash(preview.bridgeToChat.payloadSha256)}</code>
        </header>
        <SourceNote
          addedBy="LifeOS Bridge发送策略"
          explanation="Bridge依据所选Workflow决定传Prompt Selection或Workspace Instructions，再由Chat公开Command接收。"
          files={[
            "packages/dsh-lifeos-bridge/src/bridge-service.ts",
            "packages/dsh-lifeos-bridge/src/adapter.ts",
            "packages/dsh-lifeos-bridge/src/chat-client.ts",
          ]}
        />
        <div className="lifeos-prompt-real-label">真实命令Payload</div>
        <pre>{preview.bridgeToChat.payloadJson}</pre>
      </section>
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
            "dsh/packages/core/agent-loop/src/index.ts",
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
