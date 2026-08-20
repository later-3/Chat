import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import {
  ContextInjectionManager,
  type ContextInjectionManagerInjected,
} from "./ContextInjectionManager.tsx";
import { DshSendReviewToggle, type DshSendReviewToggleInjected } from "./DshSendReviewToggle.tsx";
import { PromptComposer, type PromptComposerInjected } from "./PromptComposer.tsx";
import { WorkflowPicker, type WorkflowPickerInjected } from "./WorkflowPicker.tsx";

export type PromptControlBarInjected = Omit<
  WorkflowPickerInjected &
    ContextInjectionManagerInjected &
    DshSendReviewToggleInjected &
    PromptComposerInjected,
  "hooks"
> & {
  hooks: WorkflowPickerInjected["hooks"] & PromptComposerInjected["hooks"];
};

export type PromptControlBarProps = PropsRuntime<"conversation.input.dock"> &
  InjectFace<PromptControlBarInjected>;

/** Chat拥有的本轮配置栏；与DSH原生权限、模型和发送控件分层显示。 */
export function PromptControlBar(props: PromptControlBarProps) {
  return (
    <section
      className="lifeos-prompt-control-bar"
      data-testid="lifeos-prompt-control-bar"
      aria-label="本轮运行配置"
    >
      <div className="lifeos-prompt-control-main">
        <WorkflowPicker
          input={props.input}
          useLifeos={props.useLifeos}
          loadWorkflows={props.loadWorkflows}
          selectWorkflow={props.selectWorkflow}
        />
        <span className="lifeos-prompt-control-divider" aria-hidden="true" />
        <ContextInjectionManager
          useLifeos={props.useLifeos}
          useSession={props.useSession}
          loadContextInjections={props.loadContextInjections}
        />
        <PromptComposer
          input={props.input}
          usePromptComposer={props.usePromptComposer}
          usePromptStudio={props.usePromptStudio}
          load={props.load}
          setMode={props.setMode}
          toggleRevision={props.toggleRevision}
          reset={props.reset}
          previewConfiguration={props.previewConfiguration}
          previewBridgeSend={props.previewBridgeSend}
          clearPreviews={props.clearPreviews}
          refresh={props.refresh}
          select={props.select}
          closeDetail={props.closeDetail}
          viewRevision={props.viewRevision}
          create={props.create}
          copy={props.copy}
          revise={props.revise}
          archive={props.archive}
          openSourceFile={props.openSourceFile}
        />
      </div>
      <div className="lifeos-prompt-control-review">
        <DshSendReviewToggle
          input={props.input}
          useLifeos={props.useLifeos}
          setEnabled={props.setEnabled}
        />
      </div>
    </section>
  );
}
