import type { PermissionRequest } from "../state/session";
import { toolBrief } from "./Messages";

interface Props {
  request: PermissionRequest;
  onReply: (behavior: "allow" | "deny", always?: boolean) => void;
}

export function PermissionCard({ request, onReply }: Props) {
  const brief = toolBrief(request.toolName, request.input);
  return (
    <div className="permission">
      <div className="permission-title">{request.title || `允许使用 ${request.toolName}？`}</div>
      {request.description && <div className="permission-desc">{request.description}</div>}
      {brief ? <pre className="tool-input">{brief}</pre> : <pre className="tool-input">{JSON.stringify(request.input, null, 2)}</pre>}
      {request.decisionReason && <div className="permission-desc">{request.decisionReason}</div>}
      <div className="permission-actions">
        <button className="primary" onClick={() => onReply("allow")}>
          允许
        </button>
        {request.canAlways && <button onClick={() => onReply("allow", true)}>总是允许</button>}
        <button onClick={() => onReply("deny")}>拒绝</button>
      </div>
    </div>
  );
}
