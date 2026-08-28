import {
  defineEventHandler,
  getCookie,
  getQuery,
  sendRedirect,
  setResponseHeader,
  setResponseStatus,
} from "nitro/h3";
import {
  CHAT_WEB_AUTH_COOKIE,
  getChatWebAuthConfig,
  sanitizeChatWebAuthNext,
  verifyChatWebAuthToken,
} from "../web-auth.js";

function scriptValue(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const nextPath = sanitizeChatWebAuthNext(typeof query.next === "string" ? query.next : "/");
  const config = getChatWebAuthConfig();
  if (config.state === "disabled") return sendRedirect(event, nextPath, 307);
  if (config.state === "enabled") {
    const verification = verifyChatWebAuthToken(config, getCookie(event, CHAT_WEB_AUTH_COOKIE));
    if (verification.valid) return sendRedirect(event, nextPath, 307);
  }

  setResponseHeader(event, "Cache-Control", "private, no-store, max-age=0");
  setResponseHeader(event, "Content-Type", "text/html; charset=utf-8");
  if (config.state === "misconfigured") setResponseStatus(event, 503);
  const initialError = config.state === "misconfigured"
    ? "登录服务尚未正确配置，请检查部署设置。"
    : query.expired === "1" ? "会话已过期，请重新登录。" : "";

  return `<!doctype html>
<html lang="zh-CN" translate="no" class="notranslate">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <meta name="application-name" content="Chat" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Chat" />
  <meta name="format-detection" content="telephone=no" />
  <meta name="google" content="notranslate" />
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1a1a" />
  <link rel="manifest" href="/manifest.webmanifest?v=lifeos-astronaut-v2" />
  <link rel="icon" href="/lifeos-astronaut-192x192.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/lifeos-astronaut-apple-touch-icon.png" />
  <title>登录到 Chat</title>
  <style>
    *{box-sizing:border-box}body{min-height:100dvh;margin:0;padding:max(56px,calc(env(safe-area-inset-top,0px) + 32px)) max(24px,env(safe-area-inset-right,0px)) max(36px,calc(env(safe-area-inset-bottom,0px) + 20px)) max(24px,env(safe-area-inset-left,0px));display:flex;justify-content:center;overflow-y:auto;background:#fff;color:#17191c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.login{width:min(100%,488px);margin:auto 0}.brand{display:flex;align-items:center;justify-content:center;gap:12px;font-size:22px;font-weight:650}.mark{color:#2563eb;font-family:Georgia,serif;font-size:45px;font-weight:700;line-height:1}.intro{margin-top:58px;text-align:center}.intro h1{margin:0;font-size:31px;line-height:1.2}.intro p{margin:12px 0 0;color:#6b7280;font-size:15px}.alert{display:none;min-height:52px;margin-top:28px;padding:12px 14px;align-items:center;color:#b42318;background:#fff4f3;border:1px solid #f7aaa4;border-radius:10px;font-size:14px}.alert.visible{display:flex}.form{margin-top:28px;display:flex;flex-direction:column;gap:22px}.field{display:flex;flex-direction:column;gap:9px;font-size:14px;font-weight:620}.field input{width:100%;height:54px;padding:0 15px;color:#17191c;background:#fff;border:1px solid #d9dde3;border-radius:10px;font:inherit;font-size:16px;outline:none}.field input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}.remember{display:flex;align-items:center;gap:9px;color:#3f4650;font-size:14px}.remember input{width:18px;height:18px;accent-color:#2563eb}.submit{min-height:56px;color:#fff;background:#2563eb;border:1px solid #2563eb;border-radius:10px;font:inherit;font-size:16px;font-weight:650}.submit:disabled{opacity:.5}.note{margin:27px 0 0;color:#7a828e;text-align:center;font-size:12px;line-height:1.55}@media(display-mode:standalone){body{min-height:100vh}}@media(max-width:600px){body{padding-top:max(78px,calc(env(safe-area-inset-top,0px) + 54px))}.login{margin:0}.intro{margin-top:54px}.intro h1{font-size:29px}}
  </style>
</head>
<body translate="no" class="notranslate">
  <main class="login">
    <div class="brand"><span class="mark" aria-hidden="true">C</span><span>Chat</span></div>
    <div class="intro"><h1>登录到 Chat</h1><p>验证身份后继续使用 Chat。</p></div>
    <div id="error" class="alert${initialError ? " visible" : ""}" role="alert">${initialError}</div>
    <form id="login-form" class="form">
      <label class="field"><span>用户名</span><input name="username" type="text" autocomplete="username" placeholder="请输入用户名" required autofocus /></label>
      <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required /></label>
      <label class="remember"><input name="persistent" type="checkbox" checked /><span>保持登录 30 天</span></label>
      <button class="submit" type="submit">登录</button>
    </form>
    <p class="note">请通过 HTTPS 访问公网部署；密码只提交给 Chat 后端，不保存在浏览器中。</p>
  </main>
  <script>
    const nextPath=${scriptValue(nextPath)};
    const form=document.getElementById("login-form");
    const error=document.getElementById("error");
    const button=form.querySelector("button");
    form.addEventListener("submit",async(event)=>{
      event.preventDefault();button.disabled=true;button.textContent="登录中…";error.classList.remove("visible");
      const data=new FormData(form);
      try{
        const response=await fetch("/api/auth/session",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({username:data.get("username"),password:data.get("password"),persistent:data.get("persistent")==="on"})});
        if(response.ok){location.replace(nextPath);return}
        error.textContent=response.status===401?"用户名或密码错误，请重新输入。":response.status===429?"尝试次数过多，请稍后再试。":"暂时无法登录，请检查部署设置和网络。";error.classList.add("visible");
      }catch{error.textContent="暂时无法登录，请检查网络后重试。";error.classList.add("visible")}
      finally{button.disabled=false;button.textContent="登录"}
    });
  </script>
</body>
</html>`;
});
