// Compile the Electron main process and assemble dist/.
//
// 1. main/**/*.ts  -> dist/main/**/*.js   (tsc, CommonJS, ES2022 — the same
//    emit shape the shipped build uses)
// 2. main/**/*.js  -> dist/main/**/*.js   (the prebuilt esbuild preload bundle)
// 3. model-menu/   -> dist/model-menu/    (prebuilt popup renderer)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

function copyTree(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, dest, filter);
    else if (entry.isFile() && filter(source)) fs.copyFileSync(source, dest);
  }
}

export function build() {
  const tsc = path.join(appDir, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) {
    throw new Error(
      "typescript is not installed; run `pnpm install --ignore-workspace` in apps/electron first",
    );
  }
  execFileSync(process.execPath, [tsc, "-p", path.join(appDir, "tsconfig.json"), "--noCheck"], {
    stdio: "inherit",
  });
  copyTree(
    path.join(appDir, "main"),
    path.join(appDir, "dist", "main"),
    (file) => file.endsWith(".js"),
  );
  copyTree(path.join(appDir, "model-menu"), path.join(appDir, "dist", "model-menu"));
  console.log("[build] dist/main and dist/model-menu are up to date");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
