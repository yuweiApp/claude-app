import type { AttachmentChip } from "../state/session";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 用户消息里的附件 */
export function Attachments({ items }: { items: AttachmentChip[] }) {
  return (
    <div className="chips">
      {items.map((a) => (
        <span key={a.path} className="chip done" title={a.path}>
          <span className="chip-name">{a.name}</span>
          {a.size !== undefined && <span className="chip-meta">{formatSize(a.size)}</span>}
        </span>
      ))}
    </div>
  );
}
