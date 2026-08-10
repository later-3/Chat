import React from "react";
import { createRoot } from "react-dom/client";
import "./vendor/fontawesome/css/all.min.css";
import { App } from "./App.jsx";
import "./styles.css";
import "./theme-overrides.css";

function applyReferenceContext() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.dataset.reference = "things";
  document.documentElement.dataset.theme = params.get("theme") || "source";
  document.documentElement.dataset.embedded = params.get("embedded") === "1" ? "1" : "0";
}

applyReferenceContext();

window.addEventListener("message", (event) => {
  if (window.parent !== window && event.source !== window.parent) return;
  if (event.data?.type === "chat:theme") {
    const next = new URL(window.location.href);
    next.searchParams.set("theme", event.data.themeId || "source");
    window.history.replaceState(window.history.state, "", `${next.pathname}${next.search}${next.hash}`);
    document.documentElement.dataset.theme = event.data.themeId || "source";
    return;
  }
  if (event.data?.type !== "chat:route" || typeof event.data.url !== "string") return;

  const previousUrl = window.location.href;
  const next = new URL(event.data.url, window.location.href);
  const nextUrl = `${window.location.pathname}${next.search}${next.hash}`;
  window.history.pushState({ ...(window.history.state || {}), chatReference: true }, "", nextUrl);
  applyReferenceContext();
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  if (new URL(previousUrl).hash !== next.hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: previousUrl, newURL: window.location.href }));
  }
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
