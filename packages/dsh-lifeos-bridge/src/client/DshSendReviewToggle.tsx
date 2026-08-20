import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { LifeosClientState } from "./controller.ts";

export interface DshSendReviewToggleInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  setEnabled: (enabled: boolean) => Promise<boolean>;
}

export type DshSendReviewToggleProps = Pick<PropsRuntime<"conversation.input.dock">, "input"> &
  InjectFace<DshSendReviewToggleInjected>;

/** 原生发送按钮前的会话级审核开关；真正暂停发生在Host侧LifeOS Adapter。 */
export function DshSendReviewToggle({ input, useLifeos, setEnabled }: DshSendReviewToggleProps) {
  const state = useLifeos((value) => value);
  const enabled = state.projection?.dshSendReviewEnabled ?? false;
  const locked = input.phase === "adjudicating" || input.phase === "submitting";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`DSH发送前审核，当前${enabled ? "开启" : "关闭"}`}
      className="lifeos-dsh-send-review-toggle"
      data-enabled={enabled ? "true" : "false"}
      disabled={state.submitting || locked}
      title={enabled ? "点击关闭；关闭会立即放行当前等待项" : "点击开启；发送后先审核再进入Bridge"}
      onClick={() => void setEnabled(!enabled)}
    >
      <span aria-hidden="true" />
      <span>发送审核</span>
    </button>
  );
}
