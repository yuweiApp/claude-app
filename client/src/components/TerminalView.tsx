import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { api, type TerminalEvent } from "../api";

const LIGHT: ITheme = {
  background: "#faf9f7",
  foreground: "#1f1e1c",
  cursor: "#1f1e1c",
  selectionBackground: "#c9644233",
  black: "#1f1e1c",
  brightBlack: "#77736b",
};
const DARK: ITheme = {
  background: "#1f1e1c",
  foreground: "#ecebe7",
  cursor: "#ecebe7",
  selectionBackground: "#c9644255",
};

const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * 输入按顺序发：一个请求在路上时攒着，回来了再把攒下的一起发（并发的请求可能乱序到达）
 */
function inputSender(id: string) {
  let pending = "";
  let busy = false;
  const flush = () => {
    if (busy || !pending) return;
    const data = pending;
    pending = "";
    busy = true;
    void api
      .terminalInput(id, data)
      .catch(() => undefined)
      .finally(() => {
        busy = false;
        flush();
      });
  };
  return (data: string) => {
    pending += data;
    flush();
  };
}

/** 右侧面板的一个终端：xterm 画屏幕，输出走 SSE（连上先收到已有的输出），输入、改大小走 POST */
export function TerminalView({ terminalId, active }: { terminalId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: dark() ? DARK : LIGHT,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const send = inputSender(terminalId);
    const dataSub = term.onData(send);

    // 只在看得见、大小变了时通知网关
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      fit.fit();
      const size = `${term.cols}x${term.rows}`;
      if (size === last) return;
      last = size;
      clearTimeout(timer);
      timer = setTimeout(() => void api.resizeTerminal(terminalId, term.cols, term.rows).catch(() => undefined), 80);
    };
    fitRef.current = sync;
    const ro = new ResizeObserver(sync);
    ro.observe(host);
    sync();

    const source = new EventSource(api.terminalStreamUrl(terminalId));
    let first = true;
    source.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as TerminalEvent | { type: "error"; message: string };
      if (event.type === "data") {
        // 重连时会再收到一遍完整的输出，先清屏
        if (first) term.reset();
        first = false;
        term.write(event.data);
      } else if (event.type === "exit") {
        term.write(`\r\n\x1b[2m[进程已退出，代码 ${event.code}]\x1b[0m\r\n`);
        source.close();
      } else {
        term.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
        source.close();
      }
    };
    source.onerror = () => {
      first = true;
    };

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => (term.options.theme = media.matches ? DARK : LIGHT);
    media.addEventListener("change", onTheme);

    return () => {
      media.removeEventListener("change", onTheme);
      source.close();
      ro.disconnect();
      clearTimeout(timer);
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  // 切到这个标签时按现在的大小重新排一下，并把焦点给终端
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <div className="terminal-host" ref={hostRef} />;
}
