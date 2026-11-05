import { useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { api, type Attachment } from "../api";
import { AddMenu } from "./AddMenu";
import { formatSize } from "./Attachments";
import { ImageThumb } from "./ImageThumb";
import { MentionMenu, type MentionOption } from "./MentionMenu";
import { fileMention, findMentions, MentionText, PluginNamesContext, tabMention, type Mention } from "./MentionText";

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
}

/** 外面往输入框里写内容 */
export interface ComposerHandle {
  /** 用技能：写到消息开头（Claude Code 只认开头的 /技能名），已经有技能时换掉 */
  useSkill: (name: string) => void;
  /** 引用插件：接在现有内容后面 */
  mention: (name: string) => void;
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
  /** 桌面版内置浏览器里这个会话的标签页：输入 @ 可以引用 */
  browserTabs?: { title: string; url: string }[];
}

/** 输入框，样式同 codex-app-server：一个圆角框，上面输入，下面一行「+」、权限、模型、发送 */
export function Composer({ running, maxUploadMb, onSend, onInterrupt, left, right, top, handle, cwd, onContinue, browserTabs }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const plugins = useContext(PluginNamesContext);
  // @ 菜单里选过的文件，只有这些（和带引号的）算文件引用，手打的 @xxx 不算
  const [picked, setPicked] = useState<string[]>([]);
  const mentions = findMentions(text, plugins, picked);
  const highlighted = mentions.length > 0;

  // 光标前紧挨着的 @xxx：弹出项目里的文件候选（插件走上面的「插件」按钮，这里不列）；已经是整体的引用不弹，选中的文件夹接着列里面的
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
  const menuWanted = focused && atStart >= 0 && !completed && dismissed !== atStart && (!!cwd || !!browserTabs?.length);
  const [options, setOptions] = useState<MentionOption[]>([]);
  const [activeOption, setActiveOption] = useState(0);
  useEffect(() => {
    if (!menuWanted) {
      setOptions([]);
      return;
    }
    let stale = false;
    // 标签页排在文件前面：标题或网址包含输入的，最多 5 个
    const q = atQuery.toLowerCase();
    const tabs = (browserTabs ?? [])
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
      .slice(0, 5)
      .map((t): MentionOption => ({ kind: "tab", value: t.url, title: t.title }));
    const timer = setTimeout(() => {
      void (cwd ? api.files(cwd, atQuery).catch(() => []) : Promise.resolve([])).then((entries) => {
        if (stale) return;
        setOptions([...tabs, ...entries.map((e): MentionOption => ({ kind: e.dir ? "dir" : "file", value: e.path }))]);
        setActiveOption(0);
      });
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [menuWanted, atQuery, cwd, browserTabs]);
  const menuOpen = menuWanted && options.length > 0;

  const pickOption = (option: MentionOption) => {
    // 文件夹不加空格，菜单接着列里面的；文件、标签页后面加空格
    const token = option.kind === "tab" ? tabMention(option.title ?? "", option.value) : fileMention(option.value);
    const insert = option.kind === "dir" ? token : `${token} `;
    const rest = text.slice(caret);
    pendingCaret.current = atStart + insert.length;
    setText(text.slice(0, atStart) + insert + (insert.endsWith(" ") && rest.startsWith(" ") ? rest.slice(1) : rest));
    if (option.kind !== "tab") setPicked((prev) => (prev.includes(option.value) ? prev : [...prev, option.value]));
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
  // 改了文字后要放的光标位置（技能名、插件引用整体删掉后），等新文字渲染完再放
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);
  useImperativeHandle(handle, () => ({
    useSkill: (name) => {
      setText((t) => `/${name} ${t.replace(/^\/\S+\s*/, "")}`);
      textareaRef.current?.focus();
    },
    mention: (name) => {
      setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}@${name} `);
      textareaRef.current?.focus();
    },
  }));
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploading = files.some((f) => f.status === "uploading");
  const ready = files.filter((f) => f.status === "done");
  const canSend = (text.trim() || ready.length > 0) && !uploading && !sending;

  const addFiles = (list: File[]) => {
    for (const file of list) {
      const key = crypto.randomUUID();
      if (file.size > maxUploadMb * 1024 * 1024) {
        setFiles((prev) => [...prev, { key, name: file.name, size: file.size, status: "error", error: `超过 ${maxUploadMb} MB` }]);
        continue;
      }
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setFiles((prev) => [...prev, { key, name: file.name, size: file.size, status: "uploading", preview }]);
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
      await onSend(text.trim(), ready.map((f) => f.attachment!.id));
      setText("");
      setPicked([]);
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
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
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="composer-wrap">
    {top && <div className="new-chat-bar">{top}</div>}
    <div
      className={dragging ? "composer dragging" : "composer"}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {menuOpen && <MentionMenu options={options} active={activeOption} onHover={setActiveOption} onPick={pickOption} />}
      {files.length > 0 && (
        <div className="chips">
          {files.map((f) => {
            const remove = () => {
              if (f.preview) URL.revokeObjectURL(f.preview);
              setFiles((prev) => prev.filter((p) => p.key !== f.key));
            };
            // 图片显示缩略图（同 codex-app-server 输入框里的图片附件），其他文件是文件名加大小
            if (f.preview) {
              return (
                <span key={f.key} className={`image-chip ${f.status}`} title={f.error ?? f.name}>
                  <ImageThumb src={f.preview} alt={f.name} className="image-chip-thumb" />
                  {f.status === "uploading" && <span className="image-chip-state">上传中…</span>}
                  {f.status === "error" && <span className="image-chip-state error">{f.error}</span>}
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
            <MentionText text={text} files={picked} />
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
        {running && !text.trim() && ready.length === 0 ? (
          <button className="send-btn send-stop" onClick={onInterrupt} title="停止" aria-label="停止">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : onContinue && !running && !text.trim() && files.length === 0 ? (
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
