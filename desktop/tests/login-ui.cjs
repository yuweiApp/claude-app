// Run with Electron after `npm run build`. Uses fake credentials and a local IPC stub.
const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

app.setPath("userData", path.join(app.getPath("temp"), `claude-login-ui-${process.pid}`));
const timeout = setTimeout(() => { console.error("Login UI test timed out"); app.exit(1); }, 20_000);
let loginCalls = 0;
const uiRoot = process.env.RELEASE_UI_ROOT || path.resolve(__dirname, "..");
ipcMain.handle("account:gateway-token", () => process.env.RELEASE_GATEWAY_TOKEN || null);
ipcMain.handle("account:info", () => ({ userId: 1, username: "release-test", displayName: "Release Test" }));
ipcMain.handle("window:is-maximized", () => false);
ipcMain.handle("account:login", async (_event, body) => {
  loginCalls++;
  assert.equal(body.username, "test-user");
  assert.equal(body.password, "test-password");
  return { error: "Test login error" };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(uiRoot, "dist/preload.cjs") } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  try {
    await win.loadFile(path.join(uiRoot, "login.html"));
    const initial = await win.webContents.executeJavaScript(`({
      hasBridge: !!window.desktop?.account?.login,
      hasHandler: typeof document.getElementById('form').onsubmit === 'function',
      bridgeDescriptor: Object.getOwnPropertyDescriptor(window, 'desktop')?.configurable,
    })`);
    console.log(JSON.stringify({ initial, errors }));
    assert.equal(initial.hasBridge, true, "Electron preload must expose the account bridge");
    assert.equal(initial.hasHandler, true, "Login form must install its submit handler");
    await win.webContents.executeJavaScript(`document.getElementById('username').value = 'test-user'; document.getElementById('password').value = 'test-password'; document.getElementById('form').requestSubmit();`);
    let rendered;
    for (let attempt = 0; attempt < 50; attempt++) {
      rendered = await win.webContents.executeJavaScript(`({ error: document.getElementById('error').textContent, disabled: document.getElementById('submit').disabled })`);
      if (rendered.error) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(loginCalls, 1, "One form submission must invoke account login once");
    assert.equal(rendered.error, "Test login error");
    assert.equal(rendered.disabled, false, "Failed login must allow retry");
    if (process.env.RELEASE_GATEWAY_URL) {
      await win.loadURL(process.env.RELEASE_GATEWAY_URL);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await win.webContents.executeJavaScript(`!!document.querySelector('.app-shell .sidebar')`);
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(ready, true, "Protected renderer must mount and fetch authenticated gateway config");
      assert.deepEqual(errors, [], "Protected UI must not produce JavaScript errors");
    }
    console.log("Login UI integration passed");
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(JSON.stringify(errors));
    app.exit(1);
  }
}).catch((error) => { console.error(error); app.exit(1); });
