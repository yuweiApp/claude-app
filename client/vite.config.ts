import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = process.env.VITE_PROXY_TARGET || env.VITE_PROXY_TARGET || "http://127.0.0.1:8788";
  return {
    plugins: [react()],
    build: { sourcemap: false },
    server: {
      port: 5180,
      strictPort: true,
      proxy: {
        // 开发时 /api/* 转发到网关，前端不用处理 CORS
        "/api": {
          target,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
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
