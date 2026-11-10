import { createContext, isValidElement, useContext, useRef, type AnchorHTMLAttributes, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { useFileExists } from "../state/fileExists";
import { MermaidBlock } from "./MermaidBlock";
import { CopyAction } from "./MessageActions";

/**
 * Claude 回复里的链接指向本地文件时，在右侧面板打开：cwd 是会话的工作目录，open 打开相对它的路径的文件，
 * openFolder 在目录树里定位文件夹；工作目录外的传 root（绝对路径），路径相对它，面板里以它为根。
 * 没有（新会话页，还没有工作目录）时本地文件链接点了没反应
 */
export const FileLinkContext = createContext<{
  cwd: string;
  open: (path: string, root?: string) => void;
  openFolder: (path: string, root?: string) => void;
} | null>(null);

/**
 * Claude 回复的 Markdown：GFM，本地文件链接点开在右侧面板，网址在新窗口打开。
 * 行内代码像文件路径（`index.html`、`src/a.ts:12`）、又是工作目录里存在的文件时，显示成文件链接，
 * 同写成 [index.html](index.html)；只改显示，消息内容不变。```mermaid 代码块渲染成图
 */
export function ReplyMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkKeepWindowsPaths]}
      urlTransform={urlTransform}
      components={COMPONENTS}
    >
      {children}
    </Markdown>
  );
}

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
const PATH_LIKE = /^(?:[a-z]:[\\/]|\\\\|\.{0,2}[\\/])?[^\s`'"<>|*?()[\]{}]*[^\s`'"<>|*?()[\]{}\\/.]\.[a-z\d]{1,10}(?::\d+(?::\d+)?)?$/i;

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

function ReplyLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const files = useContext(FileLinkContext);
  const local = href ? isLocalLink(href) : false;
  if (!href || !local) {
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  const path = files ? projectPath(files.cwd, href) : null;
  // 工作目录外的：面板里以它所在的文件夹（是文件夹时是它自己）为根打开
  const outside = files && path === null ? absolutePath(files.cwd, href) : null;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // file:// 和相对路径在网页里打不开，不让它跳
    e.preventDefault();
    if (!files || (path === null && !outside)) return;
    const { cwd, open, openFolder } = files;
    // 链接看不出是文件还是文件夹：是文件就打开；能列出内容的是文件夹，在目录树里定位；都不是也当文件打开（面板里显示原因）
    // 文件：root 下的 rel；文件夹：dirRoot 下的 dirRel
    const t =
      path !== null
        ? { root: cwd, rel: path, dirRoot: cwd, dirRel: path, file: () => open(path), folder: () => openFolder(path) }
        : { root: outside!.parent, rel: outside!.name, dirRoot: outside!.abs, dirRel: "", file: () => open(outside!.name, outside!.parent), folder: () => openFolder("", outside!.abs) };
    void api
      .filesExist(t.root, [t.rel])
      .catch(() => [t.rel])
      .then((exists) => (exists.includes(t.rel) ? t.file() : api.listDir(t.dirRoot, t.dirRel).then(t.folder, t.file)));
  };
  if (path === null && !outside) {
    // 还没有工作目录（新会话页）：照原样显示文字，不像链接那样能点
    return (
      <span className="md-link-off" title={localPath(href) ?? href}>
        {children}
      </span>
    );
  }
  return (
    <a {...rest} href={href} onClick={onClick} title={`在右侧面板打开 ${path ?? outside!.abs}`}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// 链接地址解析（同 codex-app-server 的 Markdown.tsx）

/** 本地文件路径：C:\a.png、C:/a.png、/home/a.png、file:///C:/a.png；返回去掉 file:// 的路径，不是返回 null */
function localPath(raw: string): string | null {
  // Markdown 解析后链接地址已经过百分号编码（\ → %5C、中文 → %E8…）
  let url = raw;
  try {
    url = decodeURIComponent(raw);
  } catch {
    // 不是合法编码，按原样处理
  }
  if (/^file:\/\//i.test(url)) {
    let p = url.replace(/^file:\/\/(localhost)?/i, "");
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1); // file:///C:/x → C:/x
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

/** 链接指向的文件相对工作目录的路径（/ 分隔，去掉行号、查询参数和锚点）；不在工作目录里返回 null */
function projectPath(cwd: string, href: string): string | null {
  const abs = localPath(href);
  let rel: string;
  if (abs !== null) {
    const norm = abs.replaceAll("\\", "/");
    const root = `${cwd.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
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
    rel = rel.replace(/[?#].*$/, "");
  }
  // 行号（a.ts:12、a.ts#L12）：面板不定位到行，去掉
  rel = rel.replace(/:\d+(?::\d+)?$/, "");
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
    p = `${cwd.replace(/[\\/]+$/, "")}/${rel.replace(/[?#].*$/, "")}`;
  }
  p = p.replaceAll("\\", "/").replace(/:\d+(?::\d+)?$/, "");
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
