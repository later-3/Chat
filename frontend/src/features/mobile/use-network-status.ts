import { useEffect, useState } from "react";

export type BrowserNetworkStatus = "online" | "offline";

function currentNetworkStatus(): BrowserNetworkStatus {
  if (typeof navigator === "undefined") return "online";
  return navigator.onLine ? "online" : "offline";
}

/**
 * Project the browser's transport hint into React.
 *
 * `navigator.onLine` cannot prove that the Chat backend is reachable, so this
 * state is intentionally kept separate from the backend health projection.
 */
export function useNetworkStatus(): BrowserNetworkStatus {
  const [status, setStatus] = useState<BrowserNetworkStatus>(currentNetworkStatus);

  useEffect(() => {
    const update = () => setStatus(currentNetworkStatus());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return status;
}
