import { machinePath, parseRemote, remoteUri } from "../remote";
import { createContext, isValidElement, memo, useContext, useRef, type AnchorHTMLAttributes, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import { api } from "../api";
import type { LineRange } from "./FileBrowser";
import { useFileExists } from "../state/fileExists";
import { MermaidBlock } from "./MermaidBlock";
import { CopyAction } from "./MessageActions";
import { ContextMenu } from "./ContextMenu";
import { downloadFile, TRANSFERS_CHANGED } from "./FileTransfers";
import { localGateway } from "../desktop";

/**
 * Claude 回复里的链接指向本地文件时，在右侧面板打开：cwd 是会话的工作目录，open 打开相对它的路径的文件，
 * line 是链接里的行号（a.ts:12、a.ts:12-20、a.ts#L12-L20），面板滚到并选中这几行；
 * openFolder 在目录树里定位文件夹；工作目录外的传 root（绝对路径），路径相对它，面板里以它为根。
 * openUrl（桌面版、有会话时）在内置浏览器里打开网址，没有时网址在新窗口打开（桌面版是系统浏览器）。
 * 没有（新会话页，还没有工作目录）时本地文件链接点了没反应
 */
export const FileLinkContext = createContext<{
  cwd: string;
  openUrl?: (url: string) => void;
  open: (path: string, root?: string, line?: LineRange | null) => void;
  openFolder: (path: string, root?: string) => void;
} | null>(null);

/**
 * Claude 回复的 Markdown：GFM（加上 cjk-friendly：`**……。**中文` 这种标点后面紧跟汉字的结尾，
 * CommonMark 不算闭合，会原样显示星号），本地文件链接点开在右侧面板，网址在内置浏览器（桌面版）或新窗口打开。
 * 行内代码像文件路径（`index.html`、`src/a.ts:12`）、又是工作目录里存在的文件时，显示成文件链接，
 * 同写成 [index.html](index.html)；只改显示，消息内容不变。```mermaid 代码块渲染成图。
 * 裸网址后面紧跟中文标点时网址在标点前结束，见 remarkCjkAutolinkEnd
 */
const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkKeepWindowsPaths, remarkCjkAutolinkEnd];

/**
 * 按文字 memo：会话里每来一个事件（流式的每个字、state、tasks 等）整个对话都会重新渲染，
 * 文字没变的回复不再重新解析 Markdown。长会话里这是重新渲染的主要开销
 */
export const ReplyMarkdown = memo(function ReplyMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={urlTransform}
      components={COMPONENTS}
    >
      {children}
    </Markdown>
  );
});

/**
 * 写在模块里、不在渲染时新建：react-markdown 把这些函数当组件类型，每次渲染换一个新函数，
 * 里面的组件就会整个卸载重挂（mermaid 图会先变回源码再出图，高度一变滚动位置就跳）
 */
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <ReplyLink {...props} />,
  pre: ({ node: _node, ...props }) =>
    codeLanguage(props.children) === "mermaid" ? <MermaidBlock code={codeText(props.children)} /> : <CodeBlock {...props} />,
  code: ({ node: _node, ...props }) => <ReplyCode {...props} />,
};

/** 在代码块（```）里：里面的 code 不当文件路径 */
const InCodeBlock = createContext(false);

/** 代码块：右上角常驻复制按钮（同 codex-app-server 的 MdCodeBlock），复制的是代码原文 */
function CodeBlock(props: HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <InCodeBlock.Provider value={true}>
      <div className="md-code">
        <pre ref={ref} {...props} />
        <CopyAction className="md-code-copy" title="复制代码" text={() => (ref.current?.textContent ?? "").replace(/\n$/, "")} />
      </div>
    </InCodeBlock.Provider>
  );
}

/** 代码块的语言：<code> 的 class 里 language-xxx 的 xxx */
function codeLanguage(children: ReactNode): string {
  const code = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(code)) return "";
  return /(?:^|\s)language-(\S+)/.exec(code.props.className ?? "")?.[1]?.toLowerCase() ?? "";
}

/** 代码块的源码：<code> 里的文字 */
function codeText(children: ReactNode): string {
  const code = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ children?: ReactNode }>(code)) return "";
  const text = code.props.children;
  return typeof text === "string" ? text : Array.isArray(text) ? text.filter((t) => typeof t === "string").join("") : "";
}

/** 像文件路径的行内代码：没有空白和引号、括号这些，带扩展名（可以带 :行号）；网址不算 */
const PATH_LIKE = /^(?:[a-z]:[\\/]|\\\\|\.{0,2}[\\/])?[^\s`'"<>|*?()[\]{}]*[^\s`'"<>|*?()[\]{}\\/.]\.[a-z\d]{1,10}(?::\d+(?:[:-]\d+)?)?$/i;

function ReplyCode({ children, ...rest }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  const inBlock = useContext(InCodeBlock);
  const files = useContext(FileLinkContext);
  const text = typeof children === "string" ? children : null;
  const candidate = !inBlock && files && text && !text.includes("://") && PATH_LIKE.test(text) ? text : null;
  const path = candidate && files ? projectPath(files.cwd, candidate) : null;
  const exists = useFileExists(files?.cwd ?? null, path);
  if (candidate && exists) return <ReplyLink href={candidate}>{candidate}</ReplyLink>;
  return <code {...rest}>{children}</code>;
}

/** 链接：本地文件在右侧面板打开，网址在内置浏览器或新窗口打开，右键有菜单（见上面 ReplyMarkdown）；后台任务面板里 MCP 任务返回的文件也用它 */
export function ReplyLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const files = useContext(FileLinkContext);
  const local = href ? isLocalLink(href) : false;
  if (!href || !local) {
    // http(s) 网址：桌面版在内置浏览器里开，右键可以选内置还是外部浏览器
    const openUrl = /^https?:\/\//i.test(href ?? "") ? files?.openUrl : undefined;
    if (openUrl) return <WebLink {...rest} href={href!} openUrl={openUrl}>{children}</WebLink>;
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  const path = files ? projectPath(files.cwd, href) : null;
  // 工作目录外的：面板里以它所在的文件夹（是文件夹时是它自己）为根打开
  const outside = files && path === null ? absolutePath(files.cwd, href) : null;
  // 链接看不出是文件还是文件夹：当文件是 root 下的 rel，当文件夹是 dirRoot 下的 dirRel
  const target = () => {
    if (!files || (path === null && !outside)) return null;
    const { cwd, open, openFolder } = files;
    const line = linkLine(href);
    // 工作目录外的远端路径：面板、接口要的是 ssh://<id><路径>
    const remote = parseRemote(cwd);
    const at = (p: string) => (remote ? remoteUri(remote.host, p) : p);
    return path !== null
      ? { root: cwd, rel: path, dirRoot: cwd, dirRel: path, file: () => open(path, undefined, line), folder: () => openFolder(path) }
      : { root: at(outside!.parent), rel: outside!.name, dirRoot: at(outside!.abs), dirRel: "", file: () => open(outside!.name, at(outside!.parent), line), folder: () => openFolder("", at(outside!.abs)) };
  };
  // 是文件就打开；能列出内容的是文件夹，在目录树里定位；都不是也当文件打开（面板里显示原因）
  const openFile = () => {
    const t = target();
    if (!t) return;
    void api
      .filesExist(t.root, [t.rel])
      .catch(() => [t.rel])
      .then((exists) => (exists.includes(t.rel) ? t.file() : api.listDir(t.dirRoot, t.dirRel).then(t.folder, t.file)));
  };
  // 下载：同文件树的「下载…」；不是文件时说原因
  const downloadLink = async () => {
    const t = target();
    if (!t) return;
    try {
      const exists = await api.filesExist(t.root, [t.rel]);
      if (!exists.includes(t.rel)) {
        const folder = await api.listDir(t.dirRoot, t.dirRel).then(
          () => true,
          () => false,
        );
        window.alert(folder ? "这是文件夹，只能下载文件" : `文件不存在：${localPath(href) ?? href}`);
        return;
      }
      const started = await downloadFile(t.root, t.rel, await localGateway());
      if (started?.length) watchDownload(t.root, started[0]!.id);
    } catch (err) {
      window.alert(`下载失败：${(err as Error).message}`);
    }
  };
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // file:// 和相对路径在网页里打不开，不让它跳
    e.preventDefault();
    openFile();
  };
  if (path === null && !outside) {
    // 还没有工作目录（新会话页）：照原样显示文字，不像链接那样能点
    return (
      <span className="md-link-off" title={localPath(href) ?? href}>
        {children}
      </span>
    );
  }
  // 右键：在右侧面板打开（同单击）、下载（同文件树）、复制绝对路径（相对路径按工作目录算，去掉行号）
  const absolute = absolutePath(files!.cwd, href);
  return (
    <ContextMenu
      items={[
        { label: "在右侧面板打开", run: openFile },
        { label: "下载…", run: () => void downloadLink() },
        ...(absolute ? [{ label: "复制路径", run: () => void navigator.clipboard.writeText(nativePath(absolute.abs)).catch(() => undefined) }] : []),
      ]}
    >
      {(onContextMenu) => (
        <a {...rest} href={href} onClick={onClick} onContextMenu={onContextMenu} title={`在右侧面板打开 ${path ?? outside!.abs}`}>
          {children}
        </a>
      )}
    </ContextMenu>
  );
}

/**
 * 回复里的链接开始的直传下载：告诉同一个 cwd 的文件树（开着的话传输列表里有这一行），
 * 网关在后台复制，跟着进度到结束，失败时提示（文件树没开着时界面上没有别的地方显示）
 */
function watchDownload(cwd: string, id: string) {
  window.dispatchEvent(new CustomEvent(TRANSFERS_CHANGED, { detail: cwd }));
  const timer = window.setInterval(() => {
    void api.transfers(cwd).then(
      (list) => {
        const t = list.find((x) => x.id === id);
        if (t && (t.state === "queued" || t.state === "running")) return;
        window.clearInterval(timer);
        if (t?.state === "error") window.alert(`下载失败：${t.error || t.name}`);
      },
      () => window.clearInterval(timer),
    );
  }, WATCH_MS);
}
const WATCH_MS = 500;

/** 复制给用户的绝对路径：Windows 的（盘符、//server 开头）换回反斜杠，其余照旧用 / */
function nativePath(abs: string): string {
  return /^[a-z]:\//i.test(abs) || abs.startsWith("//") ? abs.replaceAll("/", "\\") : abs;
}

/**
 * 桌面版回复里的网址：单击在内置浏览器里开（按着 Ctrl、Shift 等点的交给系统浏览器）；
 * 右键菜单：在内置浏览器中打开、在外部浏览器中打开（window.open，外壳交给系统浏览器）、复制链接
 */
function WebLink({ href, openUrl, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; openUrl: (url: string) => void }) {
  const items = [
    { label: "在内置浏览器中打开", run: () => openUrl(href) },
    { label: "在外部浏览器中打开", run: () => void window.open(href, "_blank", "noopener") },
    { label: "复制链接", run: () => void navigator.clipboard.writeText(href).catch(() => undefined) },
  ];
  return (
    <ContextMenu items={items}>
      {(onContextMenu) => (
        <a
          {...rest}
          href={href}
          target="_blank"
          rel="noreferrer"
          title={href}
          onClick={(e) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            openUrl(href);
          }}
          onContextMenu={onContextMenu}
        >
          {children}
        </a>
      )}
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// 链接地址解析（同 codex-app-server 的 Markdown.tsx）

/** 本地文件路径：C:\a.png、C:/a.png、/home/a.png、\\server\share\a.png、file:///C:/a.png、file://server/share/a.png；返回去掉 file:// 的路径，不是返回 null */
function localPath(raw: string): string | null {
  // Markdown 解析后链接地址已经过百分号编码（\ → %5C、中文 → %E8…）
  let url = raw;
  try {
    url = decodeURIComponent(raw);
  } catch {
    // 不是合法编码，按原样处理
  }
  if (/^file:\/\//i.test(url)) {
    let p = url.replace(/^file:\/\/(localhost(?=\/|$))?/i, "");
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1); // file:///C:/x → C:/x
    else if (p && !p.startsWith("/") && !/^[a-z]:/i.test(p)) p = `//${p}`; // file://server/share/x → //server/share/x（Windows 的网络共享）
    return p;
  }
  if (/^\/[a-z]:[\\/]/i.test(url)) return url.slice(1); // /C:/x → C:/x
  if (/^[a-z]:[\\/]/i.test(url) || url.startsWith("\\\\")) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  return null;
}

/** 链接指向本地文件：绝对路径、file://，或者相对路径（相对会话的工作目录）；带协议的网址、#锚点、?查询、//网址不是 */
function isLocalLink(href: string): boolean {
  return localPath(href) !== null || !/^(?:[a-z][a-z\d+.-]*:|[#?]|\/\/)/i.test(href);
}

/**
 * 路径末尾的行号：a.ts:12、a.ts:12-20、a.ts:12:5（第 5 列，不算）、a.ts#L12、a.ts#L12-L20、a.ts#L12C3-L20C1。
 * 返回去掉行号的路径和行范围（没有时 null）
 */
const LINE_SUFFIX = /(?:#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?|:(\d+)(?:-(\d+)|:\d+)?)$/i;
function splitLine(p: string): { path: string; line: LineRange | null } {
  const m = LINE_SUFFIX.exec(p);
  if (!m) return { path: p, line: null };
  const start = Number(m[1] ?? m[3]);
  if (!start) return { path: p.slice(0, m.index), line: null };
  const end = Number(m[2] ?? m[4] ?? start);
  return { path: p.slice(0, m.index), line: { start, end: Math.max(start, end) } };
}

/** 链接里的行号 */
function linkLine(href: string): LineRange | null {
  try {
    return splitLine(decodeURIComponent(href)).line;
  } catch {
    return splitLine(href).line;
  }
}

/** 链接指向的文件相对工作目录的路径（/ 分隔，去掉行号、查询参数和锚点）；不在工作目录里返回 null */
function projectPath(cwd: string, href: string): string | null {
  const abs = localPath(href);
  let rel: string;
  if (abs !== null) {
    const norm = splitLine(abs.replaceAll("\\", "/")).path;
    // 远程会话的工作目录是 ssh://<id><路径>，模型写的是远端路径，和路径部分比
    const root = `${machinePath(cwd).replaceAll("\\", "/").replace(/\/+$/, "")}/`;
    // Windows 的路径不分大小写
    const win = /^[a-z]:\//i.test(root) || root.startsWith("//");
    const head = norm.slice(0, root.length);
    if (win ? head.toLowerCase() !== root.toLowerCase() : head !== root) return null;
    rel = norm.slice(root.length);
  } else {
    try {
      rel = decodeURIComponent(href);
    } catch {
      rel = href;
    }
    rel = splitLine(rel).path.replace(/[?#].*$/, "");
  }
  const parts: string[] = [];
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") parts.push(seg);
    else if (parts.length) parts.pop();
    else return null;
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * 链接指向的绝对路径（/ 分隔，去掉行号、查询参数和锚点，解开 ..），相对路径按工作目录算；
 * 带上它所在的文件夹和名字。是根目录（/、C:/）时返回 null
 */
function absolutePath(cwd: string, href: string): { abs: string; parent: string; name: string } | null {
  let p = localPath(href);
  if (p === null) {
    let rel = href;
    try {
      rel = decodeURIComponent(href);
    } catch {
      // 不是合法编码，按原样处理
    }
    p = `${machinePath(cwd).replace(/[\\/]+$/, "")}/${splitLine(rel).path.replace(/[?#].*$/, "")}`;
  }
  p = splitLine(p.replaceAll("\\", "/")).path;
  // 开头：Windows 盘符、UNC（//server）或者 /
  const head = /^[a-z]:\//i.exec(p)?.[0] ?? (p.startsWith("//") ? "//" : "/");
  const parts: string[] = [];
  for (const seg of p.slice(head.length).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const name = parts.pop();
  if (!name) return null;
  const parent = head + parts.join("/");
  return { abs: parent.endsWith("/") ? parent + name : `${parent}/${name}`, parent, name };
}

/** react-markdown 默认会把 file:// 和 C:\... 当成不认识的协议清空，本地路径原样保留 */
function urlTransform(url: string) {
  return localPath(url) !== null ? url : defaultUrlTransform(url);
}

interface DestinationCompileContext {
  readonly stack: ReadonlyArray<{ readonly type: string; url?: string }>;
  resume(): string;
  sliceSerialize(token: unknown): string;
}

function keepWindowsPathDestination(this: DestinationCompileContext, token: unknown) {
  const decoded = this.resume();
  const authored = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  if (!node) return;
  // 带 &amp; 这类字符引用的地址还得靠解析器解码，用解析结果
  const windows = /^[a-z]:\\/i.test(authored) || authored.startsWith("\\\\");
  node.url = windows && !/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(authored) ? authored : decoded;
}

/**
 * CommonMark 在链接地址里也处理反斜杠转义，C:\Users\a\.claude\x 的 \. 会变成 .，
 * 解析出 C:\Users\a.claude\x。Windows 路径里的反斜杠都是分隔符，[x](地址) 和 [x]: 地址
 * 的地址是 Windows 路径时保留原文（同 codex-app-server，做法来自 t3code 的 remarkKeepWindowsPathDestinations）
 */
function remarkKeepWindowsPaths(this: { data(): object }) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] };
  (data.fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
    },
  });
}

/** 中文标点（非 ASCII 的标点）：GFM 的裸网址只在空白处结束，中文句子里网址后面紧跟的标点和文字都会算进网址 */
const CJK_PUNCTUATION = /(?![\x00-\x7f])\p{P}/u;

/**
 * GFM 的裸网址（http://…、www.…）一直延伸到空白，中文里网址后面通常不留空格：
 * `访问 **http://a/**。` 整段 `http://a/**。` 成了网址，加粗的星号也被吞进去、原样显示。
 * 网址里出现中文标点时在那里截断（再按 GFM 去掉末尾的 .,:;*_~ 等），原文里改写成 <网址>
 * 后用同一套插件重新解析一遍；网址里的汉字不截（中文维基这类地址本来就带汉字）。
 * 只改显示，消息内容不变
 */
function remarkCjkAutolinkEnd(this: { parse(file: string): unknown }) {
  const processor = this;
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    if (!CJK_PUNCTUATION.test(source)) return;
    const edits: { start: number; end: number; text: string }[] = [];
    const walk = (node: MdNode) => {
      if (node.type === "link") {
        const edit = autolinkEdit(node, source);
        if (edit) edits.push(edit);
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    if (!edits.length) return;
    let fixed = source;
    for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
      fixed = fixed.slice(0, start) + text + fixed.slice(end);
    }
    return processor.parse(fixed);
  };
}

interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function autolinkEdit(node: MdNode, source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  // 裸网址的原文就是显示的文字；[文字](地址) 和 <地址> 的原文带括号，不动
  const literal = source.slice(start, end);
  const text = node.children?.length === 1 ? node.children[0]?.value : undefined;
  if (literal !== text || !/^(?:https?:\/\/|www\.)/i.test(literal)) return null;
  const cut = literal.search(CJK_PUNCTUATION);
  if (cut <= 0) return null;
  let url = literal.slice(0, cut);
  for (;;) {
    const last = url.at(-1);
    if (last && `?!.,:;*_~"'`.includes(last)) url = url.slice(0, -1);
    else if (last === ")" && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
    else break;
  }
  if (!url || /^www\.$/i.test(url) || /^https?:\/\/$/i.test(url)) return null;
  return {
    start,
    end: start + url.length,
    text: /^www\./i.test(url) ? `[${url}](http://${url})` : `<${url}>`,
  };
}
