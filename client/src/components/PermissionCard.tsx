import { useState } from "react";
import type { PermissionRequest } from "../state/session";
import { toolBrief } from "./Messages";

/** 网关自己的工具，确认卡片上用说人话的标题 */
const PERMISSION_TITLES: Record<string, string> = {
  mcp__terminal__run_in_terminal: "允许在终端里运行这条命令？",
  mcp__terminal__stop_terminal_tab: "允许停止或关闭这个终端？",
};

interface Props {
  request: PermissionRequest;
  /** answers：AskUserQuestion 的回答（问题原文 → 选中的选项） */
  onReply: (behavior: "allow" | "deny", always?: boolean, answers?: Record<string, string>) => void;
}

export function PermissionCard({ request, onReply }: Props) {
  // AskUserQuestion 也经 canUseTool 过来：它不是要不要允许，而是模型在向用户提问，渲染成选择题
  if (request.toolName === "AskUserQuestion") return <QuestionCard request={request} onReply={onReply} />;
  const brief = toolBrief(request.toolName, request.input);
  return (
    <div className="permission">
      <div className="permission-title">{request.title || (PERMISSION_TITLES[request.toolName] ?? `允许使用 ${request.toolName}？`)}</div>
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

interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** 一道题的作答：选中的选项、「其他」里写的字 */
interface Answer {
  picked: string[];
  other: string;
  otherOn: boolean;
}

const emptyAnswer = (): Answer => ({ picked: [], other: "", otherOn: false });

/** 交给 Claude Code 的回答：选项的 label（按选项的顺序，不按点的先后），多选用逗号连接；「其他」是用户写的文字 */
function answerText(q: Question | undefined, a: Answer): string {
  const picked = q ? q.options.map((o) => o.label).filter((l) => a.picked.includes(l)) : a.picked;
  const parts = [...picked, ...(a.otherOn && a.other.trim() ? [a.other.trim()] : [])];
  return parts.join(", ");
}

/**
 * AskUserQuestion 的选择题卡片（同 Claude Code 终端里的问题界面）：每道题一组选项，单选或多选，另有「其他」可以自己写；
 * 提交后把回答经权限回复交给网关（updatedInput.answers），「跳过」是拒绝这次调用
 */
function QuestionCard({ request, onReply }: Props) {
  const questions = (Array.isArray(request.input.questions) ? request.input.questions : []) as Question[];
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(emptyAnswer));
  const update = (index: number, change: (a: Answer) => Answer) => setAnswers((all) => all.map((a, i) => (i === index ? change(a) : a)));

  const pick = (index: number, q: Question, label: string) =>
    update(index, (a) =>
      q.multiSelect
        ? { ...a, picked: a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label] }
        : { ...a, picked: [label], otherOn: false },
    );
  const toggleOther = (index: number, q: Question, on: boolean) =>
    update(index, (a) => ({ ...a, otherOn: on, ...(on && !q.multiSelect ? { picked: [] } : {}) }));

  const complete = answers.every((a, i) => answerText(questions[i], a) !== "");
  const submit = () => {
    if (!complete) return;
    onReply("allow", false, Object.fromEntries(questions.map((q, i) => [q.question, answerText(q, answers[i] ?? emptyAnswer())])));
  };

  return (
    <div className="permission question-card">
      <div className="permission-title">需要你回答</div>
      {questions.map((q, i) => {
        const a = answers[i] ?? emptyAnswer();
        const preview = q.options.find((o) => a.picked.includes(o.label) && o.preview)?.preview;
        return (
          <div key={i} className="question">
            <div className="question-text">
              {q.header && <span className="question-chip">{q.header}</span>}
              {q.question}
              {q.multiSelect && <span className="question-hint">（可多选）</span>}
            </div>
            <div className="question-options" role={q.multiSelect ? "group" : "radiogroup"}>
              {q.options.map((o) => {
                const selected = a.picked.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    role={q.multiSelect ? "checkbox" : "radio"}
                    aria-checked={selected}
                    aria-label={o.description ? `${o.label}：${o.description}` : o.label}
                    className={`question-option${selected ? " selected" : ""}`}
                    onClick={() => pick(i, q, o.label)}
                  >
                    <span className="question-mark">{q.multiSelect ? (selected ? "☑" : "☐") : selected ? "◉" : "○"}</span>
                    <span className="question-body">
                      <span className="question-label">{o.label}</span>
                      {o.description && <span className="question-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              <div className={`question-option question-other${a.otherOn ? " selected" : ""}`}>
                <button
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={a.otherOn}
                  aria-label="其他"
                  className="question-mark"
                  onClick={() => toggleOther(i, q, !a.otherOn)}
                >
                  {q.multiSelect ? (a.otherOn ? "☑" : "☐") : a.otherOn ? "◉" : "○"}
                </button>
                <input
                  value={a.other}
                  placeholder="其他（自己写）"
                  onFocus={() => toggleOther(i, q, true)}
                  onChange={(e) => update(i, (x) => ({ ...x, other: e.target.value, otherOn: true, ...(q.multiSelect ? {} : { picked: [] }) }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
                  }}
                />
              </div>
            </div>
            {preview && <pre className="tool-input">{preview}</pre>}
          </div>
        );
      })}
      <div className="permission-actions">
        <button className="primary" disabled={!complete} onClick={submit}>
          提交
        </button>
        <button onClick={() => onReply("deny")}>跳过</button>
      </div>
    </div>
  );
}
