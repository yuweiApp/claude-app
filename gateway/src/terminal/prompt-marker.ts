import { randomBytes } from "node:crypto";

/**
 * 提示符标记：让 shell 每次显示提示符时带上一段看不见的记号（OSC 133，FinalTerm 的语义提示符，
 * VS Code、iTerm2、Windows Terminal 都认），网关从输出里认出来，就知道终端回到了提示符、上一条命令的退出码是多少。
 *
 * 只给 PowerShell 用（本机 Windows、远端 Windows）：Windows 上没有「前台在跑什么」的接口（Unix 上是 tcgetpgrp），
 * 不加标记就判断不出命令结束了没有。脚本参照 VS Code 的 shellIntegration.ps1（MIT）裁剪，只留提示符这一段。
 *
 * 用到的三个：
 * - `ESC ] 133 ; D [; 退出码] ; aid=<nonce> BEL`：上一条命令结束（没跑命令、只按了回车时不带退出码）
 * - `ESC ] 133 ; A ; aid=<nonce> BEL`：提示符开始
 * - `ESC ] 133 ; B ; aid=<nonce> BEL`：提示符结束，等输入
 *
 * nonce 每个终端随机：命令的输出里恰好有这种序列（cat 一份别的终端的日志）不会被当成回到了提示符。
 */
export interface PromptMark {
  kind: "A" | "B" | "C" | "D";
  /** D 带的退出码；没带是 undefined */
  exitCode?: number;
}

export const newNonce = () => randomBytes(8).toString("hex");

/**
 * PowerShell 启动后执行的脚本（-NoExit -EncodedCommand，在用户的 profile 之后跑）：包住已有的 prompt 函数
 * （默认的、oh-my-posh 等主题设的都行），前后加上标记。兼容系统自带的 PowerShell 5.1。
 * - `$?` 一进函数就取，调原来的 prompt 之前用 Write-Error 还原成失败（主题靠它显示上一条命令的成败）
 * - 退出码：成功是 0；失败时用 $LASTEXITCODE（原生程序的退出码），它是 0（失败的是 cmdlet）就算 1
 * - 历史编号没变（只按了回车、Ctrl-C 取消了输入）说明没跑命令，D 不带退出码
 */
export function powershellPromptScript(nonce: string): string {
  const mark = (body: string) => `$e]133;${body};aid=${nonce}$b`;
  return [
    "try {",
    "$Global:__cgTerm = @{ Prompt = $function:prompt; Last = -1 }",
    "function Global:prompt {",
    "$f = [int]!$global:?; $c = $global:LASTEXITCODE",
    "Set-StrictMode -Off",
    "$e = [char]27; $b = [char]7",
    "$h = Get-History -Count 1",
    "$d = ''",
    "if ($h -and $h.Id -ne $Global:__cgTerm.Last) { if ($f -and $c) { $f = $c }; $d = \";$f\" }",
    "if ($h) { $Global:__cgTerm.Last = $h.Id }",
    `$r = "${mark("D$d")}${mark("A")}"`,
    "if ($f) { Write-Error 'failure' -ErrorAction Ignore }",
    "$r += $Global:__cgTerm.Prompt.Invoke()",
    `$r + "${mark("B")}"`,
    "}",
    "} catch {}",
  ].join("\n");
}

const MARK = /\x1b\]133;([A-D])((?:;[^\x07\x1b]*)?)(?:\x07|\x1b\\)/g;
/** 没收完的序列最多留这么长，再长就不是标记了 */
const MAX_PENDING = 256;

/** 从终端的输出流里认标记：一个序列可能被切在两段输出之间，没收完的尾巴留到下一段 */
export class PromptMarkParser {
  private pending = "";

  constructor(private readonly nonce: string) {}

  feed(data: string): PromptMark[] {
    const text = this.pending + data;
    const marks: PromptMark[] = [];
    for (const m of text.matchAll(MARK)) {
      const params = m[2]!.split(";").slice(1);
      if (!params.includes(`aid=${this.nonce}`)) continue;
      const kind = m[1] as PromptMark["kind"];
      const code = kind === "D" && /^-?\d+$/.test(params[0] ?? "") ? Number(params[0]) : undefined;
      marks.push(code === undefined ? { kind } : { kind, exitCode: code });
    }
    this.pending = unfinished(text);
    return marks;
  }
}

/** 结尾处还没收到结束符的 OSC（结束符 ESC \ 可能只到了 ESC），或者最后单独一个 ESC（后面可能是 ]） */
function unfinished(text: string): string {
  const lone = text.endsWith("\x1b") ? "\x1b" : "";
  const open = text.lastIndexOf("\x1b]");
  if (open < 0 || text.length - open > MAX_PENDING) return lone;
  const rest = text.slice(open + 2);
  if (rest.includes("\x07")) return lone;
  const esc = rest.indexOf("\x1b");
  // 里面没有 ESC、或者只有结尾一个（ESC \ 的前一半）：还没收完；否则这个 OSC 已经结束或被别的序列打断了
  return esc < 0 || esc === rest.length - 1 ? text.slice(open) : lone;
}
