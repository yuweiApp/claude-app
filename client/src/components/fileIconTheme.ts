/**
 * 文件、文件夹图标用开源的 Material Icon Theme（VS Code 的同名图标主题，MIT 许可，npm 包 material-icon-theme），同 codex-app-server：
 * 按文件名、扩展名、文件夹名查它的映射表（dist/material-icons.json），得到图标名，再取 icons/ 下对应的 svg。
 * 映射表比较大，这个模块由 FileTypeIcon.tsx 按需加载，不打进首屏
 */
import { fileExtensions, fileNames, folderNames, iconDefinitions, light } from "material-icon-theme/dist/material-icons.json";

type NameMap = Record<string, string | undefined>;

// 图标都是单独的文件（不内联成 data URL），用到哪个浏览器才去下载哪个
const ICON_URLS = import.meta.glob<string>("../../node_modules/material-icon-theme/icons/*.svg", {
  query: "?url&no-inline",
  import: "default",
  eager: true,
});
const ICON_DIR = "../../node_modules/material-icon-theme/icons/";

const defs = iconDefinitions as Record<string, { iconPath: string } | undefined>;

/** 图标名对应的 svg 地址（有的图标名对应的文件名不同，以映射表为准） */
function iconUrl(icon: string): string | undefined {
  const file = defs[icon]?.iconPath.split("/").pop() ?? `${icon}.svg`;
  return ICON_URLS[ICON_DIR + file];
}

/** 浅色界面有的图标换成浅色版（映射表的 light 部分），没有的用默认的 */
function pick(map: NameMap, lightMap: NameMap | undefined, key: string, dark: boolean) {
  return (!dark && lightMap?.[key]) || map[key];
}

/** 文件的图标：先按完整文件名（Dockerfile、package.json 等），再按扩展名从长到短（a.spec.ts 先 spec.ts 再 ts），都没有是普通文件 */
export function fileIconUrl(name: string, dark: boolean): string | undefined {
  const lower = name.toLowerCase();
  let icon = pick(fileNames as NameMap, light.fileNames as NameMap, lower, dark);
  const parts = lower.split(".");
  for (let i = 1; !icon && i < parts.length; i++) {
    icon = pick(fileExtensions as NameMap, light.fileExtensions as NameMap, parts.slice(i).join("."), dark);
  }
  return (icon && iconUrl(icon)) || iconUrl("file");
}

/** 文件夹的图标：按文件夹名（src、node_modules、.git 等），展开时是打开的样子 */
export function folderIconUrl(name: string, open: boolean, dark: boolean): string | undefined {
  const lower = name.toLowerCase();
  const lightIcon = dark ? undefined : (open ? light.folderNamesExpanded : light.folderNames)[lower as keyof typeof light.folderNames];
  if (lightIcon) return iconUrl(lightIcon);
  // 展开时的图标都是「名字-open」
  const icon = (folderNames as NameMap)[lower] ?? "folder";
  return iconUrl(open ? `${icon}-open` : icon) ?? iconUrl(open ? "folder-open" : "folder");
}
