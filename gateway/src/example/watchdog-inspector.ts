/**
 * 简易 demo：用「看门狗线程 + inspector」从外面打断卡死的同步代码。
 * 这是对 loop-guard.ts（在循环里插检查）的另一种思路，网关里目前没有用，这里只演示原理和它的副作用。
 *
 * 运行（在 gateway 目录下）：
 *   npx tsx src/example/watchdog-inspector.ts
 *
 * 背景：
 * - 主线程被同步代码占住时，主线程上的任何 JS（计时器、事件回调）都没机会执行，所以「自己检查自己」只能靠插进代码里的检查。
 * - 但别的线程不受影响。Node 的 worker 线程有自己的事件循环，主线程卡住时它照样在跑。
 * - 只靠 worker 也不够：JS 没有让一个线程打断另一个线程的 API。能做到这件事的是 V8 的调试接口（inspector）：
 *   Chrome 开发者工具能在网页死循环时按「暂停」，靠的就是它。worker 里用 inspector.Session 的 connectToMainThread()
 *   连上主线程的调试接口，就能对主线程发调试命令，命令会在主线程正在跑 JS 的时候被处理（V8 用「中断」插进去执行）。
 *
 * 用到的三个调试命令（Chrome DevTools Protocol，CDP）：
 * - Debugger.pause：让主线程停在当前执行的位置，发出 Debugger.paused 事件，里面有调用栈（每一帧的文件名、行号）
 * - Runtime.terminateExecution：终止主线程上正在跑的 JS。这种终止 try/catch 接不住，finally 也不执行，
 *   一直退到最外层（计时器回调、微任务的入口），然后主线程回到事件循环，接着处理别的事情
 * - Debugger.resume：从暂停中恢复
 *
 * 为了演示快一点，这里的上限是 1 秒。
 */
import { Worker } from "node:worker_threads";
import vm from "node:vm";

/** 主线程被占住多久算卡死 */
const LIMIT_MS = 1000;

// ───────────────────────────── 看门狗线程里跑的代码 ─────────────────────────────

/**
 * 看门狗线程的代码，用 eval: true 交给 Worker 直接跑（worker 里是 CommonJS，可以 require）。
 * 写成字符串是为了这个 demo 一个文件就能跑；用 String.raw，里面的反斜杠原样保留。
 *
 * 它做的事：
 * 1. 每 100 毫秒看一眼共享内存里的心跳计数（主线程每 50 毫秒加一）
 * 2. 计数超过 LIMIT_MS 没变，说明主线程卡住了：
 *    暂停主线程、看调用栈里有没有模型代码的文件（browser_run_code_<编号>.js）
 *    - 有：告诉主线程是哪个编号卡住了，然后终止执行
 *    - 没有（卡住的是网关自己的代码）：不动它，恢复执行
 */
const WATCHDOG_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const inspector = require("node:inspector");

const session = new inspector.Session();
session.connectToMainThread();
// session.post 改成返回 Promise 的写法
const post = (method, params) =>
  new Promise((resolve, reject) => session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))));

const heartbeat = new Int32Array(workerData.buffer);
let lastBeat = Atomics.load(heartbeat, 0);
let lastChange = Date.now();
let handling = false;

// 脚本编号 → 文件名。Debugger.enable 时 V8 会把已经加载的每个脚本都发一条 Debugger.scriptParsed 过来，
// 之后新加载的也会发。调用栈里每一帧只有脚本编号（callFrame.url 是空的，CDP 已经不推荐用它），要靠这张表查文件名
const scripts = new Map();
session.on("Debugger.scriptParsed", ({ params }) => scripts.set(params.scriptId, params.url));

// 主线程停下来之后，Debugger.paused 事件带着调用栈过来
session.on("Debugger.paused", async ({ params }) => {
  const urls = params.callFrames.map((frame) => scripts.get(frame.location.scriptId) || "");
  const match = urls.map((url) => /browser_run_code_(\d+)\.js/.exec(url)).find(Boolean);
  if (match) {
    // 先告诉主线程是谁（主线程恢复之后才会收到这条消息），再终止、恢复。
    // terminateExecution 要等主线程上的 JS 真正被终止之后才回复，而主线程这时还停在暂停里，
    // 所以不能等它的回复，接着发 Debugger.resume，主线程一恢复就被终止
    parentPort.postMessage({ type: "terminated", id: Number(match[1]) });
    void post("Runtime.terminateExecution");
  } else {
    parentPort.postMessage({ type: "skipped", top: urls[0] || "(未知)" });
  }
  await post("Debugger.resume");
  await post("Debugger.disable");
  lastChange = Date.now();
  handling = false;
});

setInterval(async () => {
  const beat = Atomics.load(heartbeat, 0);
  if (beat !== lastBeat) {
    lastBeat = beat;
    lastChange = Date.now();
    return;
  }
  if (handling || Date.now() - lastChange <= workerData.limit) return;
  // 主线程卡住了：开启调试器、让它暂停，后面的事在 Debugger.paused 里做
  handling = true;
  await post("Debugger.enable");
  await post("Debugger.pause");
}, 100);

parentPort.postMessage({ type: "ready" });
`;

// ───────────────────────────── 主线程这边 ─────────────────────────────

/** 心跳：主线程每 50 毫秒加一，看门狗看它变没变 */
const heartbeat = new Int32Array(new SharedArrayBuffer(4));
setInterval(() => Atomics.add(heartbeat, 0, 1), 50).unref();

/** 正在跑的模型代码：编号 → 让这次调用以出错结束的函数 */
const running = new Map<number, (reason: Error) => void>();
let nextId = 1;

/**
 * 被终止的代码，它的 Promise 永远不会结束（终止不是抛错，连 reject 都不会发生），
 * 所以要靠看门狗的消息，由我们自己让这次调用以出错结束
 */
function onWatchdogMessage(msg: { type: string; id?: number; top?: string }): void {
  if (msg.type === "terminated" && msg.id !== undefined) {
    console.log(`   [看门狗] 调用栈里有 browser_run_code_${msg.id}.js，已终止`);
    running.get(msg.id)?.(new Error(`代码连续同步执行超过 ${LIMIT_MS / 1000} 秒，已被看门狗终止。`));
  } else if (msg.type === "skipped") {
    console.log(`   [看门狗] 卡住的不是模型代码（栈顶在 ${msg.top}），不终止`);
  }
}

/**
 * 在 vm 里跑一段「模型代码」，文件名带编号，看门狗靠它认出是谁。
 *
 * 注意：如果模型代码在第一个 await 之前就卡住，这时 run() 自己也在调用栈上（正在执行 runInContext），
 * 终止会把 run() 一起打断，下面的 catch、finally 都不会执行。这里演示的都是 await 之后才卡住的情况；
 * 真正要用的话，第一个 await 之前的那段可以继续交给 vm 的 timeout 选项（它会正常抛错）
 */
async function run(context: vm.Context, code: string): Promise<string> {
  const id = nextId++;
  const start = Date.now();
  const killed = new Promise<never>((_, reject) => running.set(id, reject));
  killed.catch(() => undefined); // 万一没人等它（run 被一起终止了），也不算未处理的 Promise 拒绝
  try {
    const promise = vm.runInContext(`(async () => {\n${code}\n})()`, context, { filename: `browser_run_code_${id}.js` }) as Promise<unknown>;
    // 正常结束、抛错、被看门狗终止，哪个先到用哪个
    const value = await Promise.race([promise, killed]);
    return `${String(value)}（用了 ${Date.now() - start} 毫秒）`;
  } catch (err) {
    return `出错：${(err as Error).message}（用了 ${Date.now() - start} 毫秒）`;
  } finally {
    running.delete(id);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function demo(): Promise<void> {
  const watchdog = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { buffer: heartbeat.buffer, limit: LIMIT_MS } });
  watchdog.on("message", onWatchdogMessage);
  await new Promise<void>((resolve) => watchdog.once("message", () => resolve()));
  console.log("看门狗线程已就绪\n");

  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY);
  Object.assign(context, { setTimeout });

  // 1. await 之后的死循环：不用改写代码，没有插任何检查，照样能打断
  console.log("1. await 之后进入 while (true) {}（代码没有插任何检查）：");
  console.log("  ", await run(context, "await new Promise(r => setTimeout(r, 50));\nwhile (true) {}"));

  // 2. 回溯爆炸的正则：里面没有循环语句，插检查的办法管不到，看门狗能管
  console.log("2. 回溯爆炸的正则（插检查的办法管不到的情况）：");
  console.log("  ", await run(context, "await new Promise(r => setTimeout(r, 50));\nreturn /(a+)+$/.test('a'.repeat(40) + '!');"));

  // 3. 被终止的代码里，try/catch 接不住、finally 也不执行
  console.log("3. 代码里有 try/catch/finally：");
  const log: string[] = [];
  Object.assign(context, { log: (s: string) => log.push(s) });
  console.log(
    "  ",
    await run(context, "await new Promise(r => setTimeout(r, 50));\ntry { while (true) {} } catch { log('catch 执行了'); } finally { log('finally 执行了'); }"),
  );
  console.log(`   代码里记下的：${log.length ? log.join("、") : "（什么都没有：catch、finally 都没执行）"}`);

  // 4. 卡住的是网关自己的代码（不在 browser_run_code_*.js 里）：看门狗只看、不终止，等它自己跑完
  console.log("4. 网关自己的代码忙了 1.5 秒：");
  const start = Date.now();
  const end = start + 1500;
  while (Date.now() < end) {
    // 忙等
  }
  await sleep(50); // 让主线程转一圈，收到看门狗的消息
  console.log(`   网关的代码正常跑完了（用了 ${Date.now() - start} 毫秒）`);

  // 5. 副作用：终止发生在微任务里时，V8 会把整个微任务队列清空，排在后面的其他 Promise 回调全丢了
  console.log("5. 副作用：排在卡死代码后面的其他微任务");
  const seen: string[] = [];
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      queueMicrotask(() => seen.push("A（排在前面）"));
      // 模型代码 await 之后的部分是作为微任务跑的：await null 之后的死循环，就排在 A 后面、C 前面
      void run(context, "await null;\nwhile (true) {}").then((r) => console.log("  ", r));
      queueMicrotask(() => seen.push("C（排在后面，可能是网关别处的 Promise 回调）"));
      void Promise.resolve().then(() => seen.push("D（排在后面的 then）"));
      setTimeout(resolve, 1500);
    }, 0);
  });
  console.log(`   实际执行了的：${seen.join("、")}`);
  console.log("   C 和 D 丢了：如果它们是网关别处在等的 Promise，那边就会永远挂住、也不报错");

  // 6. 打断之后主线程照常工作
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);
  await sleep(500);
  clearInterval(timer);
  console.log(`6. 最后 0.5 秒里计时器跳了 ${ticks} 次，主线程正常`);

  // 退出前关掉看门狗：inspector 的会话还连着时退出，Node 会打印「Waiting for the debugger to disconnect...」
  await watchdog.terminate();
}

await demo();
