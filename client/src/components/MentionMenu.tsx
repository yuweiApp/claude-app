import { useEffect, useRef } from "react";
import { GlobeIcon } from "./BrowserTab";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";

/**
 * 输入 @ 后弹出的一项：项目里的文件、文件夹（value 相对项目文件夹，文件夹以 / 结尾），
 * 或者内置浏览器里这个会话的标签页（value 是网址，title 是标题）
 */
export interface MentionOption {
  kind: "file" | "dir" | "tab";
  value: string;
  title?: string;
}

interface Props {
  options: MentionOption[];
  active: number;
  onHover: (index: number) => void;
  onPick: (option: MentionOption) => void;
}

/** 输入框上方的 @ 候选列表，键盘上下选、Enter / Tab 确定由输入框处理 */
export function MentionMenu({ options, active, onHover, onPick }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, options]);

  return (
    <div className="menu mention-menu" role="listbox" ref={listRef}>
      {options.map((option, i) => {
        if (option.kind === "tab") {
          return (
            <button
              key={`tab:${option.value}`}
              role="option"
              aria-selected={i === active}
              className={`mention-option${i === active ? " active" : ""}`}
              title={option.value}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== active && onHover(i)}
              onClick={() => onPick(option)}
            >
              <span className="mention-option-icon">
                <GlobeIcon />
              </span>
              <span className="mention-option-name">{option.title || option.value}</span>
              <span className="mention-option-sub">{option.value.replace(/^https?:\/\//, "")}</span>
            </button>
          );
        }
        const trimmed = option.kind === "dir" ? option.value.slice(0, -1) : option.value;
        const slash = trimmed.lastIndexOf("/");
        const name = trimmed.slice(slash + 1);
        const parent = slash === -1 ? "" : trimmed.slice(0, slash);
        return (
          <button
            key={`${option.kind}:${option.value}`}
            role="option"
            aria-selected={i === active}
            className={`mention-option${i === active ? " active" : ""}`}
            title={option.value}
            // 不让输入框失焦
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== active && onHover(i)}
            onClick={() => onPick(option)}
          >
            <span className="mention-option-icon">
              {option.kind === "dir" ? <FolderTypeIcon open={false} name={name} /> : <FileTypeIcon name={name} />}
            </span>
            <span className="mention-option-name">{name}</span>
            {parent && <span className="mention-option-sub">{parent}</span>}
          </button>
        );
      })}
    </div>
  );
}

