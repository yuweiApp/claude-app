// 内置浏览器标签页的预加载脚本（views.ts 的 setupSession 给标签页的会话登记，每个框架都跑，iframe 也跑）。
// 沙箱里的预加载脚本只能是 CommonJS，所以是 .cts。
//
// 通行密钥的「自动填充」请求（navigator.credentials.get 带 mediation: "conditional"）：Chrome 把它放进输入框的
// 自动填充下拉里，不弹窗；Electron 没有这个界面，Windows 上请求一发出就弹系统的「使用通行密钥登录」对话框。
// 苹果等网站的登录页一打开就发这个请求，重启后恢复的标签页（哪怕在后台）每次启动都会弹。
// 这里在网页自己的脚本之前改掉：报告不支持自动填充，带 conditional 的请求一直等着（网页取消时按取消结束），
// 和 Chrome 里没有可用通行密钥时一样。用户在网页上点「用通行密钥登录」发的是普通请求，照常弹系统对话框。
import electron = require("electron");

electron.contextBridge.executeInMainWorld({
  func: () => {
    // 这个函数会被序列化后在网页的环境里执行，不能用外面的变量；预加载脚本没有 DOM 的类型声明
    const w = globalThis as any;
    const PKC = w.PublicKeyCredential;
    const Container = w.CredentialsContainer;
    if (!PKC || !Container) return;
    const define = (target: object, name: string, value: unknown) =>
      Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });

    define(PKC, "isConditionalMediationAvailable", function isConditionalMediationAvailable() {
      return Promise.resolve(false);
    });
    const getClientCapabilities = PKC.getClientCapabilities;
    if (typeof getClientCapabilities === "function") {
      define(PKC, "getClientCapabilities", function getClientCapabilities_(this: unknown) {
        return Promise.resolve(getClientCapabilities.call(this)).then((caps: Record<string, boolean>) => ({ ...caps, conditionalGet: false }));
      });
    }
    const get = Container.prototype.get;
    define(Container.prototype, "get", function get_(this: unknown, options?: { mediation?: string; publicKey?: unknown; signal?: any }) {
      if (options?.mediation !== "conditional" || !options.publicKey) return get.call(this, options);
      return new Promise((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
  },
});
