import { useEffect, useRef } from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import { FolderIcon } from "./FolderPicker";

/** 输入 @ 后弹出的一项：项目里的文件、文件夹（value 相对项目文件夹，文件夹以 / 结尾） */
export interface MentionOption {
  kind: "file" | "dir";
  value: string;
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
              {option.kind === "dir" ? <FolderIcon /> : <FileTypeIcon name={name} />}
            </span>
            <span className="mention-option-name">{name}</span>
            {parent && <span className="mention-option-sub">{parent}</span>}
          </button>
        );
      })}
    </div>
  );
}

