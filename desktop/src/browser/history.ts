import fs from "node:fs";
import path from "node:path";

/**
 * 内置浏览器的浏览历史（Electron 的网页视图不写 Chrome 的 History 数据库，这里自己记）：
 * 页面跳转时记网址、标题、访问次数、最近访问时间，最多 MAX 个网址，存在用户数据目录的 browser-history.json。
 * 地址栏的建议从这里取
 */
interface Entry {
  url: string;
  title: string;
  visits: number;
  last: number;
}

export interface Suggestion {
  url: string;
  title: string;
}

const MAX = 5000;

export class BrowserHistory {
  private entries = new Map<string, Entry>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string) {
    try {
      const list = JSON.parse(fs.readFileSync(file, "utf8")) as Entry[];
      for (const e of list) if (e && typeof e.url === "string") this.entries.set(e.url, e);
    } catch {
      // 第一次用，或者文件坏了：从空的开始
    }
  }

  /** 页面跳转到了 url（主框架） */
  visit(url: string, title: string): void {
    if (!/^https?:/i.test(url)) return;
    const e = this.entries.get(url);
    if (e) {
      e.visits++;
      e.last = Date.now();
      if (title) e.title = title;
    } else {
      this.entries.set(url, { url, title, visits: 1, last: Date.now() });
      if (this.entries.size > MAX) this.trim();
    }
    this.scheduleSave();
  }

  /** 页面标题出来了（跳转时常常还没有标题） */
  title(url: string, title: string): void {
    const e = this.entries.get(url);
    if (!e || !title || e.title === title) return;
    e.title = title;
    this.scheduleSave();
  }

  /** 地址栏的建议：网址或标题包含输入里的每个词（不分大小写），按访问次数和远近排 */
  suggest(query: string, limit = 8): Suggestion[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const now = Date.now();
    const score = (e: Entry) => {
      const days = (now - e.last) / 86_400_000;
      // 网址以输入开头的排前面（输入 git 先出 github.com）
      const host = e.url.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
      const prefix = host.startsWith(words[0]!) ? 3 : 1;
      return (prefix * Math.log2(1 + e.visits)) / (1 + days / 7);
    };
    return [...this.entries.values()]
      .filter((e) => {
        const hay = `${e.url} ${e.title}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit)
      .map(({ url, title }) => ({ url, title }));
  }

  clear(): void {
    this.entries.clear();
    this.scheduleSave();
  }

  /** 退出前写盘 */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.save();
  }

  private trim(): void {
    const sorted = [...this.entries.values()].sort((a, b) => b.last - a.last).slice(0, MAX);
    this.entries = new Map(sorted.map((e) => [e.url, e]));
  }

  private scheduleSave(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1000);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.entries.values()]));
    } catch {
      // 写不了就算了，下次再试
    }
  }
}
