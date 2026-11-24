import path from "node:path";
import type { HookCallbackMatcher, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { localFs, remoteFs, type HostFs } from "../ssh/host-fs.js";
import { sshHost } from "../ssh/hosts.js";
import { fromWindowsPath, parseRemote } from "../ssh/location.js";

/**
 * 文件不是 UTF-8 时（中文 Windows 上的老代码、SDK 头文件、导出的 CSV 多是 GBK），Claude Code 的 Read、Grep 按 UTF-8 解，
 * 中文全成了 U+FFFD，模型看到的就是乱码。这里在 PostToolUse 把这些行换回来，模型照常按 UTF-8 用工具，不用知道文件的编码。
 *
 * 只动结果里带 U+FFFD 的行：网关自己读那个文件的原始字节（本机用 fs，远程会话经 SFTP），找到对应的那一行，
 * 这一行的字节按 UTF-8（替换模式）解出来正好等于工具结果里的那一行、按 GB18030 又能完整解开，才换成 GB18030 解出来的文字。
 * 对不上的（行号对不上、行被截断、-o 只输出匹配的部分、没有行号、文件本来就是合法 UTF-8 里带 U+FFFD 的）原样不动。
 * 同 ssh/host.ts 的 decodeText：不是合法 UTF-8 时按 GB18030 解。
 *
 * 管不到的：Grep 的中文搜索词按 UTF-8 去匹配，搜不到 GBK 文件里的中文；Bash 里程序输出的字节 Claude Code 已经解过了，拿不回来
 */
export function gbkTextHooks(sessionCwd: string): HookCallbackMatcher[] {
  return [
    {
      matcher: "^(Read|Grep)$",
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PostToolUse") return {};
          try {
            const files = new FileLines(sessionCwd, input.cwd);
            const updated = input.tool_name === "Read" ? await fixRead(input, files) : await fixGrep(input, files);
            return updated ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: updated } } : {};
          } catch {
            return {};
          }
        },
      ],
    },
  ];
}

const REPLACEMENT = "\uFFFD";
/** 比这大的文件不读（Read 本来也读不了这么大的） */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** 一次 Grep 最多试几个路径（包括按分隔符切出来、其实不存在的）：远程会话每个一次 SFTP 请求 */
const MAX_FILES = 40;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const gb18030 = new TextDecoder("gb18030", { fatal: true });

/** 按 \n 切开文件的原始字节（GBK、GB18030 的多字节字符里不会出现 0x0A），不是合法 UTF-8 的文件才切；合法 UTF-8 的返回 null */
function splitRaw(buf: Buffer): Buffer[] | null {
  try {
    utf8.decode(buf);
    return null;
  } catch {
    // 不是合法 UTF-8，往下切
  }
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, start)) {
    lines.push(buf.subarray(start, i));
    start = i + 1;
  }
  lines.push(buf.subarray(start));
  return lines;
}

/** 工具结果里的一行 shown 对应文件里的 raw：raw 按 UTF-8 解出来就是 shown 时，返回 GB18030 解出来的；对不上返回 null */
function fixLine(raw: Buffer | undefined, shown: string): string | null {
  if (!raw) return null;
  // 行尾的 \r：Claude Code 有时去掉、有时留着，两边都去掉再比，留着的补回去
  const cr = shown.endsWith("\r") ? "\r" : "";
  const core = cr ? shown.slice(0, -1) : shown;
  const bytes = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
  if (bytes.toString("utf8") !== core) return null;
  try {
    return gb18030.decode(bytes) + cr;
  } catch {
    return null;
  }
}

/** 不知道行号时：文件里所有对得上 shown 的行，换出来的都一样才算（不同的字节按 UTF-8 解可能都是同样的 U+FFFD） */
function fixAnyLine(raw: Buffer[], shown: string): string | null {
  let found: string | null = null;
  for (const line of raw) {
    const fixed = fixLine(line, shown);
    if (fixed === null) continue;
    if (found !== null && found !== fixed) return null;
    found = fixed;
  }
  return found;
}

/** 按 Claude Code 的工作目录解析工具结果里的路径，读文件、切行，同一次调用里读过的不再读 */
class FileLines {
  private readonly cache = new Map<string, Promise<Buffer[] | null>>();
  private readonly fs: HostFs;
  private readonly resolve: (p: string) => string;

  constructor(sessionCwd: string, toolCwd: string) {
    const remote = parseRemote(sessionCwd);
    if (!remote) {
      this.fs = localFs;
      this.resolve = (p) => path.resolve(toolCwd, p);
      return;
    }
    const host = sshHost(remote.host);
    this.fs = remoteFs(host);
    // Windows 远端：工具结果里是 C:\… 或相对路径，换成 SFTP 的 /C:/… 写法
    this.resolve = host.windows ? (p) => fromWindowsPath(path.win32.resolve(toolCwd, p)) : (p) => path.posix.resolve(toolCwd, p);
  }

  lines(p: string): Promise<Buffer[] | null> {
    const abs = this.resolve(p);
    let lines = this.cache.get(abs);
    if (!lines) {
      if (this.cache.size >= MAX_FILES) return Promise.resolve(null);
      lines = this.read(abs);
      this.cache.set(abs, lines);
    }
    return lines;
  }

  private async read(abs: string): Promise<Buffer[] | null> {
    try {
      const st = await this.fs.stat(abs);
      if (!st.isFile || st.size > MAX_FILE_BYTES) return null;
      return splitRaw(await this.fs.readFile(abs));
    } catch {
      return null;
    }
  }
}

interface ReadOutput {
  type: string;
  file?: { filePath?: string; content?: string; startLine?: number };
}

async function fixRead(input: PostToolUseHookInput, files: FileLines): Promise<ReadOutput | null> {
  const out = input.tool_response as ReadOutput | null;
  const file = out?.type === "text" ? out.file : undefined;
  if (!file?.filePath || typeof file.content !== "string" || !file.content.includes(REPLACEMENT)) return null;
  const raw = await files.lines(file.filePath);
  if (!raw) return null;
  // startLine 是 Read 的 offset，从 1 数（传 0 时也是从第一行读）
  const base = Math.max(0, (file.startLine ?? 1) - 1);
  let changed = false;
  const lines = file.content.split("\n").map((line, i) => {
    if (!line.includes(REPLACEMENT)) return line;
    const fixed = fixLine(raw[base + i], line);
    if (fixed === null) return line;
    changed = true;
    return fixed;
  });
  return changed ? { ...out!, file: { ...file, content: lines.join("\n") } } : null;
}

interface GrepOutput {
  mode?: string;
  content?: string;
}

/** 单个文件时行首是「行号:」或「行号-」（上下文行） */
const NUMBERED = /^(\d+)([:-])/;
/** 多个文件时是「路径:行号:」或「路径-行号-」；路径里也可能有这样的片段，所以每个位置都试 */
const PREFIXED = /([:-])(\d+)\1/g;
/** 不带行号（-n false）时是「路径:」或「路径-」 */
const SEPARATOR = /[:-]/g;

async function fixGrep(input: PostToolUseHookInput, files: FileLines): Promise<GrepOutput | null> {
  const out = input.tool_response as GrepOutput | null;
  if (out?.mode !== "content" || typeof out.content !== "string" || !out.content.includes(REPLACEMENT)) return null;
  const searched = (input.tool_input as { path?: unknown } | null)?.path;
  const single = typeof searched === "string" && searched ? searched : null;

  /** 文件 p 的第 n 行（从 1 数，null 是不知道第几行）是不是 shown，是就返回换好的 */
  const tryLine = async (p: string, n: number | null, shown: string): Promise<string | null> => {
    const raw = await files.lines(p);
    if (!raw) return null;
    return n === null ? fixAnyLine(raw, shown) : fixLine(raw[n - 1], shown);
  };

  let changed = false;
  const lines = out.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(REPLACEMENT)) continue;
    let fixed: string | null = null;
    const m = single ? NUMBERED.exec(line) : null;
    if (m) {
      const head = m[0];
      const text = await tryLine(single!, Number(m[1]), line.slice(head.length));
      if (text !== null) fixed = head + text;
    }
    if (fixed === null) {
      for (const pm of line.matchAll(PREFIXED)) {
        const head = line.slice(0, pm.index + pm[0].length);
        const p = line.slice(0, pm.index);
        if (!p || p.includes(REPLACEMENT)) continue;
        const text = await tryLine(p, Number(pm[2]), line.slice(head.length));
        if (text !== null) {
          fixed = head + text;
          break;
        }
      }
    }
    // 不带行号：「路径:文字」，单个文件时整行就是文字
    if (fixed === null) {
      for (const sm of line.matchAll(SEPARATOR)) {
        const p = line.slice(0, sm.index);
        if (!p || p.includes(REPLACEMENT)) continue;
        const text = await tryLine(p, null, line.slice(sm.index + 1));
        if (text !== null) {
          fixed = line.slice(0, sm.index + 1) + text;
          break;
        }
      }
    }
    if (fixed === null && single) fixed = await tryLine(single, null, line);
    if (fixed !== null) {
      lines[i] = fixed;
      changed = true;
    }
  }
  return changed ? { ...out, content: lines.join("\n") } : null;
}
