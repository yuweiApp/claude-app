/** agent-desktop 的 snapshot 结果转成缩进文本（格式向 browser_snapshot 靠），见 docs/agent-desktop.md 第 4 节 */

interface SnapshotNode {
  role?: string;
  name?: string | null;
  description?: string | null;
  value?: unknown;
  ref_id?: string;
  states?: string[];
  available_actions?: string[];
  bounds?: { x: number; y: number; width: number; height: number };
  children_count?: number;
  children?: SnapshotNode[];
}

export interface SnapshotData {
  app?: string;
  complete?: boolean;
  ref_count?: number;
  snapshot_id?: string;
  tree?: SnapshotNode;
  window?: { id?: string; title?: string };
}

const quote = (s: string) => JSON.stringify(s);

function line(node: SnapshotNode): string {
  const name = node.name?.trim();
  // 没有名字时才带描述：有名字的菜单项、按钮多半还有一句描述（「Create a new document」），全带上快照大一截
  const description = !name ? node.description?.trim() : undefined;
  let text = `- ${node.role ?? "unknown"}`;
  if (name) text += ` ${quote(name)}`;
  else if (description) text += ` （描述：${quote(description)}）`;
  if (node.ref_id) text += ` [ref=${node.ref_id}]`;
  if (node.states?.length) text += ` (${node.states.join(", ")})`;
  if (node.ref_id && node.available_actions?.length) text += ` 可用：${node.available_actions.join(", ")}`;
  if (node.bounds) text += ` @${node.bounds.x},${node.bounds.y} ${node.bounds.width}×${node.bounds.height}`;
  if (node.value !== undefined && node.value !== null) text += `: ${typeof node.value === "string" ? quote(node.value) : JSON.stringify(node.value)}`;
  if (node.children_count && !node.children?.length) text += `（${node.children_count} 个子元素未展开）`;
  return text;
}

/** 没有名字、没有 ref、没有值的 group：不单独占一行，子元素提上来（Chromium 应用里有很长一串这样的） */
const passThrough = (node: SnapshotNode) =>
  node.role === "group" && !node.name?.trim() && !node.ref_id && (node.value === undefined || node.value === null) && !node.children_count;

export function renderSnapshot(data: SnapshotData): string {
  const lines: string[] = [];
  const walk = (node: SnapshotNode, depth: number) => {
    if (passThrough(node)) {
      for (const child of node.children ?? []) walk(child, depth);
      return;
    }
    lines.push("  ".repeat(depth) + line(node));
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  if (data.tree) walk(data.tree, 0);
  const header = [
    `snapshot ${data.snapshot_id ?? "?"}`,
    data.app ? `应用 ${data.app}` : "",
    data.window?.id ? `窗口 ${data.window.id}` : "",
    `${data.ref_count ?? 0} 个 ref`,
    data.complete === false ? "树没有读完整（complete: false）" : "",
  ]
    .filter(Boolean)
    .join("，");
  return `${header}\n${lines.join("\n")}`;
}
