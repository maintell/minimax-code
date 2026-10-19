// Build and package the Windows desktop client with electron-builder.
//
// Output:
//   dist/installers/win-unpacked/       portable app directory
//   dist/installers/MiniMax Code Setup <version>.exe   NSIS installer
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));

function electronBuilderCli() {
  const candidates = [
    path.join(appDir, "node_modules", "electron-builder", "cli.js"),
    path.join(appDir, "node_modules", "electron-builder", "out", "cli", "cli.js"),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("electron-builder is not installed; run `pnpm install --ignore-workspace` first");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
  const args = [
    electronBuilderCli(),
    "--config",
    path.join(appDir, "electron-builder.yml"),
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never",
  ];
  console.log(`[package] electron-builder ${args.slice(1).join(" ")}`);
  // The packaged environment file: written for the run, removed afterwards so
  // the repository never carries a `.env*` file.
  const envLocal = path.join(appDir, ".env.local");
  fs.copyFileSync(path.join(appDir, "env", "prod-zh.env"), envLocal);
  try {
    execFileSync(process.execPath, args, { stdio: "inherit", cwd: appDir });
  } finally {
    fs.rmSync(envLocal, { force: true });
  }
  console.log(`[package] artifacts in ${path.join(appDir, "dist", "installers")}`);
}
