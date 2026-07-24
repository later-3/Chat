import { registerSW } from "virtual:pwa-register";
import { Download, RefreshCw, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type PwaNotice = "install" | "offline-ready" | "update" | null;

function supportsServiceWorker(): boolean {
  return window.isSecureContext && "serviceWorker" in navigator;
}

/**
 * Register the production service worker without forcing a reload while a
 * Product Run or HITL decision may still be active.
 */
export function PwaStatus() {
  const [notice, setNotice] = useState<PwaNotice>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const updateServiceWorkerRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    let updateTimer: number | null = null;
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setNotice("install");
    };
    const handleInstalled = () => {
      setInstallPrompt(null);
      setNotice(null);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    if (supportsServiceWorker()) {
      updateServiceWorkerRef.current = registerSW({
        immediate: true,
        onNeedRefresh() {
          setNotice("update");
        },
        onOfflineReady() {
          setNotice((current) => current ?? "offline-ready");
        },
        onRegisteredSW(_serviceWorkerUrl, registration) {
          if (!registration) return;
          updateTimer = window.setInterval(
            () => {
              if (navigator.onLine) void registration.update();
            },
            60 * 60 * 1000,
          );
        },
      });
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      if (updateTimer !== null) window.clearInterval(updateTimer);
    };
  }, []);

  const install = useCallback(async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setInstallPrompt(null);
      setNotice(null);
    }
  }, [installPrompt]);

  if (!notice) return null;

  const copy = {
    install: {
      icon: <Download size={19} />,
      title: "把Chat安装到手机",
      description: "安装后可从主屏幕进入独立工作区。",
      action: "安装",
    },
    "offline-ready": {
      icon: <WifiOff size={19} />,
      title: "离线外壳已经准备好",
      description: "断网时可打开界面和草稿；执行仍需连接本地Chat。",
      action: null,
    },
    update: {
      icon: <RefreshCw size={19} />,
      title: "Chat有新版本",
      description: "由你决定何时刷新，不打断正在运行的工作。",
      action: "更新",
    },
  }[notice];

  return (
    <aside aria-live="polite" className="pwa-notice">
      <span>{copy.icon}</span>
      <div>
        <strong>{copy.title}</strong>
        <small>{copy.description}</small>
      </div>
      {copy.action && (
        <button
          onClick={() => {
            if (notice === "install") void install();
            if (notice === "update") void updateServiceWorkerRef.current?.(true);
          }}
          type="button"
        >
          {copy.action}
        </button>
      )}
      <button aria-label="关闭PWA提示" onClick={() => setNotice(null)} type="button">
        <X size={17} />
      </button>
    </aside>
  );
}
