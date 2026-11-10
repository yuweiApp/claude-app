import assert from "node:assert/strict";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(desktop, "build/resources/gateway/package.json"));
const { _electron } = require("playwright-core");
const profile = path.join(desktop, "build/smoke-app");
mkdirSync(profile, { recursive: true });
const executablePath = path.join(desktop, "release/win-unpacked/树屿森 SYS.exe");
const application = await _electron.launch({
  executablePath,
  env: { ...process.env, DESKTOP_USER_DATA: profile },
  timeout: 30_000,
});
try {
  const window = await application.firstWindow({ timeout: 15_000 });
  await window.waitForFunction(() => document.getElementById("form")?.onsubmit != null);
  const state = await window.evaluate(async () => ({
    title: document.title,
    hasLogin: typeof window.desktop?.account?.login === "function",
    account: await window.desktop.account.info(),
  }));
  assert.equal(state.hasLogin, true);
  assert.equal(state.account, null);
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  console.log("Packaged executable verification passed: production main process, ASAR preload, login form and account IPC");
} finally {
  await application.close();
}

if (process.argv.includes("--installer")) {
  const { version } = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
  const installer = path.join(desktop, `release/sys-claude-${version}-win-x64-setup.exe`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  writeFileSync(`${installer}.sha256`, `${hash.digest("hex")}  ${path.basename(installer)}\n`, "utf8");
  console.log(`Installer checksum saved: ${installer}.sha256`);
}
