import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, type MenuItemConstructorOptions, type OpenDialogOptions, type Rectangle } from "electron";
import { GatewayBridge } from "./browser/bridge.js";
import { BrowserViews, FAVICON_SCHEME, tabInfo } from "./browser/views.js";
import { findCaptureSource } from "./capture.js";
import { accountEnv, accountInfo, loadAccount, loginAccount, logoutAccount } from "./account.js";

// 桌面版：登录后拉起当前账号独立的网关和网页（Vite），在窗口里打开网页。
const root = path.resolve(import.meta.dirname, "..", "..");
const desktopRoot = app.isPackaged ? app.getAppPath() : path.join(root, "desktop");
const loginFile = path.join(desktopRoot, "login.html");
let gatewayUrl = process.env.DESKTOP_GATEWAY_URL || "http://127.0.0.1:8788";
let clientUrl = process.env.DESKTOP_CLIENT_URL || "http://localhost:5180";
/** 拉起子进程用的 node，默认取 PATH 里的（Electron 自带的 Node 版本和网关要求的不一定一致） */
const nodeBin = app.isPackaged ? path.join(process.resourcesPath, "runtime", process.platform === "win32" ? "node.exe" : "node") : process.env.DESKTOP_NODE || "node";
const readyTimeoutMs = 60_000;
/** 每次启动独立生成的网关访问凭证，供网页和内置浏览器桥接使用 */
const gatewayToken = randomBytes(24).toString("hex");
const iconPath = path.join(desktopRoot, "assets", "icon.png");

// 开发时指定单独的数据目录，可以和已经开着的桌面版同时运行（单实例锁、登录状态都按数据目录分开）
if (process.env.DESKTOP_USER_DATA) app.setPath("userData", path.resolve(process.env.DESKTOP_USER_DATA));

// Windows 会把屏幕外、被挡住的窗口当成不可见、不再绘制，内置浏览器的停放窗口要一直渲染（见 browser/views.ts）
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

interface Service {
  name: string;
  child: ChildProcess;
  /** 最近的输出，启动失败时显示在对话框里 */
  tail: string[];
  exited: boolean;
}

const services: Service[] = [];

function start(name: string, cwd: string, args: string[], env: Record<string, string> = {}): Service {
  const child = spawn(nodeBin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Windows 上从图形界面拉起 node 会弹出控制台窗口
    windowsHide: true,
  });
  const service: Service = { name, child, tail: [], exited: false };
  const forward = (out: NodeJS.WriteStream) => (chunk: Buffer) => {
    out.write(chunk);
    service.tail.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
    service.tail.splice(0, Math.max(0, service.tail.length - 20));
  };
  child.stdout?.on("data", forward(process.stdout));
  child.stderr?.on("data", forward(process.stderr));
  child.on("error", (err) => service.tail.push(`无法启动 ${nodeBin}：${err.message}`));
  child.on("exit", () => (service.exited = true));
  services.push(service);
  return service;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url: string, service: Service): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs;
  while (!(await reachable(url))) {
    if (service.exited) throw new Error(`${service.name}启动失败：\n\n${service.tail.join("\n")}`);
    if (Date.now() > deadline) throw new Error(`${service.name}在 ${readyTimeoutMs / 1000} 秒内没有就绪：\n\n${service.tail.join("\n")}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function serviceUrl(configured: string | undefined, preferred: number): Promise<string> {
  const url = new URL(configured || `http://127.0.0.1:${preferred}`);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("账号登录模式的后台服务地址必须是本机 HTTP 地址");
  }
  const requested = Number(url.port || 80);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !configured) {
        const fallback = createServer();
        fallback.once("error", reject);
        fallback.listen(0, "127.0.0.1", () => {
          const address = fallback.address();
          fallback.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("无法分配后台端口")));
        });
      } else reject(new Error(`后台端口 ${requested} 已被占用，请关闭对应服务或修改桌面服务地址`));
    });
    probe.listen(requested, "127.0.0.1", () => probe.close(() => resolve(requested)));
  });
  url.port = String(port);
  return url.origin;
}

function stopAll(): void {
  for (const { child, exited } of services) {
    if (exited || child.pid === undefined) continue;
    // Windows 没有 SIGTERM，kill() 只结束 node 本身，网关拉起的 claude 子进程会留下来，所以连进程树一起结束
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "Claude App",
    // macOS 不看窗口的 icon，程序坞图标在 whenReady 里用 app.dock.setIcon 换
    icon: iconPath,
    show: false,
    autoHideMenuBar: true,
    // 不要系统标题栏：网页自己画（client/src/components/TitleBar.tsx），按钮通过 preload 调下面的 window:* 消息。
    // macOS 保留左上角的红绿灯按钮
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : { frame: false }),
    webPreferences: { preload: path.join(import.meta.dirname, "preload.cjs"), devTools: !app.isPackaged },
  });
  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));
  // 网页里的外部链接用系统浏览器打开，不在应用窗口里跳走
  const external = (url: string) => !url.startsWith(clientUrl) && /^https?:/.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!external(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  // Electron 窗口默认没有右键菜单：输入框给编辑菜单，选中文字给「复制」。网页自己画了菜单的地方（会话列表、目录树）会拦下右键，不走这里
  win.webContents.on("context-menu", (_e, p) => {
    let items: MenuItemConstructorOptions[] = [];
    if (p.isEditable) {
      items = [
        { label: "撤销", role: "undo", enabled: p.editFlags.canUndo },
        { label: "重做", role: "redo", enabled: p.editFlags.canRedo },
        { type: "separator" },
        { label: "剪切", role: "cut", enabled: p.editFlags.canCut },
        { label: "复制", role: "copy", enabled: p.editFlags.canCopy },
        { label: "粘贴", role: "paste", enabled: p.editFlags.canPaste },
        { label: "全选", role: "selectAll", enabled: p.editFlags.canSelectAll },
      ];
    } else if (p.selectionText.trim()) {
      items = [{ label: "复制", role: "copy" }];
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  return win;
}

// 网页标题栏上的窗口按钮
ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("window:toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win?.isMaximized()) win.unmaximize();
  else win?.maximize();
});
ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle("window:is-maximized", (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

// 内置浏览器（右侧面板的「浏览器」）：界面经 preload 的 browser 接口建标签页、导航、告诉外壳显示位置；
// 标签页有变化时把整个列表推给界面（browser:tabs），AI 切标签页、用户在网页里点开新页面时让面板跟着切（browser:activate）
let mainWindow: BrowserWindow | undefined;
const browserViews = new BrowserViews(() => mainWindow);
// 内置浏览器标签页的图标（views.ts 的 fetchFavicon 取下来的）：界面的 <img> 用 favicon://icon/<编号> 加载。要在 ready 之前注册
protocol.registerSchemesAsPrivileged([{ scheme: FAVICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const fromUi = (sender: Electron.WebContents) => !!mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents;
let startingSession = false;
let uiReady = false;
let startSession: (() => Promise<void>) | undefined;
ipcMain.handle("account:info", (e) => fromUi(e.sender) ? accountInfo() : null);
ipcMain.handle("account:gateway-token", (e) => fromUi(e.sender) && uiReady ? gatewayToken : null);
ipcMain.handle("account:login", async (e, credentials: { username?: unknown; password?: unknown; code?: unknown } = {}) => {
  if (!fromUi(e.sender) || uiReady || startingSession) return { error: "当前无法登录，请稍后重试" };
  startingSession = true;
  try {
    const result = await loginAccount(credentials.username, credentials.password, credentials.code);
    if (!result.need2fa) await startSession?.();
    return result;
  } catch (err) {
    stopAll();
    services.length = 0;
    return { error: (err as Error).message };
  } finally { startingSession = false; }
});
ipcMain.handle("account:logout", async (e) => {
  if (!fromUi(e.sender) || !uiReady) return;
  uiReady = false;
  try { await logoutAccount(); }
  catch (err) { uiReady = true; throw err; }
  browserViews.hide();
  browserViews.freeze();
  stopAll();
  // 重启外壳，彻底释放旧账号的后台进程、浏览器视图和内存凭证，随后显示登录页。
  app.relaunch();
  app.quit();
});
let tabsPush: NodeJS.Timeout | undefined;
const pushTabs = () => {
  tabsPush ??= setTimeout(() => {
    tabsPush = undefined;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("browser:tabs", browserViews.list().map(tabInfo));
  }, 50);
};
for (const event of ["created", "closed", "changed"] as const) browserViews.on(event, pushTabs);
browserViews.on("activate", (tab) => mainWindow?.webContents.send("browser:activate", tab.id));
ipcMain.handle("browser:list", (e) => (fromUi(e.sender) ? browserViews.list().map(tabInfo) : []));
ipcMain.handle("browser:create", async (e, sessionId: unknown, url: unknown) => {
  if (!fromUi(e.sender) || typeof sessionId !== "string") return null;
  return tabInfo(await browserViews.create(sessionId, typeof url === "string" && url ? url : undefined, "user"));
});
ipcMain.on("browser:close", (e, id: unknown) => fromUi(e.sender) && typeof id === "string" && browserViews.close(id, "user"));
ipcMain.on("browser:navigate", (e, id: unknown, url: unknown) => {
  if (fromUi(e.sender) && typeof id === "string" && typeof url === "string") void browserViews.navigate(id, url);
});
ipcMain.on("browser:go", (e, id: unknown, action: unknown) => {
  if (fromUi(e.sender) && typeof id === "string" && (action === "back" || action === "forward" || action === "reload" || action === "stop")) browserViews.go(id, action);
});
ipcMain.on("browser:show", (e, id: unknown, bounds: Rectangle) => fromUi(e.sender) && typeof id === "string" && browserViews.show(id, bounds));
ipcMain.on("browser:hide", (e) => fromUi(e.sender) && browserViews.hide());
ipcMain.handle("browser:snapshot", (e, id: unknown) => (fromUi(e.sender) && typeof id === "string" ? browserViews.snapshot(id) : null));
ipcMain.handle("browser:suggest", (e, query: unknown) => (fromUi(e.sender) && typeof query === "string" ? browserViews.history.suggest(query) : []));

// 桌面工具正在操作的窗口的实时画面（网页右上角的浮窗）：按标题找采集源，见 capture.ts
ipcMain.handle("capture:find", (e, title: unknown) => (fromUi(e.sender) && typeof title === "string" ? findCaptureSource(title) : null));

// 新会话的「选择文件夹…」：系统的文件夹对话框（Windows 上是资源管理器），取消时返回 null
ipcMain.handle("dialog:pick-folder", async (e, defaultPath: unknown) => {
  const options: OpenDialogOptions = {
    title: "选择文件夹",
    properties: ["openDirectory"],
    defaultPath: typeof defaultPath === "string" ? defaultPath : undefined,
  };
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// 技能详情等处的「在文件夹中显示」：用系统的文件管理器打开所在的文件夹并选中它；文件不在这台机器上时返回 false
ipcMain.handle("shell:show-item", (e, target: unknown) => {
  if (!fromUi(e.sender) || typeof target !== "string" || !path.isAbsolute(target) || !existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let bridge: GatewayBridge | undefined;

  app.on("second-instance", () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // 停放窗口不算：主窗口关了就退出
  app.on("window-all-closed", () => app.quit());
  // 退出时先存下开着的标签页，之后视图跟着窗口销毁不算关闭
  app.on("before-quit", () => browserViews.freeze());
  app.on("will-quit", () => {
    bridge?.stop();
    browserViews.history.flush();
    stopAll();
  });

  // 入口模块不能在顶层 await whenReady()：Electron 要等入口模块的顶层 await 结束才发 ready，会互相等死
  void app.whenReady().then(async () => {
    // 开发时直接跑 electron，macOS 程序坞默认是 Electron 自己的图标。放在等网关、网页之前，启动的这几秒也是新图标
    if (process.platform === "darwin") app.dock?.setIcon(iconPath);
    try {
      mainWindow = createWindow();
      mainWindow.on("close", () => browserViews.freeze());
      mainWindow.on("closed", () => app.quit());
      let browserInitialized = false;
      startSession = async () => {
        gatewayUrl = await serviceUrl(app.isPackaged ? undefined : process.env.DESKTOP_GATEWAY_URL, app.isPackaged ? 18788 : 8788);
        clientUrl = app.isPackaged ? gatewayUrl : await serviceUrl(process.env.DESKTOP_CLIENT_URL, 5180);
        const env = accountEnv();
        const gatewayRoot = app.isPackaged ? path.join(process.resourcesPath, "gateway") : path.join(root, "gateway");
        const gateway = start("网关", app.isPackaged ? app.getPath("userData") : gatewayRoot, app.isPackaged ? [path.join(gatewayRoot, "dist", "index.js")] : ["--import", "tsx", "src/index.ts"], {
          ...env, LOG_PRETTY: app.isPackaged ? "0" : "1", HOST: "127.0.0.1", PORT: new URL(gatewayUrl).port, API_TOKEN: gatewayToken,
          ...(app.isPackaged ? { NODE_ENV: "production", STATIC_DIR: path.join(process.resourcesPath, "client"), LOG_DIR: path.join(app.getPath("userData"), "logs") } : {}),
        });
        await waitFor(`${gatewayUrl}/health`, gateway);
        if (!app.isPackaged) {
          const client = start("网页", path.join(root, "client"), ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", new URL(clientUrl).port], { VITE_PROXY_TARGET: gatewayUrl });
          await waitFor(clientUrl, client);
        }
        if (!browserInitialized) {
          await browserViews.init(path.dirname(env.CLAUDE_CONFIG_DIR!));
          browserInitialized = true;
          session.defaultSession.protocol.handle(FAVICON_SCHEME, (request) => browserViews.faviconResponse(request.url));
        }
        const ws = new URL("/browser/host", gatewayUrl.replace(/^http/, "ws"));
        ws.searchParams.set("token", gatewayToken);
        bridge?.stop();
        bridge = new GatewayBridge(ws.toString(), browserViews, (message) => console.log(message));
        bridge.start();
        uiReady = true;
        try { await mainWindow!.loadURL(clientUrl); }
        catch (err) { uiReady = false; throw err; }
      };
      if (loadAccount()) {
        startingSession = true;
        try { await startSession(); }
        catch (err) {
          stopAll();
          services.length = 0;
          await mainWindow.loadFile(loginFile, { query: { error: (err as Error).message } });
        } finally { startingSession = false; }
      } else {
        await mainWindow.loadFile(loginFile);
      }
    } catch (err) {
      dialog.showErrorBox("Claude App 启动失败", (err as Error).message);
      app.quit();
    }
  });
}
