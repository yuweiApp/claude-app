// 最简示例：AI 怎么操控桌面版里的内置浏览器
//
// 运行（在项目根目录）：
//   npm --prefix desktop i -D --save-exact playwright-core@1.64.1
//   desktop/node_modules/.bin/electron desktop/examples/ai-browser-demo.cjs
//
// 链路：AI 的指令 → Playwright → CDP 消息 → 这里的小代理 → webContents.debugger → 窗口里的网页
"use strict";
const { app, BaseWindow, WebContentsView } = require("electron");
const { chromium } = require("playwright-core");

// 演示用的网页：一个搜索框和一个按钮
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <h1>演示页</h1>
  <input placeholder="搜索" aria-label="搜索">
  <button onclick="document.querySelector('p').textContent='你搜索了：'+document.querySelector('input').value">搜索</button>
  <p></p>`)}`;

app.whenReady().then(async () => {
  // ① 桌面版里的「浏览器标签页」：一个原生网页视图
  const win = new BaseWindow({ width: 800, height: 500 });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 500 });
  await view.webContents.loadURL("about:blank");

  // ② Electron 自带的调试接口：能对这个网页收发 CDP 消息，不用开端口
  const dbg = view.webContents.debugger;
  dbg.attach("1.3");
  const { targetInfo } = await dbg.sendCommand("Target.getTargetInfo");

  // ③ 最小代理：把这一个网页包装成「只有一个标签页的浏览器」交给 Playwright。
  //    浏览器级的命令自己回答，其余的转给网页（真正实现里按会话只放这个会话的标签页）
  const PAGE_SESSION = "page-1";
  // 回给 Playwright 的消息要异步送：它发完命令才登记等回复，同步回会对不上
  const deliver = (message) => setImmediate(() => transport.onmessage?.(message));
  const transport = {
    send(msg) {
      const reply = (result) => deliver({ id: msg.id, sessionId: msg.sessionId, result });
      const event = (method, params, sessionId) => deliver({ method, params, sessionId });
      if (!msg.sessionId) {
        // 浏览器级：Playwright 问「你是什么浏览器」「有哪些标签页」
        if (msg.method === "Browser.getVersion") return reply({ protocolVersion: "1.3", product: "Chrome/Electron", userAgent: "", jsVersion: "" });
        if (msg.method === "Target.setAutoAttach") {
          // 告诉 Playwright：有一个标签页，会话号是 page-1
          event("Target.attachedToTarget", { sessionId: PAGE_SESSION, targetInfo: { ...targetInfo, attached: true, browserContextId: "default" }, waitingForDebugger: false });
          return reply({});
        }
        return reply({}); // 其他浏览器级命令（下载设置等）这里一律当成功
      }
      // 标签页级：原样转给网页（page-1 对应网页本身，其他会话号是 iframe 等，原样带上）
      dbg
        .sendCommand(msg.method, msg.params, msg.sessionId === PAGE_SESSION ? undefined : msg.sessionId)
        .then(reply, (err) => deliver({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: err.message } }));
    },
    close() {},
  };
  // 网页那边主动发来的事件（加载完成、控制台输出……）转回给 Playwright
  dbg.on("message", (_e, method, params, sessionId) => deliver({ method, params, sessionId: sessionId || PAGE_SESSION }));

  // ④ connectOverCDP：Playwright 接管这个已经打开的网页
  const browser = await chromium.connectOverCDP(transport);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));

  // ⑤ 下面这几步就是「AI」在操作。真实情况里，模型调用 Playwright MCP 的工具，
  //    工具内部执行的就是这些 Playwright 调用
  const step = (name) => console.log(`\n[AI] ${name}`);

  step("browser_navigate：打开演示页");
  await page.goto(PAGE);

  step("browser_snapshot：读页面结构（无障碍树，模型靠它知道页面上有什么）");
  console.log(await page.locator("body").ariaSnapshot());

  step("browser_type：在「搜索」框里输入");
  await page.getByRole("textbox", { name: "搜索" }).fill("Claude");

  step("browser_click：点「搜索」按钮");
  await page.getByRole("button", { name: "搜索" }).click();

  step("browser_snapshot：再读一次，看结果");
  console.log(await page.locator("body").ariaSnapshot());

  setTimeout(() => app.quit(), 3000); // 留 3 秒看窗口
});
