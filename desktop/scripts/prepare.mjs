import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.dirname(desktop);
const build = path.join(desktop, "build");
const resources = path.join(build, "resources");
const shell = path.join(build, "shell");
const generated = [build, ...["desktop", "gateway", "client"].map((name) => path.join(root, name, "dist"))];
const npmCli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find((file) => file && existsSync(file));
if (!npmCli) throw new Error("找不到 npm CLI，请通过 npm run prepare:release 执行");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("当前打包脚本用于 Windows x64，请在 Windows x64 Node.js 下执行");
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("打包需要 Node.js 22 或更新版本");

function clean(directory) {
  if (!generated.includes(path.resolve(directory))) throw new Error(`拒绝清理非构建目录：${directory}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

function npm(args, cwd) {
  console.log(`> npm ${args.join(" ")} (${path.relative(root, cwd)})`);
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} 失败（${result.status}）`);
}

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

const stripMap = (source) => source.replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, "").replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, "");
function protect(source, target) {
  return JavaScriptObfuscator.obfuscate(stripMap(source), {
    target,
    compact: true,
    sourceMap: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    renameProperties: false,
    stringArray: true,
    stringArrayEncoding: ["rc4"],
    stringArrayThreshold: 0.8,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    selfDefending: false,
    disableConsoleOutput: false,
    // 不改动态 REPL、Electron 接口和模块导出的名称。
    reservedNames: ["^__", "^exports$", "^module$", "^require$"],
  }).getObfuscatedCode();
}

function protectTree(directory, target) {
  let count = 0;
  for (const file of files(directory)) {
    if (/\.(?:c?js|mjs)$/.test(file)) {
      writeFileSync(file, protect(readFileSync(file, "utf8"), target), "utf8");
      count++;
      if (count % 10 === 0) console.log(`  已保护 ${path.relative(build, directory)} 的 ${count} 个脚本`);
    } else if (file.endsWith(".html")) {
      const html = readFileSync(file, "utf8").replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attributes, source) => {
        if (!source.trim() || /\bsrc\s*=|\btype\s*=\s*["']application\//i.test(attributes)) return tag;
        return `<script${attributes}>${protect(source, "browser-no-eval").replace(/<\/script/gi, "<\\/script")}</script>`;
      });
      writeFileSync(file, html, "utf8");
    }
  }
  console.log(`  ${path.relative(build, directory)}：${count} 个脚本已混淆，字符串使用 RC4 编码`);
}

function copyRuntime(source, destination) {
  cpSync(source, destination, { recursive: true, filter: (file) => {
    const name = path.basename(file);
    return !/\.(?:map|ts|cts|mts|pdb|tsbuildinfo)$/i.test(name) && !/^\.env(?:\.|$)/i.test(name) && ![".git", ".cache", "test", "tests", "__tests__"].includes(name);
  } });
}

clean(build);
for (const name of ["client", "gateway", "desktop"]) {
  const directory = path.join(root, name);
  if (!existsSync(path.join(directory, "node_modules"))) npm(["ci", "--no-audit", "--no-fund"], directory);
  clean(path.join(directory, "dist"));
  npm(["run", "build"], directory);
}

const metadata = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
mkdirSync(shell, { recursive: true });
copyRuntime(path.join(desktop, "dist"), path.join(shell, "dist"));
cpSync(path.join(desktop, "login.html"), path.join(shell, "login.html"));
cpSync(path.join(desktop, "assets"), path.join(shell, "assets"), { recursive: true });
writeFileSync(path.join(shell, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version, type: "module", main: "dist/main.js", description: metadata.description, author: "树屿森", private: true }, null, 2));
protectTree(shell, "node");

const client = path.join(resources, "client");
copyRuntime(path.join(root, "client", "dist"), client);
protectTree(client, "browser-no-eval");

const gateway = path.join(resources, "gateway");
copyRuntime(path.join(root, "gateway", "dist"), path.join(gateway, "dist"));
// 示例脚本不属于运行时。
rmSync(path.join(gateway, "dist", "example"), { recursive: true, force: true });
protectTree(path.join(gateway, "dist"), "node");
for (const name of ["package.json", "package-lock.json", "config.yml"]) cpSync(path.join(root, "gateway", name), path.join(gateway, name));
npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], gateway);
// 只保留运行依赖；第三方库不做混淆，保留许可证，清除调试映射与类型源码。
for (const file of files(path.join(gateway, "node_modules"))) {
  if (/\.(?:map|ts|cts|mts|pdb|tsbuildinfo)$/i.test(file) || /^\.env(?:\.|$)/i.test(path.basename(file))) rmSync(file);
  else if (/\.(?:c?js|mjs)$/.test(file)) {
    const source = readFileSync(file, "utf8");
    const stripped = stripMap(source);
    if (source !== stripped) writeFileSync(file, stripped, "utf8");
  }
}
rmSync(path.join(gateway, "package-lock.json"));

const runtime = path.join(resources, "runtime");
mkdirSync(runtime, { recursive: true });
cpSync(process.execPath, path.join(runtime, "node.exe"));
const license = ["LICENSE", "LICENSE.txt"].map((name) => path.join(path.dirname(process.execPath), name)).find(existsSync);
if (license) cpSync(license, path.join(runtime, "NODE-LICENSE.txt"));
else {
  const response = await fetch(`https://nodejs.org/dist/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("未能取得随包 Node.js 的许可证");
  writeFileSync(path.join(runtime, "NODE-LICENSE.txt"), await response.text(), "utf8");
}

// 发布前再次拒绝源码、sourcemap、环境文件；清单记录每个文件的摘要，便于复核。
const manifest = { version: metadata.version, platform: process.platform, arch: process.arch, node: process.versions.node, protection: "javascript-obfuscator + RC4 string encoding", sourceMaps: false, files: {} };
for (const directory of [shell, resources]) {
  for (const file of files(directory)) {
    if (/\.(?:map|ts|cts|mts|pdb|tsbuildinfo)$/i.test(file) || /^\.env(?:\.|$)/i.test(path.basename(file))) throw new Error(`发布目录包含禁止文件：${file}`);
    const data = readFileSync(file);
    if (/\.(?:c?js|mjs|html|css)$/.test(file) && /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=/.test(data.toString("utf8"))) throw new Error(`发布脚本仍包含 sourcemap 引用：${file}`);
    manifest.files[path.relative(build, file).replaceAll("\\", "/")] = { size: statSync(file).size, sha256: createHash("sha256").update(data).digest("hex") };
  }
}
writeFileSync(path.join(build, "release-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(`发布资源准备完成：${build}（${Object.keys(manifest.files).length} 个文件，无 sourcemap / 项目源码 / .env）`);
