import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.VITE_PROXY_TARGET || "http://127.0.0.1:8788";
  return {
    plugins: [react()],
    resolve: {
      // 网关的 shared 目录：类型之外还有和网关共用的、不依赖 Node 的代码（如 shared/element-context.ts）。
      // client 没装 @types/node，用 URL 算路径；Windows 上 pathname 是 /F:/…，去掉开头的斜杠
      alias: { "@gateway": decodeURIComponent(new URL("../gateway/src", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1") },
    },
    server: {
      port: 5180,
      strictPort: true,
      // @gateway 别名指到 client 外面，开发服务器默认不给读
      fs: { allow: [".", "../gateway/src/shared"] },
      proxy: {
        // 开发时 /api/* 转发到网关，前端不用处理 CORS
        "/api": {
          target,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
          // 终端走 WebSocket（/api/terminals/:id/socket）
          ws: true,
          // 网关进程退出时，代理不会关掉浏览器这边的事件流长连接，页面不知道断了、不会重连（同 codex-app-server）：
          // 网关那边的连接一断就同时断开浏览器这边
          // （client 没装 @types/node，这里只写用到的成员）
          configure: (proxy) => {
            const events = proxy as unknown as {
              on(
                event: "proxyRes",
                fn: (proxyRes: { on(e: "close", f: () => void): void }, req: unknown, res: { writableEnded: boolean; destroy(): void }) => void,
              ): void;
            };
            events.on("proxyRes", (proxyRes, _req, res) => {
              proxyRes.on("close", () => {
                if (!res.writableEnded) res.destroy();
              });
            });
          },
        },
      },
    },
  };
});
