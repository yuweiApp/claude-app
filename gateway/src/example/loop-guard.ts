/**
 * 简易 demo：browser_run_code 在循环体开头插入的检查，是怎么防止模型的代码卡死网关的（真正的实现见 ../browser/repl.ts）。
 *
 * 运行（在 gateway 目录下）：
 *   npx tsx src/example/loop-guard.ts
 *
 * 背景：
 * - 模型的代码和网关在同一个 Node 进程里跑（vm 上下文），Node 是单线程的，
 *   代码里一个同步的死循环（比如 while (Date.now() < t) {} 这种忙等）会一直占着线程，
 *   网关的其他事情（别的会话、HTTP 接口、计时器）全都没法执行，整个网关就卡死了。
 * - JS 没有办法从外面「打断」一段正在跑的同步代码，只能让这段代码自己停下来。
 *   所以在每个循环体开头插一句检查：循环每转一圈都会经过它，发现卡太久就抛错，循环就被打断了。
 *
 * 为了演示快一点，这里的上限是 1 秒（真正的实现是 2 秒，MAX_BLOCK_MS）。
 */
import vm from "node:vm";
import { parse } from "acorn";

/** 事件循环最多被占住多久 */
const MAX_BLOCK_MS = 1000;
/** 插进循环体里的那个函数的名字（起个不会和模型变量重名的名字） */
const LOOP_GUARD = "__loopGuard__";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────────── 第一部分：死循环为什么会卡住整个网关 ─────────────────────────────

/**
 * 用一个每 100 毫秒跳一次的计时器代表「网关的其他事情」，然后跑一段 1.5 秒的忙等：
 * 忙等期间计时器一次都跳不了，等忙等结束才一下子补上
 */
async function whyItHangs(): Promise<void> {
  console.log("===== 第一部分：同步的循环会卡住整个进程 =====\n");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);

  await sleep(500);
  console.log(`正常情况：0.5 秒里计时器跳了 ${ticks} 次`);

  ticks = 0;
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    // 忙等 1.5 秒
  }
  console.log(`忙等 1.5 秒期间：计时器跳了 ${ticks} 次（一次都没轮到）`);
  clearInterval(timer);

  // vm 自带的 timeout 选项只管 runInContext 这一次同步执行；
  // 代码 await 之后剩下的部分是以后才跑的，那时 runInContext 早就返回了，timeout 管不到
  const context = vm.createContext({ setTimeout, Date });
  const start = Date.now();
  const promise = vm.runInContext(
    "(async () => { await new Promise(r => setTimeout(r, 10)); const end = Date.now() + 1500; while (Date.now() < end) {} return 'await 之后的循环跑完了，没人拦'; })()",
    context,
    { timeout: 100 }, // 只允许同步跑 100 毫秒，但对 await 之后的部分没用
  ) as Promise<string>;
  console.log(`vm 的 timeout 设成 100 毫秒：${await promise}（用了 ${Date.now() - start} 毫秒）\n`);
}

// ───────────────────────────── 第二部分：在循环体开头插检查 ─────────────────────────────

/** 五种循环语句 */
const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);
type AnyNode = { type: string; start: number; end: number; [key: string]: unknown };

/**
 * 插进去的那句话。先用 typeof 看函数在不在：
 * 传给 page.evaluate 这类方法的函数，会被 Playwright 转成字符串放到网页里跑，网页里没有这个函数，
 * 直接调用会报 ReferenceError；typeof 遇到没定义的名字不报错，只返回 "undefined"，于是在网页里就跳过了
 */
const GUARD_CALL = `typeof ${LOOP_GUARD} === "function" && ${LOOP_GUARD}();`;

/**
 * 用 acorn 把代码解析成语法树，找到所有循环，在循环体开头插入 GUARD_CALL：
 * - 循环体是 { ... }：插在「{」后面
 * - 循环体只有一条语句（for (...) foo();）：前后补上花括号，变成 for (...) { 检查; foo(); }
 * 插入是按字符位置改原文，不重新生成代码，所以模型写的其余部分原样不动
 */
function guardLoops(code: string): string {
  // 允许顶层 await 和 return：代码之后会被包进 async 函数里跑
  const program = parse(code, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as AnyNode;
  const inserts: { pos: number; text: string }[] = [];

  // 递归遍历语法树的每一个节点（函数里的、回调里的循环也都会找到）
  const visit = (node: AnyNode) => {
    if (LOOPS.has(node.type)) {
      const body = node.body as AnyNode;
      if (body.type === "BlockStatement") inserts.push({ pos: body.start + 1, text: GUARD_CALL });
      else inserts.push({ pos: body.start, text: `{${GUARD_CALL}` }, { pos: body.end, text: "}" });
    }
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child === "object" && typeof (child as AnyNode).type === "string") visit(child as AnyNode);
    }
  };
  visit(program);

  // 从后往前插：先插后面的，前面那些位置就不会被挤动
  inserts.sort((a, b) => b.pos - a.pos);
  let out = code;
  for (const { pos, text } of inserts) out = out.slice(0, pos) + text + out.slice(pos);
  return out;
}

function showInsertion(): void {
  console.log("===== 第二部分：插检查之后的代码 =====\n");
  const sample = [
    "while (true) {}",
    "for (const p of pages) console.log(p);",
    "for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) sum += i * j; }",
    "await page.evaluate(() => { for (const el of document.querySelectorAll('a')) el.remove(); });",
  ].join("\n");
  console.log("模型写的：\n" + sample + "\n");
  console.log("实际运行的：\n" + guardLoops(sample) + "\n");
}

// ───────────────────────────── 第三部分：检查函数本身 ─────────────────────────────

/**
 * 怎么知道「卡住了」：网关这边有一个每 100 毫秒跳一次的计时器，每次都把当前时间记到 lastTick。
 * 事件循环正常转动时，lastTick 最多落后 100 毫秒左右；
 * 如果有同步代码占着线程，计时器跳不了，lastTick 就一直停在卡住之前的时刻。
 * 所以在循环里看一眼 Date.now() - lastTick，超过 MAX_BLOCK_MS 就说明被占住太久了。
 *
 * 这个判断也管得到 await 之后、定时器回调里的循环：不管循环是什么时候开始跑的，看的都是「线程被占了多久」
 */
let lastTick = Date.now();
setInterval(() => {
  lastTick = Date.now();
}, 100).unref(); // unref：这个计时器不阻止进程退出

/** 网关这边的检查：真正看时间、抛错的地方 */
function checkBlocked(): void {
  if (Date.now() - lastTick > MAX_BLOCK_MS) {
    lastTick = Date.now(); // 重置一下，免得同一次卡顿里别的循环接着被判定成卡住
    throw new Error(`代码连续同步执行超过 ${MAX_BLOCK_MS / 1000} 秒（中间没有 await），已中止。`);
  }
}

/**
 * vm 里面的 LOOP_GUARD：只数次数，每 1024 次才调用一次 checkBlocked。
 * 原因是每转一圈都跨出 vm 调用网关的函数、再读一次时间，开销不小，
 * 正常的大计算循环（比如一千万次）会被拖慢好几倍，甚至被误判成卡死。
 * (++n & 1023) === 0 等价于 n % 1024 === 0，用位运算更快
 */
const GUARD_SOURCE = `var ${LOOP_GUARD} = (() => {
  const check = __checkBlocked__;
  let n = 0;
  return () => { if ((++n & 1023) === 0) check(); };
})();`;

/**
 * 建一个装好检查函数的 vm 上下文。
 *
 * fast = true 时用 vm.constants.DONT_CONTEXTIFY（Node 22.8 起有）：全局对象是 vm 里一个普通的全局对象。
 * 默认的 vm 上下文，读写全局变量都要经过 Node 的拦截器转到外面那个对象上，很慢；
 * 插进去的检查每圈都要读一次全局的 __loopGuard__，在默认上下文里一千万次的循环会慢到超过上限、被误判成卡死。
 * 真正的实现用的就是 DONT_CONTEXTIFY
 */
function createGuardedContext(fast: boolean): vm.Context {
  const context = fast ? vm.createContext(vm.constants.DONT_CONTEXTIFY) : vm.createContext({});
  // DONT_CONTEXTIFY 建出来的上下文不能在 createContext 时传对象进去，建好之后再挂属性
  Object.assign(context, { setTimeout, Date, __checkBlocked__: checkBlocked });
  vm.runInContext(GUARD_SOURCE, context);
  return context;
}

/** 插好检查后包进 async 函数跑（顶层可以 await），返回结果或错误信息 */
async function run(context: vm.Context, code: string): Promise<string> {
  const script = `(async () => {\n${guardLoops(code)}\n})()`;
  const start = Date.now();
  try {
    const value: unknown = await vm.runInContext(script, context);
    return `${String(value)}（用了 ${Date.now() - start} 毫秒）`;
  } catch (err) {
    return `出错：${(err as Error).message}（用了 ${Date.now() - start} 毫秒）`;
  }
}

async function demo(): Promise<void> {
  console.log("===== 第三部分：跑起来看看 =====\n");
  const context = createGuardedContext(true);

  // 1. await 之后的死循环：vm 的 timeout 管不到，靠插进去的检查打断
  console.log("1. await 之后进入死循环：");
  console.log("  ", await run(context, "await new Promise(r => setTimeout(r, 50));\nwhile (true) {}"));

  // 2. 打断之后，网关（这个进程）照常工作：计时器又能跳了
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);
  await sleep(500);
  clearInterval(timer);
  console.log(`2. 打断之后 0.5 秒里计时器跳了 ${ticks} 次，进程恢复正常`);

  // 3. 正常的大循环不受影响：一千万次很快就跑完了，不会被误杀
  console.log("3. 一千万次的正常计算：");
  const bigLoop = "let sum = 0;\nfor (let i = 0; i < 1e7; i++) sum += i;\nreturn sum;";
  console.log("   DONT_CONTEXTIFY 的上下文：", await run(context, bigLoop));
  // 对比：同样的代码放在默认的 vm 上下文里，读全局的 __loopGuard__ 太慢，会被误杀
  console.log("   默认的上下文（对比）：", await run(createGuardedContext(false), bigLoop));

  // 4. 中间有 await 的长循环也不受影响：每次 await 都让出了线程，计时器能跳，lastTick 一直是新的
  console.log("4. 跑 1.5 秒、但每圈都 await 一下的循环：");
  console.log(
    "  ",
    await run(context, "const end = Date.now() + 1500;\nlet n = 0;\nwhile (Date.now() < end) { n++; await new Promise(r => setTimeout(r, 20)); }\nreturn `转了 ${n} 圈`;"),
  );

  // 5. 模型的代码 try/catch 住了这个错误：外层循环接着转，下一次检查又会抛，最终还是停得下来
  //    （每次抛错都会重置 lastTick，所以大约每 MAX_BLOCK_MS 抛一次）
  console.log("5. 代码自己 catch 住了错误、外层还在循环：");
  console.log(
    "  ",
    await run(context, "let caught = 0;\nwhile (caught < 2) { try { while (true) {} } catch { caught++; } }\nreturn `catch 了 ${caught} 次之后自己退出了`;"),
  );

  // 管不到的情况（只说明，不运行）：
  // - 不是循环的同步卡顿，比如回溯爆炸的正则 /(a+)+$/.test("aaaa…a!")：里面没有我们插的检查。
  //   真正的实现里，代码开头同步执行的那一段（第一个 await 之前）还设了 vm 的 timeout 兜底，await 之后的就管不到了
  // - 递归死循环：不需要管，调用栈很快就满了，会报 Maximum call stack size exceeded
}

await whyItHangs();
showInsertion();
await demo();
