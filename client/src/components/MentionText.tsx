import { createContext, useContext, type ReactNode } from "react";

/** 消息开头的 /技能名（插件技能是 /插件名:技能名）；/home/x 这样的路径后面还有斜杠，不算 */
const SKILL_PREFIX = /^\/([\w.-]+(?::[\w.-]+)?)(?=\s|$)/;
/** 前后是空白或首尾的 @名字，带空格的路径用引号：@"a b.txt" */
const AT_MENTION = /(^|\s)@("[^"\n]+"|\S+)/g;
/** 看着像路径：有 / 或带扩展名（@README.md、@src/）；@someone 不算 */
const PATH_LIKE = /\/|\.\w+$/;

/** 插入输入框的文件引用：带空白的路径加引号 */
export const fileMention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** 当前工作目录可用的插件名，输入框和消息里据此高亮 @插件名 */
export const PluginNamesContext = createContext<string[]>([]);

/** 文字里的一个技能名或插件引用，[start, end) */
export interface Mention {
  start: number;
  end: number;
  kind: "skill" | "plugin" | "file";
}

/**
 * 找出技能名、插件引用和文件引用，按位置排好。
 * 插件要在插件列表里；文件是带引号的，再加上：输入框里传 files（选过的文件），
 * 消息里不传，看着像路径的都算（输入框里不这么猜，不然 @README.m 还没打完就成了整体）
 */
export function findMentions(text: string, plugins: string[], files?: string[]): Mention[] {
  const mentions: Mention[] = [];
  const skill = SKILL_PREFIX.exec(text);
  if (skill) mentions.push({ start: 0, end: skill[0].length, kind: "skill" });
  const pluginNames = new Set(plugins);
  const fileNames = new Set(files ?? []);
  for (const { index, 1: space = "", 2: name = "" } of text.matchAll(AT_MENTION)) {
    const kind = pluginNames.has(name) ? "plugin" : name.startsWith('"') || fileNames.has(name) || (!files && PATH_LIKE.test(name)) ? "file" : null;
    if (!kind) continue;
    const start = index + space.length;
    mentions.push({ start, end: start + 1 + name.length, kind });
  }
  return mentions;
}

/** 消息文字，技能名、插件和文件引用高亮；files 是输入框里选过的文件 */
export function MentionText({ text, files }: { text: string; files?: string[] }) {
  const mentions = findMentions(text, useContext(PluginNamesContext), files);
  if (!mentions.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const { start, end, kind } of mentions) {
    if (start > pos) parts.push(text.slice(pos, start));
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
