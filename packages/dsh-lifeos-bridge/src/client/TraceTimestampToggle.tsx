import type { SnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";

export interface TraceTimestampToggleInjected {
  hooks: { traceTimestamps: SnapshotStore<boolean> };
  setTraceTimestamps: (visible: boolean) => void;
}

export type TraceTimestampToggleProps = PropsRuntime<"conversation.session.header.utilities"> &
  InjectFace<TraceTimestampToggleInjected>;

/**
 * Trajectory没有公开toolbar加法Slot；时间偏好因此使用官方Session utility加法位。
 * 组件只写插件自己的浏览器偏好，不接触DSH Session事件或Chat产品事实。
 */
export function TraceTimestampToggle({
  useTraceTimestamps,
  setTraceTimestamps,
}: TraceTimestampToggleProps) {
  const visible = useTraceTimestamps((value) => value);
  const label = visible ? "隐藏轨迹时间戳" : "显示轨迹时间戳";
  return (
    <button
      type="button"
      className="lifeos-trace-time-toggle"
      data-testid="lifeos-trace-time-toggle"
      aria-label={label}
      aria-pressed={visible}
      title={label}
      onClick={() => setTraceTimestamps(!visible)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8 4.5v3.7l2.4 1.45"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>时间</span>
    </button>
  );
}
