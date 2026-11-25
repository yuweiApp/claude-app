import path from "node:path";
import { BrowserWindow, ipcMain, Menu, screen } from "electron";
import { stopWindowEdges, warmWindowEdges, windowEdges, type Segment } from "./pet-lines.js";

/** 会话一轮结束的通知，网页发来（client/src/pet.ts） */
export interface PetNotice {
  sessionId: string;
  title: string;
}

/** 推给灵宠页面的状态（desktop/assets/pet.html） */
interface PetState {
  /** 正在运行的会话数 */
  working: number;
  /** 主窗口不在前台期间完成的会话，新的在前 */
  notices: PetNotice[];
}

/** 推给灵宠实时回复卡片的单条任务（desktop/assets/pet-peek.html） */
interface PetLiveTask {
  id: string;
  title: string;
  text: string;
  activity: string;
  startedAt: number;
}

const WIDTH = 260;
const HEIGHT = 230;
/** 实时回复卡片窗口大小（内含 12px 阴影留白，卡片本体宽 332px） */
const PEEK_WIDTH = 356;
const PEEK_HEIGHT = 248;
/** 卡片开着期间拉取实时回复的间隔；移出灵宠与卡片后延迟这么久收起，方便鼠标从灵宠滑进卡片 */
const PEEK_POLL_MS = 850;
const PEEK_HIDE_MS = 260;
/** 最多记几条完成的会话 */
const MAX_NOTICES = 5;
/** 主窗口最小化期间叫网页刷新会话列表的间隔：窗口最小化时网页的定时器会被节流，靠外壳发消息唤起 */
const TICK_MS = 4000;
/** 鼠标穿透（setIgnoreMouseEvents 的 forward）Linux 上不支持：开了就点不到灵宠，所以 Linux 上整个窗口都接鼠标 */
const passThrough = process.platform !== "linux";

/**
 * 小精灵两只眼睛在灵宠窗口里的位置（窗口坐标），按 assets/pet.html 的布局算：小精灵 104px 见方，离窗口右边 22px、下边 8px，
 * SVG 的 viewBox 是 120；眼睛中心在 (47, 66)、(73, 66)，半宽 4.6、半高 5.6。改了 pet.html 的布局要跟着改
 */
const PET_SIZE = 104;
const PET_LEFT = WIDTH - 22 - PET_SIZE;
const PET_TOP = HEIGHT - 8 - PET_SIZE;
const UNIT = PET_SIZE / 120;
const EYES = {
  /** 左眼的左边、右边 */
  leftEye: [PET_LEFT + (47 - 4.6) * UNIT, PET_LEFT + (47 + 4.6) * UNIT] as const,
  /** 右眼的左边、右边 */
  rightEye: [PET_LEFT + (73 - 4.6) * UNIT, PET_LEFT + (73 + 4.6) * UNIT] as const,
  top: PET_TOP + (66 - 5.6) * UNIT,
  bottom: PET_TOP + (66 + 5.6) * UNIT,
};
/** 眼睛离屏幕边至少留这么多：浮动动画会往上飘 4px，干活时眼珠左右看 2.5px，留够了贴边时眼睛也不会被切掉一点 */
const EYE_MARGIN = 4;

/**
 * 小精灵轮廓在窗口里的位置（窗口坐标），吸附和限制位置时拿来对齐线和屏幕边，加上了描边的一半 0.75。改了 pet.html 的布局要跟着改：
 * 下边是小爪子底边（爪子椭圆 cy 99、ry 4，侧面的也一样），左边/右边是身体左右沿（身体椭圆 cx 60、rx 37），
 * 中间是身体与两只爪子中线（x 60）：站在线上要这一点落在线段里，吸附左右屏幕边时把这一条中线贴到屏幕边（正好露出一半）
 */
const OUTLINE = {
  bottom: Math.round(PET_TOP + (99 + 4 + 0.75) * UNIT),
  left: Math.round(PET_LEFT + (60 - 37 - 0.75) * UNIT),
  right: Math.round(PET_LEFT + (60 + 37 + 0.75) * UNIT),
  center: Math.round(PET_LEFT + 60 * UNIT),
};

/**
 * 灵宠窗口能放的位置：左右最多拖到身体中线贴住屏幕边（正好露出一半，单侧眼睛完整露着），上边可以拖出一部分但两只眼睛都露着；
 * 下边最低到小爪子底边贴住工作区下沿（不压到任务栏下面）。按眼睛中间那一点最近的屏幕的工作区算，多块屏幕之间照常能拖过去
 */
function clampPosition(x: number, y: number): { x: number; y: number } {
  const cx = x + (EYES.leftEye[0] + EYES.rightEye[1]) / 2;
  const cy = y + (EYES.top + EYES.bottom) / 2;
  const a = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
  const minX = a.x - OUTLINE.center;
  const maxX = a.x + a.width - OUTLINE.center;
  const minY = a.y - EYES.top + EYE_MARGIN;
  const maxY = a.y + a.height - OUTLINE.bottom;
  return { x: Math.round(Math.min(Math.max(x, minX), maxX)), y: Math.round(Math.min(Math.max(y, minY), maxY)) };
}
/** 拖动时轮廓离线、离屏幕边在这么多以内就吸上去，里外都算 */
const SNAP = 12;
/** 贴左右屏幕边松手时，滑到露出一半位置的时长 */
const SIDE_DOCK_MS = 180;
/** 爪子中间离线段两头至少这么多才算站在线上 */
const STAND_MARGIN = 8;
/** 跳舞：最多走出去多远、往哪边能走的不到这么多就换一边、爪子中间离线段两头留多少 */
const DANCE_DISTANCE = 120;
const DANCE_MIN = 30;
const DANCE_MARGIN = 24;
/** 跳舞：走一趟多久、到头翻跟头多久（和 pet.html 里 flip 动画的时长一致） */
const DANCE_WALK_MS = 1200;
const DANCE_FLIP_MS = 700;

/** 眼睛中间那一点最近的屏幕的工作区，和 clampPosition 一致 */
function workAreaAt(p: { x: number; y: number }): Electron.Rectangle {
  const cx = p.x + (EYES.leftEye[0] + EYES.rightEye[1]) / 2;
  const cy = p.y + (EYES.top + EYES.bottom) / 2;
  return screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
}

/** 这块工作区的左（side=-1）或右（side=1）边是不是紧挨着另一块显示器（拼缝处不做吸一半，方便跨屏拖） */
function hasAdjacentDisplay(a: Electron.Rectangle, side: -1 | 1): boolean {
  const edge = side < 0 ? a.x : a.x + a.width;
  return screen.getAllDisplays().some(({ workArea: b }) => {
    if (b.x === a.x && b.y === a.y && b.width === a.width && b.height === a.height) return false;
    if (!(b.y < a.y + a.height && b.y + b.height > a.y)) return false;
    return side < 0 ? Math.abs(b.x + b.width - edge) <= 2 : Math.abs(b.x - edge) <= 2;
  });
}

/** 每块屏幕工作区的下边（任务栏上沿；任务栏自动隐藏时是屏幕下边），也是一条能站的线 */
function workAreaBottoms(): Segment[] {
  return screen.getAllDisplays().map(({ workArea: a }) => ({ y: a.y + a.height, x1: a.x, x2: a.x + a.width }));
}

/**
 * 拖动松手时检查是不是贴在屏幕最左/最右边：身体边缘碰到或越过屏幕边（12px 内）就返回「吸附一半」的目标 x，
 * 让窗口顺滑贴进去露出一半；多屏之间的拼缝不吸附
 */
function sideDockX(p: { x: number; y: number }): number | undefined {
  const a = workAreaAt(p);
  const right = a.x + a.width;
  if (!hasAdjacentDisplay(a, -1) && p.x + OUTLINE.left <= a.x + SNAP) return a.x - OUTLINE.center;
  if (!hasAdjacentDisplay(a, 1) && p.x + OUTLINE.right >= right - SNAP) return right - OUTLINE.center;
  return undefined;
}

/**
 * 拖动时吸附（p 已经 clampPosition 过）：
 * - 左右：中线靠近屏幕外侧左右边够近时，直接吸到正好露出一半（任务栏在左右两侧时是任务栏的边）；
 * - 上下：爪子离某条线够近、爪子中间又在这段线里，就让爪子正好踩在线上。线是别的窗口露出来的上沿（lines）和各块屏幕工作区的下边，
 *   几条都够近时取最近的；踩上去以后眼睛不在能放的范围里（比如线贴着屏幕上边）就不吸。
 * 返回吸附后的位置，和站着的那条线（没站在线上时没有）
 */
function snapPosition(p: { x: number; y: number }, lines: Segment[]): { x: number; y: number; line?: Segment } {
  const a = workAreaAt(p);
  const right = a.x + a.width;
  let { x, y } = p;
  if (!hasAdjacentDisplay(a, -1) && Math.abs(x + OUTLINE.center - a.x) <= SNAP) x = a.x - OUTLINE.center;
  else if (!hasAdjacentDisplay(a, 1) && Math.abs(x + OUTLINE.center - right) <= SNAP) x = right - OUTLINE.center;
  const feetX = x + OUTLINE.center;
  const feetY = y + OUTLINE.bottom;
  let best: Segment | undefined;
  for (const line of [...lines, ...workAreaBottoms()]) {
    if (feetX < line.x1 + STAND_MARGIN || feetX > line.x2 - STAND_MARGIN) continue;
    const d = Math.abs(feetY - line.y);
    if (d > SNAP || (best && d >= Math.abs(feetY - best.y))) continue;
    const ny = Math.round(line.y - OUTLINE.bottom);
    if (clampPosition(x, ny).y !== ny) continue;
    best = line;
  }
  return best ? { x, y: Math.round(best.y - OUTLINE.bottom), line: best } : { x, y };
}

/**
 * 灵宠：设置里开着就一直待在屏幕右下角（主窗口开着、最小化都在），没事时在那儿待着，有会话在跑时它在干活，
 * 主窗口不在前台时会话完成就跳出气泡告诉用户；双击它或点气泡恢复主窗口并打开完成的会话。设置页「灵宠」可以关掉（网页记着开关，见 client/src/pet.ts）。
 * 右键菜单可以先隐藏到回到主窗口为止，或者直接关掉灵宠（外壳告诉网页改开关）。
 *
 * 判断哪个会话完成了在网页里做（会话列表、标题都在那边），这里只管窗口：主窗口不在前台时才收通知，回到主窗口时清空通知
 */
export class Pet {
  private win: BrowserWindow | undefined;
  /** 双击灵宠时展示正在运行任务实时回复的浮窗 */
  private peekWin: BrowserWindow | undefined;
  /** 网页没发来开关之前按默认开着 */
  private enabled = true;
  private working = 0;
  private notices: PetNotice[] = [];
  private liveTasks: PetLiveTask[] = [];
  private peekOverPet = false;
  private peekOverCard = false;
  private peekPoll: NodeJS.Timeout | undefined;
  private peekHideTimer: NodeJS.Timeout | undefined;
  private peekLayout: { arrowX: number; placement: "top" | "bottom" } = { arrowX: 286, placement: "top" };
  /** 右键菜单里选了「隐藏」：回到主窗口之前不再出现 */
  private dismissed = false;
  /** 用户拖过之后的位置，这次运行期间记着 */
  private position: { x: number; y: number } | undefined;
  private tick: NodeJS.Timeout | undefined;
  private main: BrowserWindow | undefined;
  /** 这次拖动开始时取到的别的窗口露出来的上沿（还没取到时是空的，只吸屏幕的边） */
  private lines: Segment[] = [];
  /** 正在拖动，第几次拖动：取窗口上沿是异步的，结果回来时对得上才用 */
  private dragging = false;
  private drags = 0;
  /** 拖动中现在站着的线：松手时站在线上就跳一段舞 */
  private standing: Segment | undefined;
  /** 跳舞的定时器，拖动开始时停掉 */
  private danceTimer: NodeJS.Timeout | undefined;
  /** 跳舞时挪窗口的逐帧定时器 */
  private danceFrame: NodeJS.Timeout | undefined;

  constructor(private readonly assetsDir: string) {
    ipcMain.on("pet:update", (e, state: unknown) => {
      if (!this.fromMain(e.sender) || !state || typeof state !== "object") return;
      const { enabled, working } = state as { enabled?: unknown; working?: unknown };
      if (typeof enabled === "boolean") this.enabled = enabled;
      if (typeof working === "number" && Number.isFinite(working)) this.working = Math.max(0, Math.floor(working));
      if (this.working === 0) this.liveTasks = [];
      if (!this.enabled) this.notices = [];
      this.sync();
    });
    ipcMain.on("pet:live", (e, tasks: unknown) => {
      if (!this.fromMain(e.sender) || !Array.isArray(tasks)) return;
      this.liveTasks = tasks
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as { sessionId?: unknown }).sessionId === "string" && !!(t as { sessionId: string }).sessionId)
        .slice(0, 20)
        .map((t) => ({
          id: t.sessionId as string,
          title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : "新会话",
          text: typeof t.text === "string" ? t.text : "",
          activity: typeof t.activity === "string" && t.activity.trim() ? t.activity.trim() : "正在处理",
          startedAt: typeof t.startedAt === "number" && Number.isFinite(t.startedAt) ? t.startedAt : 0,
        }));
      if (this.peekWin && !this.peekWin.isDestroyed() && this.peekWin.isVisible()) {
        if (!this.liveTasks.length) this.hidePeek();
        else this.peekWin.webContents.send("pet:live", this.livePayload());
      }
    });
    ipcMain.on("pet:notify", (e, notice: unknown) => {
      if (!this.fromMain(e.sender) || !this.enabled || this.dismissed || this.mainFocused()) return;
      const { sessionId, title } = (notice ?? {}) as { sessionId?: unknown; title?: unknown };
      if (typeof sessionId !== "string" || !sessionId) return;
      const item = { sessionId, title: typeof title === "string" && title.trim() ? title.trim() : "新会话" };
      this.notices = [item, ...this.notices.filter((n) => n.sessionId !== sessionId)].slice(0, MAX_NOTICES);
      this.sync();
      this.win?.webContents.send("pet:done", item);
    });
    // 灵宠页面上的操作
    // 卡片只在双击时弹出（pet:activate），悬停不弹；开着时鼠标移出灵宠和卡片就收起
    ipcMain.on("pet:peek-hover", (e, source: unknown, over: unknown) => {
      if (source === "pet" && this.fromPet(e.sender)) this.peekOverPet = !!over;
      else if (source === "card" && this.fromPeek(e.sender)) this.peekOverCard = !!over;
      else return;
      if (!this.peekWin || this.peekWin.isDestroyed() || !this.peekWin.isVisible()) return;
      if (this.peekOverPet || this.peekOverCard) {
        clearTimeout(this.peekHideTimer);
        this.peekHideTimer = undefined;
      } else {
        this.scheduleHidePeek();
      }
    });
    // 双击灵宠：有会话在跑（没有待看的完成通知）时弹出实时回复卡片，卡片开着时收起；否则同以前，回到主窗口打开那个会话
    ipcMain.on("pet:activate", (e, sessionId: unknown) => {
      if (!this.fromPet(e.sender)) return;
      if (this.peekWin && !this.peekWin.isDestroyed() && this.peekWin.isVisible()) return this.hidePeek();
      if (this.canPeek()) {
        // 双击时鼠标就在灵宠上（hidePeek 清掉过这个标记，鼠标没离开过就不会再收到 pointerenter）
        this.peekOverPet = true;
        return this.showPeek();
      }
      this.openMain(typeof sessionId === "string" ? sessionId : this.notices[0]?.sessionId);
    });
    ipcMain.on("pet:open", (e, sessionId: unknown) => {
      if (!this.fromPet(e.sender) && !this.fromPeek(e.sender)) return;
      this.hidePeek();
      this.openMain(typeof sessionId === "string" ? sessionId : this.notices[0]?.sessionId);
    });
    ipcMain.on("pet:dismiss", (e) => {
      if (!this.fromPet(e.sender)) return;
      this.notices = [];
      this.sync();
    });
    // 拖动开始、结束：开始时停下正在跳的舞，取一次别的窗口的上沿；松手时贴左右边就顺滑吸进去露一半，否则站在线上就跳一段舞
    ipcMain.on("pet:drag", (e, active: unknown) => {
      if (!this.fromPet(e.sender) || !this.win) return;
      if (active === true) {
        this.stopDance();
        this.hidePeek();
        this.lines = [];
        this.standing = undefined;
        const drag = ++this.drags;
        void windowEdges(this.win.getBounds()).then((lines) => {
          // 取得慢、这次拖动已经结束或者又开始了新的一次时不用
          if (drag === this.drags && this.dragging) this.lines = lines;
        });
        this.dragging = true;
      } else if (active === false) {
        this.dragging = false;
        const line = this.standing;
        this.lines = [];
        this.standing = undefined;
        const cur = this.position ?? this.win.getBounds();
        const dockX = sideDockX(cur);
        if (dockX !== undefined) {
          if (dockX !== cur.x) this.slide(cur.x, dockX, cur.y, SIDE_DOCK_MS);
        } else if (line) {
          this.dance(line);
        }
      }
    });
    // 拖动：页面按鼠标位置算出窗口该在的位置（屏幕坐标），这里限制在眼睛还露着的范围里，靠近线、左右屏幕边时吸上去
    ipcMain.on("pet:move", (e, x: unknown, y: unknown) => {
      if (!this.fromPet(e.sender) || !this.win || typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const c = clampPosition(x, y);
      const { line, ...p } = snapPosition(c, this.lines);
      this.standing = line;
      this.position = p;
      this.win.setPosition(p.x, p.y);
    });
    // 窗口透明的地方要让鼠标穿过去，不挡住下面的东西；鼠标移到小精灵、气泡上时页面告诉这里接住鼠标
    ipcMain.on("pet:hover", (e, over: unknown) => {
      if (!this.fromPet(e.sender) || !this.win || !passThrough) return;
      this.win.setIgnoreMouseEvents(!over, { forward: true });
    });
    ipcMain.on("pet:menu", (e) => {
      if (!this.fromPet(e.sender) || !this.win) return;
      const win = this.win;
      // 灵宠窗口平时不接焦点（不抢主窗口的焦点），但菜单所在的窗口没有焦点时，点别处菜单不会收起：弹菜单期间临时让它接焦点
      win.setFocusable(true);
      win.focus();
      this.menu().popup({
        window: win,
        callback: () => {
          if (win.isDestroyed()) return;
          win.setFocusable(false);
          win.blur();
        },
      });
    });
    ipcMain.handle("pet:state", (e) => (this.fromPet(e.sender) ? this.state() : null));
    ipcMain.handle("pet:live-state", (e) => (this.fromPeek(e.sender) ? this.livePayload() : null));
  }

  /** 主窗口建好后接上：显示灵宠；最小化期间叫网页刷新，回到主窗口时清空通知 */
  attach(main: BrowserWindow): void {
    this.main = main;
    main.on("minimize", () => this.sync());
    main.on("hide", () => this.sync());
    const back = () => {
      if (!this.mainFocused()) return;
      this.notices = [];
      this.dismissed = false;
      this.sync();
    };
    main.on("restore", back);
    main.on("show", back);
    main.on("focus", back);
    // 屏幕缩放、分辨率变了（比如远程桌面连上、断开时），或者接上、拔掉显示器：窗口大小、位置按现在的屏幕重新放。
    // Windows 上缩放变了以后透明窗口会停在原来的物理大小，换算成新的缩放就大了或小了，小精灵会跑到屏幕外面去
    const replace = () => {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.place(this.win);
      if (this.peekWin && !this.peekWin.isDestroyed() && this.peekWin.isVisible()) this.placePeek(this.peekWin);
    };
    screen.on("display-metrics-changed", replace);
    screen.on("display-added", replace);
    screen.on("display-removed", replace);
    main.on("closed", () => {
      screen.off("display-metrics-changed", replace);
      screen.off("display-added", replace);
      screen.off("display-removed", replace);
      this.main = undefined;
      this.stopTick();
      this.stopDance();
      this.hidePeek();
      stopWindowEdges();
      if (this.peekWin && !this.peekWin.isDestroyed()) this.peekWin.destroy();
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
    });
  }

  private fromMain(sender: Electron.WebContents): boolean {
    return !!this.main && !this.main.isDestroyed() && sender === this.main.webContents;
  }

  private fromPet(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents;
  }

  private fromPeek(sender: Electron.WebContents): boolean {
    return !!this.peekWin && !this.peekWin.isDestroyed() && sender === this.peekWin.webContents;
  }

  private canPeek(): boolean {
    return this.enabled && !this.dismissed && this.working > 0 && this.notices.length === 0 && !this.dragging && !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  private livePayload(): { tasks: PetLiveTask[]; arrowX: number; placement: "top" | "bottom" } {
    return { tasks: this.liveTasks, ...this.peekLayout };
  }

  private mainHidden(): boolean {
    const main = this.main;
    return !!main && !main.isDestroyed() && (main.isMinimized() || !main.isVisible());
  }

  /** 用户正在主窗口里：这时完成的会话不用灵宠提醒 */
  private mainFocused(): boolean {
    const main = this.main;
    return !!main && !main.isDestroyed() && !this.mainHidden() && main.isFocused();
  }

  private state(): PetState {
    return { working: this.working, notices: this.notices };
  }

  private sync(): void {
    const shown = this.enabled && !this.dismissed && !!this.main && !this.main.isDestroyed();
    if (shown && this.mainHidden()) this.startTick();
    else this.stopTick();
    if (!shown) {
      this.stopDance();
      this.hidePeek();
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
    if (!this.canPeek()) this.hidePeek();
  }

  private ensurePeekWindow(): BrowserWindow {
    if (this.peekWin && !this.peekWin.isDestroyed()) return this.peekWin;
    const w = new BrowserWindow({
      width: PEEK_WIDTH,
      height: PEEK_HEIGHT,
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
      title: "灵宠实时回复",
      webPreferences: { preload: path.join(import.meta.dirname, "pet-preload.cjs") },
    });
    w.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void w.loadFile(path.join(this.assetsDir, "pet-peek.html"));
    this.peekWin = w;
    return w;
  }

  /** 根据灵宠当前位置把实时回复卡片放在上方（顶边不够时翻到下方），左右限制在屏幕工作区内（贴边露一半时卡片也不出屏） */
  private placePeek(w: BrowserWindow): void {
    if (!this.win || this.win.isDestroyed()) return;
    const pb = this.win.getBounds();
    const a = workAreaAt(pb);
    const petCenterX = pb.x + OUTLINE.center;
    const petTopY = pb.y + PET_TOP;
    const petBottomY = pb.y + OUTLINE.bottom;
    const x = Math.round(Math.min(Math.max(petCenterX - PEEK_WIDTH + 54, a.x + 8), a.x + a.width - PEEK_WIDTH - 8));
    let placement: "top" | "bottom" = "top";
    let y = Math.round(petTopY - PEEK_HEIGHT + 16);
    if (y < a.y + 4) {
      placement = "bottom";
      y = Math.round(Math.min(petBottomY - 6, a.y + a.height - PEEK_HEIGHT - 4));
    }
    const arrowX = Math.round(Math.min(Math.max(petCenterX - (x + 12), 24), 332 - 24));
    this.peekLayout = { arrowX, placement };
    w.setBounds({ x, y, width: PEEK_WIDTH, height: PEEK_HEIGHT });
  }

  private requestPeekData(): void {
    if (this.main && !this.main.isDestroyed()) this.main.webContents.send("pet:peek");
  }

  private showPeek(): void {
    if (!this.canPeek()) return;
    clearTimeout(this.peekHideTimer);
    this.peekHideTimer = undefined;
    const w = this.ensurePeekWindow();
    this.placePeek(w);
    w.webContents.send("pet:live", this.livePayload());
    if (!w.isVisible()) {
      w.showInactive();
      if (this.win && !this.win.isDestroyed()) {
        // 卡片窗口下沿的留白和箭头压在小精灵上沿（点击区是整个方框，耳朵上面那一条是透明的）。卡片窗口在上面时，
        // 灵宠窗口穿透期间照样收到转发的鼠标移动，判断在小精灵上就改成接鼠标，可鼠标落在上面的卡片窗口里，
        // 页面马上收到离开、又改回穿透，光标在抓手和箭头之间来回闪。灵宠窗口放到最上面，重叠的地方由它按自己的点击区决定
        this.win.moveTop();
        this.win.webContents.send("pet:peeking", true);
      }
    }
    if (!this.peekPoll) {
      this.requestPeekData();
      this.peekPoll = setInterval(() => {
        if (!this.canPeek() || (!this.peekOverPet && !this.peekOverCard)) return this.hidePeek();
        this.requestPeekData();
      }, PEEK_POLL_MS);
    }
  }

  private hidePeek(): void {
    clearTimeout(this.peekHideTimer);
    this.peekHideTimer = undefined;
    if (this.peekPoll) clearInterval(this.peekPoll);
    this.peekPoll = undefined;
    this.peekOverPet = false;
    this.peekOverCard = false;
    if (this.peekWin && !this.peekWin.isDestroyed() && this.peekWin.isVisible()) this.peekWin.hide();
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("pet:peeking", false);
  }

  private scheduleHidePeek(): void {
    clearTimeout(this.peekHideTimer);
    this.peekHideTimer = setTimeout(() => {
      this.peekHideTimer = undefined;
      if (!this.peekOverPet && !this.peekOverCard) this.hidePeek();
    }, PEEK_HIDE_MS);
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
    warmWindowEdges();
    return win;
  }

  /**
   * 放到主窗口所在屏幕的右下角（拖过就放回拖到的位置，限制在眼睛还露着的范围里）。
   * 大小也一起设回去：缩放变过之后窗口可能不是 WIDTH × HEIGHT 了
   */
  private place(win: BrowserWindow): void {
    const display = this.main && !this.main.isDestroyed() ? screen.getDisplayMatching(this.main.getBounds()) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const { x, y } = this.position ? clampPosition(this.position.x, this.position.y) : { x: area.x + area.width - WIDTH - 12, y: area.y + area.height - HEIGHT };
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height: HEIGHT });
  }

  /**
   * 跳一段舞：转成侧面，往屏幕中间那边（在屏幕右半边就往左，左半边往右）蹦着走出去一段，到头翻个跟头，转身蹦回原来的位置，再转回正面。
   * 传了 line 时按那条线限制范围（拖到线上松手），没传时按当前屏幕工作区范围（右键菜单手动触发）。
   * 那边地方不够就往另一边，两边都不够就不跳。窗口由这里一帧帧挪，页面只管换姿势和动画
   */
  private dance(line?: Segment): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const home = win.getBounds();
    const a = workAreaAt(home);
    const feet = home.x + OUTLINE.center;
    const x1 = line ? line.x1 : a.x;
    const x2 = line ? line.x2 : a.x + a.width;
    // 往一边最多能走多远：爪子中间离线段两头留点地方，窗口也不出能放的范围
    const room = (dir: -1 | 1) => {
      const toLine = dir < 0 ? feet - (x1 + DANCE_MARGIN) : x2 - DANCE_MARGIN - feet;
      const tx = home.x + dir * Math.max(0, Math.min(DANCE_DISTANCE, toLine));
      return Math.abs(clampPosition(tx, home.y).x - home.x);
    };
    const first: -1 | 1 = feet > a.x + a.width / 2 ? -1 : 1;
    const dir = room(first) >= DANCE_MIN ? first : room(first === -1 ? 1 : -1) >= DANCE_MIN ? (first === -1 ? 1 : -1) : 0;
    if (!dir) return;
    const far = home.x + dir * room(dir);
    const pose = (facing: "left" | "right" | null, motion: "walk" | "flip" | "stand") => {
      if (!win.isDestroyed()) win.webContents.send("pet:pose", { facing, motion });
    };
    const facing = (d: number) => (d < 0 ? "left" : "right");
    const steps: (() => number)[] = [
      () => (pose(facing(dir), "walk"), this.slide(home.x, far, home.y, DANCE_WALK_MS), DANCE_WALK_MS),
      () => (pose(facing(dir), "flip"), DANCE_FLIP_MS),
      () => (pose(facing(-dir), "walk"), this.slide(far, home.x, home.y, DANCE_WALK_MS), DANCE_WALK_MS),
      () => (pose(null, "stand"), 0),
    ];
    this.stopDance();
    const next = (i: number) => {
      if (win.isDestroyed()) return void (this.danceTimer = undefined);
      const step = steps[i];
      if (!step) return void (this.danceTimer = undefined);
      this.danceTimer = setTimeout(() => next(i + 1), step());
    };
    next(0);
  }

  /** 跳舞时把窗口从 x1 平移到 x2（先慢后快再慢），每一帧一次 */
  private slide(x1: number, x2: number, y: number, ms: number): void {
    const win = this.win;
    if (!win) return;
    const start = Date.now();
    const frame = setInterval(() => {
      if (win.isDestroyed() || this.danceFrame !== frame) return clearInterval(frame);
      const t = Math.min(1, (Date.now() - start) / ms);
      const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.position = { x: Math.round(x1 + (x2 - x1) * k), y };
      win.setPosition(this.position.x, y);
      if (t >= 1) {
        clearInterval(frame);
        this.danceFrame = undefined;
      }
    }, 16);
    this.danceFrame = frame;
  }

  /** 停下正在跳的舞，转回正面（停在当时走到的地方） */
  private stopDance(): void {
    if (!this.danceTimer && !this.danceFrame) return;
    clearTimeout(this.danceTimer);
    clearInterval(this.danceFrame);
    this.danceTimer = this.danceFrame = undefined;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("pet:pose", { facing: null, motion: "stand" });
  }

  private menu(): Menu {
    const latest = this.notices[0];
    return Menu.buildFromTemplate([
      { label: latest ? `打开「${latest.title.length > 20 ? `${latest.title.slice(0, 20)}…` : latest.title}」` : "回到 Claude App", click: () => this.openMain(latest?.sessionId) },
      { label: "知道了", enabled: this.notices.length > 0, click: () => ((this.notices = []), this.sync()) },
      { type: "separator" },
      { label: "跳一段舞", click: () => this.dance() },
      { type: "separator" },
      {
        label: "隐藏",
        click: () => {
          this.dismissed = true;
          this.notices = [];
          this.sync();
        },
      },
      {
        label: "关闭灵宠",
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
