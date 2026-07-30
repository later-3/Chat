import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

// 浏览器先加载 index.html，再执行本入口；这里把 React 应用挂到 <div id="root">。
// main.tsx 只负责“启动前端”。页面状态、REST 请求和 AG-UI 订阅从 App 继续向下分发。
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Chat frontend root element was not found.");
}

// StrictMode 会在开发环境帮助发现不安全副作用；产品权威状态仍属于后端数据库，
// React 只保存当前页面需要显示和交互的投影。
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
