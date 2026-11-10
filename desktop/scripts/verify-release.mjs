import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { once } from "node:events";

const desktop = path.resolve(import.meta.dirname, "..");
const resources = process.argv[2] ? path.resolve(process.argv[2]) : path.join(desktop, "build/resources");
const uiRoot = existsSync(path.join(resources, "app.asar")) ? path.join(resources, "app.asar") : path.join(desktop, "build/shell");
const runtime = path.join(resources, "runtime/node.exe");
assert.ok(existsSync(runtime), "Run prepare:release before verifying");
const sandbox = path.join(desktop, "build/smoke");
mkdirSync(sandbox, { recursive: true });
const portProbe = createServer();
portProbe.listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const provider = createHttpServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [{ id: "claude-release-test" }] }));
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const token = randomBytes(24).toString("hex");
const url = `http://127.0.0.1:${port}`;
const child = spawn(runtime, [path.join(resources, "gateway/dist/index.js")], {
  cwd: sandbox,
  env: {
    ...process.env, NODE_ENV: "production", DESKTOP_ACCOUNT_AUTH: "true", HOST: "127.0.0.1", PORT: String(port), API_TOKEN: token,
    STATIC_DIR: path.join(resources, "client"), LOG_PRETTY: "0", LOG_ENABLED: "0", LOG_LEVEL: "error",
    CLAUDE_CONFIG_DIR: path.join(sandbox, "claude-home"), WORKSPACE_DIR: sandbox, AGENT_DESKTOP_HOME: path.join(sandbox, "agent-desktop"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, ANTHROPIC_MODEL: "claude-release-test", ANTHROPIC_AUTH_TOKEN: "local-test-token",
  },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged gateway exited: ${output}`);
    try { ready = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Packaged gateway failed to start: ${output}`);
  const index = await fetch(url);
  assert.equal(index.status, 200);
  const html = await index.text();
  const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  assert.ok(script, "Built client must contain its entry script");
  assert.equal((await fetch(new URL(script, url))).status, 200);
  assert.equal((await fetch(`${url}/api/config`)).status, 401);
  assert.equal((await fetch(`${url}/config`)).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const config = await fetch(`${url}/api/config`, { headers });
  assert.equal(config.status, 200);
  assert.equal((await config.json()).model, "claude-release-test");
  const termResponse = await fetch(`${url}/api/terminals`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ cwd: sandbox }) });
  const term = await termResponse.json();
  assert.equal(termResponse.status, 200, `Bundled native terminal failed: ${JSON.stringify(term)}`);
  assert.equal((await fetch(`${url}/api/terminals/${term.terminal.id}`, { method: "DELETE", headers })).status, 200);

  const electron = path.join(desktop, "node_modules/electron/dist/electron.exe");
  const ui = spawn(electron, [path.join(desktop, "tests/login-ui.cjs")], {
    cwd: desktop,
    env: { ...process.env, RELEASE_UI_ROOT: uiRoot, RELEASE_GATEWAY_URL: url, RELEASE_GATEWAY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let uiOutput = "";
  ui.stdout.on("data", (chunk) => { uiOutput += chunk; });
  ui.stderr.on("data", (chunk) => { uiOutput += chunk; });
  const [code] = await once(ui, "exit");
  assert.equal(code, 0, `Protected login and renderer test failed: ${uiOutput}`);
  console.log(uiOutput.trim());
  const manifest = JSON.parse(readFileSync(path.join(desktop, "build/release-manifest.json"), "utf8"));
  assert.equal(manifest.sourceMaps, false);
  console.log(`Release verification passed: gateway, static assets, API authorization, native terminal, protected login and renderer (${Object.keys(manifest.files).length} files)`);
} finally {
  if (child.exitCode === null && child.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  provider.close();
}
