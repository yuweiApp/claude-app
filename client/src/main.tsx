import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setShareToken } from "./api";
import { ShareApp, shareTokenFromLocation } from "./ShareApp";
import "./theme";
import "./skin";
import "./font";
import "./styles.css";
import "./skins.css";

// 局域网分享的访客打开的是 /share/<令牌>（见 docs/lan-share.md），其余照旧是本机的界面
const shareToken = shareTokenFromLocation();
if (shareToken) setShareToken(shareToken);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {shareToken ? <ShareApp /> : <App />}
  </StrictMode>,
);
