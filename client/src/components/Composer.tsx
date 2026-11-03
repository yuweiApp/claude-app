import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { api, type Attachment } from "../api";
import { formatSize } from "./Attachments";

const MODES: Array<[string, string]> = [
  ["default", "每次询问"],
  ["acceptEdits", "自动允许编辑"],
  ["plan", "只做计划"],
  ["bypassPermissions", "全部允许"],
];

/** 输入框下方的附件：选中后立刻上传，发送时只传 id */
interface PendingFile {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  attachment?: Attachment;
  error?: string;
}

interface Props {
  running: boolean;
  permissionMode: string;
  maxUploadMb: number;
  onSend: (text: string, attachmentIds: string[]) => Promise<void>;
  onInterrupt: () => void;
  onPermissionMode: (mode: string) => void;
}

export function Composer({ running, permissionMode, maxUploadMb, onSend, onInterrupt, onPermissionMode }: Props) {
  const [text, setText] = useState("");
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
      setFiles((prev) => [...prev, { key, name: file.name, size: file.size, status: "uploading" }]);
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
          {files.map((f) => (
            <span key={f.key} className={`chip ${f.status}`} title={f.error ?? f.attachment?.path ?? f.name}>
              <span className="chip-name">{f.name}</span>
              <span className="chip-meta">
                {f.status === "uploading" ? "上传中…" : f.status === "error" ? f.error : formatSize(f.size)}
              </span>
              <button className="chip-remove" onClick={() => setFiles((prev) => prev.filter((p) => p.key !== f.key))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={text}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行；可以拖入或粘贴文件"
        rows={3}
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
        <button onClick={() => inputRef.current?.click()} title="添加文件">
          附件
        </button>
        <select value={permissionMode} onChange={(e) => onPermissionMode(e.target.value)}>
          {MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {running && <button onClick={onInterrupt}>中断</button>}
        <button className="primary" disabled={!canSend} onClick={() => void submit()}>
          发送
        </button>
      </div>
    </div>
  );
}
