import { useEffect, useState } from "react";
import { desktop, type BrowserTabInfo } from "../desktop";

/** 桌面版内置浏览器里这个会话的标签页，输入框「标签页」按钮引用用；网页版和新会话页（sessionId 为 null）是空的 */
export function useBrowserTabs(sessionId: string | null): BrowserTabInfo[] {
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  useEffect(() => {
    const browser = desktop?.browser;
    if (!browser || !sessionId) {
      setTabs([]);
      return;
    }
    const apply = (list: BrowserTabInfo[]) => setTabs(list.filter((t) => t.sessionId === sessionId && t.url && t.url !== "about:blank"));
    void browser.list().then(apply);
    return browser.onTabs(apply);
  }, [sessionId]);
  return tabs;
}
