import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { LifeosClientState } from "./controller.ts";

export interface DebugReviewControlInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  setDshSendReviewEnabled: (enabled: boolean) => Promise<boolean>;
  setBridgeDispatchReviewEnabled: (enabled: boolean) => Promise<boolean>;
}

export type DebugReviewControlProps = Pick<PropsRuntime<"conversation.input.dock">, "input"> &
  InjectFace<DebugReviewControlInjected>;

interface ReviewSwitchProps {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly description: string;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

function ReviewSwitch({ checked, disabled, label, description, onChange }: ReviewSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}，当前${checked ? "开启" : "关闭"}`}
      className="lifeos-debug-review-switch"
      data-enabled={checked ? "true" : "false"}
      disabled={disabled}
      onClick={() => void onChange(!checked)}
    >
      <span className="lifeos-debug-review-switch-track" aria-hidden="true" />
      <span className="lifeos-debug-review-switch-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

/**
 * 两道Bridge调试闸门共用一个紧凑入口，避免在Composer主工具栏堆叠独立Switch。
 * 开关只改变当前DSH会话的调试行为；真正的暂停与放行均发生在Host侧。
 */
export function DebugReviewControl({
  input,
  useLifeos,
  setDshSendReviewEnabled,
  setBridgeDispatchReviewEnabled,
}: DebugReviewControlProps) {
  const state = useLifeos((value) => value);
  const dshEnabled = state.projection?.dshSendReviewEnabled ?? false;
  const bridgeEnabled = state.projection?.bridgeDispatchReviewEnabled ?? false;
  const enabledCount = Number(dshEnabled) + Number(bridgeEnabled);
  const locked = input.phase === "adjudicating" || input.phase === "submitting";
  const disabled = state.submitting || locked;

  return (
    <details className="lifeos-debug-review-control">
      <summary
        aria-label={`调试审核，已开启${String(enabledCount)}项，共2项`}
        data-enabled-count={String(enabledCount)}
        data-testid="lifeos-debug-review-toggle"
      >
        <span>调试审核</span>
        <strong>{enabledCount}/2</strong>
      </summary>
      <section className="lifeos-debug-review-panel" aria-label="调试审核设置">
        <header>
          <strong>发送边界调试审核</strong>
          <small>每项独立开启；关闭会自动放行该边界当前等待项。</small>
        </header>
        <ReviewSwitch
          checked={dshEnabled}
          disabled={disabled}
          label="DSH → Bridge"
          description="查看DSH Agent Loop交给Bridge的真实输入。"
          onChange={setDshSendReviewEnabled}
        />
        <ReviewSwitch
          checked={bridgeEnabled}
          disabled={disabled}
          label="Bridge → Chat后端"
          description="查看Bridge筛选后准备发送的完整Command。"
          onChange={setBridgeDispatchReviewEnabled}
        />
        <p>执行Agent → Provider的最终提示词审核仍由所选Workflow独立控制。</p>
      </section>
    </details>
  );
}
