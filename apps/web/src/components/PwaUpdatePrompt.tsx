import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * PWA 更新提示：新版本 Service Worker 等待激活时展示克制入口。
 * 只有用户点击“刷新更新”才激活新版本；草稿在输入时已写入本地存储，刷新不丢草稿。
 * Service Worker 注册失败时本组件静默不渲染，绝不让外壳白屏。
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="pwa-update-banner" role="status">
      <span>新版本可用</span>
      <button className="pwa-update-confirm" onClick={() => void updateServiceWorker(true)}>
        刷新更新
      </button>
      <button
        className="pwa-update-dismiss"
        aria-label="稍后更新"
        onClick={() => setNeedRefresh(false)}
      >
        稍后
      </button>
    </div>
  );
}
