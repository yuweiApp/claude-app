import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { Duplex, type Readable, type Writable } from "node:stream";
import ssh2, { Client, type AnyAuthMethod, type AuthHandlerMiddleware, type ClientChannel, type ExecOptions, type SFTPWrapper } from "ssh2";
import type { SshConnectionInfo, SshStatus } from "../shared/types.js";
import { getConnection, patchConnection, type SshConnection } from "./connections.js";
import { HostKeyError, hostKeyOf, knownHostsHas, type HostKey } from "./host-key.js";
import { resolveTarget, sshBin, type RemoteForward, type ResolvedTarget } from "./ssh-config.js";
import { prepareRemote, type RemoteEnv } from "./deploy.js";
import { createModelProxy, type ModelProxy } from "./model-proxy.js";

/** 单引号转义，给远端的 sh 用 */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 单引号转义，给远端的 PowerShell 用（它把 ‘’‚‛ 也当单引号） */
export const psQuote = (s: string) => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;

/**
 * Windows 远端：命令交给 PowerShell 5.1（系统自带），输出用 UTF-8。
 * 用 -EncodedCommand 时它把进度和错误写成 CLIXML：不显示进度，错误自己按纯文本写到标准错误、退出码 1
 */
/** PowerShell 的 -EncodedCommand 参数：UTF-16LE 的 base64 */
export const psEncoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

const psCommand = (script: string) => {
  const full = [
    "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "try {",
    script,
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join("\n");
  return `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${psEncoded(full)}`;
};

export class SshError extends Error {}

/** 127.0.0.1:80、[::1]:80 */
export const hostPort = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

/** 远端输出转成文字：不是合法 UTF-8 时按 GB18030 解（中文 Windows 的 cmd、PowerShell 输出的是 GBK） */
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("gb18030").decode(buf);
  }
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

const READY_TIMEOUT_MS = 20_000;
/** 连着时每 15 秒探一次，连续 4 次没回应（最长约 75 秒收不到远端的任何响应）就断开 */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 4;
const KEEPALIVE_DESC = `${((KEEPALIVE_COUNT_MAX + 1) * KEEPALIVE_INTERVAL_MS) / 1000} 秒内没收到远端的响应`;

/**
 * 一台远程主机：一条 ssh2 连接，claude 进程、终端、SFTP、模型请求的反向转发都在这条连接上开通道。
 * 连上后先准备远端（上传 Claude Code、启动脚本，见 deploy.ts），再在远端 127.0.0.1 上开一个端口转发回网关（见 model-proxy.ts）。
 * 断开后不自动重连，下次要用时（发消息、开终端、看文件）再连
 */
export class SshHost {
  status: SshStatus = "disconnected";
  error: string | undefined;
  /** 等用户确认的主机密钥 */
  pendingKey: (HostKey & { changed: boolean }) | undefined;
  needsPassword = false;
  progress: number | undefined;
  /** 远端的目录、PATH 等，准备好之后才有 */
  env: RemoteEnv | null = null;
  /** 远端 127.0.0.1 上转发回网关模型代理的端口 */
  proxyPort: number | null = null;
  /** 这次连上（准备好）的时间，断开后留着旧值，info() 只在 ready 时给 */
  connectedAt: number | null = null;
  /** 上一次连上后断开的时间和原因（会话报错用，见 AgentSession） */
  lastClose: { at: number; reason: string } | null = null;

  private client: Client | null = null;
  private ready: Promise<void> | null = null;
  private sftpConn: Promise<SFTPWrapper> | null = null;
  /** 用户输入过的密码：只在内存里，断开后重连还用它 */
  private password: string | undefined;
  private proxy: ModelProxy | null = null;
  private readonly closeListeners = new Set<() => void>();
  private readonly changeListeners = new Set<() => void>();
  /** 反向转发：远端端口 → 转发配置；没开成的记着原因（设置页显示） */
  private readonly forwards = new Map<number, RemoteForward>();
  private forwardErrors: { forward: RemoteForward; error: string }[] = [];
  /** 这条连接断开的原因：连接的 error 事件或 disconnect() 记的，close 时写进 lastClose */
  private closeReason: string | undefined;

  constructor(readonly id: string) {}

  get connection(): SshConnection {
    const conn = getConnection(this.id);
    if (!conn) throw new SshError("SSH 连接不存在（可能已经在设置里删掉了）");
    return conn;
  }

  info(): SshConnectionInfo {
    const conn = this.connection;
    return {
      id: conn.id,
      name: conn.name,
      host: conn.host,
      ...(conn.fromConfig ? { fromConfig: true } : {}),
      ...(conn.address ? { address: conn.address } : {}),
      ...(conn.port ? { port: conn.port } : {}),
      ...(conn.identityFile ? { identityFile: conn.identityFile } : {}),
      ...(conn.startDirectory ? { startDirectory: conn.startDirectory } : {}),
      status: this.status,
      ...(this.status === "ready" && this.connectedAt ? { connectedAt: this.connectedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.pendingKey ? { hostKey: this.pendingKey } : {}),
      ...(this.needsPassword ? { needsPassword: true } : {}),
      ...(conn.hostKey ? { trustedFingerprint: conn.hostKey.fingerprint } : {}),
      ...(this.progress !== undefined ? { progress: this.progress } : {}),
      ...(conn.facts ? { platform: conn.facts.platform, home: conn.facts.home } : {}),
      ...(conn.remoteForwards ? { remoteForwards: conn.remoteForwards } : {}),
      ...(this.client && (this.forwards.size || this.forwardErrors.length)
        ? {
            forwards: [
              ...[...this.forwards.values()].map((f) => ({ remote: hostPort(f.bindHost, f.bindPort), local: hostPort(f.host, f.port) })),
              ...this.forwardErrors.map(({ forward: f, error }) => ({ remote: hostPort(f.bindHost, f.bindPort), local: hostPort(f.host, f.port), error })),
            ],
          }
        : {}),
    };
  }

  /** 现在开着的反向转发（远端地址 → 本机地址），给模型看的说明用 */
  activeForwards(): RemoteForward[] {
    return [...this.forwards.values()];
  }

  /** 连接断开（主动断开、网络断了）时通知，claude 进程、终端随之结束 */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** 状态变了（设置页显示用） */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** 连上并准备好远端；已经连着的直接返回。password 是这次用户输入的密码 */
  ensureReady(password?: string): Promise<void> {
    if (password !== undefined) this.password = password || undefined;
    if (this.ready && this.status !== "error") return this.ready;
    const ready = this.connect().catch((err: unknown) => {
      if (this.ready === ready) this.ready = null;
      this.client?.end();
      this.client = null;
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    });
    this.ready = ready;
    return ready;
  }

  /** 已经连着、准备好了 */
  get isReady(): boolean {
    return this.status === "ready" && this.client !== null;
  }

  /** reason 记进 lastClose：设置页点了断开、连接配置改了或删了、网关退出 */
  disconnect(reason = "网关主动断开"): void {
    const client = this.client;
    if (client) {
      this.closeReason = reason;
      client.end();
      // 现在就按断开处理（claude 进程、终端收到 onClose）：之后连接的 close 事件因为 this.client 已经换掉，closed() 不会再处理。
      // 对方不一定马上关连接，过一会儿还没关就直接断
      setTimeout(() => client.destroy(), 3000).unref();
      this.closed(client);
      return;
    }
    this.ready = null;
    this.sftpConn = null;
    this.client = null;
    this.proxyPort = null;
    if (this.status !== "error") this.setStatus("disconnected");
  }

  /** 用户确认了指纹：记下来，下次连接时按它验证 */
  trust(fingerprint: string): void {
    const key = this.pendingKey;
    if (!key || key.fingerprint !== fingerprint) throw new SshError("指纹和主机现在提供的不一致，重新连接一次再确认");
    patchConnection(this.id, { hostKey: { type: key.type, fingerprint: key.fingerprint } });
    this.pendingKey = undefined;
    this.emitChange();
  }

  private async connect(): Promise<void> {
    const conn = this.connection;
    this.pendingKey = undefined;
    this.needsPassword = false;
    this.setStatus("connecting");
    const target = await resolveTarget(conn);
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      let hostKeyError: HostKeyError | null = null;
      client.once("ready", () => resolve());
      client.once("error", (err: Error & { level?: string }) => {
        if (hostKeyError) return reject(hostKeyError);
        if (err.level === "client-authentication") {
          this.needsPassword = true;
          return reject(new SshError(this.password ? "密码不对，或者服务器不接受密码登录" : "用密钥、ssh-agent 都登录不了，需要输入密码"));
        }
        reject(new SshError(`连接 ${target.user}@${target.hostname}:${target.port} 失败：${err.message}`));
      });
      client.connect({
        host: target.hostname,
        port: target.port,
        username: target.user,
        ...(target.proxyJump || target.proxyCommand ? { sock: proxySocket(target) } : {}),
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        hostVerifier: (blob: Buffer, verify: (ok: boolean) => void) => {
          void this.verifyHostKey(conn, target, blob).then(
            () => verify(true),
            (err: unknown) => {
              if (err instanceof HostKeyError) hostKeyError = err;
              verify(false);
            },
          );
        },
        authHandler: authMethods(target, this.password),
      });
    });
    this.client = client;
    this.closeReason = undefined;
    client.on("close", () => this.closed(client));
    // 连上之后的错误（保活超时、网络错误）之后都跟着 close，记下来当断开的原因
    client.on("error", (err: Error & { level?: string }) => {
      if (this.client !== client) return;
      this.closeReason = err.message === "Keepalive timeout" ? `保活超时：${KEEPALIVE_DESC}` : `网络错误：${err.message}`;
    });
    // 模型请求的反向转发：远端连 127.0.0.1:<端口>，经这条连接回到网关
    client.on("tcp connection", (details, accept, reject) => {
      if (details.destPort === this.proxyPort && this.proxy) return this.proxy.handle(accept());
      // 反向转发：在本机连配置里的地址
      const forward = this.forwards.get(details.destPort);
      if (!forward) return reject();
      const stream = accept();
      const local = net.connect({ host: forward.host, port: forward.port });
      local.on("error", () => stream.close());
      stream.on("error", () => local.destroy());
      stream.on("close", () => local.destroy());
      local.on("close", () => stream.close());
      stream.pipe(local).pipe(stream);
    });
    this.setStatus("deploying");
    this.env = await prepareRemote(this, (p) => {
      this.progress = p;
      this.emitChange();
    });
    this.progress = undefined;
    patchConnection(this.id, { facts: { platform: this.env.platform, home: this.env.home } });
    this.proxy ??= createModelProxy();
    this.proxyPort = await new Promise<number>((resolve, reject) =>
      client.forwardIn("127.0.0.1", 0, (err, port) => (err ? reject(new SshError(`远端不允许端口转发，模型请求转发不了：${err.message}`)) : resolve(port))),
    );
    await this.syncForwards(target.remoteForwards);
    this.connectedAt = Date.now();
    this.setStatus("ready");
  }

  /**
   * 按配置开、关反向转发（连上时、设置页改了之后）：远端开不了的端口（被占了、sshd 不让）记下原因，不影响连接。
   * list 不给时重新解析一次配置（~/.ssh/config 和设置页的）
   */
  async syncForwards(list?: RemoteForward[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    const wanted = list ?? (await resolveTarget(this.connection)).remoteForwards;
    const key = (f: RemoteForward) => `${f.bindHost}|${f.bindPort}|${f.host}|${f.port}`;
    const keep = new Set(wanted.map(key));
    for (const [port, f] of [...this.forwards]) {
      if (keep.has(key(f))) continue;
      this.forwards.delete(port);
      client.unforwardIn(f.bindHost, f.bindPort, () => undefined);
    }
    const have = new Set([...this.forwards.values()].map(key));
    this.forwardErrors = [];
    for (const f of wanted) {
      if (have.has(key(f))) continue;
      if ([...this.forwards.values()].some((o) => o.bindPort === f.bindPort)) {
        this.forwardErrors.push({ forward: f, error: `远端端口 ${f.bindPort} 已经用于另一条转发` });
        continue;
      }
      const error = await new Promise<string | null>((resolve) => client.forwardIn(f.bindHost, f.bindPort, (err) => resolve(err ? err.message : null)));
      if (error) this.forwardErrors.push({ forward: f, error: `远端开不了这个端口（被占用，或者 sshd 不允许）：${error}` });
      else this.forwards.set(f.bindPort, f);
    }
    this.emitChange();
  }

  /** 从网关这边连远端的 host:port（内置浏览器访问远端的 localhost 时用，见 browser/tunnel.ts） */
  async forwardOut(host: string, port: number): Promise<ClientChannel> {
    await this.ensureReady();
    const client = this.rawClient();
    return new Promise((resolve, reject) =>
      client.forwardOut("127.0.0.1", 0, host, port, (err, channel) => (err ? reject(new SshError(`远端连不上 ${hostPort(host, port)}：${err.message}`)) : resolve(channel))),
    );
  }

  private async verifyHostKey(conn: SshConnection, target: ResolvedTarget, blob: Buffer): Promise<void> {
    const key = hostKeyOf(blob);
    if (conn.hostKey) {
      if (conn.hostKey.fingerprint === key.fingerprint) return;
      this.pendingKey = { ...key, changed: true };
      throw new HostKeyError(key, true);
    }
    // 本机用 ssh 连过、known_hosts 里记着同一把密钥的，直接信任
    if (await knownHostsHas(target.knownHostsFiles, target.hostKeyAlias ?? target.hostname, target.port, blob)) {
      patchConnection(this.id, { hostKey: key });
      return;
    }
    this.pendingKey = { ...key, changed: false };
    throw new HostKeyError(key, false);
  }

  private closed(client: Client): void {
    if (this.client !== client) return;
    this.lastClose = { at: Date.now(), reason: this.closeReason ?? "远端关闭了连接" };
    this.client = null;
    this.ready = null;
    this.sftpConn = null;
    this.proxyPort = null;
    this.forwards.clear();
    this.forwardErrors = [];
    if (this.status !== "error") this.setStatus("disconnected");
    for (const l of [...this.closeListeners]) l();
  }

  private setStatus(status: SshStatus, error?: string): void {
    this.status = status;
    this.error = status === "error" ? error : undefined;
    if (status !== "deploying") this.progress = undefined;
    this.emitChange();
  }

  private emitChange(): void {
    for (const l of [...this.changeListeners]) l();
  }

  /** 准备远端时用（这时还不算 ready），其余地方用 exec / openExec */
  rawClient(): Client {
    if (!this.client) throw new SshError("SSH 连接已断开");
    return this.client;
  }

  /** 远端是 Windows：准备远端时探测到后设上，之后的命令都是 PowerShell 写的 */
  windows = false;

  /**
   * 开一个执行命令的通道；命令交给远端的 sh（用户的登录 shell 可能是 fish、csh）。
   * Windows 远端交给 PowerShell（默认 shell 可能是 cmd，也可能是 PowerShell，都不管），命令要用 PowerShell 写
   */
  async openExec(command: string, opts: ExecOptions = {}): Promise<ClientChannel> {
    await this.ensureReady();
    return this.openExecNow(command, opts);
  }

  openExecNow(command: string, opts: ExecOptions = {}): Promise<ClientChannel> {
    const client = this.rawClient();
    return new Promise((resolve, reject) =>
      client.exec(this.windows ? psCommand(command) : `exec sh -c ${shQuote(command)}`, opts, (err, channel) => (err ? reject(new SshError(`远端执行命令失败：${err.message}`)) : resolve(channel))),
    );
  }

  /**
   * 远端是不是 Windows：命令不经 sh，直接交给远端的默认 shell。
   * cmd 展开 %OS%，PowerShell 展开 $env:OS，Windows 上都是 Windows_NT；sh 两个都不展开成它
   */
  async isWindows(): Promise<boolean> {
    const client = this.rawClient();
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      client.exec("echo %OS% $env:OS", (err, ch) => (err ? reject(new SshError(`远端执行命令失败：${err.message}`)) : resolve(ch))),
    );
    const r = await collect(channel, undefined, 15_000);
    return decodeText(r.stdout).includes("Windows_NT");
  }

  /** 开一个执行命令的通道，命令原样交给远端的默认 shell（不包 sh、PowerShell） */
  async openRaw(command: string, opts: ExecOptions = {}): Promise<ClientChannel> {
    await this.ensureReady();
    const client = this.rawClient();
    return new Promise((resolve, reject) =>
      client.exec(command, opts, (err, channel) => (err ? reject(new SshError(`远端执行命令失败：${err.message}`)) : resolve(channel))),
    );
  }

  /** 执行一条命令、收齐输出 */
  async exec(command: string, opts: { stdin?: Buffer | string | Readable; timeoutMs?: number; now?: boolean } = {}): Promise<ExecResult> {
    const channel = opts.now ? await this.openExecNow(command) : await this.openExec(command);
    return collect(channel, opts.stdin, opts.timeoutMs ?? 60_000);
  }

  /** SFTP 会话，整个连接共用一个 */
  sftp(): Promise<SFTPWrapper> {
    return this.ensureReady().then(() => this.sftpNow());
  }

  /** 准备远端时用（这时还不算 ready），其余地方用 sftp() */
  sftpNow(): Promise<SFTPWrapper> {
    if (!this.sftpConn) {
      const opening = new Promise<SFTPWrapper>((resolve, reject) =>
        this.rawClient().sftp((err, sftp) => {
          if (err) return reject(new SshError(`远端打不开 SFTP：${err.message}`));
          sftp.on("close", () => {
            if (this.sftpConn === opening) this.sftpConn = null;
          });
          resolve(sftp);
        }),
      );
      opening.catch(() => {
        if (this.sftpConn === opening) this.sftpConn = null;
      });
      this.sftpConn = opening;
    }
    return this.sftpConn;
  }

  /** 模型代理的令牌：远端的 claude 拿它当 ANTHROPIC_AUTH_TOKEN，网关验过后换成真正的密钥 */
  get proxyToken(): string {
    if (!this.proxy) throw new SshError("SSH 连接还没准备好");
    return this.proxy.token;
  }
}

export function collect(channel: ClientChannel, stdin: Buffer | string | Readable | undefined, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let code: number | null = null;
    const timer = setTimeout(() => {
      channel.close();
      err.push(Buffer.from(`\n命令超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    channel.on("data", (d: Buffer) => out.push(d));
    channel.stderr.on("data", (d: Buffer) => err.push(d));
    channel.on("exit", (c: number | null) => {
      code = c;
    });
    channel.on("close", () => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: decodeText(Buffer.concat(err)) });
    });
    if (stdin === undefined) channel.end();
    else if (typeof stdin === "string" || Buffer.isBuffer(stdin)) channel.end(stdin);
    else stdin.pipe(channel);
  });
}

/** 认证顺序：配置里的私钥（加密了的跳过）→ ssh-agent → 用户输入的密码（密码登录和键盘交互都用它） */
function authMethods(target: ResolvedTarget, password: string | undefined) {
  const username = target.user;
  const methods: AnyAuthMethod[] = [];
  for (const file of target.identityFiles) {
    if (!existsSync(file)) continue;
    try {
      const key = readFileSync(file);
      // ssh2 是 CommonJS，utils 只能从默认导出里取
      const parsed = ssh2.utils.parseKey(key);
      if (parsed instanceof Error) continue;
      methods.push({ type: "publickey", username, key });
    } catch {
      // 读不了的跳过
    }
  }
  const agent = process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
  if (agent && (process.platform === "win32" || existsSync(agent))) methods.push({ type: "agent", username, agent });
  if (password) {
    methods.push({ type: "password", username, password });
    methods.push({ type: "keyboard-interactive", username, prompt: (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password)) });
  }
  let i = 0;
  const middleware: AuthHandlerMiddleware = (left, _partial, next) => {
    while (i < methods.length) {
      const m = methods[i++]!;
      const kind = m.type === "agent" ? "publickey" : m.type;
      if (!left || left.includes(kind)) return next(m);
    }
    // 没有可试的了：ssh2 约定传 false
    next(false as unknown as AnyAuthMethod);
  };
  return middleware;
}

/** ProxyJump、ProxyCommand：交给本机 ssh 建隧道，ssh2 在它的标准输入输出上握手 */
function proxySocket(target: ResolvedTarget): Duplex {
  let child;
  if (target.proxyJump) {
    const jumps = target.proxyJump.split(",");
    child = spawn(sshBin(), ["-o", "BatchMode=yes", ...(jumps.length > 1 ? ["-J", jumps.slice(0, -1).join(",")] : []), "-W", `${target.hostname}:${target.port}`, jumps.at(-1)!], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } else {
    const command = target.proxyCommand!.replace(/%h/g, target.hostname).replace(/%p/g, String(target.port)).replace(/%r/g, target.user).replace(/%%/g, "%");
    child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  }
  // 两个方向各是 ssh 子进程的一端，拼成一个双工流
  return new ProxyStream(child.stdout!, child.stdin!);
}

class ProxyStream extends Duplex {
  constructor(private readonly out: Readable, private readonly inp: Writable) {
    super();
    out.on("data", (d: Buffer) => {
      if (!this.push(d)) out.pause();
    });
    out.on("end", () => this.push(null));
    out.on("error", (err) => this.destroy(err));
    inp.on("error", (err) => this.destroy(err));
  }
  override _read(): void {
    this.out.resume();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.inp.write(chunk, cb);
  }
  override _final(cb: (err?: Error | null) => void): void {
    this.inp.end(cb);
  }
}
