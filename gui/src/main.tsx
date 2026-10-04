import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}

// The preview bridge is absent from production bundles and never falls through
// to native commands when its fixed fixtures cannot be initialized.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1") {
  void import("./dev/previewBridge").then(({ installPreviewBridge }) => {
    if (!installPreviewBridge()) throw new Error("演示模式未初始化");
    renderApp();
  }).catch(error => {
    const root = document.getElementById("root");
    if (root) root.textContent = `演示初始化失败：${String(error)}`;
  });
} else {
  renderApp();
}
