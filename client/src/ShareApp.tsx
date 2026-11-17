import { useEffect, useMemo, useState } from "react";
import { RemoteBrowser, RemoteBrowserContext } from "./state/remoteBrowser";
import { api, RequestError, type GatewayConfig, type SessionListItem, type ShareInfo } from "./api";
import { Chat } from "./App";
import { revealInTree, type LineRange } from "./components/FileBrowser";
import { FileLinkContext } from "./components/ReplyMarkdown";
import { folderName, sessionTitle } from "./components/Sidebar";
import { newPanelState, PanelIcon, SidePanel, withBrowserTab, withFileOpen, withFolderTab, type PanelState } from "./components/SidePanel";

/** 访客页面多久问一次分享的会话（停止分享、会话清空后换了 id） */
const INFO_POLL_MS = 5_000;
/** 连续这么多次连不上就当分享结束了（约 15 秒） */
const OFFLINE_POLLS = 3;

/**
 * 局域网分享的访客页面（地址 /share/<令牌>，见 docs/lan-share.md）：只有被分享的这一个会话，
 * 对话用本机同一个 Chat（输入框上面不放按钮），右侧面板是同一个 SidePanel。没有侧栏、设置
 */
export function ShareApp() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  /** 分享停了、链接无效 */
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panel, setPanel] = useState<PanelState>(newPanelState);

  useEffect(() => {
    api.config().then(setConfig, (e: Error) => setError(e.message));
    let stopped = false;
    let failures = 0;
    const load = () =>
      api.shareInfo().then(
        (next) => {
          if (stopped) return;
          failures = 0;
          // 会话没变时保留原来的对象，Chat 不用重建
          setInfo((prev) => (prev && prev.sessionId === next.sessionId && prev.cwd === next.cwd && prev.title === next.title && prev.chat === next.chat ? prev : next));
          setEnded(false);
        },
        (e: Error) => {
          if (stopped) return;
          if (e instanceof RequestError && e.status === 401) return setEnded(true);
          // 连不上：最后一个分享停掉时入口不再监听，分享方的电脑关了也是这样；网关重启只有几秒，连续几次才算结束
          if (!(e instanceof RequestError) && ++failures >= OFFLINE_POLLS) setEnded(true);
        },
      );
    void load();
    const timer = setInterval(load, INFO_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const title = info ? sessionTitle({ customTitle: info.title ?? undefined } as SessionListItem) : null;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  // 分享方桌面版的内置浏览器（右侧面板的「浏览器」）：按会话连，清空会话换了 id 就重连
  const sessionId = info?.sessionId ?? null;
  const [remoteBrowser, setRemoteBrowser] = useState<RemoteBrowser | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const browser = new RemoteBrowser();
    setRemoteBrowser(browser);
    return () => {
      browser.dispose();
      setRemoteBrowser(null);
    };
  }, [sessionId]);

  const cwd = info?.cwd ?? null;
  // 回复里的文件链接：在右侧面板打开（同本机的 App）
  const fileLinks = useMemo(
    () =>
      cwd
        ? {
            cwd,
            // 回复里的网址：在分享方的内置浏览器里开一个标签页，打开右侧面板切过去（同本机桌面版）
            openUrl: remoteBrowser
              ? async (url: string) => {
                  const tab = await remoteBrowser.create("", url);
                  if (!tab) return;
                  setPanel((state) => withBrowserTab(state, state.active, tab));
                  setPanelOpen(true);
                }
              : undefined,
            open: (path: string, root?: string, line?: LineRange | null) => {
              setPanel((state) => withFileOpen(state, state.active, path, false, root, line));
              setPanelOpen(true);
            },
            openFolder: (path: string, root?: string) => {
              setPanel((state) => withFolderTab(state, state.active, root));
              setPanelOpen(true);
              if (path) revealInTree(root ?? cwd, path);
            },
          }
        : null,
    [cwd, remoteBrowser],
  );

  if (ended) {
    return (
      <div className="share-ended">
        <div className="empty">
          分享已结束
          <div className="empty-sub">分享方停止了分享、关了电脑，或者链接不对</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app">
        <RemoteBrowserContext.Provider value={remoteBrowser}>
        <FileLinkContext.Provider value={fileLinks}>
          <main>
            {error && (
              <div className="banner" onClick={() => setError(null)}>
                {error}
              </div>
            )}
            <div className="main-split">
              {config && info && (
                <Chat
                  key={info.sessionId}
                  guest
                  sessionId={info.sessionId}
                  cwd={info.cwd}
                  config={config}
                  // 访客打开的就是建好的会话，不会新建；分叉不给访客
                  onCreated={() => undefined}
                  // 清空后换了 id，网关已经把分享跟过去了
                  onCleared={(_from, to) => setInfo((prev) => (prev ? { ...prev, sessionId: to } : prev))}
                  onChanged={() => undefined}
                  onError={setError}
                  title={title}
                  folder={info.chat ? null : folderName(info.cwd)}
                  headerEnd={
                    !panelOpen && (
                      <button className="icon-btn panel-toggle" onClick={() => setPanelOpen(true)} title="打开右侧面板（文件、终端、浏览器）" aria-label="打开右侧面板">
                        <PanelIcon />
                      </button>
                    )
                  }
                />
              )}
              {info && panelOpen && (
                <SidePanel key={info.cwd} cwd={info.cwd} sessionId={info.sessionId} state={panel} onChange={setPanel} onClose={() => setPanelOpen(false)} />
              )}
            </div>
          </main>
        </FileLinkContext.Provider>
        </RemoteBrowserContext.Provider>
      </div>
    </div>
  );
}

/** 地址是 /share/<令牌> 时返回令牌 */
export function shareTokenFromLocation(): string | null {
  const match = /^\/share\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  return match ? match[1]! : null;
}
