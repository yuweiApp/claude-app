import { createContext, useContext, type ReactNode } from "react";
import { BrowserIcon, GlobeIcon } from "./BrowserTab";
import { MonitorIcon } from "./DesktopTargetFloat";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";

/** 消息开头的 /技能名（插件技能是 /插件名:技能名）；/home/x 这样的路径后面还有斜杠，不算 */
const SKILL_PREFIX = /^\/([\w.-]+(?::[\w.-]+)?)(?=\s|$)/;
/** 中间的 /名字：前后是空白或首尾，名字在技能列表里才算 */
const SKILL_ANYWHERE = /(^|\s)\/([\w.-]+(?::[\w.-]+)?)(?=\s|$)/g;
/** 前后是空白或首尾的 @名字，带空格的路径用引号：@"a b.txt" */
const AT_MENTION = /(^|\s)@("[^"\n]+"|\S+)/g;
/** 看着像路径：有 /、\ 或带扩展名（@README.md、@src/、@D:\a\b）；@someone 不算 */
const PATH_LIKE = /[/\\]|\.\w+$/;
/**
 * 标签页的引用：内置浏览器的 @[标题](网址)，外部浏览器（用户的 Chrome）的 @chrome[标题](网址)，见 tabMention；
 * 桌面上的窗口（输入框上面「Computer Use」里选的）也用这个格式：@desktop[标题](window:窗口 id)
 */
const TAB_MENTION = /(^|\s)@(chrome|desktop)?\[([^\]\n]*)\]\(([a-z][\w+.-]*:[^\s)]+)\)/gi;

/** 引用来源：不写是内置浏览器，chrome 是外部浏览器（用户的 Chrome），desktop 是桌面（桌面工具 agent-desktop） */
export type MentionSource = "chrome" | "desktop";

/**
 * 引用整个浏览器或桌面：内置浏览器写成 @内置浏览器，外部浏览器（用户的 Chrome）写成 @Chrome，桌面写成 @桌面，
 * 网关给两个浏览器、桌面工具的说明里写了这个写法指什么
 */
export const browserMention = (source?: MentionSource) => (source === "chrome" ? "@Chrome" : source === "desktop" ? "@桌面" : "@内置浏览器");
const BROWSER_MENTION = /(^|\s)@(内置浏览器|Chrome|桌面)(?=\s|$)/g;
const BROWSER_SOURCE: Record<string, MentionSource | undefined> = { Chrome: "chrome", 桌面: "desktop" };

/** 发给模型的标签页（窗口）引用：标题里的方括号、换行去掉 */
export const tabMention = (title: string, url: string, source?: MentionSource) => `${tabToken(title || url, source)}(${url})`;

/**
 * 输入框里的标签页引用只写 @[标题]、@chrome[标题]，不露网址；网址由输入框记着，发送时补成 tabMention 的完整格式。
 * 标签页标题里的方括号、换行去掉
 */
export const tabToken = (title: string, source?: MentionSource) => `@${source ?? ""}[${title.replace(/[[\]\n]/g, " ").trim()}]`;

/**
 * 从右侧面板的目录树拖到输入框的文件、文件夹：拖动数据里放这个类型，值是绝对路径（文件夹以分隔符结尾），
 * 输入框照原样插成文件引用（fileMention），发给模型的就是绝对路径
 */
export const PATH_DRAG_TYPE = "application/x-claude-app-path";

/** 插入输入框的文件引用：带空白的路径加引号 */
export const fileMention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** 文件引用（@ 后面的部分，可能带引号）拆成路径、文件名（带后缀）和是不是文件夹（以分隔符结尾） */
export function fileRefParts(ref: string): { path: string; base: string; dir: boolean } {
  const path = ref.replace(/^"(.*)"$/, "$1");
  const dir = /[/\\]$/.test(path);
  const trimmed = path.replace(/[/\\]+$/, "");
  return { path, base: trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || path, dir };
}

/** 输入框里带空白的文件引用：引号透明占位，只露出路径 */
const quoted = (ref: string): ReactNode =>
  ref.length > 1 && ref.startsWith('"') && ref.endsWith('"') ? (
    <>
      <span className="mention-tab-bracket">"</span>
      {ref.slice(1, -1)}
      <span className="mention-tab-bracket">"</span>
    </>
  ) : (
    ref
  );

/** 文件引用的图标：按文件名（同名区分用的「 (2)」不算），文件夹用文件夹图标 */
function FileRefIcon({ base, dir }: { base: string; dir: boolean }) {
  const name = base.replace(/ \(\d+\)$/, "");
  return dir ? <FolderTypeIcon open={false} name={name} /> : <FileTypeIcon name={name} />;
}

/** 当前工作目录可用的插件名、技能名，输入框和消息里据此高亮 @插件名、/技能名 */
export const MentionNamesContext = createContext<MentionNames>({ plugins: [], skills: [] });
export interface MentionNames {
  plugins: string[];
  skills: string[];
}

/** 文字里的一个技能名或插件引用，[start, end) */
export interface Mention {
  start: number;
  end: number;
  kind: "skill" | "plugin" | "file" | "tab" | "browser";
  /** 标签页引用的标题（消息里只显示标题） */
  title?: string;
  /** 标签页、浏览器的来源：外部浏览器（用户的 Chrome）、桌面；内置浏览器的没有 */
  source?: MentionSource;
}

/**
 * 找出技能名、插件引用和文件引用，按位置排好。
 * 技能名在开头的都算（Claude Code 会展开），在中间的要在技能列表里；插件要在插件列表里；文件是带引号的，再加上：输入框里传 files（选过的文件），
 * 消息里不传，看着像路径的都算（输入框里不这么猜，不然 @README.m 还没打完就成了整体）。
 * 输入框里还传 tabTokens：「浏览器」「Computer Use」里选过的 @[标题]、@chrome[标题]、@desktop[标题]（不带网址的短格式，见 tabToken）
 */
export function findMentions(text: string, { plugins, skills }: MentionNames, files?: string[], tabTokens?: string[]): Mention[] {
  const mentions: Mention[] = [];
  const skill = SKILL_PREFIX.exec(text);
  if (skill) mentions.push({ start: 0, end: skill[0].length, kind: "skill" });
  const skillNames = new Set(skills);
  for (const { index, 1: space = "", 2: name = "" } of text.matchAll(SKILL_ANYWHERE)) {
    const start = index + space.length;
    if (start > 0 && skillNames.has(name)) mentions.push({ start, end: start + 1 + name.length, kind: "skill" });
  }
  const pluginNames = new Set(plugins);
  const fileNames = new Set(files ?? []);
  const tabs: Mention[] = [];
  for (const { index, 0: whole, 1: space = "", 2: src, 3: title = "" } of text.matchAll(TAB_MENTION)) {
    const start = index + space.length;
    const source = src?.toLowerCase() as MentionSource | undefined;
    tabs.push({ start, end: index + whole.length, kind: "tab", title, ...(source ? { source } : {}) });
  }
  for (const token of tabTokens ?? []) {
    const [, source, title = ""] = /^@(chrome|desktop)?\[(.*)\]$/.exec(token) as [string, MentionSource | undefined, string] | null ?? [];
    for (let start = text.indexOf(token); start >= 0; start = text.indexOf(token, start + token.length)) {
      const end = start + token.length;
      // 前面是空白或开头；后面紧跟 ( 的是完整格式，上面已经算过
      if ((start > 0 && !/\s/.test(text[start - 1]!)) || text[end] === "(") continue;
      tabs.push({ start, end, kind: "tab", title, ...(source ? { source } : {}) });
    }
  }
  for (const { index, 1: space = "", 2: name = "" } of text.matchAll(BROWSER_MENTION)) {
    const start = index + space.length;
    const source = BROWSER_SOURCE[name];
    tabs.push({ start, end: start + 1 + name.length, kind: "browser", ...(source ? { source } : {}) });
  }
  const inTab = (pos: number) => tabs.some((t) => pos >= t.start && pos < t.end);
  for (const { index, 1: space = "", 2: name = "" } of text.matchAll(AT_MENTION)) {
    const kind = pluginNames.has(name) ? "plugin" : name.startsWith('"') || fileNames.has(name) || (!files && PATH_LIKE.test(name)) ? "file" : null;
    if (!kind) continue;
    const start = index + space.length;
    if (inTab(start)) continue;
    mentions.push({ start, end: start + 1 + name.length, kind });
  }
  return [...mentions, ...tabs].sort((a, b) => a.start - b.start);
}

/**
 * 消息文字，技能名、插件、文件和标签页引用高亮；files、tabTokens 是输入框里选过的文件、标签页（见 findMentions）。
 * compact：标签页引用只显示标题、文件引用只显示文件名（消息里）；输入框的镜像层要和输入的字一一对齐，不能省
 */
export function MentionText({ text, files, tabTokens, compact }: { text: string; files?: string[]; tabTokens?: string[]; compact?: boolean }) {
  const mentions = findMentions(text, useContext(MentionNamesContext), files, tabTokens);
  if (!mentions.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const { start, end, kind, title, source } of mentions) {
    if (start > pos) parts.push(text.slice(pos, start));
    const chrome = source === "chrome";
    const desktop = source === "desktop";
    if (kind === "browser") {
      // 输入框里 @ 透明占位、叠浏览器（桌面）图标（和 textarea 对齐）；消息里图标加名字
      const icon = desktop ? <MonitorIcon className="" /> : <BrowserIcon chrome={chrome} />;
      parts.push(
        compact ? (
          <span key={start} className="mention mention-tab" title={chrome ? "用户自己的 Chrome" : desktop ? "这台电脑的桌面" : "右侧面板里的内置浏览器"}>
            {icon}
            {text.slice(start + 1, end)}
          </span>
        ) : (
          <span key={start} className="mention mention-tab-input">
            <span className="mention-tab-at">@{icon}</span>
            {text.slice(start + 1, end)}
          </span>
        ),
      );
      pos = end;
      continue;
    }
    if (kind === "tab" && compact) {
      const url = /\]\(([^)]*)\)$/.exec(text.slice(start, end))?.[1] ?? "";
      parts.push(
        <span key={start} className="mention mention-tab" title={chrome ? `Chrome：${url}` : desktop ? "桌面上的窗口" : url}>
          {desktop ? <MonitorIcon className="" /> : <GlobeIcon />}
          {(chrome || desktop) && <span className="mention-tab-source">{chrome ? "Chrome" : "桌面"}</span>}
          {title || url}
        </span>,
      );
      pos = end;
      continue;
    }
    if (kind === "tab") {
      // 输入框里：每个字都要留着（和 textarea 对齐），@ 和方括号透明，@ 的位置叠一个地球（桌面）图标；chrome、desktop 字样淡一些
      const [, src = "", inner = "", rest = ""] = /^@(chrome|desktop)?\[([^\]\n]*)\]([\s\S]*)$/.exec(text.slice(start, end)) ?? [];
      parts.push(
        <span key={start} className="mention mention-tab-input">
          <span className="mention-tab-at">@{desktop ? <MonitorIcon className="" /> : <GlobeIcon />}</span>
          {src && <span className="mention-tab-src">{src}</span>}
          <span className="mention-tab-bracket">[</span>
          {inner}
          <span className="mention-tab-bracket">]</span>
          {rest}
        </span>,
      );
      pos = end;
      continue;
    }
    if (kind === "file") {
      const { path, base, dir } = fileRefParts(text.slice(start + 1, end));
      // 消息里：图标加文件名，完整路径在悬停提示里；输入框里字不能少（和 textarea 对齐），@ 透明占位、叠文件图标
      parts.push(
        compact ? (
          <span key={start} className="mention mention-tab mention-file" title={path}>
            <FileRefIcon base={base} dir={dir} />
            {base}
          </span>
        ) : (
          <span key={start} className="mention mention-tab-input">
            <span className="mention-tab-at">
              @<FileRefIcon base={base} dir={dir} />
            </span>
            {quoted(text.slice(start + 1, end))}
          </span>
        ),
      );
      pos = end;
      continue;
    }
    parts.push(
      <span key={start} className="mention">
        <span className="mention-sigil">{kind === "skill" ? "/" : "@"}</span>
        {text.slice(start + 1, end)}
      </span>,
    );
    pos = end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}
