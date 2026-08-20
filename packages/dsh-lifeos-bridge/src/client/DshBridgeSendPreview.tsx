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

export function BridgeSendPreview({ preview }: { preview: DshBridgeSendPreview }) {
  const context = preview.dshToBridge.contextInjections;
  return (
    <section
      className="lifeos-prompt-compose-preview lifeos-bridge-send-preview"
      data-testid="lifeos-dsh-bridge-send-preview"
    >
      <header>
        <div>
          <strong>DSH 前端发送预览</strong>
          <span>
            展示 DSH → Bridge 语义边界和 Bridge → Chat 命令；不是最终 Provider HTTP 请求。
          </span>
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
      {preview.promptConfiguration === null ? (
        <p className="lifeos-bridge-preview-note">
          当前不是 Direct 工作流；本会话保存的 Prompt Region 配置不会进入这次 Bridge 命令。
        </p>
      ) : (
        <details className="lifeos-prompt-preview-final" open>
          <summary>本轮将采用的提示词配置</summary>
          <p className="lifeos-bridge-preview-note">
            内容与“提示词配置预览”一致；DSH 不重复传正文，Chat 后端按命令中的精确 Revision ID 与
            Hash 编译。
          </p>
          <PromptConfigurationDetails preview={preview.promptConfiguration} />
        </details>
      )}
      <details className="lifeos-prompt-preview-final" open>
        <summary>用户当前输入</summary>
        <pre>{preview.dshToBridge.userInput.text}</pre>
      </details>
      <details className="lifeos-prompt-preview-final" open={context.totalItems > 0}>
        <summary>
          DSH上下文注入 ·{" "}
          {context.status === "not_assembled" ? "尚未组装" : `${context.totalItems}项`}
        </summary>
        {context.status === "not_assembled" ? (
          <p className="lifeos-bridge-preview-note">
            当前DSH会话尚未完成过模型前组装；真正发送时仍会按当时的Session surface重新生成。
          </p>
        ) : context.items.length === 0 ? (
          <p className="lifeos-bridge-preview-note">当前没有额外的DSH生产者上下文。</p>
        ) : (
          <div className="lifeos-bridge-context-list">
            {context.items.map((item) => (
              <details key={item.messageId}>
                <summary>
                  {item.sourceName ?? item.sourceKind} · {item.contentCharacters}字符
                </summary>
                <pre>{item.text === "" ? "（没有文本内容）" : item.text}</pre>
              </details>
            ))}
          </div>
        )}
      </details>
      <details className="lifeos-prompt-preview-final" open>
        <summary>Bridge → Chat 实际命令 Payload</summary>
        <p className="lifeos-bridge-preview-note">
          提示词正文不会在这里重复传输；Chat后端使用下面冻结的Revision ID与Hash完成组装。
        </p>
        <pre>{JSON.stringify(preview.bridgeToChat.payload, null, 2)}</pre>
      </details>
    </section>
  );
}
