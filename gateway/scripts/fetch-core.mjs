#!/usr/bin/env node
/**
 * 下载设置页「网络代理」订阅模式用的代理内核 mihomo（见 docs/proxy-subscription.md）。
 * 版本和每个平台文件的 sha256 写死在这里，校验不过不用。放到 gateway/vendor/mihomo/<平台>-<架构>/（不提交）。
 * 当成依赖装：npm install 时自动跑（postinstall，--optional），网关启动时没找到内核也会自己跑一次（net/core.ts）。
 *
 *   npm --prefix gateway run fetch-core                       # 当前平台；已经是这个版本就跳过
 *   npm --prefix gateway run fetch-core -- --force            # 重新下载
 *   npm --prefix gateway run fetch-core -- --platform win32 --arch x64   # 别的平台（打包用）
 *
 * --optional：下载失败只提示、退出码 0（不让 npm install 失败）；设了 MIHOMO_PATH 或 CLAUDE_APP_SKIP_CORE=1 时什么都不做。
 * 连 GitHub 要代理时设 HTTPS_PROXY（只认 http:// 的代理）。也可以自己下载解压，放到上面的目录，或者用 MIHOMO_PATH 指到已有的 mihomo
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const VERSION = "v1.19.33";
/** <平台>-<架构> → 发布包的文件名和 sha256（GitHub 发布页给的）；amd64 用 v1 版（兼容老 CPU） */
const ASSETS = {
  "linux-x64": ["mihomo-linux-amd64-v1-v1.19.33.gz", "8ec92e7b2fdc6b853ba00156bab7e4e965c8b0d843b8c4ac8ab98795f02ad524"],
  "linux-arm64": ["mihomo-linux-arm64-v1.19.33.gz", "ba408b317080ee265c46cb923a50018c1b82cbd708551cdd46a1e3e307396187"],
  "darwin-x64": ["mihomo-darwin-amd64-v1-v1.19.33.gz", "61f979d6aae3deffe4e3895161349c3d9189149eef88c5aceb7c6d4a7270a78d"],
  "darwin-arm64": ["mihomo-darwin-arm64-v1.19.33.gz", "060b64b0f2c9a310831db0fe4adb2878de67bfa606c311813c1f13966aa504b6"],
  "win32-x64": ["mihomo-windows-amd64-v1-v1.19.33.zip", "fb0b960eff568459502d4ebe53e9cca203053d86ec9024fe935f19615d74d9aa"],
  "win32-arm64": ["mihomo-windows-arm64-v1.19.33.zip", "a2a26869a14634c49f3fbcecc593b498ed8591fbdd7616b24475b3d60b148da3"],
};

const has = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const optional = has("optional");

/** 失败：--optional 时只提示（npm install 照常完成），否则退出码 1 */
function fail(message) {
  console.error(optional ? `跳过代理内核 mihomo：${message}（订阅模式要用时网关会再试；也可以之后运行 npm --prefix gateway run fetch-core）` : message);
  process.exit(optional ? 0 : 1);
}

async function main() {
  if (optional && (process.env.MIHOMO_PATH || process.env.CLAUDE_APP_SKIP_CORE === "1")) return;
  const platform = arg("platform") ?? process.platform;
  const arch = arg("arch") ?? process.arch;
  const key = `${platform}-${arch}`;
  const asset = ASSETS[key];
  if (!asset) return fail(`不支持的平台：${key}（支持 ${Object.keys(ASSETS).join("、")}）`);
  const [file, sha256] = asset;
  const exe = platform === "win32" ? "mihomo.exe" : "mihomo";
  const outDir = path.resolve(import.meta.dirname, "..", "vendor", "mihomo", key);
  const target = path.join(outDir, exe);
  const versionFile = path.join(outDir, "VERSION");

  const current = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : null;
  if (!has("force") && existsSync(target) && current === VERSION) {
    console.log(`代理内核 mihomo ${VERSION} 已经在 ${target}`);
    return;
  }

  if (process.env.HTTPS_PROXY || process.env.https_proxy) setGlobalDispatcher(new EnvHttpProxyAgent());
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/${file}`;
  console.log(`下载代理内核 ${url}`);
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) return fail(`下载失败：HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const cause = err?.cause;
    return fail(`下载失败：${cause?.code ?? cause?.message ?? err?.message ?? err}${err?.name === "TimeoutError" ? "（10 分钟没下载完）" : ""}`);
  }
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== sha256) return fail(`sha256 不对，不用这个文件：应为 ${sha256}，实际 ${got}`);

  mkdirSync(outDir, { recursive: true });
  if (file.endsWith(".gz")) {
    writeFileSync(`${target}.tmp`, gunzipSync(data), { mode: 0o755 });
    renameSync(`${target}.tmp`, target);
  } else {
    // zip：用系统自带的 tar 解（Windows 10 起、macOS 的 tar 都能解 zip），解出来的文件名带平台和版本，改成 mihomo.exe
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mihomo-"));
    try {
      const zip = path.join(tmp, file);
      writeFileSync(zip, data);
      execFileSync("tar", ["-xf", zip, "-C", tmp]);
      const found = readdirSync(tmp).find((n) => n.endsWith(".exe"));
      if (!found) return fail("压缩包里没有 .exe");
      rmSync(target, { force: true });
      renameSync(path.join(tmp, found), target);
    } catch (err) {
      return fail(`解压失败：${err?.message ?? err}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (platform !== "win32") chmodSync(target, 0o755);
  if (platform === "darwin" && process.platform === "darwin") {
    // 下载来的可执行文件 macOS 可能打隔离标记，去掉才能直接跑
    try {
      execFileSync("xattr", ["-d", "com.apple.quarantine", target], { stdio: "ignore" });
    } catch {
      // 没有这个标记
    }
  }
  // VERSION 最后写：写了它就表示可执行文件是完整的
  writeFileSync(versionFile, `${VERSION}\n`);
  console.log(`代理内核 mihomo ${VERSION} 已放到 ${target}`);
}

await main().catch((err) => fail(err?.message ?? String(err)));
