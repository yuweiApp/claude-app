import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { PAGE_TYPES } from "../files/content.js";

/** 打包时记下「按哪一版源码打的」（源码里最新的修改时间），放在打包目录里 */
const STAMP = ".built-from";
/** 访客打开页面时最多多久检查一次源码有没有改 */
const CHECK_INTERVAL_MS = 5_000;
/** 留着多久以前打包的 assets：已经打开着的页面还会按需加载它的旧文件 */
const KEEP_OLD_ASSETS_MS = 7 * 24 * 3600_000;
/** 小于这个的不压缩 */
const MIN_COMPRESS_BYTES = 1024;

/** 参与打包的源码：改了任何一个就要重新打包 */
const SOURCES = () => [
  path.join(config.clientDir, "src"),
  path.join(config.clientDir, "public"),
  path.join(config.clientDir, "index.html"),
  path.join(config.clientDir, "vite.config.ts"),
  path.join(config.clientDir, "package.json"),
  path.join(config.clientDir, "tsconfig.json"),
  path.resolve(config.clientDir, "..", "gateway", "src", "shared"),
];

/** 值得压缩的类型（图片、字体本来就压过） */
export const compressible = (type: string | undefined): boolean =>
  !!type && !type.includes("event-stream") && /^(text\/|application\/(json|javascript|wasm|xml)|image\/svg)/.test(type);

/** 浏览器接受的压缩方式：优先 brotli */
export function pickEncoding(req: IncomingMessage): "br" | "gzip" | null {
  const accept = String(req.headers["accept-encoding"] ?? "");
  if (/\bbr\b/.test(accept)) return "br";
  if (/\bgzip\b/.test(accept)) return "gzip";
  return null;
}

/**
 * 公网分享的访客用的打包版网页（见 docs/lan-share.md「公网分享」）：开发时页面是 Vite 开发服务器发的，
 * 没压缩、几十个模块各一个请求，经公网很慢。网关在后台用 vite build 打一份（源码比打包新时重新打），公网入口直接发它：
 * assets 文件名带哈希，长期缓存；文本内容压缩（brotli / gzip，压过的留在内存里）。一次都还没打好、打包失败时照旧转给 Vite；
 * 源码改了重新打包期间先发上一次打的。
 */
export class ClientBundle {
  /** 有打包好的能发（可能是按旧源码打的：重新打包期间先发旧的，打好了换新的） */
  private usable = false;
  /** 正在做的检查（含打包）：同时只做一次，后来的等它 */
  private running: Promise<void> | null = null;
  private lastCheck = 0;
  /** 压过的内容：路径 + 修改时间 + 压缩方式 */
  private readonly compressed = new Map<string, Buffer>();

  constructor(private readonly log: FastifyBaseLogger) {}

  get dir(): string {
    return config.shareClientDist;
  }

  /** 访客打开页面时（最多 5 秒一次）、开公网分享时：源码比打包新就在后台重新打 */
  check(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastCheck < CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    if (this.running) return;
    this.running = this.ensure()
      .catch((err: unknown) => this.log.error({ err }, "检查公网分享的打包版网页失败"))
      .finally(() => {
        this.running = null;
      });
  }

  private async ensure(): Promise<void> {
    const newest = await newestSource();
    const built = Number(await readFile(path.join(this.dir, STAMP), "utf8").catch(() => "0"));
    const hasIndex = existsSync(path.join(this.dir, "index.html"));
    // 没有源码（打包好的桌面版）：有什么用什么
    this.usable = hasIndex;
    if (newest === 0 || (hasIndex && built >= newest)) return;
    const vite = path.join(config.clientDir, "node_modules", "vite", "bin", "vite.js");
    if (!existsSync(vite)) {
      this.log.warn({ vite }, "找不到 vite，公网分享的访客照旧用开发服务器的页面");
      return;
    }
    await this.build(vite, newest);
  }

  /** 打到临时目录，再把新的 assets 拷进打包目录（旧的留着，已经打开着的页面还要用）、换掉其他文件 */
  private async build(vite: string, newest: number): Promise<void> {
    const tmp = `${this.dir}.tmp`;
    const started = Date.now();
    this.log.info("正在给公网分享的访客打包网页（vite build）");
    await rm(tmp, { recursive: true, force: true });
    const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
      let text = "";
      const child = spawn(process.execPath, [vite, "build", "--outDir", tmp, "--emptyOutDir", "--logLevel", "warn"], {
        cwd: config.clientDir,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const keep = (d: Buffer) => {
        text = (text + d.toString("utf8")).slice(-4000);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.on("error", (err) => resolve({ code: -1, text: err.message }));
      child.on("close", (code) => resolve({ code, text }));
    });
    if (output.code !== 0 || !existsSync(path.join(tmp, "index.html"))) {
      this.log.error({ code: output.code, output: output.text }, "公网分享的网页打包失败，访客照旧用开发服务器的页面");
      await rm(tmp, { recursive: true, force: true });
      return;
    }
    await mkdir(path.join(this.dir, "assets"), { recursive: true });
    if (existsSync(path.join(tmp, "assets"))) await cp(path.join(tmp, "assets"), path.join(this.dir, "assets"), { recursive: true });
    for (const name of await readdir(tmp)) {
      if (name === "assets") continue;
      await rm(path.join(this.dir, name), { recursive: true, force: true });
      await rename(path.join(tmp, name), path.join(this.dir, name));
    }
    await rm(tmp, { recursive: true, force: true });
    await writeFile(path.join(this.dir, STAMP), String(newest));
    await this.pruneAssets();
    this.compressed.clear();
    this.usable = true;
    this.log.info({ ms: Date.now() - started, dir: this.dir }, "公网分享的网页已经打包好");
  }

  /** 删掉很久以前打包留下的 assets */
  private async pruneAssets(): Promise<void> {
    const dir = path.join(this.dir, "assets");
    const now = Date.now();
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      const s = await stat(file).catch(() => null);
      if (s?.isFile() && now - s.mtimeMs > KEEP_OLD_ASSETS_MS) await rm(file, { force: true });
    }
  }

  /**
   * 发打包好的文件：/assets/ 下有的总是发（旧页面要的旧文件也在）；其他路径有打包好的时发，访客页面的地址（/share/…）发 index.html（页面自己按地址渲染）。
   * 其他没有的文件（打包期间从 Vite 打开的页面还会要 /src/…、/@vite/…）照旧转给 Vite。
   * 返回 false 是这个请求要照旧转给 Vite
   */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const asset = rel.startsWith("/assets/");
    // 打开页面（不是 assets）时顺便看一眼源码有没有改
    if (!asset) this.check();
    if (!asset && !this.usable) return false;
    let file = path.join(this.dir, path.normalize(rel));
    if (!file.startsWith(this.dir + path.sep)) return false;
    let info = await stat(file).catch(() => null);
    if (!info?.isFile() || path.basename(file) === STAMP) {
      if (asset || !rel.startsWith("/share/")) return false;
      file = path.join(this.dir, "index.html");
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) return false;
    }
    const type = PAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const etag = `"${Math.round(info.mtimeMs).toString(36)}-${info.size.toString(36)}"`;
    const headers: Record<string, string> = {
      "content-type": type,
      etag,
      // 带哈希的文件名内容不会变；index.html 等每次都问一下有没有新的
      "cache-control": asset ? "public, max-age=31536000, immutable" : "no-cache",
      vary: "accept-encoding",
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    let body: Buffer = await readFile(file);
    const encoding = compressible(type) && body.length >= MIN_COMPRESS_BYTES ? pickEncoding(req) : null;
    if (encoding) {
      body = this.compress(file, info.mtimeMs, encoding, body);
      headers["content-encoding"] = encoding;
    }
    headers["content-length"] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  private compress(file: string, mtime: number, encoding: "br" | "gzip", body: Buffer): Buffer {
    const key = `${file}|${mtime}|${encoding}`;
    let out = this.compressed.get(key);
    if (!out) {
      // 压一次留着，压得狠一点；brotli 最高档太慢，用 9
      out =
        encoding === "br"
          ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
          : zlib.gzipSync(body, { level: 9 });
      this.compressed.set(key, out);
    }
    return out;
  }
}

/** 源码里最新的修改时间（毫秒）；没有源码目录时 0 */
async function newestSource(): Promise<number> {
  let newest = 0;
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p).catch(() => null);
    if (!s) return;
    if (s.isFile()) {
      newest = Math.max(newest, s.mtimeMs);
      return;
    }
    if (!s.isDirectory()) return;
    for (const name of await readdir(p).catch(() => [] as string[])) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      await walk(path.join(p, name));
    }
  };
  for (const p of SOURCES()) await walk(p);
  return Math.floor(newest);
}
