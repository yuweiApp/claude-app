import type { IncomingHttpHeaders } from "node:http";

/** 逐跳的头（只对这一段连接有效）：代理转发请求、响应时不往下一跳传 */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "transfer-encoding", "upgrade"];

/** 去掉逐跳的头和 extra 里的（都是小写），值是 undefined 的也去掉 */
export function endToEndHeaders(headers: IncomingHttpHeaders, extra: string[] = []): Record<string, string | string[]> {
  const drop = new Set([...HOP_BY_HOP, ...extra]);
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !drop.has(k)) out[k] = v;
  return out;
}
