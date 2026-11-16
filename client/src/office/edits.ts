// 这个文件不引用 jszip：预览组件一开始就要用它，解析、渲染的代码（pkg.ts 和各格式）打开文档时才加载

/**
 * Office 文档（docx、xlsx、pptx）都是 zip 包着一堆 XML（OOXML）。右侧面板的预览（components/OfficePreview.tsx）在界面里
 * 解开、渲染成 HTML 放进沙箱 iframe；改内容时只改对应 XML 节点里的文字，别的原样留着，再打包写回去。
 *
 * 改动（Edits）：键是元素在文档里的位置（docx「p:<第几个段落>」、xlsx「c:<第几张表>:<单元格>」、pptx「p:<第几张幻灯片>:<第几个段落>」），
 * 值是这个元素里各段文字改成什么：段落按原来的文字段（一段格式一样的文字，XML 里的一个 <t>）分开给，各段的格式不变；
 * null 是这一段没动。单元格只有一段，是输入的内容（= 开头是公式）。
 * 没保存的改动按这个形状转成 JSON 存在 state/fileDrafts 里
 */
export type Edits = Record<string, (string | null)[]>;

export function parseEdits(draft: string | undefined): Edits {
  if (!draft) return {};
  try {
    const v = JSON.parse(draft) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Edits) : {};
  } catch {
    return {};
  }
}
