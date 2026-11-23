import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Agent } from "undici";
import { config } from "../config.js";
import type { ProxyCoreStatus, ProxyNodes } from "../shared/types.js";
import { HttpError } from "../errors.js";

/**
 * 设置页「网络代理」订阅模式的代理内核 mihomo（见 docs/proxy-subscription.md）：网关拉起它当客户端，
 * 订阅里的节点（VLESS、VMess、Trojan 等）变成 127.0.0.1 上一个要认证的 HTTP/SOCKS5 代理端口（proxyUrl），
 * 网关自己的请求、子进程、内置浏览器都指向这个端口（net/proxy.ts）。
 * 两个端口在网关启动时选好、整个网关进程内不变：内核重启、换订阅都不用换子进程的环境变量。
 * 工作目录 claude-home/proxy-core（700：内核自己建的文件是 664，订阅缓存里有节点的密钥，只能靠目录挡住）
 */

/** 代理端口的用户名（密码是 token） */
const USER = "claude-app";
/** 代理组：select 是用户选的（「自动」或某个节点），auto 是自动选延迟最低的 */
const SELECT_GROUP = "节点";
const AUTO_GROUP = "自动";
const PROVIDER = "sub";
const TEST_URL = "https://www.gstatic.com/generate_204";
/** 内核拉起后最多等多久控制接口通 */
const START_TIMEOUT_MS = 15_000;
/** 挂了以后重启的间隔：1、2、4…秒，最长 60 秒；稳定跑满 60 秒后从头算 */
const MAX_BACKOFF_MS = 60_000;
const STABLE_MS = 60_000;
/** 内核在跑、但订阅里没取到节点时的提示（之后取到了自动清掉，见 nodes） */
const NO_NODES = "订阅里没有取到节点：订阅地址连不上，或者订阅是空的（内核会按间隔重试，也可以手动更新）";
/** 没有找到可执行文件时的提示（设置页显示；订阅模式这时保存不了） */
const MISSING = "没有找到代理内核 mihomo：在网关目录运行 npm run fetch-core 下载，或者用 MIHOMO_PATH 指到已有的 mihomo";
/** 下载内核的脚本（npm install 时的 postinstall 也是它），没找到内核时网关自己跑 */
const FETCH_SCRIPT = path.resolve(import.meta.dirname, "..", "..", "scripts", "fetch-core.mjs");
/** 下载失败后多久再试（设置页轮询、保存设置时才会触发） */
const DOWNLOAD_RETRY_MS = 5 * 60_000;
/** 留多少行内核的输出（启动失败时显示） */
const TAIL_LINES = 50;

export interface CoreSettings {
  url: string;
  /** 自动更新订阅的间隔（小时） */
  intervalHours: number;
}

/** 内核可执行文件：MIHOMO_PATH > gateway/vendor/mihomo/<平台>-<架构>/ > PATH 里的 mihomo */
export function findCore(): string | null {
  const exe = process.platform === "win32" ? "mihomo.exe" : "mihomo";
  const fromEnv = process.env.MIHOMO_PATH?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const vendored = path.resolve(import.meta.dirname, "..", "..", "vendor", "mihomo", `${process.platform}-${process.arch}`, exe);
  if (existsSync(vendored)) return vendored;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = dir && path.join(dir, exe);
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** 本机一个空闲端口（开一下再关） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const yamlString = (s: string) => JSON.stringify(s);

class ProxyCore {
  private readonly dir = () => path.join(config.claudeConfigDir, "proxy-core");
  private readonly token = randomBytes(18).toString("base64url");
  private readonly secret = randomBytes(18).toString("base64url");
  private mixedPort = 0;
  private controllerPort = 0;
  /** 想要的设置；null 是不跑 */
  private desired: CoreSettings | null = null;
  /** 不跑的时候要不要删掉工作目录（见 apply） */
  private purge = false;
  /** 正在跑的进程用的设置（变了要重启） */
  private running: { child: ChildProcess; settings: CoreSettings; startedAt: number } | null = null;
  private state: ProxyCoreStatus["state"] = "stopped";
  private version: string | undefined;
  private error: string | undefined;
  private tail: string[] = [];
  private backoff = 1000;
  private restartTimer: NodeJS.Timeout | undefined;
  /** 每次 apply 加一，过时的启动流程看到号变了就不再往下走 */
  private generation = 0;
  /** 控制接口直连（不经全局 dispatcher，它可能就指向这个内核） */
  private readonly direct = new Agent();

  /** 网关启动时调用一次：选好两个端口；没有内核的话在后台下载（当依赖装，不用用户手动） */
  async init(): Promise<void> {
    if (this.mixedPort) return;
    this.mixedPort = await freePort();
    this.controllerPort = await freePort();
    // 网关不管怎么退出都带走内核（正常关闭走 stop；这里管崩溃、process.exit）
    process.once("exit", () => this.killNow());
    this.ensureCore();
  }

  /** 下载内核时用的代理（设置页现在的代理，SOCKS5 是本机的转接；订阅模式是 null：内核还没有，没法经它下载），net/proxy.ts 设上 */
  downloadProxy: () => string | null = () => null;

  /** 下载内核的进度：running 是正在下载；error 是上次失败的原因；at 是上次开始的时间 */
  private download: { running: boolean; error?: string; at: number } = { running: false, at: 0 };

  /**
   * 没找到内核时下载（跑 scripts/fetch-core.mjs，校验 sha256）：网关启动时、设置页看状态时、要拉起内核时都会调，
   * 正在下载、刚失败不到 5 分钟时不重复下；设了 MIHOMO_PATH 时以它为准，不下载
   */
  ensureCore(): void {
    if (findCore() || process.env.MIHOMO_PATH?.trim() || this.download.running) return;
    if (this.download.at && Date.now() - this.download.at < DOWNLOAD_RETRY_MS) return;
    this.download = { running: true, at: Date.now() };
    const env: NodeJS.ProcessEnv = { ...process.env };
    const proxy = this.downloadProxy();
    if (proxy) env.HTTPS_PROXY = env.https_proxy = proxy;
    execFile(process.execPath, [FETCH_SCRIPT], { env, timeout: 11 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      const ok = !err && findCore() !== null;
      const reason = stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? err?.message;
      this.download = { running: false, at: Date.now(), ...(ok ? {} : { error: reason ?? "原因不明" }) };
      // 下好了、又要用：现在就拉起
      if (ok && this.desired && !this.running) {
        this.state = "starting";
        this.error = undefined;
        void this.reconcile(this.generation);
      }
    });
  }

  /** 给子进程、undici 用的代理地址（带用户名、令牌） */
  get proxyUrl(): string {
    return `http://${USER}:${this.token}@127.0.0.1:${this.mixedPort}`;
  }

  /** 给内置浏览器的：不带认证的地址，和用户名、密码分开 */
  get browserProxy(): { url: string; username: string; password: string } {
    return { url: `http://127.0.0.1:${this.mixedPort}`, username: USER, password: this.token };
  }

  status(): ProxyCoreStatus {
    const found = findCore();
    if (!found) {
      this.ensureCore();
      if (this.download.running) return { state: "downloading" };
      if (process.env.MIHOMO_PATH?.trim()) return { state: "missing", error: `MIHOMO_PATH 指的文件不存在：${process.env.MIHOMO_PATH.trim()}` };
      return {
        state: "missing",
        error: this.download.error
          ? `代理内核下载失败：${this.download.error.replace(/^下载失败：/, "")}。5 分钟后自动重试；也可以在网关目录运行 npm run fetch-core，或者用 MIHOMO_PATH 指到已有的 mihomo`
          : MISSING,
      };
    }
    // 之前没找到、现在有了（刚下载好）：不用等下次保存设置，现在就拉起
    if (this.state === "missing" && this.desired) {
      this.state = "starting";
      void this.reconcile(this.generation);
    }
    return { state: this.state, ...(this.version ? { version: this.version } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  /**
   * 按设置跑或者停；设置没变时什么都不做。
   * purge：订阅地址已经清掉了，停下以后把工作目录删掉（订阅缓存里有节点的密钥，配置里有订阅地址）；
   * 只是换到别的模式时不删，切回来接着用缓存和上次选的节点
   */
  apply(settings: CoreSettings | null, purge = false): void {
    this.purge = purge;
    const same = (a: CoreSettings | null, b: CoreSettings | null) => a?.url === b?.url && a?.intervalHours === b?.intervalHours;
    const settled = settings === null ? !(purge && existsSync(this.dir())) : this.running || this.state === "starting" || this.restartTimer;
    if (same(settings, this.desired) && settled) return;
    this.desired = settings;
    this.generation++;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.backoff = 1000;
    // 马上算「启动中」（关旧进程、检查配置是异步的），保存后返回的状态就对
    if (settings && findCore()) {
      this.state = "starting";
      this.error = undefined;
    }
    void this.reconcile(this.generation);
  }

  /** 网关关闭时 */
  async stop(): Promise<void> {
    this.desired = null;
    this.generation++;
    clearTimeout(this.restartTimer);
    await this.killRunning();
    this.state = "stopped";
  }

  private async reconcile(gen: number): Promise<void> {
    await this.killRunning();
    if (gen !== this.generation) return;
    const settings = this.desired;
    if (!settings) {
      this.state = "stopped";
      this.error = undefined;
      if (this.purge) rmSync(this.dir(), { recursive: true, force: true });
      return;
    }
    const bin = findCore();
    if (!bin) {
      // 下载好了会接着拉起（ensureCore 的回调）
      this.state = "missing";
      this.ensureCore();
      return;
    }
    this.state = "starting";
    this.error = undefined;
    try {
      this.writeConfig(settings);
      await this.check(bin);
      if (gen !== this.generation) return;
      await this.spawn(bin, settings, gen);
    } catch (err) {
      if (gen !== this.generation) return;
      this.state = "error";
      this.error = (err as Error).message;
      this.scheduleRestart(gen);
    }
  }

  private writeConfig(s: CoreSettings): void {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // 订阅的缓存文件名跟着订阅地址走：内核启动时缓存还没到更新间隔就直接用、不重新拉，
    // 文件名不变的话换了订阅地址用的还是上一个订阅的节点。别的订阅的缓存删掉（里面有节点的密钥）
    const cache = `${PROVIDER}-${createHash("sha256").update(s.url).digest("hex").slice(0, 16)}.yaml`;
    const providers = path.join(dir, "providers");
    if (existsSync(providers)) {
      for (const name of readdirSync(providers)) if (name !== cache) rmSync(path.join(providers, name), { recursive: true, force: true });
    }
    const yaml = [
      `mixed-port: ${this.mixedPort}`,
      `bind-address: 127.0.0.1`,
      `allow-lan: false`,
      `authentication: [${yamlString(`${USER}:${this.token}`)}]`,
      `external-controller: 127.0.0.1:${this.controllerPort}`,
      `secret: ${yamlString(this.secret)}`,
      `mode: rule`,
      `log-level: warning`,
      `ipv6: true`,
      `profile:`,
      `  store-selected: true`,
      ``,
      `proxy-providers:`,
      `  ${PROVIDER}:`,
      `    type: http`,
      `    url: ${yamlString(s.url)}`,
      `    path: ./providers/${cache}`,
      // 拉订阅一律直连：不写的话经当前节点拉，节点挂了就再也更新不了
      `    proxy: DIRECT`,
      `    interval: ${Math.round(s.intervalHours * 3600)}`,
      `    header:`,
      `      User-Agent: ["clash.meta"]`,
      `    health-check:`,
      `      enable: true`,
      `      url: ${TEST_URL}`,
      `      interval: 300`,
      ``,
      `proxy-groups:`,
      `  - name: ${AUTO_GROUP}`,
      `    type: url-test`,
      // 没有节点时组里只剩 REJECT，请求被拒；不写的话 mihomo 用内置的 COMPATIBLE，它等于直连，请求会直接出去。
      // 有节点时 REJECT 测不出延迟，不会被选上
      `    proxies: [REJECT]`,
      `    use: [${PROVIDER}]`,
      `    url: ${TEST_URL}`,
      `    interval: 300`,
      `    tolerance: 50`,
      `  - name: ${SELECT_GROUP}`,
      `    type: select`,
      `    proxies: [${AUTO_GROUP}]`,
      `    use: [${PROVIDER}]`,
      ``,
      `rules:`,
      `  - MATCH,${SELECT_GROUP}`,
      ``,
    ].join("\n");
    writeFileSync(path.join(dir, "config.yaml"), yaml, { mode: 0o600 });
    chmodSync(path.join(dir, "config.yaml"), 0o600);
  }

  /** mihomo -t：配置不对就不拉起，报它的原因 */
  private check(bin: string): Promise<void> {
    const dir = this.dir();
    return new Promise((resolve, reject) => {
      execFile(bin, ["-t", "-d", dir, "-f", path.join(dir, "config.yaml")], { env: coreEnv(), timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve();
        const msg = lastError(`${stdout}\n${stderr}`) ?? err.message;
        reject(new Error(`代理内核的配置检查没通过：${msg}`));
      });
    });
  }

  private async spawn(bin: string, settings: CoreSettings, gen: number): Promise<void> {
    const dir = this.dir();
    const child = spawn(bin, ["-d", dir, "-f", path.join(dir, "config.yaml")], { env: coreEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.tail = [];
    const onData = (chunk: Buffer) => {
      this.tail.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
      this.tail.splice(0, Math.max(0, this.tail.length - TAIL_LINES));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const running = { child, settings, startedAt: Date.now() };
    this.running = running;
    let exited = false;
    child.once("error", (err) => this.tail.push(`无法启动 ${bin}：${err.message}`));
    child.once("exit", (code, signal) => {
      exited = true;
      // 我们自己关的（killRunning 先把 running 清掉了）不算挂了：不然启动超时后重启时，旧进程的退出会再排一次重启，把刚拉起的又关掉
      if (this.running !== running) return;
      this.running = null;
      if (gen !== this.generation) return;
      // 不是我们关的：记下原因，过一会儿重启
      this.state = "error";
      this.version = undefined;
      this.error = `代理内核退出了（${signal ?? `退出码 ${code}`}）${lastError(this.tail.join("\n")) ? `：${lastError(this.tail.join("\n"))}` : ""}`;
      if (Date.now() - running.startedAt > STABLE_MS) this.backoff = 1000;
      this.scheduleRestart(gen);
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) {
      const v = await this.api<{ version?: string }>("GET", "/version").catch(() => null);
      if (v?.version) {
        // 控制接口通了不等于能用：订阅是启动后才拉的，拉到之前没有节点，请求会被拒。等它拉完（成功或失败）
        const nodes = await this.waitProvider(deadline);
        if (gen !== this.generation) return;
        this.state = "running";
        this.version = v.version;
        this.error = nodes === 0 ? NO_NODES : undefined;
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (exited) return;
    throw new Error(`代理内核 ${START_TIMEOUT_MS / 1000} 秒内没有启动好${lastError(this.tail.join("\n")) ? `：${lastError(this.tail.join("\n"))}` : ""}`);
  }

  /** 等订阅拉完（有缓存时启动就有节点；没有时等第一次拉取有结果），返回节点数；到 deadline 还没结果按 0 算 */
  private async waitProvider(deadline: number): Promise<number> {
    while (Date.now() < deadline) {
      const p = await this.api<{ proxies?: unknown[]; updatedAt?: string }>("GET", `/providers/proxies/${PROVIDER}`).catch(() => null);
      const count = p?.proxies?.length ?? 0;
      if (count > 0) return count;
      // 拉过了（updatedAt 不是零值）还是没有节点：订阅连不上或是空的
      if (p?.updatedAt && !p.updatedAt.startsWith("0001-")) return 0;
      await new Promise((r) => setTimeout(r, 200));
    }
    return 0;
  }

  private scheduleRestart(gen: number): void {
    if (gen !== this.generation || !this.desired) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (gen === this.generation) void this.reconcile(gen);
    }, wait);
  }

  private async killRunning(): Promise<void> {
    const r = this.running;
    if (!r) return;
    this.running = null;
    this.version = undefined;
    const { child } = r;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    const timer = setTimeout(() => this.forceKill(child), 3000);
    await exited;
    clearTimeout(timer);
  }

  private forceKill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  }

  /** 网关进程退出时（同步） */
  private killNow(): void {
    const child = this.running?.child;
    if (child && child.exitCode === null) this.forceKill(child);
  }

  /** 调内核的控制接口 */
  private async api<T>(method: string, pathname: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.controllerPort}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${this.secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher: this.direct,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T & { message?: string }) : ({} as T & { message?: string });
    if (!res.ok) throw new CoreApiError(data.message || `HTTP ${res.status}`, res.status);
    return data;
  }

  private requireRunning(): void {
    if (this.state !== "running") throw new CoreApiError(this.status().error ?? "代理内核没有运行", 503);
  }

  /** 节点列表、选的是哪个、订阅的流量和到期时间 */
  async nodes(): Promise<ProxyNodes> {
    this.requireRunning();
    const [provider, group] = await Promise.all([
      this.api<{ proxies?: { name: string; type: string; alive?: boolean; history?: { delay: number }[] }[]; subscriptionInfo?: { Upload: number; Download: number; Total: number; Expire: number } | null; updatedAt?: string }>(
        "GET",
        `/providers/proxies/${PROVIDER}`,
      ),
      this.api<{ now?: string }>("GET", `/proxies/${encodeURIComponent(SELECT_GROUP)}`),
    ]);
    // 订阅后来取到了（自动更新、手动更新），「没有节点」的提示清掉；又没了再提示
    if (this.state === "running" && (!this.error || this.error === NO_NODES)) this.error = provider.proxies?.length ? undefined : NO_NODES;
    const info = provider.subscriptionInfo;
    const updatedAt = provider.updatedAt && !provider.updatedAt.startsWith("0001-") ? provider.updatedAt : null;
    return {
      selected: group.now === AUTO_GROUP ? null : (group.now ?? null),
      nodes: (provider.proxies ?? []).map((p) => {
        const last = p.history?.at(-1)?.delay;
        return { name: p.name, type: p.type, alive: p.alive ?? false, delay: last && last > 0 ? last : null };
      }),
      subscription: {
        updatedAt,
        ...(info ? { upload: info.Upload, download: info.Download, total: info.Total || null, expire: info.Expire ? new Date(info.Expire * 1000).toISOString() : null } : {}),
      },
    };
  }

  /** 选节点：null 是「自动」 */
  async select(name: string | null): Promise<void> {
    this.requireRunning();
    await this.api("PUT", `/proxies/${encodeURIComponent(SELECT_GROUP)}`, { name: name ?? AUTO_GROUP });
    // 已经建立的连接（keep-alive 的、正在传的）内核不会自己换节点，断开它们，之后的请求才都走新选的
    await this.api("DELETE", "/connections").catch(() => {});
  }

  /** 所有节点测一次延迟，返回 节点名 → 毫秒（不通的是 null） */
  async testDelay(): Promise<Record<string, number | null>> {
    this.requireRunning();
    const { nodes } = await this.nodes();
    const got = await this.api<Record<string, number>>("GET", `/group/${encodeURIComponent(AUTO_GROUP)}/delay?url=${encodeURIComponent(TEST_URL)}&timeout=5000`, undefined, 15_000).catch(() => ({}) as Record<string, number>);
    return Object.fromEntries(nodes.map((n) => [n.name, got[n.name] ?? null]));
  }

  /** 马上更新订阅 */
  async update(): Promise<void> {
    this.requireRunning();
    await this.api("PUT", `/providers/proxies/${PROVIDER}`, undefined, 30_000);
  }
}

/** 内核控制接口的错误：接口返回内核给的状态码（不是 4xx、5xx 的按 502） */
export class CoreApiError extends HttpError {
  constructor(message: string, status: number) {
    super(status >= 400 && status < 600 ? status : 502, message);
  }
}

/** 内核的环境变量：去掉继承来的代理变量（拉订阅一律直连，不让它被环境变量带到别处） */
function coreEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  return env;
}

/** 内核输出里最后一条错误（level=error / fatal），去掉时间等前缀 */
function lastError(out: string): string | undefined {
  const lines = out.split(/\r?\n/).filter((l) => /level=(error|fatal)|Parse config error|test failed/i.test(l));
  const last = lines.at(-1);
  if (!last) return undefined;
  const m = /msg="((?:[^"\\]|\\.)*)"/.exec(last);
  return (m ? m[1]!.replace(/\\"/g, '"') : last).slice(0, 300);
}

export const proxyCore = new ProxyCore();
