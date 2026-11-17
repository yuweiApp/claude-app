import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { BrowserTabInfo } from "../desktop";
import type { RemoteBrowser, RemoteFrame } from "../state/remoteBrowser";
import { BrowserToolbar, displayUrl, loadErrorText } from "./BrowserTab";

/** 鼠标移动最多多久发一次（毫秒） */
const MOVE_INTERVAL_MS = 33;

interface Props {
  browser: RemoteBrowser;
  id: string;
  info: BrowserTabInfo | undefined;
  active: boolean;
}

/**
 * 局域网分享的访客看到的内置浏览器标签页（见 docs/lan-share.md「内置浏览器」）：上面是同一个地址栏，
 * 下面是分享方桌面版推过来的画面（不在前面时不要画面）。在画面上点击、滚动、打字经 RemoteBrowser 发回去注入网页；
 * 键盘输入经一个看不见的输入框接住，中文输入法打完的字整段送过去，粘贴的文字也是。右键不转发（菜单会弹在分享方的屏幕上）
 */
export function RemoteBrowserTab({ browser, id, info, active }: Props) {
  const url = displayUrl(info?.pendingUrl || info?.url);
  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const [frame, setFrame] = useState<RemoteFrame | null>(null);
  const [cursor, setCursor] = useState("default");
  const [shell, setShell] = useState(browser.shellConnected);
  const imgRef = useRef<HTMLImageElement>(null);
  const keyRef = useRef<HTMLTextAreaElement>(null);
  const lastMove = useRef(0);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useEffect(() => browser.onShell(setShell), [browser]);
  useEffect(() => {
    if (!active) return;
    return browser.watch(id, setFrame, setCursor);
  }, [browser, id, active]);
  useEffect(() => {
    if (!editing) setAddress(url);
  }, [url, editing]);

  /** 界面上的位置换成网页的 CSS 像素：画面按比例缩放、居中（object-fit: contain） */
  const toPage = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    const f = frameRef.current;
    if (!img || !f || !f.width || !f.height) return null;
    const r = img.getBoundingClientRect();
    const scale = Math.min(r.width / f.width, r.height / f.height);
    const left = r.left + (r.width - f.width * scale) / 2;
    const top = r.top + (r.height - f.height * scale) / 2;
    const x = (e.clientX - left) / scale;
    const y = (e.clientY - top) / scale;
    if (x < 0 || y < 0 || x > f.width || y > f.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const mouse = (kind: "down" | "up" | "move", e: ReactMouseEvent) => {
    const p = toPage(e);
    if (!p) return;
    const button = kind === "move" ? (e.buttons & 1 ? "left" : "none") : e.button === 0 ? "left" : e.button === 1 ? "middle" : "none";
    if (button === "none" && kind !== "move") return;
    browser.input(id, { type: "mouse", kind, ...p, button, buttons: e.buttons, clickCount: kind === "move" ? 0 : Math.max(1, e.detail), modifiers: modifiers(e) });
  };

  // 滚轮：要阻止界面自己滚，React 的 onWheel 是被动监听，阻止不了，直接挂在图片上
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toPage(e);
      if (!p) return;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? img.clientHeight : 1;
      browser.input(id, { type: "wheel", ...p, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: modifiers(e) });
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => img.removeEventListener("wheel", onWheel);
  }, [browser, id, frame !== null]);

  const key = (kind: "down" | "up", e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法正在组字：交给 compositionend 整段送
    if (e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    // 粘贴走 onPaste（访客这边剪贴板里的文字）
    if (mod && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    const text = kind === "down" ? (e.key.length === 1 && !mod ? e.key : e.key === "Enter" ? "\r" : undefined) : undefined;
    browser.input(id, { type: "key", kind, key: e.key, code: e.code, keyCode: e.keyCode, ...(text ? { text } : {}), modifiers: modifiers(e) });
  };

  const failed = info?.error;
  return (
    <div className="browser-tab">
      <BrowserToolbar
        info={info}
        address={address}
        onAddress={(value) => {
          setEditing(true);
          setAddress(value);
        }}
        onReset={() => {
          setEditing(false);
          setAddress(url);
        }}
        onSubmit={(next) => {
          browser.navigate(id, next);
          setEditing(false);
        }}
        onGo={(action) => browser.go(id, action)}
        suggest={browser.suggest}
      />
      <div className="browser-area remote-browser-area">
        {frame && (
          <img
            ref={imgRef}
            className="remote-browser-frame"
            src={frame.url}
            alt=""
            draggable={false}
            style={{ cursor }}
            onMouseDown={(e) => {
              e.preventDefault();
              keyRef.current?.focus({ preventScroll: true });
              mouse("down", e);
            }}
            onMouseUp={(e) => mouse("up", e)}
            onMouseMove={(e) => {
              const now = performance.now();
              if (now - lastMove.current < MOVE_INTERVAL_MS) return;
              lastMove.current = now;
              mouse("move", e);
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
        <textarea
          ref={keyRef}
          className="remote-browser-keys"
          aria-label="网页的键盘输入"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => key("down", e)}
          onKeyUp={(e) => key("up", e)}
          onCompositionEnd={(e) => {
            if (e.data) browser.input(id, { type: "text", text: e.data });
            e.currentTarget.value = "";
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text");
            if (text) browser.input(id, { type: "text", text });
          }}
          // 没经过按键进来的文字（手机软键盘按键是 229、不阻止默认；拖进来、自动填的）：整段送过去。按键打的字在 keydown 里阻止了，不会到这里
          onInput={(e) => {
            const el = e.currentTarget;
            if ((e.nativeEvent as InputEvent).isComposing) return;
            if (el.value) browser.input(id, { type: "text", text: el.value });
            el.value = "";
          }}
        />
        {shell === false ? (
          <div className="browser-covered">分享方的桌面版没有打开，内置浏览器用不了</div>
        ) : failed ? (
          <div className="browser-error" role="alert">
            <div className="browser-error-title">无法访问此网站</div>
            <div className="browser-error-url">{failed.url}</div>
            <div className="browser-error-reason">{loadErrorText(failed.code)}</div>
            <div className="browser-error-code">{failed.description || `错误码 ${failed.code}`}</div>
            <button className="btn-small browser-error-retry" onClick={() => browser.go(id, "reload")}>
              重试
            </button>
          </div>
        ) : (
          !frame && <div className="browser-covered">正在取分享方的网页画面…</div>
        )}
      </div>
    </div>
  );
}

/** 键盘、鼠标事件的修饰键，按 CDP 的写法：Alt 1、Ctrl 2、Meta 4、Shift 8 */
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
