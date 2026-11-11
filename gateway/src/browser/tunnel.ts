import type { WebSocket } from "ws";
import { getConnection } from "../ssh/connections.js";
import { sshHost } from "../ssh/hosts.js";
import { CONNECTION_ID } from "../ssh/location.js";

/**
 * 内置浏览器访问远端的 localhost（docs/README.md「SSH 远程开发」）：远程会话的标签页在桌面版里用这台主机自己的分区，
 * 分区的代理是桌面版在本机开的（desktop/src/browser/ssh-proxy.ts），请求 localhost、127.0.0.1、[::1]、*.localhost 的连接，
 * 每条开一个 WebSocket 到这里（/browser/tunnel?host=<连接 id>&dest=<主机名>&port=<端口>），网关经 SSH 连远端的那个地址，之后两边原样转发字节。
 * 只转 loopback 的地址，不当通用代理用
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h) || h === "0.0.0.0";
}

/** 远端按它自己的规则解析主机名；*.localhost 远端不一定认，换成 localhost（请求里的 Host 头不变） */
const remoteName = (host: string) => {
  const h = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return h.endsWith(".localhost") ? "localhost" : h;
};

/** WebSocket 的关闭原因最多 123 字节 */
const reason = (s: string) => Buffer.from(s).subarray(0, 120).toString("utf8").replace(/�+$/, "");

export function handleTunnel(socket: WebSocket, query: { host?: string; dest?: string; port?: string }): void {
  const port = Number(query.port);
  if (!query.host || !CONNECTION_ID.test(query.host) || !getConnection(query.host) || !query.dest || !isLoopbackHost(query.dest) || !Number.isInteger(port) || port < 1 || port > 65535) {
    socket.close(1008, "参数不对：只转发远端的 loopback 地址");
    return;
  }
  // 远端连上之前浏览器就可能发数据（TLS 握手）：先存着
  const pending: Buffer[] = [];
  let channel: import("ssh2").ClientChannel | null = null;
  let closed = false;
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (!channel) return void pending.push(buf);
    if (!channel.write(buf)) socket.pause();
  });
  socket.on("close", () => {
    closed = true;
    channel?.end();
  });
  socket.on("error", () => channel?.close());
  sshHost(query.host)
    .forwardOut(remoteName(query.dest), port)
    .then((ch) => {
      if (closed) return void ch.close();
      channel = ch;
      for (const b of pending.splice(0)) ch.write(b);
      ch.on("drain", () => socket.resume());
      ch.on("data", (d: Buffer) => {
        // 本机这边写不过来时先停一下远端
        ch.pause();
        socket.send(d, () => ch.resume());
      });
      // 远端发完了（EOF）：WebSocket 没有半关闭，整条关掉（之前排着的数据先发完）；ssh2 的通道要两边都结束才 close
      ch.on("end", () => {
        socket.close();
        ch.end();
      });
      ch.on("close", () => socket.close());
      ch.on("error", () => socket.close());
    })
    .catch((err: unknown) => socket.close(1011, reason(err instanceof Error ? err.message : String(err))));
}
