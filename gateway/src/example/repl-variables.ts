/**
 * 简易 demo：browser_run_code 是怎么让变量在多次调用之间保留的（真正的实现见 ../browser/repl.ts）。
 *
 * 运行（在 gateway 目录下）：
 *   npx tsx src/example/repl-variables.ts
 *
 * 不需要浏览器：这里用一个假的 page 对象代替 Playwright 的 Page，只演示变量共享的原理。
 *
 * 整体思路就两点：
 * 1. 常驻的 vm 上下文：每个会话建一个，之后每次调用都在同一个上下文里跑，它的全局对象一直在，
 *    所以存成全局变量的东西下次还能用。
 * 2. 改写代码：模型写的顶层 const / let / function 本来不会变成「能反复用的全局变量」，
 *    运行前用 acorn 解析一遍，把它们改写成全局变量的赋值。
 */
import vm from "node:vm";
import { parse, type Pattern } from "acorn";

// ───────────────────────────── 第一部分：为什么不能直接跑 ─────────────────────────────

/** 不改写、直接在同一个上下文里跑，会遇到的两个问题 */
async function whyTransform(): Promise<void> {
  console.log("===== 第一部分：直接跑会有什么问题 =====\n");

  // 问题一：同一个上下文里，第二次写同名的 const 会报「已声明」。
  // 脚本顶层的 const / let 属于这个上下文的「全局词法作用域」，不能重复声明；模型经常会再写一遍同名变量
  const context1 = vm.createContext({});
  vm.runInContext("const title = 'A';", context1);
  try {
    vm.runInContext("const title = 'B';", context1);
  } catch (err) {
    console.log("问题一：第二次声明 const title →", (err as Error).message);
  }

  // 问题二：为了支持顶层 await，代码要包进 async 函数；这样一来 const 就成了函数里的局部变量，调用结束就没了
  const context2 = vm.createContext({});
  await vm.runInContext("(async () => { const count = await Promise.resolve(3); })()", context2);
  const result = vm.runInContext("typeof count", context2);
  console.log("问题二：包进 async 函数后，下一次调用里 typeof count →", result);
  console.log();
}

// ───────────────────────────── 第二部分：改写代码 ─────────────────────────────

/** 收集解构写法里声明的变量名：const { a, b: [c, ...d] } = x → a、c、d */
function patternNames(pattern: Pattern, out: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) patternNames(element, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    default:
      break;
  }
}

/**
 * 把模型写的代码改写成能在同一个上下文里反复跑的脚本：
 * - 顶层的 const / let / var 改成给全局变量赋值，变量名统一在最外面用 var 声明
 *   （var 声明在脚本顶层会成为全局对象的属性，可以重复声明，不会报错）
 * - 顶层的 function 声明提到最前面赋值（保留「函数可以先用后定义」的效果）
 * - 整段包进 async 函数，所以顶层可以 await
 * - 最后一条是表达式时，return 它的值，作为这次调用的结果
 *
 * 真正的实现还处理了 class、在循环里插卡死检查等，这里省略了
 */
function transform(code: string): string {
  const program = parse(code, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true, // 允许顶层 await，不然解析就报错
  });
  // 取某个语法节点在原文里对应的那段代码
  const src = (node: { start: number; end: number }) => code.slice(node.start, node.end);

  const declared = new Set<string>(); // 要在最外面用 var 声明的名字
  const hoisted: string[] = []; // 提到最前面的函数
  const body: string[] = []; // 其余语句，按原来的顺序

  program.body.forEach((stmt, i) => {
    const isLast = i === program.body.length - 1;

    // const / let / var：去掉声明关键字，改成赋值
    if (stmt.type === "VariableDeclaration") {
      const assigns: string[] = [];
      for (const decl of stmt.declarations) {
        const names: string[] = [];
        patternNames(decl.id, names);
        names.forEach((n) => declared.add(n));
        // 解构赋值要包一层括号：({ a } = obj) 才是合法的表达式
        if (decl.init) assigns.push(`(${src(decl.id)} = ${src(decl.init)})`);
        // 没写初始值的 let x; 重新声明时清空成 undefined；var x; 保留原来的值（和 var 本来的语义一致）
        else if (stmt.kind !== "var") assigns.push(`(${src(decl.id)} = undefined)`);
      }
      if (assigns.length) body.push(`void (${assigns.join(", ")});`);
      return;
    }

    // function f() {}：改成 f = function f() {}，放到最前面
    if (stmt.type === "FunctionDeclaration" && stmt.id) {
      declared.add(stmt.id.name);
      hoisted.push(`${stmt.id.name} = ${src(stmt)};`);
      return;
    }

    // 最后一条是表达式：作为结果返回
    if (stmt.type === "ExpressionStatement" && isLast) {
      body.push(`return (${src(stmt.expression)});`);
      return;
    }

    // 其他语句原样保留；补一个分号，免得和下一条连在一起
    body.push(`${src(stmt)};`);
  });

  const vars = declared.size ? `var ${[...declared].join(", ")};\n` : "";
  return `${vars}(async () => {\n${[...hoisted, ...body].join("\n")}\n})()`;
}

// ───────────────────────────── 第三部分：常驻的 REPL ─────────────────────────────

/** 假的 page：代替 Playwright 的 Page，只有两个方法 */
function createFakePage() {
  let url = "about:blank";
  return {
    async goto(next: string) {
      url = next;
    },
    async title() {
      return `「${url} 的标题」`;
    },
    url: () => url,
  };
}

/**
 * 一个会话的 REPL：构造时建一个 vm 上下文，之后每次 run 都用它。
 * 真正的实现里，网关按「浏览器:会话 id」把它存在一个 Map 里（见 ../browser/tool.ts 的 replFor），
 * 所以同一个会话的多次调用拿到的是同一个 REPL、同一个上下文
 */
class MiniRepl {
  private readonly context: vm.Context;
  /** 这次调用里 console.log 的输出，跑完一起返回 */
  private output: string[] = [];

  constructor() {
    // 上下文的全局对象：网关预先放进去的东西（真正的实现里还有 context、emitImage、setTimeout 等）
    this.context = vm.createContext({
      page: createFakePage(),
      // console 不用网关自己的：输出要收集起来，作为这次调用的结果返回给模型
      console: { log: (...args: unknown[]) => this.output.push(args.map(String).join(" ")) },
      // 新建的 vm 上下文里只有 JS 语言自带的东西（Object、Promise、JSON……），
      // URL、setTimeout、fetch、Buffer 这些是 Node 提供的，要从网关这边复制进去，不然会报「URL is not defined」。
      // 真正的实现里复制了一整个列表，见 ../browser/repl.ts 的 EXPOSED_GLOBALS
      URL,
    });
  }

  /** 跑一次代码，返回输出和最后一个表达式的值 */
  async run(code: string): Promise<string> {
    this.output = [];
    const script = transform(code);
    try {
      // 关键在这里：每次都是同一个 this.context
      const value = await vm.runInContext(script, this.context);
      if (value !== undefined) this.output.push(`→ ${String(value)}`);
    } catch (err) {
      this.output.push(`出错：${(err as Error).message}`);
    }
    return this.output.join("\n");
  }
}

async function demo(): Promise<void> {
  console.log("===== 第二部分：改写后的代码长什么样 =====\n");
  const sample = `const t = await page.title();\nfunction twice(s) { return s + s; }\ntwice(t)`;
  console.log("模型写的：\n" + sample + "\n");
  console.log("实际运行的：\n" + transform(sample) + "\n");

  console.log("===== 第三部分：同一个 REPL 连续调用 =====\n");
  const repl = new MiniRepl();
  // 模拟模型的五次 browser_run_code 调用
  const calls = [
    // 第一次：打开网页，把标题存进变量
    `await page.goto("https://example.com");\nconst title = await page.title();\ntitle`,
    // 第二次：直接用上一次的 title，再定义一个函数
    `console.log("上次存的 title 还在：", title);\nfunction shout(s) { return s + "！"; }\nshout(title)`,
    // 第三次：再写一遍 const title，不会报「已声明」，值被换掉
    `const title = "新的标题";\nshout(title)`,
    // 第四次：解构写法也能保留
    `const { host, path = "/" } = { host: new URL(page.url()).host };\n\`\${host}\${path}\``,
    // 第五次：let 不给初始值，会把变量清空成 undefined
    `let title;\ntypeof title`,
  ];
  for (const [i, code] of calls.entries()) {
    console.log(`--- 第 ${i + 1} 次调用 ---`);
    console.log(code);
    console.log("结果：");
    console.log(await repl.run(code));
    console.log();
  }

  // 另建一个 REPL（相当于另一个会话）：上下文是新的，看不到前一个会话的变量
  console.log("--- 另一个会话（新的 REPL）---");
  console.log(await new MiniRepl().run("typeof shout"));
}

await whyTransform();
await demo();
