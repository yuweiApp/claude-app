import { useState, type KeyboardEvent } from "react";

const MODES: Array<[string, string]> = [
  ["default", "每次询问"],
  ["acceptEdits", "自动允许编辑"],
  ["plan", "只做计划"],
  ["bypassPermissions", "全部允许"],
];

interface Props {
  running: boolean;
  permissionMode: string;
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => void;
  onPermissionMode: (mode: string) => void;
}

export function Composer({ running, permissionMode, onSend, onInterrupt, onPermissionMode }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await onSend(value);
      setText("");
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

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        <select value={permissionMode} onChange={(e) => onPermissionMode(e.target.value)}>
          {MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {running && <button onClick={onInterrupt}>中断</button>}
        <button className="primary" disabled={!text.trim() || sending} onClick={() => void submit()}>
          发送
        </button>
      </div>
    </div>
  );
}
