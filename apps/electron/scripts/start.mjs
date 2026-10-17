// Stage a runnable app root under dist/app and launch the local Electron.
//
// dist/app mirrors the packaged layout (package.json, .env.local, dist/,
// out/, resources/, node_modules) so the app boots the same way it does when
// installed. Heavy directories are linked with Windows junctions to avoid
// duplicating gigabytes of assets.
//
// Environment:
//   MMX_USER_DATA_DIR  optional --user-data-dir for an isolated profile
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const stage = path.join(appDir, "dist", "app");

function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, "junction");
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, dest);
    else fs.copyFileSync(source, dest);
  }
}

export function stageApp() {
  build();
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(path.join(appDir, "package.json"), path.join(stage, "package.json"));
  fs.copyFileSync(path.join(appDir, "env", "prod-zh.env"), path.join(stage, ".env.local"));
  copyTree(path.join(appDir, "dist", "main"), path.join(stage, "dist", "main"));
  copyTree(path.join(appDir, "dist", "model-menu"), path.join(stage, "dist", "model-menu"));
  link(path.join(appDir, "out"), path.join(stage, "out"));
  link(path.join(appDir, "resources"), path.join(stage, "resources"));
  link(path.join(appDir, "node_modules"), path.join(stage, "node_modules"));
  return stage;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stageDir = stageApp();
  const electronPath = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
  if (!fs.existsSync(electronPath)) {
    throw new Error("electron is not installed; run `pnpm install --ignore-workspace` first");
  }
  const args = [];
  if (process.env.MMX_USER_DATA_DIR) {
    args.push(`--user-data-dir=${path.resolve(process.env.MMX_USER_DATA_DIR)}`);
  }
  args.push(stageDir);
  console.log(`[start] launching ${electronPath} ${args.join(" ")}`);
  const child = spawn(electronPath, args, { stdio: "inherit", cwd: stageDir });
  child.on("exit", (code) => process.exit(code ?? 0));
}
