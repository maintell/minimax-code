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

// `dist/` survives an upgrade, and tsc only emits the files that still have a
// source. A module the shipped build dropped would otherwise stay in
// `dist/main` and be packaged into the installer, so every output file without
// a source counterpart is removed after the emit (the directory branch is
// pruned too, for outputs whose whole subtree is gone).
function pruneStaleOutput(outputRoot, sourceFor) {
  const staleDirectories = [];
  const visit = (relative) => {
    const outputDirectory = path.join(outputRoot, relative);
    let kept = 0;
    for (const entry of fs.readdirSync(outputDirectory, { withFileTypes: true })) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (visit(child)) kept += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      if (fs.existsSync(sourceFor(child))) {
        kept += 1;
        continue;
      }
      fs.unlinkSync(path.join(outputRoot, child));
      console.log(`[build] removed stale output ${path.join(outputRoot, child)}`);
    }
    if (kept === 0 && relative) staleDirectories.push(relative);
    return kept;
  };
  visit("");
  for (const relative of staleDirectories.sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(path.join(outputRoot, relative));
    } catch {
      // A concurrently written file keeps the directory; the next build retries.
    }
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
  // The emit is per-file: `main/foo.ts` becomes `dist/main/foo.js`, while the
  // prebuilt bundle is copied verbatim, so the source path is the `.ts` file or
  // the `.js` file itself.
  pruneStaleOutput(
    path.join(appDir, "dist", "main"),
    (relative) => [
      path.join(appDir, "main", relative.replace(/\.js$/u, ".ts")),
      path.join(appDir, "main", relative),
    ].find((candidate) => fs.existsSync(candidate)),
  );
  pruneStaleOutput(
    path.join(appDir, "dist", "model-menu"),
    (relative) => path.join(appDir, "model-menu", relative),
  );
  console.log("[build] dist/main and dist/model-menu are up to date");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
