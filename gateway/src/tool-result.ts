/** 网关的 MCP 工具（终端、浏览器、桌面）共用的返回结果写法 */

export const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export const errorResult = (text: string) => ({ ...textResult(text), isError: true });

/** 结果前面加一段说明（应用重启过、别的会话动过桌面等），空行隔开；没有说明时原样 */
export const withNotice = (notice: string | null | undefined, body: string) => (notice ? (body ? `${notice}\n\n${body}` : notice) : body);
