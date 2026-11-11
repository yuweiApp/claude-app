import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { config } from "../config.js";
import { sshRegistries } from "../config-file.js";
import type { SshHost } from "./host.js";
import { collect, decodeText, psQuote, shQuote, SshError } from "./host.js";
import { fromWindowsPath, nativePath } from "./location.js";
import { sftpUpload, sftpWrite } from "./remote-ops.js";

/**
 * 准备远端：远端用户目录下的 ~/.claude-app 放网关用的东西，和远端用户自己的 ~/.claude 分开（同本机的配置隔离）：
 * - bin/claude-<SDK 版本>：Claude Code，和网关的 SDK 同一个版本（不同版本的协议可能对不上），旧版本删掉
 * - bin/launch.sh：启动脚本，从标准输入读环境变量、参数和工作目录，再 exec claude（密钥不出现在命令行里）
 * - claude-home：远端 claude 的配置目录（会话记录在这里）
 * - workspace：远端的普通会话（scratch-…）和上传的附件
 * 远端支持 macOS、Linux、Windows（x64、arm64）。Windows 上是 %USERPROFILE%\.claude-app，claude-<版本>.exe、launch.ps1，
 * 命令都用 PowerShell 写（SshHost.windows）；这里的路径一律是 posix 写法（/C:/Users/…，见 location.ts）
 */
export interface RemoteEnv {
  windows: boolean;
  home: string;
  /** darwin-arm64、linux-x64、linux-x64-musl、win32-x64 这样 */
  platform: string;
  /** 远端用户登录 shell 里的 PATH（claude 的 Bash 工具、git 等按它找命令） */
  path: string;
  shell: string;
  root: string;
  bin: string;
  launcher: string;
  configDir: string;
  workspace: string;
  attachments: string;
  /** Windows：启动 claude 时网关经 SFTP 写的配置文件放这里，启动脚本读完就删 */
  runDir?: string;
  /** Windows：Git for Windows 的 bash.exe（Claude Code 的 Bash 工具用它，远端的 Windows 写法），传给 CLAUDE_CODE_GIT_BASH_PATH */
  gitBash?: string;
  /** Windows：Claude Code 每条 Bash 命令前先执行的脚本（CLAUDE_ENV_FILE），把控制台代码页切到 UTF-8 */
  bashEnv?: string;
}

const require = createRequire(import.meta.url);
const sdkDir = path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
export const SDK_VERSION = (JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8")) as { version: string }).version;

const PATH_MARK = "__CLAUDE_APP_PATH__=";

export async function prepareRemote(host: SshHost, onProgress: (p: number) => void): Promise<RemoteEnv> {
  host.windows = false;
  const probe = await probeRemote(host);
  if (probe === null) {
    host.windows = true;
    return prepareWindows(host, onProgress);
  }
  const lines = probe.split("\n");
  const [home, sys, machine, shell, libc] = lines;
  // Windows 主机把 SSH 的默认 shell 设成了 Git Bash、MSYS2、Cygwin：sh 能用，但这是 Windows，按 Windows 准备（命令交给 PowerShell）
  if (/^(MINGW|MSYS|CYGWIN)/i.test(sys ?? "")) {
    host.windows = true;
    return prepareWindows(host, onProgress);
  }
  const remotePath = lines.find((l) => l.startsWith(PATH_MARK))?.slice(PATH_MARK.length) || "/usr/local/bin:/usr/bin:/bin";
  if (!home?.startsWith("/")) throw new SshError(`读不到远端的用户目录：${probe.slice(0, 200)}`);
  const platform = platformOf(sys ?? "", machine ?? "", libc === "musl");
  const root = `${home}/.claude-app`;
  const env: RemoteEnv = {
    windows: false,
    home,
    platform,
    path: remotePath,
    shell: shell || "/bin/sh",
    root,
    bin: `${root}/bin/claude-${SDK_VERSION}`,
    launcher: `${root}/bin/launch.sh`,
    configDir: `${root}/claude-home`,
    workspace: `${root}/workspace`,
    attachments: `${root}/workspace/.attachments`,
  };
  await run(host, `mkdir -p ${shQuote(`${root}/bin`)} ${shQuote(env.configDir)} ${shQuote(env.attachments)} && cat > ${shQuote(env.launcher)}`, 30_000, LAUNCHER);
  const installed = (await runRaw(host, `test -x ${shQuote(env.bin)}`, 15_000)).code === 0;
  if (!installed) await upload(host, env, onProgress);
  return env;
}

/**
 * 探测远端的用户目录、系统、shell 和 PATH。远端的默认 shell 不是 sh 系的（Windows 的 cmd、PowerShell）时这一步会失败，
 * 再问一次是不是 Windows，是就返回 null
 */
async function probeRemote(host: SshHost): Promise<string | null> {
  const r = await runRaw(
    host,
    [
      'printf "%s\\n" "$HOME" "$(uname -s)" "$(uname -m)" "${SHELL:-/bin/sh}"',
      "if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; else echo glibc; fi",
      // 登录 shell（交互式，同终端里）的 PATH：nvm、homebrew 等常在 .zshrc、.bashrc 里加；标准输入是 /dev/null，免得它读走什么
      `P=$("\${SHELL:-/bin/sh}" -l -i -c env </dev/null 2>/dev/null | sed -n 's/^PATH=//p' | tail -n 1)`,
      `printf "${PATH_MARK}%s\\n" "\${P:-$PATH}"`,
    ].join("\n"),
    30_000,
  );
  if (r.code === 0) return decodeText(r.stdout);
  if (await host.isWindows().catch(() => false)) return null;
  throw commandError(r);
}

function commandError(r: { code: number | null; stdout: Buffer; stderr: string }): SshError {
  return new SshError(`远端命令失败：${(r.stderr || decodeText(r.stdout)).trim().slice(0, 500) || `退出码 ${r.code}`}`);
}

function platformOf(sys: string, machine: string, musl: boolean): string {
  const arch = /^(x86_64|amd64)$/i.test(machine) ? "x64" : /^(arm64|aarch64)$/i.test(machine) ? "arm64" : null;
  if (sys === "Darwin" && arch) return `darwin-${arch}`;
  if (sys === "Linux" && arch) return `linux-${arch}${musl ? "-musl" : ""}`;
  throw new SshError(`远端系统不支持：${sys} ${machine}（只支持 macOS、Linux、Windows 的 x64、arm64）`);
}

async function prepareWindows(host: SshHost, onProgress: (p: number) => void): Promise<RemoteEnv> {
  // 32 位的 PowerShell 里 PROCESSOR_ARCHITECTURE 是 x86，真正的在 PROCESSOR_ARCHITEW6432
  const probe = await run(
    host,
    [
      "$a = $env:PROCESSOR_ARCHITECTURE; if ($env:PROCESSOR_ARCHITEW6432) { $a = $env:PROCESSOR_ARCHITEW6432 }",
      // Git for Windows 的 bash.exe：远端设了 CLAUDE_CODE_GIT_BASH_PATH 用它；否则从 git.exe 往上找 bin\bash.exe（cmd\git.exe、mingw64\bin\git.exe 都有），再看常见的安装位置
      "$b = ''",
      "if ($env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path -LiteralPath $env:CLAUDE_CODE_GIT_BASH_PATH -PathType Leaf)) { $b = $env:CLAUDE_CODE_GIT_BASH_PATH }",
      "$g = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1",
      "if (-not $b -and $g) { $d = Split-Path $g.Source; foreach ($i in 1..3) { $c = Join-Path $d 'bin\\bash.exe'; if (Test-Path -LiteralPath $c -PathType Leaf) { $b = $c; break }; $d = Split-Path $d; if (-not $d) { break } } }",
      "if (-not $b) { foreach ($c in @(\"$env:ProgramFiles\\Git\\bin\\bash.exe\", \"${env:ProgramFiles(x86)}\\Git\\bin\\bash.exe\", \"$env:LOCALAPPDATA\\Programs\\Git\\bin\\bash.exe\")) { if (Test-Path -LiteralPath $c -PathType Leaf) { $b = $c; break } } }",
      '@($env:USERPROFILE, $a, $env:Path, $b) -join "`n"',
    ].join("\n"),
    30_000,
  );
  const [profile, machine, remotePath, gitBash] = probe.split(/\r?\n/);
  const home = fromWindowsPath(profile?.trim() ?? "");
  if (!home.startsWith("/")) throw new SshError(`读不到远端的用户目录：${probe.slice(0, 200)}`);
  const arch = /^amd64$/i.test(machine ?? "") ? "x64" : /^arm64$/i.test(machine ?? "") ? "arm64" : null;
  if (!arch) throw new SshError(`远端系统不支持：Windows ${machine}（只支持 x64、arm64）`);
  // Claude Code 在 Windows 上用 Git 自带的 bash 执行命令，没有它一启动就退出
  if (!gitBash?.trim()) {
    throw new SshError(
      "远端没有 Git for Windows：Claude Code 在 Windows 上要用 Git 自带的 bash 执行命令。在远端装好 Git（https://git-scm.com/downloads/win）后重新连接；" +
        "装在别处的，在远端给用户设环境变量 CLAUDE_CODE_GIT_BASH_PATH，指向 bash.exe",
    );
  }
  const root = `${home}/.claude-app`;
  const env: RemoteEnv = {
    windows: true,
    home,
    platform: `win32-${arch}`,
    path: remotePath ?? "",
    shell: "powershell.exe",
    root,
    bin: `${root}/bin/claude-${SDK_VERSION}.exe`,
    launcher: `${root}/bin/launch.ps1`,
    configDir: `${root}/claude-home`,
    workspace: `${root}/workspace`,
    attachments: `${root}/workspace/.attachments`,
    runDir: `${root}/run`,
    gitBash: gitBash.trim(),
    bashEnv: `${root}/bin/bash-env.sh`,
  };
  const w = (p: string) => psQuote(nativePath(true, p));
  // run 里剩下的配置文件（启动脚本没起来就断开了的）删掉
  const out = await run(
    host,
    [
      `New-Item -ItemType Directory -Force -Path ${w(`${root}/bin`)}, ${w(env.configDir)}, ${w(env.attachments)}, ${w(env.runDir!)} | Out-Null`,
      `Get-ChildItem -LiteralPath ${w(env.runDir!)} -File | Remove-Item -Force -ErrorAction SilentlyContinue`,
      `if (Test-Path -LiteralPath ${w(env.bin)} -PathType Leaf) { 'installed' }`,
    ].join("\n"),
    30_000,
  );
  // 启动脚本经 SFTP 写，开头加 BOM：PowerShell 5.1 把没有 BOM 的脚本当成系统的 ANSI 编码
  await sftpWrite(await host.sftpNow(), env.launcher, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LAUNCHER_PS, "utf8")]));
  // bash 读不了 CRLF，换行写死成 \n
  await sftpWrite(await host.sftpNow(), env.bashEnv!, Buffer.from(BASH_ENV_WIN, "utf8"));
  if (out.trim() !== "installed") await uploadWindows(host, env, onProgress);
  return env;
}

/**
 * Windows 远端装 Claude Code：系统自带 curl.exe、tar.exe（Windows 10 1803 起），远端自己按顺序从各个源下载平台包，
 * 下不了时网关下载后经 SFTP 传过去；都在远端校验 sha512、解出 claude.exe。
 * 上次下好了、没装成的包（校验通过）直接用
 */
async function uploadWindows(host: SshHost, env: RemoteEnv, onProgress: (p: number) => void): Promise<void> {
  const w = (p: string) => psQuote(nativePath(true, p));
  const tgz = `${env.bin}.part.tgz`;
  const meta = await packageMeta(env.platform).catch(() => null);
  onProgress(0);
  if (meta) {
    const script = [
      `$t = ${w(tgz)}`,
      testPackage(meta),
      "if (-not ((Test-Path -LiteralPath $t -PathType Leaf) -and (Test-Package))) {",
      "  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { exit 3 }",
      "  $ok = $false",
      // 按顺序换源：下载失败、校验不通过都试下一个，都不行由网关上传
      `  foreach ($u in @(${meta.tarballs.map(psQuote).join(", ")})) {`,
      "    Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue",
      "    curl.exe -fsSL --connect-timeout 10 --max-time 1800 -o $t $u",
      "    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine(\"下载失败：$u\"); continue }",
      "    if (Test-Package) { $ok = $true; break }",
      "    [Console]::Error.WriteLine(\"校验不通过：$u\")",
      "  }",
      "  if (-not $ok) { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue; exit 3 }",
      "}",
      extractWindows(env),
    ].join("\n");
    const r = await runRaw(host, script, (meta.tarballs.length * 30 + 5) * 60_000);
    if (r.code === 0) return;
    if (r.code !== 3) throw new SshError(`安装 Claude Code 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
  }
  const m = meta ?? (await packageMeta(env.platform));
  const file = await downloadPackage(env.platform, m, (p) => onProgress(p * 0.3));
  const size = (await stat(file)).size;
  await sftpUpload(await host.sftpNow(), tgz, createReadStream(file).pipe(progress(size, (p) => onProgress(0.3 + p * 0.7)))).catch((err: Error) => {
    throw new SshError(`上传 Claude Code 失败：${err.message}`);
  });
  const script = [
    `$t = ${w(tgz)}`,
    testPackage(m),
    "if (-not (Test-Package)) { Remove-Item -LiteralPath $t -Force; [Console]::Error.WriteLine('校验不通过'); exit 4 }",
    extractWindows(env),
  ].join("\n");
  const r = await runRaw(host, script, 10 * 60_000);
  if (r.code !== 0) throw new SshError(`上传 Claude Code 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
}

/** PowerShell 函数 Test-Package：$t（平台包）的 sha512 和 npm 给的一样 */
function testPackage(meta: PackageMeta): string {
  return [
    "function Test-Package {",
    "  $h = (Get-FileHash -Algorithm SHA512 -LiteralPath $t).Hash",
    "  $b = New-Object byte[] ($h.Length / 2); for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($h.Substring($i * 2, 2), 16) }",
    `  [Convert]::ToBase64String($b) -eq ${psQuote(meta.integrity.slice("sha512-".length))}`,
    "}",
  ].join("\n");
}

/** PowerShell：从 $t（校验过的平台包）解出 claude.exe 放到 env.bin，删掉包和旧版本 */
function extractWindows(env: RemoteEnv): string {
  const w = (p: string) => psQuote(nativePath(true, p));
  return [
    `$x = ${w(`${env.root}/bin/.extract`)}`,
    "if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Recurse -Force }",
    "New-Item -ItemType Directory -Force -Path $x | Out-Null",
    "tar.exe -xzf $t -C $x package/claude.exe",
    "if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('解压失败（远端要有 tar.exe，Windows 10 1803 起自带）'); exit 5 }",
    `Move-Item -LiteralPath (Join-Path $x 'package/claude.exe') -Destination ${w(env.bin)} -Force`,
    "Remove-Item -LiteralPath $x, $t -Recurse -Force",
    `Get-ChildItem -LiteralPath ${w(`${env.root}/bin`)} -Filter 'claude-*.exe' | Where-Object { $_.FullName -ne ${w(env.bin)} } | Remove-Item -Force -ErrorAction SilentlyContinue`,
  ].join("\n");
}

/** 本机的平台包名后缀，和远端一样时直接传本机的 claude */
function localPlatform(): string {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "other";
  if (process.platform === "linux") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return `linux-${arch}${report?.header?.glibcVersionRuntime ? "" : "-musl"}`;
  }
  return `${process.platform}-${arch}`;
}

/** 上传 Claude Code：先传到临时文件，完整了再改名，传到一半断了不会留下坏的 */
async function upload(host: SshHost, env: RemoteEnv, onProgress: (p: number) => void): Promise<void> {
  const tmp = `${env.bin}.part`;
  const finish = `chmod 755 ${shQuote(tmp)} && mv -f ${shQuote(tmp)} ${shQuote(env.bin)} && for f in ${shQuote(`${env.root}/bin`)}/claude-*; do [ "$f" = ${shQuote(env.bin)} ] || rm -f -- "$f"; done`;
  // 先让远端自己从 npm 源（config.yml 的 ssh.registries）下载那个平台的包（按 npm 给的 sha512 校验）：比经 SSH 传快得多（传 150 MB 的包，慢的线路要十几分钟）
  const meta = await packageMeta(env.platform).catch(() => null);
  onProgress(0);
  if (meta && (await remoteDownload(host, meta, tmp, finish))) return;
  // 远端上不了网：本机就是这个平台时压缩着传本机的 claude，否则网关下载那个平台的包传过去
  let local: string | null = null;
  try {
    local = require.resolve(`@anthropic-ai/claude-agent-sdk-${env.platform}/package.json`);
  } catch {
    local = null;
  }
  const localBin = local && path.join(path.dirname(local), "claude");
  if (localBin && env.platform === localPlatform() && existsSync(localBin)) {
    const size = (await stat(localBin)).size;
    const source = createReadStream(localBin).pipe(progress(size, onProgress)).pipe(createGzip({ level: 6 }));
    const r = await runRaw(host, `gzip -dc > ${shQuote(tmp)} && ${finish}`, 60 * 60_000, source);
    if (r.code !== 0) throw new SshError(`上传 Claude Code 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
    return;
  }
  // 前面取信息失败时再取一次，这次把原因报出来
  const tgz = await downloadPackage(env.platform, meta ?? (await packageMeta(env.platform)), (p) => onProgress(p * 0.3));
  const size = (await stat(tgz)).size;
  const source = createReadStream(tgz).pipe(progress(size, (p) => onProgress(0.3 + p * 0.7)));
  const r = await runRaw(host, `tar -xzOf - package/claude > ${shQuote(tmp)} && ${finish}`, 60 * 60_000, source);
  if (r.code !== 0) throw new SshError(`上传 Claude Code 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
}

interface PackageMeta {
  name: string;
  /** 按 config.yml 的 ssh.registries 顺序，每个源一个下载地址 */
  tarballs: string[];
  /** sha512-base64 */
  integrity: string;
}

/**
 * @anthropic-ai/claude-agent-sdk-<平台>@<SDK 版本> 的下载地址和校验值：包信息取第一个能取到的源，
 * 每个源的下载地址按 npm 的标准路径拼（取到包信息的那个源用它给的完整地址；华为云给的是 / 开头的相对路径，按主机补全不对，也按标准路径拼）
 */
async function packageMeta(platform: string): Promise<PackageMeta> {
  const name = `claude-agent-sdk-${platform}`;
  const standard = (r: string) => `${r}/@anthropic-ai/${name}/-/${name}-${SDK_VERSION}.tgz`;
  const errors: string[] = [];
  for (const r of sshRegistries) {
    try {
      const res = await fetch(`${r}/@anthropic-ai%2f${name}/${SDK_VERSION}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = (await res.json()) as { dist?: { tarball?: string; integrity?: string } };
      if (!meta.dist?.tarball || !meta.dist.integrity?.startsWith("sha512-")) throw new Error("包信息里没有下载地址或 sha512");
      const own = /^https?:\/\//.test(meta.dist.tarball) ? meta.dist.tarball : standard(r);
      return { name, tarballs: sshRegistries.map((x) => (x === r ? own : standard(x))), integrity: meta.dist.integrity };
    } catch (err) {
      errors.push(`${r}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new SshError(`取不到 ${name}@${SDK_VERSION} 的信息（config.yml 的 ssh.registries）：${errors.join("；")}`);
}

/** 远端用 curl / wget 按顺序从各个源下载，openssl 校验 sha512；远端缺工具、各个源都下不了或校验不通过都返回 false，改由网关上传 */
async function remoteDownload(host: SshHost, meta: PackageMeta, tmp: string, finish: string): Promise<boolean> {
  const expected = meta.integrity.slice("sha512-".length);
  const script = [
    `T=${shQuote(`${tmp}.tgz`)}`,
    'if command -v curl >/dev/null 2>&1; then dl() { curl -fsSL --connect-timeout 10 --max-time 900 -o "$T" "$1"; }',
    'elif command -v wget >/dev/null 2>&1; then dl() { wget -q -T 10 -O "$T" "$1"; }',
    "else exit 3; fi",
    "command -v openssl >/dev/null 2>&1 || exit 3",
    `for u in ${meta.tarballs.map(shQuote).join(" ")}; do`,
    '  rm -f "$T"',
    '  dl "$u" || { echo "下载失败：$u" >&2; continue; }',
    `  if [ "$(openssl dgst -sha512 -binary "$T" | openssl base64 -A)" = ${shQuote(expected)} ]; then`,
    `    tar -xzOf "$T" package/claude > ${shQuote(tmp)} && rm -f "$T" && ${finish}`,
    "    exit $?",
    "  fi",
    '  echo "校验不通过：$u" >&2',
    "done",
    'rm -f "$T"',
    "exit 3",
  ].join("\n");
  const r = await runRaw(host, script, (meta.tarballs.length * 15 + 5) * 60_000);
  return r.code === 0;
}

/** 网关按顺序从各个源下载那个平台的包，校验后缓存在配置目录的 gateway-ssh-bin 下 */
async function downloadPackage(platform: string, meta: PackageMeta, onProgress: (p: number) => void): Promise<string> {
  const dir = path.join(config.claudeConfigDir, "gateway-ssh-bin");
  const file = path.join(dir, `${meta.name}-${SDK_VERSION}.tgz`);
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true });
  const part = `${file}.part`;
  const errors: string[] = [];
  for (const url of meta.tarballs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash("sha512");
      const total = Number(res.headers.get("content-length")) || 0;
      let got = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          got += chunk.length;
          if (total) onProgress(Math.min(1, got / total));
          cb(null, chunk);
        },
      });
      await pipeline(res.body as unknown as Readable, tap, createWriteStream(part));
      if (`sha512-${hash.digest("base64")}` !== meta.integrity) throw new Error("校验不通过");
      await rename(part, file);
      return file;
    } catch (err) {
      await rm(part, { force: true });
      errors.push(`${url}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new SshError(`下载 ${meta.name}@${SDK_VERSION} 失败（平台 ${platform}）：${errors.join("；")}`);
}

function progress(total: number, onProgress: (p: number) => void): Transform {
  let sent = 0;
  let last = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      const p = total ? sent / total : 0;
      if (p - last >= 0.01 || p >= 1) {
        last = p;
        onProgress(Math.min(1, p));
      }
      cb(null, chunk);
    },
  });
}

/** 准备阶段还不算 ready，直接在连接上执行 */
async function runRaw(host: SshHost, command: string, timeoutMs: number, stdin?: string | Buffer | Readable) {
  const channel = await host.openExecNow(command);
  return collect(channel, stdin, timeoutMs);
}

async function run(host: SshHost, command: string, timeoutMs: number, stdin?: string | Buffer): Promise<string> {
  const r = await runRaw(host, command, timeoutMs, stdin);
  if (r.code !== 0) throw commandError(r);
  return decodeText(r.stdout);
}

/**
 * 启动脚本：标准输入开头是网关写的几行 sh 语句（环境变量、cd、参数），空行结束，之后的输入原样交给 claude。
 * 先打印一行标记再 exec：标记之前的输出（远端 .bashrc 里 echo 的东西）网关丢掉，不当成 claude 的输出
 */
const LAUNCHER = `#!/bin/sh
# claude-app 网关上传的启动脚本（gateway/src/ssh/deploy.ts），每次连接时重写
N='
'
set --
while IFS= read -r CLAUDE_APP_LINE; do
  [ -z "$CLAUDE_APP_LINE" ] && break
  eval "$CLAUDE_APP_LINE"
done
unset CLAUDE_APP_LINE N
# claude 是 Bun 编译的，也读 NODE_OPTIONS：用户给 Node 设的会让它起不来
unset NODE_OPTIONS
printf '%s\\n' "$CLAUDE_APP_MARKER"
exec "$CLAUDE_APP_BIN" "$@"
`;

/**
 * Windows 的启动脚本：参数是网关经 SFTP 写的配置文件（JSON：bin、marker、env、cwd、args，args 已经按 Windows 命令行的规则拼好），
 * 读完就删（里面有模型代理的令牌）。不从标准输入读：PowerShell 读标准输入实测偶尔一直读不到。
 * claude 用 .NET 的 Process 起（不重定向），继承这个进程的标准输入输出。同 launch.sh，先打印一行标记
 */
const LAUNCHER_PS = `# claude-app 网关上传的启动脚本（gateway/src/ssh/deploy.ts），每次连接时重写
param([string]$ConfigFile)
try { $cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json } finally { Remove-Item -LiteralPath $ConfigFile -Force -ErrorAction SilentlyContinue }
# 远端用户自己设了 CLAUDE_ENV_FILE 的：网关的 bash-env.sh 执行完再接着执行它
if ($env:CLAUDE_ENV_FILE -and -not $env:CLAUDE_APP_USER_ENV_FILE) { $env:CLAUDE_APP_USER_ENV_FILE = $env:CLAUDE_ENV_FILE }
foreach ($p in $cfg.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Process') }
# claude 是 Bun 编译的，也读 NODE_OPTIONS：用户给 Node 设的（比如 VS Code 调试器的 --require）会让它起不来，什么也不输出
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
# 模型请求发到远端的 127.0.0.1，远端自己配了代理时不能走代理
$np = $env:NO_PROXY
$env:NO_PROXY = if ($np) { "127.0.0.1,localhost,$np" } else { '127.0.0.1,localhost' }
if (-not (Test-Path -LiteralPath $cfg.cwd -PathType Container)) { [Console]::Error.WriteLine("工作目录不存在：" + $cfg.cwd); exit 97 }
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $cfg.bin
$psi.Arguments = $cfg.args
$psi.WorkingDirectory = $cfg.cwd
$psi.UseShellExecute = $false
$out = [Console]::OpenStandardOutput()
$m = [Text.Encoding]::UTF8.GetBytes($cfg.marker + "\`n")
$out.Write($m, 0, $m.Length)
$out.Flush()
$proc = [Diagnostics.Process]::Start($psi)
$proc.WaitForExit()
exit $proc.ExitCode
`;

/**
 * Windows 远端的 CLAUDE_ENV_FILE：Claude Code 的 Bash 工具跑的是 Git Bash，模型在里面调 ipconfig、dir 等原生程序时，
 * 它们按控制台代码页输出（中文系统是 936，GBK），Claude Code 按 UTF-8 读，中文全成了乱码。Claude Code 每条 Bash 命令前
 * 先在同一个 shell 里执行 CLAUDE_ENV_FILE，这里 chcp 65001。不用 BASH_ENV：Claude Code 起 bash 时把它当不安全的变量去掉了
 * （实测 2.1.322：BASH_ENV 设了，代码页还是 936；CLAUDE_ENV_FILE 生效）
 */
const BASH_ENV_WIN = [
  "# claude-app 网关上传（gateway/src/ssh/deploy.ts），每次连接时重写：远端 claude 每条 Bash 命令前先执行，控制台代码页切到 UTF-8",
  "chcp.com 65001 >/dev/null 2>&1",
  'if [ -n "${CLAUDE_APP_USER_ENV_FILE:-}" ]; then . "$CLAUDE_APP_USER_ENV_FILE"; fi',
  "",
].join("\n");
