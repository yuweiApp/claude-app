const path = require("node:path");
const fs = require("node:fs");
const { devDependencies } = require("./package.json");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "club.shuyusen.claude",
  productName: "树屿森 SYS",
  electronVersion: devDependencies.electron,
  electronDist: path.join(__dirname, "node_modules/electron/dist"),
  directories: { app: "build/shell", output: "release" },
  asar: true,
  npmRebuild: false,
  files: ["dist/**", "login.html", "assets/**", "package.json", "!**/*.map", "!**/*.ts"],
  extraResources: [{ from: path.join(__dirname, "build/resources"), to: ".", filter: ["**/*", "!**/*.map", "!**/*.ts", "!**/.env*"] }],
  artifactName: "sys-claude-${version}-win-${arch}-setup.${ext}",
  win: { target: [{ target: "nsis", arch: ["x64"] }], icon: "assets/icon.png", signExecutable: false },
  afterPack: async ({ appOutDir }) => {
    const resources = path.join(appOutDir, "resources");
    fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
    const forbidden = (file) => /\.(?:map|ts|cts|mts|pdb|tsbuildinfo)$/i.test(file) || /^\.env(?:\.|$)/i.test(path.basename(file));
    const audit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) audit(file);
        else if (forbidden(file)) throw new Error(`安装包包含禁止的源码或调试文件：${file}`);
      }
    };
    audit(resources);
    const { listPackage } = await import("@electron/asar");
    for (const file of listPackage(path.join(resources, "app.asar"))) {
      if (forbidden(file)) throw new Error(`app.asar 包含禁止的源码或调试文件：${file}`);
    }
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
};
