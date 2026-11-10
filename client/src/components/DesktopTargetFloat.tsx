import { useCallback, useEffect, useRef, useState } from "react";
import { useZoomPan, ZoomButtons } from "./ImageThumb";
import type { DesktopTarget } from "../api";
import { desktop, type CaptureSource } from "../desktop";

/** 桌面版的窗口采集接口；网页版、还没重启过的旧版桌面外壳没有 */
const capture = typeof desktop?.findCaptureSource === "function" ? desktop : undefined;

/**
 * 对话区右上角的浮窗：桌面工具（agent-desktop）正在操作哪个软件。平时是一个小条（应用图标、应用名、窗口标题），
 * 点开显示那个窗口的实时画面（桌面版按标题找到窗口，getUserMedia 取视频流，见 desktop/src/capture.ts）。
 * 只看不能点：画面上的点击不转给那个窗口。放大时铺满对话消息区，画面按比例缩放、不拉伸，Esc 缩回。网页版没有窗口采集，只显示名字
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

  // 放大时按 Esc 缩回去
  useEffect(() => {
    if (!open || !large) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLarge(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, large]);

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
            <button className="dt-btn" onClick={() => setLarge(!large)} title={large ? "缩小（Esc）" : "放大到整个对话区"} aria-label={large ? "缩小" : "放大"}>
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
          <LiveView target={target} source={source} large={large} />
        </div>
      </div>
    </div>
  );
}

/** 采集分辨率的上限：平时用 NORMAL；放大到超过画面原始像素（100%）时换 HIGH，小字也清楚，回到适应大小再换回来，平时不多占 CPU */
const NORMAL_MAX = { width: 1920, height: 1200 };
const HIGH_MAX = { width: 4096, height: 2560 };

/** 取窗口的视频流。Electron 的窗口采集：老式的 mandatory 约束（chromeMediaSource: desktop），标准的类型里没有 */
function captureWindow(sourceId: string, max: { width: number; height: number }): Promise<MediaStream> {
  const constraints = {
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: max.width, maxHeight: max.height, maxFrameRate: 15 } },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * 实时画面，或者为什么没有画面。画面可以缩放、平移（同图片查看器的 useZoomPan）：滚轮以鼠标处为中心缩放，双指捏合，
 * 放大后拖动平移，双击在适应大小和 2 倍之间切换，右下角的工具条缩小、放大、点百分比还原。换了窗口、放大缩小浮窗时还原
 */
function LiveView({ target, source, large }: { target: DesktopTarget; source: CaptureSource | null | undefined; large: boolean }) {
  const z = useZoomPan();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const setVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      z.mediaRef(el);
    },
    [z.mediaRef],
  );
  /** 正在显示的流：换分辨率时新的就绪了才停旧的，免得画面闪一下 */
  const streamRef = useRef<MediaStream | null>(null);
  const [hiRes, setHiRes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  // 换了窗口、放大缩小浮窗：缩放还原，分辨率回到平时的
  const { reset } = z;
  useEffect(() => {
    reset();
    setHiRes(false);
  }, [source?.id, large, reset]);

  // 放大到超过画面原始像素时换高分辨率；回到适应大小再换回去。换成高分辨率后百分比会变小，所以用「还在放大」判断要不要换回，免得来回切
  useEffect(() => {
    if (!hiRes && z.percent > 100) setHiRes(true);
    else if (hiRes && z.view.scale <= 1) setHiRes(false);
  }, [z.percent, z.view.scale, hiRes]);

  useEffect(() => {
    setError(null);
    setEnded(false);
    if (!source) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }
    let cancelled = false;
    captureWindow(source.id, hiRes ? HIGH_MAX : NORMAL_MAX)
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        const old = streamRef.current;
        streamRef.current = s;
        s.getVideoTracks()[0]?.addEventListener("ended", () => streamRef.current === s && setEnded(true));
        if (videoRef.current) videoRef.current.srcObject = s;
        old?.getTracks().forEach((t) => t.stop());
      })
      .catch((e: Error) => !cancelled && setError(e.message || e.name));
    return () => {
      cancelled = true;
    };
  }, [source, hiRes]);

  // 卸载（收起浮窗）时停掉流
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  // video 元素晚出现（找到窗口后才有）：出现时把已经在的流接上
  useEffect(() => {
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) videoRef.current.srcObject = streamRef.current;
  });

  let message: string | null = null;
  if (!desktop) message = "网页版看不到实时画面，在桌面版里打开可以看";
  else if (!capture) message = "桌面版重启后才能看实时画面";
  else if (!target.title) message = "还没找到这个软件的窗口";
  else if (source === undefined) message = "正在找窗口…";
  else if (source === null) message = "没找到这个窗口：可能已经关了或改了标题（macOS 上还要给本应用开「屏幕录制」权限）";
  else if (error) message = `取不到画面：${error}`;
  else if (ended) message = "窗口已经关闭";
  const live = !!source && !error && !ended;

  return (
    <div ref={z.stageRef} className={`dt-stage${live ? " live" : ""}`} {...z.stageHandlers}>
      {live && (
        <div className={`dt-frame${z.dragging ? " dragging" : ""}`} style={z.frameStyle}>
          <video
            ref={setVideo}
            className={`dt-video${z.view.scale > 1 ? " zoomed" : ""}${z.dragging ? " dragging" : ""}`}
            autoPlay
            muted
            playsInline
          />
        </div>
      )}
      {message && <div className="dt-message">{message}</div>}
      {!message && target.minimized && <div className="dt-badge">窗口最小化了，画面可能停在最小化之前</div>}
      {live && (
        <div className="image-viewer-tools dt-zoom-tools">
          <ZoomButtons z={z} />
        </div>
      )}
    </div>
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
