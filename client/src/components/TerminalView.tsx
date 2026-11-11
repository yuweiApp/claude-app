import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { api, type TerminalClientMessage, type TerminalEvent } from "../api";
import { isDark, subscribeTheme } from "../theme";
import { monoFamily, subscribeFont } from "../font";

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

/**
 * 连上终端：输出、输入、改大小走一条 WebSocket（不像 SSE 那样占浏览器对同一个源的 6 个 HTTP 连接）。
 * 断了（网关重启等）隔 2 秒重连，连上后网关先发一遍保留的输出；终端退出、不存在、卸载后不再连。
 * 没连上时的输入、改大小丢掉（onOpen 里补发大小）
 */
function connectTerminal(id: string, onOpen: () => void, onEvent: (event: TerminalEvent) => void) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const socket = new WebSocket(api.terminalSocketUrl(id));
    ws = socket;
    socket.onopen = onOpen;
    socket.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as TerminalEvent;
      if (event.type !== "data") {
        stopped = true;
        socket.close();
      }
      onEvent(event);
    };
    socket.onclose = () => {
      if (stopped || ws !== socket) return;
      timer = setTimeout(connect, 2000);
    };
  };
  connect();
  return {
    send(msg: TerminalClientMessage) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}

/** 右侧面板的一个终端：xterm 画屏幕，输出、输入、改大小走 WebSocket（连上先收到已有的输出） */
export function TerminalView({ terminalId, active }: { terminalId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: monoFamily(),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: isDark() ? DARK : LIGHT,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    // 重连时会再收到一遍完整的输出，先清屏
    let first = true;
    // 只在看得见、大小变了时通知网关；（重新）连上时补发最后的大小
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sendSize = () => conn.send({ type: "resize", cols: term.cols, rows: term.rows });
    const conn = connectTerminal(
      terminalId,
      () => {
        first = true;
        if (last) sendSize();
      },
      (event) => {
        if (event.type === "data") {
          if (first) term.reset();
          first = false;
          term.write(event.data);
        } else if (event.type === "exit") {
          term.write(`\r\n\x1b[2m[进程已退出，代码 ${event.code}]\x1b[0m\r\n`);
        } else {
          term.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
        }
      },
    );
    const dataSub = term.onData((data) => conn.send({ type: "input", data }));

    const sync = () => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      fit.fit();
      const size = `${term.cols}x${term.rows}`;
      if (size === last) return;
      last = size;
      clearTimeout(timer);
      timer = setTimeout(sendSize, 80);
    };
    fitRef.current = sync;
    const ro = new ResizeObserver(sync);
    ro.observe(host);
    sync();

    const offTheme = subscribeTheme(() => (term.options.theme = isDark() ? DARK : LIGHT));
    // 换了代码字体：字宽变了，按新字体重新算行列
    const offFont = subscribeFont(() => {
      term.options.fontFamily = monoFamily();
      sync();
    });

    return () => {
      offTheme();
      offFont();
      conn.close();
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
