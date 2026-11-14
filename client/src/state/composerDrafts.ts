import { useSyncExternalStore, type SetStateAction } from "react";
import type { Attachment } from "../api";

/** 输入框下方的附件：选中后立刻上传，发送时只传 id */
export interface PendingFile {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  attachment?: Attachment;
  error?: string;
  /** 图片的本地预览地址（URL.createObjectURL），移除或发送后释放 */
  preview?: string;
  /** 大段粘贴的文字转成的附件：卡片上显示开头一行和「粘贴的文本」 */
  pastedText?: string;
  /** 从目录树拖进来的图片：不上传，发送时在文字末尾写成 @绝对路径，由 Claude Code 读给模型；preview 是网关的 /files/raw 地址 */
  path?: string;
}

/** 引用在输入框里显示的 token 和发送时换成的完整写法 */
export interface PickedRef {
  token: string;
  full: string;
}

/** 输入框里没发出去的内容，字段含义见 Composer */
export interface ComposerDraft {
  text: string;
  picked: string[];
  pickedTabs: PickedRef[];
  pickedPaths: PickedRef[];
  pickedSessions: PickedRef[];
  files: PendingFile[];
}

const EMPTY: ComposerDraft = { text: "", picked: [], pickedTabs: [], pickedPaths: [], pickedSessions: [], files: [] };

/**
 * 每个会话输入框里没发出去的内容（新会话的键是 "new"）：切到别的会话再回来还在。
 * 只存在内存里，刷新页面就没了。附件上传完成时输入框可能已经切走了，结果照样记进这里
 */
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(key: string, patch: (draft: ComposerDraft) => Partial<ComposerDraft>): void {
  const prev = drafts.get(key) ?? EMPTY;
  const next = { ...prev, ...patch(prev) };
  const empty = !next.text && (Object.keys(EMPTY) as (keyof ComposerDraft)[]).every((k) => k === "text" || (next[k] as unknown[]).length === 0);
  if (empty) drafts.delete(key);
  else drafts.set(key, next);
  listeners.forEach((l) => l());
}

/** 整个换掉一个会话的草稿（撤回编辑排队的消息时，输入框是空的才能编辑） */
export function setComposerDraft(key: string, draft: ComposerDraft): void {
  update(key, () => draft);
}

/** 清空一个会话的草稿（发送成功后） */
export function clearComposerDraft(key: string): void {
  if (!drafts.delete(key)) return;
  listeners.forEach((l) => l());
}

/** 像 useState 一样用草稿里的一个字段 */
export function useDraftField<K extends keyof ComposerDraft>(key: string, field: K): [ComposerDraft[K], (value: SetStateAction<ComposerDraft[K]>) => void] {
  const value = useSyncExternalStore(subscribe, () => (drafts.get(key) ?? EMPTY)[field]);
  const set = (action: SetStateAction<ComposerDraft[K]>) =>
    update(key, (d) => ({ [field]: typeof action === "function" ? (action as (prev: ComposerDraft[K]) => ComposerDraft[K])(d[field]) : action }));
  return [value, set];
}
