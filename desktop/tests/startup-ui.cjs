const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { _electron } = require("../../gateway/node_modules/playwright-core");

const desktop = path.resolve(__dirname, "..");
const executablePath = require("electron");

async function listen(server) {
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("startup restores an account without visiting login and shows login on failure", { timeout: 90_000 }, async (t) => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "claude-app-startup-"));
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-test" }] }));
  });
  const providerPort = await listen(provider);
  t.after(async () => {
    await new Promise((resolve) => provider.close(resolve));
    const resolved = fs.realpathSync(profile);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("claude-app-startup-")) throw new Error("Invalid startup test profile path");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const server = `http://127.0.0.1:${providerPort}`;
  const gatewayPort = await freePort();
  const clientPort = await freePort();
  const env = {
    ...process.env,
    DESKTOP_USER_DATA: profile,
    NEWAPI_URL: server,
    DESKTOP_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    DESKTOP_CLIENT_URL: `http://127.0.0.1:${clientPort}`,
  };
  async function launch(overrides = {}) {
    return _electron.launch({ executablePath, args: [desktop], env: { ...env, ...overrides }, timeout: 30_000 });
  }

  // Start with an empty profile, then create a fake encrypted account using Electron's real safeStorage.
  const first = await launch();
  try {
    const window = await first.firstWindow();
    await window.waitForURL(/^file:/);
    assert.match(window.url(), /login\.html/);
    await first.evaluate(({ app, safeStorage }, accountServer) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("System credential encryption is unavailable");
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const apiKey = safeStorage.encryptString("sk-startup-test").toString("base64");
      fs.writeFileSync(path.join(app.getPath("userData"), "account.json"), JSON.stringify({
        server: accountServer, userId: 42, username: "startup-test", displayName: "Startup Test",
        apiKey, refresh: null, models: ["claude-test"],
      }));
    }, server);
  } finally {
    await first.close();
  }

  const restored = await launch();
  try {
    const window = await restored.firstWindow();
    await window.waitForURL(`http://127.0.0.1:${clientPort}/`, { timeout: 45_000 });
    await window.waitForSelector(".app-shell .sidebar", { timeout: 30_000 });
    const history = await restored.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith("http://"));
      return window.webContents.navigationHistory.getAllEntries().map((entry) => entry.url);
    });
    assert.equal(history.some((url) => url.includes("login.html")), false, `Saved account visited login: ${history}`);
    assert.equal((await window.evaluate(() => window.desktop.account.info())).username, "startup-test");
  } finally {
    await restored.close();
  }

  // An occupied configured port makes the startup fail without touching the user's real services.
  const failed = await launch({ DESKTOP_GATEWAY_URL: server });
  try {
    const window = await failed.firstWindow();
    await window.waitForURL(/^file:/);
    assert.match(window.url(), /login\.html/);
    assert.match(await window.locator("#error").textContent(), /端口.*已被占用/);
  } finally {
    await failed.close();
  }
});
