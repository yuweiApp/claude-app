import path from "node:path";
import { randomBytes } from "node:crypto";
import { Agent, type Dispatcher, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config, MODEL_API_BASE } from "../config.js";
import { readJson, writeJson } from "../json-file.js";
import type { ProxyMode, ProxySettingsInput, ProxySettingsView, ProxyTestResult } from "../shared/types.js";
import { proxyCore } from "./core.js";
import { SocksBridge, socksConnect, type SocksUpstream } from "./socks-bridge.js";
import { BadRequestError } from "../errors.js";

/**
 * 设置页「网络代理」（见 docs/proxy.md）。管两处：
 * - 网关自己发的请求（fetch 和 undici 的 request）：换全局 dispatcher，改了马上生效
 * - claude 子进程的环境变量（applyProxyEnv）：Claude Code 的模型请求和它拉起的 Bash、MCP、git 都按这些变量走，
 *   只在子进程启动时读，所以改了以后由会话管理器把用旧设置启动的子进程换掉（proxyEnvKey、onProxyChange）
 * 存在 Claude Code 配置目录下（同 gateway-browsers.json）；有密码，文件权限 600。
 * SOCKS5 代理：子进程和网关自己的请求都只认 HTTP 代理，指向网关在本机开的转接（socks-bridge.ts），由它经 SOCKS5 连出去。
 * 订阅：网关拉起代理内核 mihomo（core.ts），订阅里的节点变成本机的一个代理端口，所有出口都指向它
 */
const file = () => path.join(config.claudeConfigDir, "gateway-proxy.json");

interface Stored {
  mode?: ProxyMode;
  url?: string;
  username?: string;
  password?: string;
  noProxy?: string[];
  /** 订阅地址：当密码对待，不回给网页、不进日志、不给模型 */
  subscriptionUrl?: string;
  /** 自动更新订阅的间隔（小时） */
  subscriptionInterval?: number;
}

const DEFAULT_SUBSCRIPTION_INTERVAL = 12;
/** 订阅模式下「实际用的代理」显示成什么（内核的地址带令牌，不给人看） */
const SUBSCRIPTION_DISPLAY = "订阅";

/**
 * 总是不走代理的本机地址：浏览器工具、桌面工具、Playwright MCP、本地开发服务都连本机。
 * [::1] 是给 undici 的（它把 ::1 拆成主机「:」和端口 1），::1 给 curl 等
 */
const FIXED_NO_PROXY = ["localhost", "127.0.0.1", "::1"];
const FIXED_NO_PROXY_ENV = [...FIXED_NO_PROXY, "[::1]"];

/** 子进程里和代理有关的变量：Claude Code、Node 认大写，curl 的 http_proxy 只认小写，ALL_PROXY 是 curl 等的后备（常是 SOCKS） */
const PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"];

const read = (): Stored => readJson(file(), {});
const write = (stored: Stored) => writeJson(file(), stored);

/** 网关进程继承来的代理（系统环境变量、.env、.env.local）：先 HTTPS 的，模型接口都是 https */
function inheritedProxy(): string | undefined {
  const e = process.env;
  return [e.HTTPS_PROXY, e.https_proxy, e.HTTP_PROXY, e.http_proxy].map((v) => v?.trim()).find(Boolean);
}

function inheritedNoProxy(): string[] {
  return splitList(process.env.NO_PROXY ?? process.env.no_proxy ?? "");
}

function splitList(raw: string): string[] {
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 显示用：去掉用户名、密码，只留协议、主机、端口 */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw.replace(/\/\/[^@/]*@/, "//");
  }
}

/** 手动模式填的地址：只收 http、https、socks5，不能带用户名、密码（填在单独的输入框），去掉路径；SOCKS5 没写端口是 1080 */
function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw new BadRequestError("请填写代理地址");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new BadRequestError(`代理地址格式不对：${text}`);
  }
  const socks = u.protocol === "socks5:" || u.protocol === "socks5h:";
  if (u.protocol !== "http:" && u.protocol !== "https:" && !socks) {
    throw new BadRequestError(`只支持 HTTP、HTTPS、SOCKS5 代理（http://、https://、socks5:// 开头），不支持 ${u.protocol.replace(/:$/, "")}`);
  }
  if (u.username || u.password) throw new BadRequestError("用户名、密码请填在下面的输入框里，不要写在地址里");
  if (!u.hostname) throw new BadRequestError(`代理地址里没有主机：${text}`);
  return socks ? `socks5://${u.hostname}:${u.port || 1080}` : `${u.protocol}//${u.host}`;
}

function normalizeNoProxy(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    for (const entry of splitList(raw)) {
      if (/[/\\@]/.test(entry)) throw new BadRequestError(`不走代理的地址只能是域名或 IP（可以带端口）：${entry}`);
      const lower = entry.toLowerCase();
      if (!FIXED_NO_PROXY.includes(lower) && !out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

/**
 * 实际用的代理：url 是给子进程、undici 的 HTTP 代理地址（带着用户名、密码，URL 编码过；SOCKS5 时是本机的转接），
 * display 是给人看的（不含用户名、密码），socks 是 SOCKS5 时转接的上游；
 * replaceEnv：子进程里继承来的代理变量要不要换掉（只有跟随系统、用的就是继承来的 HTTP 代理时不换）。直连是 null
 */
interface Effective {
  url: string;
  display: string;
  noProxy: string[];
  socks?: SocksUpstream;
  replaceEnv: boolean;
}

/** SOCKS5 的转接：网关启动时开好（initProxy）；正在用的设置用固定的令牌，地址一直不变 */
const bridge = new SocksBridge();
const BRIDGE_TOKEN = randomBytes(18).toString("base64url");

function effectiveFor(raw: string, noProxy: string[], creds: { username?: string; password?: string }, replaceEnv: boolean, token = BRIDGE_TOKEN): Effective {
  const u = new URL(raw);
  if (u.protocol === "socks5:" || u.protocol === "socks5h:") {
    const socks: SocksUpstream = {
      host: u.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: Number(u.port) || 1080,
      ...(creds.username ? { username: creds.username, password: creds.password ?? "" } : u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
    };
    return { url: bridge.urlFor(token), display: `socks5://${u.host}`, noProxy, socks, replaceEnv: true };
  }
  if (creds.username) {
    u.username = encodeURIComponent(creds.username);
    u.password = encodeURIComponent(creds.password ?? "");
  }
  return { url: u.toString().replace(/\/$/, ""), display: displayUrl(raw), noProxy, replaceEnv };
}

function effectiveOf(stored: Stored, token?: string): Effective | null {
  const mode = stored.mode ?? "system";
  if (mode === "off") return null;
  if (mode === "subscription") {
    // 内核没起来时也指向它（连不上就报错），不退回直连
    if (!stored.subscriptionUrl) return null;
    return { url: proxyCore.proxyUrl, display: SUBSCRIPTION_DISPLAY, noProxy: [...FIXED_NO_PROXY_ENV, ...(stored.noProxy ?? [])], replaceEnv: true };
  }
  if (mode === "manual") {
    if (!stored.url) return null;
    return effectiveFor(stored.url, [...FIXED_NO_PROXY_ENV, ...(stored.noProxy ?? [])], stored, true, token);
  }
  const noProxy = [...FIXED_NO_PROXY_ENV, ...inheritedNoProxy()];
  const os = osProxy().url;
  if (os) return effectiveFor(os, noProxy, {}, true, token);
  const inherited = inheritedProxy();
  return inherited ? effectiveFor(inherited, noProxy, {}, false, token) : null;
}

/**
 * 操作系统的代理（跟随系统时用）：Node 和 Claude Code 不读 Windows、macOS 的系统代理设置，由桌面版外壳问 Chromium
 * （resolveProxy 模型接口的地址，PAC、自动检测都算）再报过来（browser/host.ts 的 systemProxy 消息）。
 * 是 PAC 格式的结果（「PROXY a:1; DIRECT」），只看第一项。外壳连着时才有：断开后清掉（桌面版关着时系统代理变了网关不知道，
 * 留着旧的可能一直连一个已经关掉的代理），回到继承的环境变量；网关重启后、外壳报过来之前也是 undefined
 */
let osRoute: string | undefined;

/** url：能用的系统代理；unusable：系统代理是 SOCKS 等网关用不了的（显示原因）；都没有是没报过或者系统说直连 */
function osProxy(): { url?: string; unusable?: string } {
  const first = osRoute?.split(";").map((s) => s.trim()).find(Boolean);
  if (!first) return {};
  const [kind, addr] = first.split(/\s+/) as [string, string | undefined];
  if (kind === "DIRECT" || !addr) return {};
  if (kind === "PROXY") return { url: `http://${addr}` };
  if (kind === "HTTPS") return { url: `https://${addr}` };
  if (kind === "SOCKS5") return { url: `socks5://${addr}` };
  return { unusable: `${kind} ${addr}` };
}

/**
 * 桌面版报来的操作系统代理（Chromium resolveProxy 的结果），桌面版断开时是 undefined；
 * 变了的话网关的请求马上换，子进程按设置改了的规矩换
 */
export function setSystemProxy(route: string | undefined): void {
  if (route === osRoute) return;
  const before = proxyEnvKey();
  osRoute = route;
  if ((settings().mode ?? "system") !== "system") return;
  install();
  if (proxyEnvKey() !== before) for (const fn of listeners) fn();
}

function dispatcherFor(effective: Effective | null): Dispatcher {
  if (!effective) return new Agent();
  return new EnvHttpProxyAgent({ httpProxy: effective.url, httpsProxy: effective.url, noProxy: effective.noProxy.join(",") });
}

// config.ts 的 agentEnv 引用这里，这里又引用 config：模块顶层不碰 config，第一次用到时才读文件
let stored: Stored | undefined;
const settings = (): Stored => (stored ??= read());
const listeners = new Set<() => void>();

function install(): void {
  const s = settings();
  // 订阅模式才跑代理内核；订阅地址、更新间隔变了内核重启（端口不变）；订阅地址清掉了的，内核的工作目录也删掉
  proxyCore.apply(s.mode === "subscription" && s.subscriptionUrl ? { url: s.subscriptionUrl, intervalHours: s.subscriptionInterval ?? DEFAULT_SUBSCRIPTION_INTERVAL } : null, !s.subscriptionUrl);
  const effective = effectiveOf(s);
  // SOCKS5 的上游换了，转接的地址不变，子进程不用换，之后的连接就走新的上游
  if (effective?.socks) bridge.register(effective.socks, BRIDGE_TOKEN);
  else bridge.unregister(BRIDGE_TOKEN);
  const old = getGlobalDispatcher();
  setGlobalDispatcher(dispatcherFor(effective));
  // 正在进行的请求（比如 SSH 远端转发回来的模型流）用完再关
  void old.close().catch(() => {});
}

/** 网关启动时调用一次，在发出任何请求之前 */
export async function initProxy(): Promise<void> {
  await bridge.start();
  // 没有内核时网关自己下载：经现在设置的代理下（订阅模式不行，内核还没有）
  proxyCore.downloadProxy = () => {
    const s = settings();
    return s.mode === "subscription" ? null : (effectiveOf(s)?.url ?? null);
  };
  await proxyCore.init();
  install();
}

/** 网关关闭时：关掉代理内核 */
export function stopProxy(): Promise<void> {
  return proxyCore.stop();
}

export function proxySettingsView(): ProxySettingsView {
  const inherited = inheritedProxy();
  const effective = effectiveOf(settings());
  const current = settings();
  return {
    mode: current.mode ?? "system",
    url: current.url ?? "",
    username: current.username ?? "",
    hasPassword: Boolean(current.password),
    noProxy: current.noProxy ?? [],
    fixedNoProxy: FIXED_NO_PROXY,
    inherited: inherited ? displayUrl(inherited) : null,
    system: osRoute === undefined ? null : { proxy: osProxy().url ?? null, unusable: osProxy().unusable ?? null },
    effective: effective ? effective.display : null,
    subscription: { hasUrl: Boolean(current.subscriptionUrl), intervalHours: current.subscriptionInterval ?? DEFAULT_SUBSCRIPTION_INTERVAL, core: proxyCore.status() },
  };
}

/** 按请求体算出要存的设置（还没存）；password 不传时沿用已存的 */
function resolveInput(input: ProxySettingsInput): Stored {
  const current = settings();
  const mode = input.mode;
  if (mode !== "system" && mode !== "off" && mode !== "manual" && mode !== "subscription") throw new BadRequestError(`不认识的代理模式：${String(mode)}`);
  const username = (input.username ?? current.username ?? "").trim();
  const password = input.password ?? current.password ?? "";
  const next: Stored = { mode };
  // 手动模式以外留着之前存的地址（这次填的不管），切回手动时不用重填
  if (mode === "manual") next.url = normalizeUrl(input.url ?? current.url ?? "");
  else if (current.url) next.url = current.url;
  if (username) next.username = username;
  if (username && password) next.password = password;
  const noProxy = normalizeNoProxy(input.noProxy ?? current.noProxy ?? []);
  if (noProxy.length) next.noProxy = noProxy;
  // 订阅：不传是不改，空字符串是清掉；别的模式下也留着，切回来不用重填
  const subscriptionUrl = input.subscriptionUrl === undefined ? current.subscriptionUrl : normalizeSubscriptionUrl(input.subscriptionUrl);
  if (subscriptionUrl) next.subscriptionUrl = subscriptionUrl;
  if (mode === "subscription" && !subscriptionUrl) throw new BadRequestError("请填写订阅地址");
  const interval = input.subscriptionInterval ?? current.subscriptionInterval;
  if (interval !== undefined) {
    if (!Number.isFinite(interval) || interval < 1 || interval > 168) throw new BadRequestError("自动更新订阅的间隔要在 1 到 168 小时之间");
    next.subscriptionInterval = interval;
  }
  return next;
}

/** 订阅地址：http(s) 网址，空字符串是清掉 */
function normalizeSubscriptionUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new BadRequestError("订阅地址格式不对，要是 http:// 或 https:// 开头的网址");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BadRequestError("订阅地址要是 http:// 或 https:// 开头的网址");
  return u.toString();
}

export function saveProxySettings(input: ProxySettingsInput): ProxySettingsView {
  const before = proxyEnvKey();
  const next = resolveInput(input);
  // 没有代理内核（也没在下载）时订阅模式保存不了：存了也连不出去（不退回直连），所有请求都会失败；
  // 正在下载时可以存，下好了自动拉起
  if (next.mode === "subscription") {
    const core = proxyCore.status();
    if (core.state === "missing") throw new BadRequestError(core.error ?? "没有找到代理内核");
  }
  write(next);
  stored = next;
  install();
  if (proxyEnvKey() !== before) for (const fn of listeners) fn();
  for (const fn of savedListeners) fn();
  return proxySettingsView();
}

const savedListeners = new Set<() => void>();

/** 每次保存都调用（不管变没变），桌面版的内置浏览器用来跟着换（browser/host.ts） */
export function onProxySaved(fn: () => void): () => void {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

/**
 * 交给桌面版外壳的设置（经 /browser/host 这条只在本机、带令牌的连接，所以带着密码）：
 * 内置浏览器按它设分区的代理、回答代理认证。跟随系统时外壳用操作系统的代理设置（Electron 自己读）；
 * bypass 是用户填的不走代理的地址，本机地址 Chromium 本来就不走代理
 */
export interface BrowserProxyConfig {
  mode: ProxyMode;
  /** 外壳按这个地址查操作系统的代理报回来（setSystemProxy） */
  probeUrl: string;
  url?: string;
  username?: string;
  password?: string;
  bypass: string[];
}

export function browserProxyConfig(): BrowserProxyConfig {
  const s = settings();
  const mode = s.mode ?? "system";
  const probeUrl = MODEL_API_BASE;
  // 订阅：浏览器用代理内核的端口（带认证的 HTTP 代理），外壳那边当手动设置处理
  if (mode === "subscription") return s.subscriptionUrl ? { mode: "manual", probeUrl, ...proxyCore.browserProxy, bypass: s.noProxy ?? [] } : { mode: "off", probeUrl, bypass: [] };
  if (mode !== "manual" || !s.url) return { mode: mode === "manual" ? "off" : mode, probeUrl, bypass: [] };
  const bypass = s.noProxy ?? [];
  // Chromium 的 SOCKS5 不支持用户名、密码：要认证的经网关在本机开的转接（HTTP 代理，令牌当密码；桌面版和网关在同一台电脑上）
  if (s.url.startsWith("socks5:") && s.username) {
    const u = new URL(bridge.urlFor(BRIDGE_TOKEN));
    return { mode, probeUrl, url: `http://${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), bypass };
  }
  return { mode, probeUrl, url: s.url, ...(s.username ? { username: s.username, password: s.password ?? "" } : {}), bypass };
}

/** 设置改了、子进程的代理环境变量跟着变了时调用（会话管理器用来换掉旧的子进程） */
export function onProxyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 把代理设置写进传给子进程的环境变量（就地改 env）：
 * 跟随系统时有操作系统的代理（桌面版报来的）就换成它，没有就把继承来的原样留着，有代理时都补上本机地址的 NO_PROXY；
 * 不使用时删掉；手动时换成设置里的
 */
export function applyProxyEnv(env: Record<string, string | undefined>): void {
  const mode = settings().mode ?? "system";
  const effective = effectiveOf(settings());
  const replace = effective?.replaceEnv ?? false;
  if (mode === "off" || replace) for (const k of PROXY_KEYS) delete env[k];
  if (!effective) return;
  const noProxy = [...new Set(effective.noProxy)].join(",");
  if (replace) {
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[k] = effective.url;
  }
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
}

/** 子进程启动时的代理环境变量，设置改了以后不一样的子进程要换掉 */
export function proxyEnvKey(): string {
  const env: Record<string, string | undefined> = Object.fromEntries(PROXY_KEYS.map((k) => [k, process.env[k]]));
  applyProxyEnv(env);
  return JSON.stringify(PROXY_KEYS.map((k) => env[k] ?? null));
}

const TEST_TIMEOUT_MS = 10_000;

/** 按请求体里的设置（不保存）请求一次模型接口：收到任何 HTTP 响应（401、404 也算）都是连上了 */
export async function testProxy(input: ProxySettingsInput): Promise<ProxyTestResult> {
  const target = `${MODEL_API_BASE}/v1/models`;
  // SOCKS5 的测试用临时的转接令牌，不动正在用的
  const token = randomBytes(18).toString("base64url");
  let effective: Effective | null;
  try {
    const next = resolveInput(input);
    // 订阅只能测正在跑的内核（换订阅要重启内核）：改了订阅地址的先保存
    if (next.mode === "subscription") {
      const cur = settings();
      if (cur.mode !== "subscription" || cur.subscriptionUrl !== next.subscriptionUrl) return { ok: false, target, via: SUBSCRIPTION_DISPLAY, error: "订阅改了还没保存：先保存，再测试" };
      const core = proxyCore.status();
      if (core.state !== "running") return { ok: false, target, via: SUBSCRIPTION_DISPLAY, error: core.error ?? (core.state === "starting" ? "代理内核正在启动，稍后再试" : "代理内核没有运行") };
    }
    effective = effectiveOf(next, token);
  } catch (err) {
    return { ok: false, target, via: null, error: (err as Error).message };
  }
  const via = effective ? effective.display : null;
  const started = Date.now();
  if (effective?.socks) {
    // 先直接经 SOCKS5 连一下目标：连不上时报 SOCKS5 自己的原因（经转接的话只看得到 502）
    const t = new URL(target);
    try {
      const s = await socksConnect(effective.socks, t.hostname, Number(t.port) || (t.protocol === "https:" ? 443 : 80));
      s.destroy();
    } catch (err) {
      return { ok: false, target, via, error: (err as Error).message };
    }
    bridge.register(effective.socks, token);
  }
  const dispatcher = dispatcherFor(effective);
  try {
    const res = await fetch(target, { dispatcher, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) } as RequestInit);
    await res.body?.cancel();
    return { ok: true, target, via, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, target, via, error: describeError(err, via) };
  } finally {
    void dispatcher.close().catch(() => {});
    bridge.unregister(token);
  }
}

/** undici 把真正的原因一层层套在 cause 里（fetch failed → Request was cancelled → Proxy response (407) …） */
function errorChain(err: unknown): (Error & { code?: string })[] {
  const chain: (Error & { code?: string })[] = [];
  for (let e = err as (Error & { code?: string; cause?: unknown }) | undefined; e instanceof Error && chain.length < 8; e = e.cause as typeof e) chain.push(e);
  return chain;
}

/** 网络错误的说明：最里面一层的消息，带上系统错误码（ECONNREFUSED 等） */
export function describeNetError(err: unknown): string {
  const chain = errorChain(err);
  const inner = chain.at(-1);
  if (!inner) return String(err);
  const code = chain.map((e) => e.code).find((c) => typeof c === "string" && /^E[A-Z]+$/.test(c));
  return code && !inner.message.includes(code) ? `${inner.message}（${code}）` : inner.message;
}

function describeError(err: unknown, via: string | null): string {
  const chain = errorChain(err);
  if (chain.some((e) => e.name === "TimeoutError")) return `${TEST_TIMEOUT_MS / 1000} 秒内没有响应`;
  const status = chain.map((e) => /Proxy response \((\d+)\)/.exec(e.message)?.[1]).find(Boolean);
  const code = chain.map((e) => e.code).find((c) => typeof c === "string" && /^E[A-Z]+$/.test(c));
  if (via && status === "407") return "代理要求认证（407）：用户名或密码不对，或者没填";
  if (via && status) return `代理拒绝了连接（${status}）`;
  // 订阅：代理内核连不上节点（或者没有节点、请求被拒）时直接断开连接
  if (via === SUBSCRIPTION_DISPLAY && code === "ECONNRESET") return "代理内核断开了连接：现在选的节点连不上目标，或者订阅里没有能用的节点";
  if (via && code === "ECONNREFUSED") return `连不上代理 ${via}（拒绝连接）`;
  if (via && code === "ENOTFOUND") return `找不到代理的主机 ${via}`;
  return describeNetError(err);
}
