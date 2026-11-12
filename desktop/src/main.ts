import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, type MenuItemConstructorOptions, type OpenDialogOptions, type Rectangle } from "electron";
import { GatewayBridge } from "./browser/bridge.js";
import { ElementInspector, pngBase64 } from "./browser/inspect.js";
import { BrowserViews, FAVICON_SCHEME, tabInfo } from "./browser/views.js";
import { SshProxies } from "./browser/ssh-proxy.js";
import { findCaptureSource } from "./capture.js";

// 桌面版：拉起网关和网页（Vite），在窗口里打开网页。已经在跑的（比如 VS Code 里先启动了「启动网页」）直接复用
const root = path.resolve(import.meta.dirname, "..", "..");
const gatewayUrl = process.env.DESKTOP_GATEWAY_URL || "http://127.0.0.1:8788";
const clientUrl = process.env.DESKTOP_CLIENT_URL || "http://localhost:5180";
/** 拉起子进程用的 node，默认取 PATH 里的（Electron 自带的 Node 版本和网关要求的不一定一致） */
const nodeBin = process.env.DESKTOP_NODE || "node";
const readyTimeoutMs = 60_000;
/** 网关设了 API_TOKEN 时，外壳连网关（内置浏览器）也要带上 */
const gatewayToken = process.env.DESKTOP_GATEWAY_TOKEN || process.env.API_TOKEN || "";
const iconPath = path.join(root, "desktop", "assets", "icon.png");

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

async function ensure(url: string, launch: () => Service): Promise<void> {
  if (await reachable(url)) return;
  await waitFor(url, launch());
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
    // plugins：Chromium 自带的 PDF 查看器，右侧面板预览 PDF 用（Electron 默认关着）
    webPreferences: { preload: path.join(import.meta.dirname, "preload.cjs"), plugins: true },
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
  // 界面缩放。默认菜单的放大快捷键是 Ctrl+Plus，美式键盘上得按 Ctrl+Shift+=，直接按 Ctrl+= 没反应，所以自己处理（含小键盘）。
  // 只管界面本身；内置浏览器的标签页是另外的 webContents，按键不经过这里
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    if (!(process.platform === "darwin" ? input.meta : input.control)) return;
    const wc = win.webContents;
    const current = wc.getZoomFactor();
    let next: number | undefined;
    if (input.key === "=" || input.key === "+" || input.code === "NumpadAdd") next = ZOOM_STEPS.find((z) => z > current + 0.001);
    else if (input.key === "-" || input.key === "_" || input.code === "NumpadSubtract") next = ZOOM_STEPS.findLast((z) => z < current - 0.001);
    else if (input.key === "0" || input.code === "Numpad0") next = 1;
    else return;
    e.preventDefault();
    if (next !== undefined) wc.setZoomFactor(next);
  });
  void win.loadURL(clientUrl);
  return win;
}

/** 和 Chrome 一样的缩放档位 */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

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
// 远程会话的内置浏览器：localhost 经网关、SSH 指远端（browser/ssh-proxy.ts）
const browserViews = new BrowserViews(() => mainWindow, new SshProxies(gatewayUrl, gatewayToken));
// 内置浏览器标签页的图标（views.ts 的 fetchFavicon 取下来的）：界面的 <img> 用 favicon://icon/<编号> 加载。要在 ready 之前注册
protocol.registerSchemesAsPrivileged([{ scheme: FAVICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const fromUi = (sender: Electron.WebContents) => !!mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents;
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
// 选择元素（见 browser/inspect.ts）：界面开关检查模式，传来取元素的函数；选中的元素、按 Esc 退出推给界面
const inspector = new ElementInspector(browserViews);
inspector.on("picked", (picked) => mainWindow?.webContents.send("browser:picked", picked));
inspector.on("ended", (id) => mainWindow?.webContents.send("browser:inspect-ended", id));
ipcMain.handle("browser:inspect", (e, id: unknown, fn: unknown) => {
  if (!fromUi(e.sender) || typeof id !== "string") return false;
  if (typeof fn !== "string") {
    inspector.stop(id);
    return false;
  }
  return inspector.start(id, fn);
});
// 界面上一块区域的截图（右侧面板 HTML 预览里选中的元素）：rect 是界面的 CSS 像素，按界面的缩放换成窗口坐标；返回 PNG 的 base64
ipcMain.handle("window:capture", async (e, rect: Rectangle) => {
  if (!fromUi(e.sender) || !mainWindow || mainWindow.isDestroyed()) return null;
  const zoom = mainWindow.webContents.getZoomFactor();
  const area = { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) };
  if (area.width < 1 || area.height < 1) return null;
  return pngBase64(await mainWindow.webContents.capturePage(area)) ?? null;
});
// 标签页里的下载（views.ts 的 UiDownload）：开始、进度、结束推给界面，浏览器标签页底部显示下载条；条上的打开、在文件夹中显示、取消
browserViews.on("downloadChanged", (d) => mainWindow?.webContents.send("browser:download", d));
ipcMain.handle("browser:downloads", (e) => (fromUi(e.sender) ? browserViews.uiDownloads() : []));
ipcMain.handle("browser:download-action", async (e, guid: unknown, action: unknown) => {
  if (!fromUi(e.sender) || typeof guid !== "string") return false;
  if (action === "cancel") {
    browserViews.cancelDownload(guid);
    return true;
  }
  const file = browserViews.downloadedPath(guid);
  if (!file || !existsSync(file)) return false;
  if (action === "show") {
    shell.showItemInFolder(file);
    return true;
  }
  return action === "open" && (await shell.openPath(file)) === "";
});
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

// 子代理页的「打开文件夹」：用系统的文件管理器打开这个文件夹本身；不是这台机器上的文件夹时返回 false
ipcMain.handle("shell:open-folder", async (e, target: unknown) => {
  if (!fromUi(e.sender) || typeof target !== "string" || !path.isAbsolute(target) || !existsSync(target)) return false;
  return (await shell.openPath(target)) === "";
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
      // 网关的 .env.local 按工作目录读，所以 cwd 设成 gateway/；输出接到管道上不是终端，LOG_PRETTY 让日志仍然按行格式化
      await ensure(`${gatewayUrl}/health`, () =>
        start("网关", path.join(root, "gateway"), ["--import", "tsx", "src/index.ts"], { LOG_PRETTY: "1" }),
      );
      await ensure(clientUrl, () => start("网页", path.join(root, "client"), ["node_modules/vite/bin/vite.js"]));
      await browserViews.init();
      session.defaultSession.protocol.handle(FAVICON_SCHEME, (request) => browserViews.faviconResponse(request.url));
      mainWindow = createWindow();
      mainWindow.on("close", () => browserViews.freeze());
      mainWindow.on("closed", () => app.quit());
      const ws = new URL("/browser/host", gatewayUrl.replace(/^http/, "ws"));
      if (gatewayToken) ws.searchParams.set("token", gatewayToken);
      bridge = new GatewayBridge(ws.toString(), browserViews, (message) => console.log(message));
      bridge.start();
    } catch (err) {
      dialog.showErrorBox("Claude App 启动失败", (err as Error).message);
      app.quit();
    }
  });
}
