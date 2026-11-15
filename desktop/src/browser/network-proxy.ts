import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, session, type Session } from "electron";

/**
 * 设置页「网络代理」在内置浏览器这边的部分（见 docs/proxy.md）。设置存在网关，外壳连上网关时和每次保存后由网关推过来
 * （bridge.ts 的 proxy 消息，gateway/src/net/proxy.ts 的 browserProxyConfig），带着密码。
 * - 本机会话的分区：按设置 setProxy（跟随系统是 Electron 自己读操作系统的代理设置）
 * - 代理要认证：app 的 login 事件里用设置里的用户名、密码回答
 * - 远程会话的分区：代理固定是 ssh-proxy.ts 的本地代理，它连 localhost 以外的地址时问这里怎么走（route）
 * 上次的设置（不含密码）存在 userData 的 browser-proxy.json，启动时先按它设好，免得连上网关前开的页面走错路。
 * 另外替网关查操作系统的代理（reportSystem）：Node 和 Claude Code 不读系统代理设置，网关跟随系统时用这里报的
 */
export type ProxyMode = "system" | "off" | "manual";

export interface ProxyConfig {
  mode: ProxyMode;
  /** 手动模式的代理，http://、https://、socks5://host:port，不含用户名、密码 */
  url?: string;
  username?: string;
  password?: string;
  /** 用户填的不走代理的地址（域名包括子域名，同网关、curl 的 NO_PROXY）；本机地址 Chromium 本来就不走代理 */
  bypass: string[];
}

/** 一条到目标的路线：直连，或者经哪个代理 */
export type Route = { kind: "direct" } | { kind: "http" | "https" | "socks5"; host: string; port: number; auth?: { username: string; password: string } };

/** 外壳刚启动、网关还没推密码过来时，代理认证最多等多久 */
const CREDENTIALS_WAIT_MS = 15_000;
/** 多久查一次操作系统的代理（用户在系统设置里改了代理，网关最晚这么久后知道） */
const SYSTEM_CHECK_MS = 30_000;

export class NetworkProxy {
  private config: ProxyConfig;
  /** 网关推过设置了（有密码的话密码也到了） */
  private fromGateway = false;
  private readonly sessions = new Set<Session>();
  private readonly file = path.join(app.getPath("userData"), "browser-proxy.json");
  /** 网关推设置之前来的代理认证 */
  private waiting: (() => void)[] = [];
  /** 设置变了时调用（ssh-proxy.ts 丢掉按旧设置建的连接） */
  private readonly changeListeners = new Set<() => void>();
  /** 网关要按哪个地址查系统代理（模型接口），网关推设置时带来 */
  private probeUrl: string | undefined;
  /** 正在给网关报系统代理（连着网关时）：发送函数和上次报的结果 */
  private reporter: { send: (route: string) => void; last?: string; timer: NodeJS.Timeout } | null = null;

  constructor() {
    this.config = this.load();
    app.on("login", (event, _wc, details, authInfo, callback) => {
      if (!authInfo.isProxy || !this.isOurProxy(authInfo.host, authInfo.port)) return;
      event.preventDefault();
      // 不是第一次问：刚给的用户名、密码代理不认，再给同样的只会一直重试，取消掉（页面显示代理认证失败）
      if (!details.firstAuthAttempt) return callback();
      const answer = () => {
        const { username, password } = this.config;
        if (username && this.isOurProxy(authInfo.host, authInfo.port)) callback(username, password ?? "");
        else callback();
      };
      if (this.fromGateway) return answer();
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((fn) => fn !== done);
        answer();
      }, CREDENTIALS_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        answer();
      };
      this.waiting.push(done);
    });
  }

  /** 本机会话的分区：按现在的设置设好代理，之后设置改了跟着换 */
  async attach(ses: Session): Promise<void> {
    this.sessions.add(ses);
    await this.applyTo(ses);
  }

  /** 网关推来的设置 */
  async update(raw: unknown): Promise<void> {
    const config = parse(raw);
    if (!config) return;
    const probeUrl = (raw as { probeUrl?: unknown }).probeUrl;
    if (typeof probeUrl === "string" && probeUrl !== this.probeUrl) {
      this.probeUrl = probeUrl;
      if (this.reporter) this.reporter.last = undefined;
    }
    void this.checkSystem();
    const changed = JSON.stringify(strip(config)) !== JSON.stringify(strip(this.config));
    this.config = config;
    this.fromGateway = true;
    for (const fn of this.waiting.splice(0)) fn();
    if (!changed) return;
    this.save();
    await Promise.all([...this.sessions].map((ses) => this.applyTo(ses)));
    for (const fn of this.changeListeners) fn();
  }

  onChange(fn: () => void): void {
    this.changeListeners.add(fn);
  }

  /**
   * 连上网关后开始报操作系统的代理：Chromium 按系统设置（PAC、自动检测都算）对模型接口的地址算出的路线，
   * 网关推设置过来（带着要查的地址）时、之后每 30 秒查一次，变了才报。断开时 stopReporting
   */
  startReporting(send: (route: string) => void): void {
    this.stopReporting();
    this.reporter = { send, timer: setInterval(() => void this.checkSystem(), SYSTEM_CHECK_MS) };
  }

  stopReporting(): void {
    if (this.reporter) clearInterval(this.reporter.timer);
    this.reporter = null;
  }

  private async checkSystem(): Promise<void> {
    const reporter = this.reporter;
    if (!reporter || !this.probeUrl) return;
    let route: string;
    try {
      // 单独一个不落盘的分区，代理固定跟随系统，不受内置浏览器的设置影响；每次重读系统设置
      const probe = session.fromPartition("claude-proxy-probe");
      await probe.setProxy({ mode: "system" });
      await probe.forceReloadProxyConfig();
      route = await probe.resolveProxy(this.probeUrl);
    } catch {
      return;
    }
    if (this.reporter !== reporter || route === reporter.last) return;
    reporter.last = route;
    reporter.send(route);
  }

  /**
   * 连 url 走哪条路（ssh-proxy.ts 用）：问本机会话的分区，Chromium 按代理设置、不走代理的规则、PAC 算出来，
   * 结果是 PAC 的格式（「PROXY a:1; DIRECT」），一条条试
   */
  async routes(url: string): Promise<Route[]> {
    const ses = [...this.sessions][0];
    if (!ses) return [{ kind: "direct" }];
    const out: Route[] = [];
    for (const entry of (await ses.resolveProxy(url)).split(";").map((s) => s.trim()).filter(Boolean)) {
      const [kind, addr] = entry.split(/\s+/) as [string, string | undefined];
      if (kind === "DIRECT") {
        out.push({ kind: "direct" });
        continue;
      }
      const type = kind === "PROXY" ? "http" : kind === "HTTPS" ? "https" : kind === "SOCKS5" || kind === "SOCKS" ? "socks5" : null;
      const hp = addr ? splitHostPort(addr, type === "http" ? 80 : type === "https" ? 443 : 1080) : null;
      if (!type || !hp) continue;
      const auth = this.isOurProxy(hp.host, hp.port) && this.config.username ? { username: this.config.username, password: this.config.password ?? "" } : undefined;
      out.push({ kind: type, ...hp, ...(auth ? { auth } : {}) });
    }
    return out.length ? out : [{ kind: "direct" }];
  }

  private async applyTo(ses: Session): Promise<void> {
    const c = this.config;
    if (c.mode === "manual" && c.url) {
      const u = new URL(c.url);
      // SOCKS5 不支持认证；要认证的网关会换成它在本机开的转接（HTTP 代理）再推过来
      const server = u.protocol === "https:" ? `https://${u.host}` : u.protocol === "socks5:" ? `socks5://${u.host}` : u.host;
      await ses.setProxy({ mode: "fixed_servers", proxyRules: server, proxyBypassRules: bypassRules(c.bypass) });
    } else {
      await ses.setProxy({ mode: c.mode === "off" ? "direct" : "system" });
    }
    // 已经建立的连接（keep-alive、HTTP/2）也换过来；记住的代理认证清掉，换了用户名、密码的马上用新的
    await ses.closeAllConnections();
    await ses.clearAuthCache();
  }

  /** 手动模式的代理服务器是不是 host:port（认证只回答它的） */
  private isOurProxy(host: string, port: number): boolean {
    if (this.config.mode !== "manual" || !this.config.url) return false;
    const u = new URL(this.config.url);
    const ourPort = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    return u.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase() === host.replace(/^\[(.*)\]$/, "$1").toLowerCase() && ourPort === port;
  }

  private load(): ProxyConfig {
    try {
      if (existsSync(this.file)) return parse(JSON.parse(readFileSync(this.file, "utf8"))) ?? { mode: "system", bypass: [] };
    } catch {
      // 读不了按默认
    }
    return { mode: "system", bypass: [] };
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(strip(this.config), null, 2));
    } catch {
      // 存不了只是下次启动先按默认
    }
  }
}

/** 存盘、比较用：去掉密码 */
function strip(c: ProxyConfig): ProxyConfig {
  const { password: _password, ...rest } = c;
  return rest;
}

function parse(raw: unknown): ProxyConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "manual" || r.mode === "off" || r.mode === "system" ? r.mode : null;
  if (!mode) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const url = str(r.url);
  if (mode === "manual" && !url) return { mode: "off", bypass: [] };
  return {
    mode,
    ...(url ? { url } : {}),
    ...(str(r.username) ? { username: str(r.username), password: typeof r.password === "string" ? r.password : undefined } : {}),
    bypass: Array.isArray(r.bypass) ? r.bypass.filter((v): v is string => typeof v === "string" && !!v) : [],
  };
}

/**
 * 不走代理的地址换成 Chromium 的规则：域名同 NO_PROXY 的意思，也包括子域名（Chromium 的 example.com 只管它自己，要再加 *.example.com）；
 * IP 原样。本机地址 Chromium 本来就不走代理，不用写
 */
function bypassRules(list: string[]): string {
  const rules: string[] = [];
  for (const raw of list) {
    const base = raw.trim().replace(/^\*?\./, "");
    if (!base) continue;
    const host = base.replace(/:\d+$/, "");
    rules.push(base);
    if (!/^[\d.]+$/.test(host) && !host.includes(":") && !host.startsWith("[")) rules.push(`*.${base}`);
  }
  return rules.join(",");
}

export function splitHostPort(s: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port > 0 && port < 65536 ? { host: m[1]!.replace(/^\[(.*)\]$/, "$1"), port } : null;
}
