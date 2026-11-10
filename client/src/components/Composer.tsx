import { useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { api, type Attachment } from "../api";
import { AddMenu } from "./AddMenu";
import { formatSize } from "./Attachments";
import { ImageThumb } from "./ImageThumb";
import { MentionMenu, type MentionOption } from "./MentionMenu";
import { fileMention, fileRefParts, findMentions, IMAGE_EXT, MentionText, browserMention, PATH_DRAG_TYPE, MentionNamesContext, tabMention, tabToken, type Mention, type MentionSource } from "./MentionText";

/** 输入框下方的附件：选中后立刻上传，发送时只传 id */
interface PendingFile {
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

/** 释放本地预览地址（拖进来的图片用的是网关地址，不用释放） */
const revokePreview = (f: PendingFile) => f.preview?.startsWith("blob:") && URL.revokeObjectURL(f.preview);

/** 粘贴的文字超过这么多字时存成附件（同 codex-app-server），输入框里只留自己要说的话 */
const PASTE_AS_FILE_CHARS = 5000;

/** 外面往输入框里写内容 */
export interface ComposerHandle {
  /** 用技能：插在光标处，写成 /技能名 */
  mentionSkill: (name: string) => void;
  /** 引用插件：插在光标处 */
  mention: (name: string) => void;
  /** 引用浏览器标签页（输入框上面的「浏览器」）或桌面上的窗口（「Computer Use」）：插在光标处，source 见 MentionSource */
  mentionTab: (title: string, url: string, source?: MentionSource) => void;
  /** 引用整个浏览器或桌面（「浏览器」「Computer Use」菜单的第一行）：插在光标处 */
  mentionBrowser: (name: string) => void;
  /** 把焦点给输入框，光标留在原来的位置 */
  focus: () => void;
}

interface Props {
  running: boolean;
  maxUploadMb: number;
  onSend: (text: string, attachmentIds: string[]) => Promise<void>;
  onInterrupt: () => void;
  /** 工具栏左边「+」后面：权限、新会话的选文件夹 */
  left?: ReactNode;
  /** 工具栏右边发送按钮前面：模型和推理强度 */
  right?: ReactNode;
  /** 输入框上面一栏：新会话的选文件夹、技能、插件 */
  top?: ReactNode;
  handle?: Ref<ComposerHandle>;
  /** 项目文件夹：有的话输入 @ 可以引用里面的文件 */
  cwd?: string | null;
  /** 上一轮被中断了：输入框空着时发送按钮变成「继续」 */
  onContinue?: () => void;
  /** 输入框里、文字上方：待发送的回复注释（「N 条注释」） */
  notes?: ReactNode;
  /** 有待发送的注释：没写文字也能发送 */
  hasNotes?: boolean;
}

/** 输入框，样式同 codex-app-server：一个圆角框，上面输入，下面一行「+」、权限、模型、发送 */
export function Composer({ running, maxUploadMb, onSend, onInterrupt, left, right, top, handle, cwd, onContinue, notes, hasNotes = false }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const names = useContext(MentionNamesContext);
  // @ 菜单里选过的文件，只有这些（和带引号的）算文件引用，手打的 @xxx 不算
  const [picked, setPicked] = useState<string[]>([]);
  // 「浏览器」里选过的：输入框里只显示 token（@[标题]），发送时换成 full（带网址的 @[标题](网址)）
  const [pickedTabs, setPickedTabs] = useState<{ token: string; full: string }[]>([]);
  // 右侧面板目录树拖进来的：输入框里只显示 token（@文件名，同名不同路径的加 (2)、(3)），发送时换成 full（绝对路径的引用）
  const [pickedPaths, setPickedPaths] = useState<{ token: string; full: string }[]>([]);
  const fileRefs = [...picked, ...pickedPaths.map((p) => p.token.slice(1))];
  const mentions = findMentions(text, names, fileRefs, pickedTabs.map((t) => t.token));
  const highlighted = mentions.length > 0;

  // 光标前紧挨着的 @xxx：弹出项目里的文件候选（插件、浏览器标签页走上面的「插件」「浏览器」按钮，这里不列）；已经是整体的引用不弹，选中的文件夹接着列里面的
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const atMatch = /(^|\s)@([^\s"]*)$/.exec(text.slice(0, caret));
  const atStart = atMatch ? atMatch.index + atMatch[1]!.length : -1;
  const atQuery = atMatch?.[2] ?? "";
  const completed = mentions.some((m) => m.start === atStart && m.end === caret && !atQuery.endsWith("/"));
  // Esc 关掉的是哪个 @（位置），换了位置再弹
  const [dismissed, setDismissed] = useState(-1);
  useEffect(() => {
    if (atStart < 0) setDismissed(-1);
  }, [atStart]);
  const menuWanted = focused && atStart >= 0 && !completed && dismissed !== atStart && !!cwd;
  const [options, setOptions] = useState<MentionOption[]>([]);
  const [activeOption, setActiveOption] = useState(0);
  useEffect(() => {
    if (!menuWanted) {
      setOptions([]);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void (cwd ? api.files(cwd, atQuery).catch(() => []) : Promise.resolve([])).then((entries) => {
        if (stale) return;
        setOptions(entries.map((e): MentionOption => ({ kind: e.dir ? "dir" : "file", value: e.path })));
        setActiveOption(0);
      });
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [menuWanted, atQuery, cwd]);
  const menuOpen = menuWanted && options.length > 0;

  const pickOption = (option: MentionOption) => {
    // 文件夹不加空格，菜单接着列里面的；文件后面加空格
    const token = fileMention(option.value);
    const insert = option.kind === "dir" ? token : `${token} `;
    const rest = text.slice(caret);
    pendingCaret.current = atStart + insert.length;
    setText(text.slice(0, atStart) + insert + (insert.endsWith(" ") && rest.startsWith(" ") ? rest.slice(1) : rest));
    setPicked((prev) => (prev.includes(option.value) ? prev : [...prev, option.value]));
  };
  // 镜像层跟着输入框：滚动位置一致，出滚动条时让出同样的宽度，换行才对得上
  const syncMirror = () => {
    const input = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    mirror.scrollTop = input.scrollTop;
    mirror.style.right = `${input.offsetWidth - input.clientWidth}px`;
  };
  useLayoutEffect(syncMirror, [text]);
  // 输入框上面那一栏放不下时（窗口窄）按钮只留图标：先去掉 compact 量一次带文字的宽度，超出就加回去。量在同一帧里，不会闪
  const barRef = useRef<HTMLDivElement>(null);
  const hasTop = !!top;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const fit = () => {
      bar.classList.remove("compact");
      bar.classList.toggle("compact", bar.scrollWidth > bar.clientWidth);
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(bar);
    // 按钮增减、文件夹名变了也重新量（只看子节点和文字，不看 class，免得自己触发自己）
    const mutation = new MutationObserver(fit);
    mutation.observe(bar, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [hasTop]);
  // 改了文字后要放的光标位置（插入引用、整体删掉技能名和插件引用后），等新文字渲染完再放
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);
  // 上面「技能」「插件」「浏览器」选中的：插在光标处（输入框失焦后 textarea 还记着光标），前后不是空白的补空格，光标放到后面
  const insertAtCaret = (token: string) => {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const insert = `${before && !/\s$/.test(before) ? " " : ""}${token}${/^\s/.test(after) ? "" : " "}`;
    pendingCaret.current = before.length + insert.length + (/^\s/.test(after) ? 1 : 0);
    setText(before + insert + after);
    input?.focus();
  };
  useImperativeHandle(handle, () => ({
    mentionSkill: (name) => insertAtCaret(`/${name}`),
    mention: (name) => insertAtCaret(`@${name}`),
    mentionBrowser: (name) => insertAtCaret(browserMention(name)),
    mentionTab: (title, url, source) => {
      // 同名不同网址的标签页：标题后面加 (2)、(3) 区分
      const full = (t: string) => tabMention(t, url, source);
      let name = title || url;
      for (let n = 2; pickedTabs.some((p) => p.token === tabToken(name, source) && p.full !== full(name)); n++) name = `${title || url} (${n})`;
      const token = tabToken(name, source);
      setPickedTabs((prev) => (prev.some((p) => p.token === token) ? prev : [...prev, { token, full: full(name) }]));
      insertAtCaret(token);
    },
    focus: () => textareaRef.current?.focus(),
  }));
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploading = files.some((f) => f.status === "uploading");
  const ready = files.filter((f) => f.status === "done");
  const canSend = (text.trim() || ready.length > 0 || hasNotes) && !uploading && !sending;

  const addFiles = (list: File[], pastedText?: string) => {
    for (const file of list) {
      const key = crypto.randomUUID();
      if (file.size > maxUploadMb * 1024 * 1024) {
        setFiles((prev) => [...prev, { key, name: file.name, size: file.size, status: "error", error: `超过 ${maxUploadMb} MB` }]);
        continue;
      }
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setFiles((prev) => [...prev, { key, name: file.name, size: file.size, status: "uploading", preview, pastedText }]);
      api.upload([file]).then(
        ([attachment]) =>
          setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, status: "done", attachment } : f))),
        (e: Error) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, status: "error", error: e.message } : f))),
      );
    }
  };

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      // 拖进来的图片写在最后一段：@绝对路径，空格隔开（消息里据此显示成缩略图，见 splitImageRefs）
      const body = expandPaths(expandTabs(text.trim(), pickedTabs), pickedPaths);
      const refs = ready.flatMap((f) => (f.path ? [fileMention(f.path)] : [])).join(" ");
      await onSend([body, refs].filter(Boolean).join("\n\n"), ready.flatMap((f) => (f.attachment ? [f.attachment.id] : [])));
      setText("");
      setPicked([]);
      setPickedPaths([]);
      setPickedTabs([]);
      files.forEach(revokePreview);
      setFiles([]);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen) {
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (step) {
        e.preventDefault();
        setActiveOption((i) => (i + step + options.length) % options.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickOption(options[activeOption] ?? options[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(atStart);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // 技能名、插件和文件引用是一个整体：退格、删除一次删掉整个（连同后面的一个空格），左右键直接跳过
    const input = e.currentTarget;
    const { selectionStart: caret, selectionEnd } = input;
    if (!mentions.length || caret !== selectionEnd || e.altKey || e.ctrlKey || e.metaKey) return;
    const remove = ({ start, end }: Mention) => {
      e.preventDefault();
      pendingCaret.current = start;
      setText(text.slice(0, start) + text.slice(text[end] === " " ? end + 1 : end));
    };
    if (e.key === "Backspace") {
      const hit = mentions.find(({ start, end }) => caret > start && caret <= (text[end] === " " ? end + 1 : end));
      if (hit) remove(hit);
    } else if (e.key === "Delete") {
      const hit = mentions.find(({ start, end }) => caret >= start && caret < end);
      if (hit) remove(hit);
    } else if (e.key === "ArrowLeft" && !e.shiftKey) {
      const hit = mentions.find(({ end }) => caret === end);
      if (hit) {
        e.preventDefault();
        input.setSelectionRange(hit.start, hit.start);
      }
    } else if (e.key === "ArrowRight" && !e.shiftKey) {
      const hit = mentions.find(({ start }) => caret === start);
      if (hit) {
        e.preventDefault();
        input.setSelectionRange(hit.end, hit.end);
      }
    }
  };

  // 光标落进技能名、插件引用中间（点击、上下键）时挪到离得近的一头，不让在里面改字
  const onSelect = () => {
    const input = textareaRef.current;
    if (!input) return;
    setCaret(input.selectionEnd);
    if (input.selectionStart !== input.selectionEnd) return;
    const caret = input.selectionStart;
    const hit = mentions.find(({ start, end }) => caret > start && caret < end);
    if (!hit) return;
    const edge = caret - hit.start < hit.end - caret ? hit.start : hit.end;
    input.setSelectionRange(edge, edge);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
      return;
    }
    const plain = e.clipboardData.getData("text/plain");
    if (plain.length > PASTE_AS_FILE_CHARS) {
      e.preventDefault();
      addFiles([new File([plain], "粘贴的文本.txt", { type: "text/plain" })], plain);
    }
  };

  // 右侧面板目录树里拖来的文件、文件夹：插成绝对路径的文件引用（见 PATH_DRAG_TYPE）；系统里拖来的文件上传成附件
  const acceptsDrop = (e: DragEvent) => e.dataTransfer.types.includes(PATH_DRAG_TYPE) || e.dataTransfer.types.includes("Files");
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const path = e.dataTransfer.getData(PATH_DRAG_TYPE);
    if (!path) {
      addFiles([...e.dataTransfer.files]);
      return;
    }
    // 图片：输入框里显示缩略图（和上传的图片一样），不上传，发送时写成 @绝对路径
    if (IMAGE_EXT.test(path)) {
      if (!files.some((f) => f.path === path)) {
        setFiles((prev) => [...prev, { key: crypto.randomUUID(), name: fileRefParts(path).base, size: 0, status: "done", preview: api.rawFileUrl(path, ""), path }]);
      }
      return;
    }
    mentionPath(path);
  };
  // 拖进来的文件、文件夹插成引用：输入框里只显示 @文件名（见 pickedPaths）
  const mentionPath = (path: string) => {
    const { base, dir } = fileRefParts(path);
    const full = fileMention(path);
    const tokenOf = (label: string) => fileMention(dir ? `${label}/` : label);
    let label = base;
    for (let n = 2; pickedPaths.some((p) => p.token === tokenOf(label) && p.full !== full); n++) label = `${base} (${n})`;
    const token = tokenOf(label);
    setPickedPaths((prev) => (prev.some((p) => p.token === token) ? prev : [...prev, { token, full }]));
    insertAtCaret(token);
  };

  return (
    <div className="composer-wrap">
    {top && <div className="new-chat-bar" ref={barRef}>{top}</div>}
    <div
      className={dragging ? "composer dragging" : "composer"}
      onDragOver={(e) => {
        if (acceptsDrop(e)) {
          e.preventDefault();
          if (e.dataTransfer.types.includes(PATH_DRAG_TYPE)) e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {menuOpen && <MentionMenu options={options} active={activeOption} onHover={setActiveOption} onPick={pickOption} />}
      {notes}
      {files.length > 0 && (
        <div className="chips">
          {files.map((f) => {
            const remove = () => {
              revokePreview(f);
              setFiles((prev) => prev.filter((p) => p.key !== f.key));
            };
            // 图片显示缩略图（同 codex-app-server 输入框里的图片附件），其他文件是文件名加大小
            if (f.preview) {
              return (
                <span key={f.key} className={`image-chip ${f.status}`} title={f.error ?? f.path ?? f.name}>
                  <ImageThumb src={f.preview} alt={f.name} className="image-chip-thumb" />
                  {f.status === "uploading" && <span className="image-chip-state">上传中…</span>}
                  {/* 缩略图只有 56px，完整的错误信息在悬停提示（title）里 */}
                  {f.status === "error" && <span className="image-chip-state error">上传失败</span>}
                  <button className="image-chip-remove" onClick={remove} title="移除" aria-label="移除">
                    ×
                  </button>
                </span>
              );
            }
            if (f.pastedText) {
              return (
                <span key={f.key} className={`chip pasted-chip ${f.status}`} title={f.error ?? f.pastedText.slice(0, 500)}>
                  <span className="pasted-chip-icon">
                    <PastedTextIcon />
                  </span>
                  <span className="pasted-chip-body">
                    <span className="chip-name">{f.pastedText.trim().split("\n", 1)[0]}</span>
                    <span className="chip-meta">
                      {f.status === "uploading" ? "上传中…" : f.status === "error" ? f.error : `粘贴的文本 · ${formatSize(f.size)}`}
                    </span>
                  </span>
                  <button className="image-chip-remove" onClick={remove} title="移除" aria-label="移除">
                    ×
                  </button>
                </span>
              );
            }
            return (
              <span key={f.key} className={`chip ${f.status}`} title={f.error ?? f.attachment?.path ?? f.name}>
                <span className="chip-name">{f.name}</span>
                <span className="chip-meta">
                  {f.status === "uploading" ? "上传中…" : f.status === "error" ? f.error : formatSize(f.size)}
                </span>
                <button className="chip-remove" onClick={remove}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {/* textarea 不能给部分文字上色：有技能名、插件引用时它的文字变透明（光标和选区还是它的），文字由上面一层画 */}
      <div className="composer-input">
        <textarea
          ref={textareaRef}
          className={highlighted ? "has-mention" : undefined}
          value={text}
          placeholder="随心输入，可以拖入或粘贴文件；Enter 发送，Shift+Enter 换行"
          rows={2}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionEnd);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onPaste={onPaste}
          onScroll={syncMirror}
        />
        {highlighted && (
          <div ref={mirrorRef} className="composer-mirror" aria-hidden="true">
            <MentionText text={text} files={fileRefs} tabTokens={pickedTabs.map((t) => t.token)} />
            {/* 结尾的换行在 div 里不占一行，在 textarea 里占 */}
            {"\n"}
          </div>
        )}
      </div>
      <div className="composer-bar">
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <AddMenu onUpload={() => inputRef.current?.click()} />
        {left}
        <div className="spacer" />
        {right}
        {running && !text.trim() && ready.length === 0 && !hasNotes ? (
          <button className="send-btn send-stop" onClick={onInterrupt} title="停止" aria-label="停止">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : onContinue && !running && !text.trim() && files.length === 0 && !hasNotes ? (
          <button className="send-btn" disabled={sending} onClick={onContinue} title="继续" aria-label="继续">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button className="send-btn" disabled={!canSend} onClick={() => void submit()} title={uploading ? "上传中…" : running ? "追加到当前任务" : "发送"} aria-label="发送">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
    </div>
  );
}

/** 发送前把输入框里的 @[标题]、@chrome[标题] 这样的换成带网址的完整格式（模型按网址找标签页）；手打的、没选过的不动 */
function expandTabs(text: string, tabs: { token: string; full: string }[]): string {
  return tabs.reduce((acc, { token, full }) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return acc.replace(new RegExp(`(^|\\s)${escaped}(?!\\()`, "g"), (_m, space: string) => space + full);
  }, text);
}

/** 发送前把拖进来的文件的 token（@文件名）换回绝对路径的引用 */
function expandPaths(text: string, paths: { token: string; full: string }[]): string {
  return paths.reduce((acc, { token, full }) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return acc.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "g"), (_m, space: string) => space + full);
  }, text);
}

function PastedTextIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7V5.5a2 2 0 0 1 2-2H7M13 3.5h1.5a2 2 0 0 1 2 2V7M16.5 13v1.5a2 2 0 0 1-2 2H13M7 16.5H5.5a2 2 0 0 1-2-2V13M7.5 8.5h5M6.5 11.5h7" />
    </svg>
  );
}
