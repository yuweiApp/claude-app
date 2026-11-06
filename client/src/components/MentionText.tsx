import { createContext, useContext, type ReactNode } from "react";
import { GlobeIcon } from "./BrowserTab";

/** 消息开头的 /技能名（插件技能是 /插件名:技能名）；/home/x 这样的路径后面还有斜杠，不算 */
const SKILL_PREFIX = /^\/([\w.-]+(?::[\w.-]+)?)(?=\s|$)/;
/** 前后是空白或首尾的 @名字，带空格的路径用引号：@"a b.txt" */
const AT_MENTION = /(^|\s)@("[^"\n]+"|\S+)/g;
/** 看着像路径：有 / 或带扩展名（@README.md、@src/）；@someone 不算 */
const PATH_LIKE = /\/|\.\w+$/;
/** 标签页的引用：内置浏览器的 @[标题](网址)，外部浏览器（用户的 Chrome）的 @chrome[标题](网址)，见 tabMention */
const TAB_MENTION = /(^|\s)@(chrome)?\[([^\]\n]*)\]\(([a-z][\w+.-]*:[^\s)]+)\)/gi;

/** 发给模型的标签页引用：标题里的方括号、换行去掉 */
export const tabMention = (title: string, url: string, chrome?: boolean) => `${tabToken(title || url, chrome)}(${url})`;

/**
 * 输入框里的标签页引用只写 @[标题]、@chrome[标题]，不露网址；网址由输入框记着，发送时补成 tabMention 的完整格式。
 * 标签页标题里的方括号、换行去掉
 */
export const tabToken = (title: string, chrome?: boolean) => `@${chrome ? "chrome" : ""}[${title.replace(/[[\]\n]/g, " ").trim()}]`;

/** 插入输入框的文件引用：带空白的路径加引号 */
export const fileMention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** 当前工作目录可用的插件名，输入框和消息里据此高亮 @插件名 */
export const PluginNamesContext = createContext<string[]>([]);

/** 文字里的一个技能名或插件引用，[start, end) */
export interface Mention {
  start: number;
  end: number;
  kind: "skill" | "plugin" | "file" | "tab";
  /** 标签页引用的标题（消息里只显示标题） */
  title?: string;
  /** 外部浏览器（用户的 Chrome）的标签页 */
  chrome?: boolean;
}

/**
 * 找出技能名、插件引用和文件引用，按位置排好。
 * 插件要在插件列表里；文件是带引号的，再加上：输入框里传 files（选过的文件），
 * 消息里不传，看着像路径的都算（输入框里不这么猜，不然 @README.m 还没打完就成了整体）。
 * 输入框里还传 tabTokens：「标签页」里选过的 @[标题]、@chrome[标题]（不带网址的短格式，见 tabToken）
 */
export function findMentions(text: string, plugins: string[], files?: string[], tabTokens?: string[]): Mention[] {
  const mentions: Mention[] = [];
  const skill = SKILL_PREFIX.exec(text);
  if (skill) mentions.push({ start: 0, end: skill[0].length, kind: "skill" });
  const pluginNames = new Set(plugins);
  const fileNames = new Set(files ?? []);
  const tabs: Mention[] = [];
  for (const { index, 0: whole, 1: space = "", 2: chrome, 3: title = "" } of text.matchAll(TAB_MENTION)) {
    const start = index + space.length;
    tabs.push({ start, end: index + whole.length, kind: "tab", title, ...(chrome ? { chrome: true } : {}) });
  }
  for (const token of tabTokens ?? []) {
    const [, chrome, title = ""] = /^@(chrome)?\[(.*)\]$/.exec(token) ?? [];
    for (let start = text.indexOf(token); start >= 0; start = text.indexOf(token, start + token.length)) {
      const end = start + token.length;
      // 前面是空白或开头；后面紧跟 ( 的是完整格式，上面已经算过
      if ((start > 0 && !/\s/.test(text[start - 1]!)) || text[end] === "(") continue;
      tabs.push({ start, end, kind: "tab", title, ...(chrome ? { chrome: true } : {}) });
    }
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
 * compact：标签页引用只显示标题（消息里）；输入框的镜像层要和输入的字一一对齐，不能省
 */
export function MentionText({ text, files, tabTokens, compact }: { text: string; files?: string[]; tabTokens?: string[]; compact?: boolean }) {
  const mentions = findMentions(text, useContext(PluginNamesContext), files, tabTokens);
  if (!mentions.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const { start, end, kind, title, chrome } of mentions) {
    if (start > pos) parts.push(text.slice(pos, start));
    if (kind === "tab" && compact) {
      const url = /\]\(([^)]*)\)$/.exec(text.slice(start, end))?.[1] ?? "";
      parts.push(
        <span key={start} className="mention mention-tab" title={chrome ? `Chrome：${url}` : url}>
          <GlobeIcon />
          {chrome && <span className="mention-tab-source">Chrome</span>}
          {title || url}
        </span>,
      );
      pos = end;
      continue;
    }
    if (kind === "tab") {
      // 输入框里：每个字都要留着（和 textarea 对齐），@ 和方括号透明，@ 的位置叠一个地球图标；chrome 字样淡一些
      const [, src = "", inner = "", rest = ""] = /^@(chrome)?\[([^\]\n]*)\]([\s\S]*)$/.exec(text.slice(start, end)) ?? [];
      parts.push(
        <span key={start} className="mention mention-tab-input">
          <span className="mention-tab-at">
            @<GlobeIcon />
          </span>
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
