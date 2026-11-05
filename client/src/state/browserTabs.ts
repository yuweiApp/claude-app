import { useEffect, useState } from "react";
import { desktop, type BrowserTabInfo } from "../desktop";

/** 桌面版内置浏览器里这个会话（新会话页是草稿名）的标签页，输入框 @ 引用用；网页版是空的 */
export function useBrowserTabs(sessionId: string): BrowserTabInfo[] {
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  useEffect(() => {
    const browser = desktop?.browser;
    if (!browser) {
      setTabs([]);
      return;
    }
    const apply = (list: BrowserTabInfo[]) => setTabs(list.filter((t) => t.sessionId === sessionId && t.url && t.url !== "about:blank"));
    void browser.list().then(apply);
    return browser.onTabs(apply);
  }, [sessionId]);
  return tabs;
}
