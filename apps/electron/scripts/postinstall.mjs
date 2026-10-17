// Ensure the Electron binary is present and the vendored dependency trees in
// node_modules match `vendor/**` exactly.
//
// pnpm may skip the electron dependency's own install script depending on the
// pnpm version, and its `file:` copy of a vendored package can stay stale when
// the vendor tree changes without a lockfile change (a package's `files` field
// also filters what gets copied). Both are repaired here, idempotently.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

const electronDist = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
const installer = path.join(appDir, "node_modules", "electron", "install.js");
if (!fs.existsSync(electronDist) && fs.existsSync(installer)) {
  console.log("[postinstall] fetching the Electron binary");
  execFileSync(process.execPath, [installer], {
    stdio: "inherit",
    cwd: path.join(appDir, "node_modules", "electron"),
  });
}

const vendorRoot = path.join(appDir, "vendor");
const modulesRoot = path.join(appDir, "node_modules");
let copied = 0;
let removed = 0;

function syncTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const names = new Set();
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    names.add(entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) fs.rmSync(dest, { force: true });
      syncTree(source, dest);
      continue;
    }
    const same =
      fs.existsSync(dest) &&
      fs.statSync(dest).isFile() &&
      fs.statSync(dest).size === fs.statSync(source).size;
    if (!same) {
      fs.copyFileSync(source, dest);
      copied += 1;
    }
  }
  if (fs.existsSync(to)) {
    for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
      if (names.has(entry.name)) continue;
      // Keep pnpm's nested dependency installs: only files/directories that
      // belong to the vendored package itself are pruned.
      if (entry.name === "node_modules") continue;
      fs.rmSync(path.join(to, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
}

function syncPackage(scopeDir, pkgName) {
  const from = path.join(vendorRoot, scopeDir, pkgName);
  const to = path.join(modulesRoot, scopeDir, pkgName);
  syncTree(from, to);
}

for (const entry of fs.readdirSync(vendorRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith("@")) {
    for (const pkg of fs.readdirSync(path.join(vendorRoot, entry.name), { withFileTypes: true })) {
      if (pkg.isDirectory()) syncPackage(entry.name, pkg.name);
    }
  } else {
    syncPackage("", entry.name);
  }
}

console.log(`[postinstall] vendor sync: ${copied} file(s) updated, ${removed} stale entry(ies) removed`);
