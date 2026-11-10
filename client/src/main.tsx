import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { desktop } from "./desktop";
import { setDesktopToken } from "./api";
import "./theme";
import "./skin";
import "./styles.css";
import "./skins.css";

// 网关令牌由外壳临时生成；模型密钥始终留在主进程，不传到网页。
if (desktop) {
  const token = await desktop.account.gatewayToken();
  setDesktopToken(token);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
