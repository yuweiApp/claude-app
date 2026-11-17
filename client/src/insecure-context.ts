/**
 * 浏览器只在安全来源（https、localhost）里提供的接口，局域网分享的访客用 http://<局域网 IP> 打开时没有（见 docs/lan-share.md）：
 * - crypto.randomUUID：界面到处用它生成 id（右侧面板的标签页、输入框、消息），没有的话页面一加载就出错、一片空白
 * - navigator.clipboard：复制按钮用它写剪贴板，没有的话点了报错
 * 没有时用旧的办法补上；本机（localhost）本来就有，不会走到这里
 */
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = (() => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }) as Crypto["randomUUID"];
}

if (typeof navigator !== "undefined" && !navigator.clipboard) {
  /** 只能写文字（document.execCommand("copy")）；图片、读剪贴板不支持，报错 */
  const writeText = (text: string): Promise<void> => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    const active = document.activeElement as HTMLElement | null;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      area.remove();
      active?.focus?.({ preventScroll: true });
    }
    return ok ? Promise.resolve() : Promise.reject(new Error("复制失败"));
  };
  const unsupported = () => Promise.reject(new Error("用 http 打开的页面不支持这个剪贴板操作"));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, write: unsupported, readText: unsupported, read: unsupported },
  });
}

export {};
