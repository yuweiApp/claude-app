import { useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { api, type Attachment } from "../api";
import { formatSize } from "./Attachments";
import { ImageThumb } from "./ImageThumb";

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
}

/** 输入框，样式同 codex-app-server：一个圆角框，上面输入，下面一行「+」、权限、模型、发送 */
export function Composer({ running, maxUploadMb, onSend, onInterrupt, left, right, top, handle }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setFiles([]);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
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
      <textarea
        ref={textareaRef}
        value={text}
        placeholder="随心输入，可以拖入或粘贴文件；Enter 发送，Shift+Enter 换行"
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
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
        <button className="icon-btn composer-add" onClick={() => inputRef.current?.click()} title="添加文件" aria-label="添加文件">
          ＋
        </button>
        {left}
        <div className="spacer" />
        {right}
        {running && !text.trim() && ready.length === 0 ? (
          <button className="send-btn send-stop" onClick={onInterrupt} title="停止" aria-label="停止">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect width="12" height="12" rx="2" fill="currentColor" />
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
