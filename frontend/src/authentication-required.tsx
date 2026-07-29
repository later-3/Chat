import { LogIn, ShieldAlert } from "lucide-react";
import { useEffect, useRef } from "react";

import { beginAuthenticationRecovery } from "./authentication-recovery.js";
import "./authentication-required.css";

export function AuthenticationRequired() {
  const loginButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    loginButtonRef.current?.focus();
  }, []);

  return (
    <div className="authentication-required-backdrop">
      <section
        aria-describedby="authentication-required-description"
        aria-labelledby="authentication-required-title"
        aria-modal="true"
        className="authentication-required-card"
        role="alertdialog"
      >
        <span aria-hidden="true" className="authentication-required-icon">
          <ShieldAlert size={26} />
        </span>
        <div>
          <p className="authentication-required-eyebrow">登录状态已失效</p>
          <h2 id="authentication-required-title">重新登录后继续</h2>
          <p id="authentication-required-description">
            PWA 界面仍可从缓存打开，但服务端已拒绝当前凭据。重新登录不会自动重发模型调用、Tool
            操作或尚未提交的输入。
          </p>
        </div>
        <button onClick={beginAuthenticationRecovery} ref={loginButtonRef} type="button">
          <LogIn size={18} />
          重新登录
        </button>
      </section>
    </div>
  );
}
