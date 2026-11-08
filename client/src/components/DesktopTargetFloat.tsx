import { useEffect, useRef, useState } from "react";
import type { DesktopTarget } from "../api";
import { desktop, type CaptureSource } from "../desktop";

/** 桌面版的窗口采集接口；网页版、还没重启过的旧版桌面外壳没有 */
const capture = typeof desktop?.findCaptureSource === "function" ? desktop : undefined;

/**
 * 对话区右上角的浮窗：桌面工具（agent-desktop）正在操作哪个软件。平时是一个小条（应用图标、应用名、窗口标题），
 * 点开显示那个窗口的实时画面（桌面版按标题找到窗口，getUserMedia 取视频流，见 desktop/src/capture.ts）。
 * 只看不能点：画面上的点击不转给那个窗口。网页版没有窗口采集，只显示名字
 */
export function DesktopTargetFloat({ target, running }: { target: DesktopTarget; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [large, setLarge] = useState(false);
  // 关掉的是哪个目标：目标换了（或者又开始新的一轮）重新出现
  const [hidden, setHidden] = useState<string | null>(null);
  const key = `${target.app}\n${target.windowId ?? ""}`;
  const [source, setSource] = useState<CaptureSource | null | undefined>(undefined);

  useEffect(() => {
    if (running) setHidden(null);
  }, [running]);

  // 按标题找窗口：标题变了（记事本保存后标题变成文件名）重新找
  useEffect(() => {
    setSource(undefined);
    if (!capture || !target.title) return;
    let cancelled = false;
    capture
      .findCaptureSource(target.title)
      .then((s) => !cancelled && setSource(s))
      .catch(() => !cancelled && setSource(null));
    return () => {
      cancelled = true;
    };
  }, [target.title, target.windowId]);

  if (hidden === key) return null;

  const label = (
    <>
      {source?.icon ? <img className="dt-icon" src={source.icon} alt="" /> : <MonitorIcon />}
      <span className="dt-app">{target.app}</span>
      {target.title && target.title !== target.app && <span className="dt-title">{target.title}</span>}
      {running && <span className="dt-live" title="正在操作" />}
    </>
  );

  if (!open) {
    return (
      <div className="dt-float">
        <button className="dt-chip" onClick={() => setOpen(true)} title={`AI 正在操作：${target.app}${target.title ? ` — ${target.title}` : ""}\n点击查看实时画面`}>
          {label}
        </button>
      </div>
    );
  }

  return (
    <div className={`dt-float dt-open${large ? " dt-large" : ""}`}>
      <div className="dt-card">
        <div className="dt-head">
          {label}
          <span className="dt-head-end">
            <button className="dt-btn" onClick={() => setLarge(!large)} title={large ? "缩小" : "放大"} aria-label={large ? "缩小" : "放大"}>
              {large ? <ShrinkIcon /> : <GrowIcon />}
            </button>
            <button className="dt-btn" onClick={() => setOpen(false)} title="收起" aria-label="收起">
              <CollapseIcon />
            </button>
            <button
              className="dt-btn"
              onClick={() => {
                setOpen(false);
                setHidden(key);
              }}
              title="关闭（换了软件或开始新的一轮时再出现）"
              aria-label="关闭"
            >
              <CloseIcon />
            </button>
          </span>
        </div>
        <div className="dt-body">
          <LiveView target={target} source={source} />
        </div>
      </div>
    </div>
  );
}

/** 实时画面，或者为什么没有画面 */
function LiveView({ target, source }: { target: DesktopTarget; source: CaptureSource | null | undefined }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    setError(null);
    setEnded(false);
    if (!source) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    // Electron 的窗口采集：老式的 mandatory 约束（chromeMediaSource: desktop），标准的类型里没有
    const constraints = {
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id, maxWidth: 1920, maxHeight: 1200, maxFrameRate: 15 } },
    } as unknown as MediaStreamConstraints;
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        s.getVideoTracks()[0]?.addEventListener("ended", () => setEnded(true));
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e: Error) => !cancelled && setError(e.message || e.name));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [source]);

  let message: string | null = null;
  if (!desktop) message = "网页版看不到实时画面，在桌面版里打开可以看";
  else if (!capture) message = "桌面版重启后才能看实时画面";
  else if (!target.title) message = "还没找到这个软件的窗口";
  else if (source === undefined) message = "正在找窗口…";
  else if (source === null) message = "没找到这个窗口：可能已经关了或改了标题（macOS 上还要给本应用开「屏幕录制」权限）";
  else if (error) message = `取不到画面：${error}`;
  else if (ended) message = "窗口已经关闭";

  return (
    <>
      {source && !error && !ended && <video ref={videoRef} className="dt-video" autoPlay muted playsInline />}
      {message && <div className="dt-message">{message}</div>}
      {!message && target.minimized && <div className="dt-badge">窗口最小化了，画面可能停在最小化之前</div>}
    </>
  );
}

const svg = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

/** 显示器图标：浮窗里没有应用图标时用；输入框上面「Computer Use」、桌面的引用也用它（传 className，不用浮窗的尺寸） */
export function MonitorIcon({ className = "dt-icon" }: { className?: string }) {
  return (
    <svg {...svg} className={className}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </svg>
  );
}

function GrowIcon() {
  return (
    <svg {...svg}>
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
    </svg>
  );
}

function ShrinkIcon() {
  return (
    <svg {...svg}>
      <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg {...svg}>
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...svg}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
