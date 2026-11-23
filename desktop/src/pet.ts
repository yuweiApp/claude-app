import path from "node:path";
import { BrowserWindow, ipcMain, Menu, screen } from "electron";

/** 会话一轮结束的通知，网页发来（client/src/pet.ts） */
export interface PetNotice {
  sessionId: string;
  title: string;
}

/** 推给灵宠页面的状态（desktop/assets/pet.html） */
interface PetState {
  /** 正在运行的会话数 */
  working: number;
  /** 最小化期间完成的会话，新的在前 */
  notices: PetNotice[];
}

const WIDTH = 260;
const HEIGHT = 230;
/** 最多记几条完成的会话 */
const MAX_NOTICES = 5;
/** 最小化期间叫网页刷新会话列表的间隔：窗口最小化时网页的定时器会被节流，靠外壳发消息唤起 */
const TICK_MS = 4000;
/** 鼠标穿透（setIgnoreMouseEvents 的 forward）Linux 上不支持：开了就点不到灵宠，所以 Linux 上整个窗口都接鼠标 */
const passThrough = process.platform !== "linux";

/**
 * 灵宠：主窗口最小化（或隐藏）时，屏幕右下角出现一个小精灵，有会话在跑时它在干活，会话完成时跳出气泡告诉用户；
 * 点它恢复主窗口并打开完成的会话。设置页「灵宠」可以关掉（网页记着开关，见 client/src/pet.ts）。
 * 右键菜单可以先隐藏到回到主窗口为止，或者直接关掉灵宠（外壳告诉网页改开关）。
 *
 * 判断哪个会话完成了在网页里做（会话列表、标题都在那边），这里只管窗口：主窗口最小化期间才显示、才收通知，恢复时收起并清空通知
 */
export class Pet {
  private win: BrowserWindow | undefined;
  /** 网页没发来开关之前按默认开着 */
  private enabled = true;
  private working = 0;
  private notices: PetNotice[] = [];
  /** 右键菜单里选了「隐藏」：回到主窗口之前不再出现 */
  private dismissed = false;
  /** 用户拖过之后的位置，这次运行期间记着 */
  private position: { x: number; y: number } | undefined;
  private tick: NodeJS.Timeout | undefined;
  private main: BrowserWindow | undefined;

  constructor(private readonly assetsDir: string) {
    ipcMain.on("pet:update", (e, state: unknown) => {
      if (!this.fromMain(e.sender) || !state || typeof state !== "object") return;
      const { enabled, working } = state as { enabled?: unknown; working?: unknown };
      if (typeof enabled === "boolean") this.enabled = enabled;
      if (typeof working === "number" && Number.isFinite(working)) this.working = Math.max(0, Math.floor(working));
      if (!this.enabled) this.notices = [];
      this.sync();
    });
    ipcMain.on("pet:notify", (e, notice: unknown) => {
      if (!this.fromMain(e.sender) || !this.enabled || this.dismissed || !this.mainHidden()) return;
      const { sessionId, title } = (notice ?? {}) as { sessionId?: unknown; title?: unknown };
      if (typeof sessionId !== "string" || !sessionId) return;
      const item = { sessionId, title: typeof title === "string" && title.trim() ? title.trim() : "新会话" };
      this.notices = [item, ...this.notices.filter((n) => n.sessionId !== sessionId)].slice(0, MAX_NOTICES);
      this.sync();
      this.win?.webContents.send("pet:done", item);
    });
    // 灵宠页面上的操作
    ipcMain.on("pet:open", (e, sessionId: unknown) => {
      if (!this.fromPet(e.sender)) return;
      this.openMain(typeof sessionId === "string" ? sessionId : this.notices[0]?.sessionId);
    });
    ipcMain.on("pet:dismiss", (e) => {
      if (!this.fromPet(e.sender)) return;
      this.notices = [];
      this.sync();
    });
    ipcMain.on("pet:move", (e, dx: unknown, dy: unknown) => {
      if (!this.fromPet(e.sender) || !this.win || typeof dx !== "number" || typeof dy !== "number") return;
      const [x = 0, y = 0] = this.win.getPosition();
      this.position = { x: Math.round(x + dx), y: Math.round(y + dy) };
      this.win.setPosition(this.position.x, this.position.y);
    });
    // 窗口透明的地方要让鼠标穿过去，不挡住下面的东西；鼠标移到小精灵、气泡上时页面告诉这里接住鼠标
    ipcMain.on("pet:hover", (e, over: unknown) => {
      if (!this.fromPet(e.sender) || !this.win || !passThrough) return;
      this.win.setIgnoreMouseEvents(!over, { forward: true });
    });
    ipcMain.on("pet:menu", (e) => {
      if (!this.fromPet(e.sender) || !this.win) return;
      this.menu().popup({ window: this.win });
    });
    ipcMain.handle("pet:state", (e) => (this.fromPet(e.sender) ? this.state() : null));
  }

  /** 主窗口建好后接上：最小化、恢复时显示或收起灵宠 */
  attach(main: BrowserWindow): void {
    this.main = main;
    main.on("minimize", () => this.sync());
    main.on("hide", () => this.sync());
    const back = () => {
      if (this.mainHidden()) return;
      this.notices = [];
      this.dismissed = false;
      this.sync();
    };
    main.on("restore", back);
    main.on("show", back);
    main.on("focus", back);
    main.on("closed", () => {
      this.main = undefined;
      this.stopTick();
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
    });
  }

  private fromMain(sender: Electron.WebContents): boolean {
    return !!this.main && !this.main.isDestroyed() && sender === this.main.webContents;
  }

  private fromPet(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents;
  }

  private mainHidden(): boolean {
    const main = this.main;
    return !!main && !main.isDestroyed() && (main.isMinimized() || !main.isVisible());
  }

  private state(): PetState {
    return { working: this.working, notices: this.notices };
  }

  private sync(): void {
    const hidden = this.enabled && !this.dismissed && this.mainHidden();
    if (hidden) this.startTick();
    else this.stopTick();
    const visible = hidden && (this.working > 0 || this.notices.length > 0);
    if (!visible) {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
      return;
    }
    const win = this.ensureWindow();
    win.webContents.send("pet:state", this.state());
    if (!win.isVisible()) {
      this.place(win);
      // 不抢焦点
      win.showInactive();
    }
  }

  private startTick(): void {
    this.tick ??= setInterval(() => {
      if (this.main && !this.main.isDestroyed()) this.main.webContents.send("pet:tick");
    }, TICK_MS);
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      title: "灵宠",
      webPreferences: { preload: path.join(import.meta.dirname, "pet-preload.cjs") },
    });
    win.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (passThrough) win.setIgnoreMouseEvents(true, { forward: true });
    void win.loadFile(path.join(this.assetsDir, "pet.html"));
    this.win = win;
    return win;
  }

  /** 放到主窗口所在屏幕的右下角（拖过就放回拖到的位置，屏幕变了放不下时回到右下角） */
  private place(win: BrowserWindow): void {
    const display = this.main && !this.main.isDestroyed() ? screen.getDisplayMatching(this.main.getBounds()) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const saved = this.position;
    const fits = saved && screen.getAllDisplays().some(({ workArea: a }) => saved.x >= a.x - WIDTH / 2 && saved.x <= a.x + a.width - WIDTH / 2 && saved.y >= a.y - HEIGHT / 2 && saved.y <= a.y + a.height - HEIGHT / 2);
    const { x, y } = fits ? saved : { x: area.x + area.width - WIDTH - 12, y: area.y + area.height - HEIGHT };
    win.setPosition(Math.round(x), Math.round(y));
  }

  private menu(): Menu {
    const latest = this.notices[0];
    return Menu.buildFromTemplate([
      { label: latest ? `打开「${latest.title.length > 20 ? `${latest.title.slice(0, 20)}…` : latest.title}」` : "回到 Claude App", click: () => this.openMain(latest?.sessionId) },
      { label: "知道了", enabled: this.notices.length > 0, click: () => ((this.notices = []), this.sync()) },
      { type: "separator" },
      {
        label: "隐藏，回到窗口前不再出现",
        click: () => {
          this.dismissed = true;
          this.notices = [];
          this.sync();
        },
      },
      {
        label: "关闭灵宠（可在设置里重新打开）",
        click: () => {
          this.enabled = false;
          this.notices = [];
          this.sync();
          // 开关记在网页里，让网页改掉
          if (this.main && !this.main.isDestroyed()) this.main.webContents.send("pet:disabled");
        },
      },
    ]);
  }

  /** 恢复主窗口，让网页打开这个会话 */
  private openMain(sessionId: string | undefined): void {
    const main = this.main;
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    if (sessionId) main.webContents.send("pet:open", sessionId);
  }
}
