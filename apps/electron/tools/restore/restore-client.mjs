// Restore the desktop client tree from a locally installed MiniMax Code.
//
// Usage:
//   node restore-client.mjs --install-dir "<…>/MiniMax Code" \
//        --out-dir "<repo>/apps/electron" [--work-dir <scratch dir>]
//
// Pipeline (see README.md for the full description):
//   1. extract the shipped app.asar (package.json, .env.local, dist, out, public)
//   2. convert dist/main (per-file tsc CommonJS output) back to TypeScript
//   3. copy the prebuilt renderer/public/model-menu and the install resources
//   4. build the pruned vendor snapshots from the asar's node_modules
//   5. write the packaged environment lane (env/prod-zh.env)
//
// The script only reads from the installation and writes into --out-dir and
// --work-dir; it never touches the installed client.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const installDir = arg("install-dir");
const outDir = arg("out-dir");
const workDir = arg("work-dir", path.join(outDir, ".restore-work"));
if (!installDir || !outDir) {
  console.error("usage: node restore-client.mjs --install-dir <dir> --out-dir <dir> [--work-dir <dir>]");
  process.exit(1);
}

const asarPath = path.join(installDir, "resources", "app.asar");
const unpackedDir = `${asarPath}.unpacked`;
const installResources = path.join(installDir, "resources", "resources");
if (!fs.existsSync(asarPath)) throw new Error(`app.asar not found: ${asarPath}`);

fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// ---- 1. extract the archive -------------------------------------------------
const extracted = path.join(workDir, "asar");
if (!fs.existsSync(extracted)) {
  console.log("[restore] extracting app.asar");
  for (const entry of ["package.json", ".env.local", "dist", "out", "public"]) {
    execFileSync(process.execPath, [path.join(here, "asar-extract.mjs"), asarPath, extracted, entry], {
      stdio: "inherit",
    });
  }
}

// ---- 2. convert the main process back to TypeScript ------------------------
console.log("[restore] converting dist/main to TypeScript");
execFileSync(
  process.execPath,
  [path.join(here, "convert-main.mjs"), path.join(extracted, "dist", "main"), path.join(outDir, "main")],
  { stdio: "inherit" },
);

// ---- 3. copy prebuilt renderer, public assets, model menu, resources -------
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const nested = copyTree(source, dest);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      fs.copyFileSync(source, dest);
      files += 1;
      bytes += fs.statSync(source).size;
    }
  }
  return { files, bytes };
}

console.log("[restore] copying prebuilt assets and resources");
copyTree(path.join(extracted, "out"), path.join(outDir, "out"));
copyTree(path.join(extracted, "public"), path.join(outDir, "public"));
copyTree(path.join(extracted, "dist", "model-menu"), path.join(outDir, "model-menu"));
copyTree(installResources, path.join(outDir, "resources"));

// ---- 4. vendor snapshots ----------------------------------------------------
// Runtime files of every first-party/native package the client loads, pruned of
// development material, with manifests rewritten for local `file:` resolution.
const VENDOR_SCOPES = ["@mavis", "@earendil-works", "@trycua", "@ubjs", "@vscode", "@mariozechner", "@minimax"];
const VENDOR_TOP_LEVEL = ["better-sqlite3", "jszip", "node-pty", "node-screenshots-win32-x64-msvc"];
const PRUNE_DIRS = new Set([
  "src", "docs", "test", "tests", "__tests__", "coverage", "examples", "scripts",
  ".github", ".vscode", ".changeset", "benchmarks", "bench", ".yarn",
]);
const PRUNE_FILE =
  /(\.test\.|\.spec\.|\.md$|\.tsbuildinfo$|^tsconfig.*\.json$|^\.eslintrc|^\.npmignore$|^\.editorconfig$|^\.prettierrc|^CHANGELOG|^\.gitignore$|\.map$|^\.gitattributes$|^vitest\.config\.|^dependency-cruiser\.config\.|^eslint\.config\.|^jest\.config\.|^rollup\.config\.|^vite\.config\.|^\.mocharc|^ava\.config\.)/;

const vendorRoot = path.join(outDir, "vendor");
fs.mkdirSync(vendorRoot, { recursive: true });
const asarNodeModules = path.join(extracted, "node_modules");
if (!fs.existsSync(asarNodeModules)) {
  execFileSync(process.execPath, [path.join(here, "asar-extract.mjs"), asarPath, extracted, "node_modules"], {
    stdio: "inherit",
  });
}

function vendorPackage(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      files += vendorPackage(source, dest);
    } else if (entry.isFile()) {
      if (PRUNE_FILE.test(entry.name)) continue;
      fs.copyFileSync(source, dest);
      files += 1;
    }
  }
  return files;
}

const vendorNames = [];
for (const scope of VENDOR_SCOPES) {
  const scopeDir = path.join(asarNodeModules, scope);
  if (!fs.existsSync(scopeDir)) continue;
  for (const pkg of fs.readdirSync(scopeDir)) {
    if (fs.statSync(path.join(scopeDir, pkg)).isDirectory()) vendorNames.push(`${scope}/${pkg}`);
  }
}
for (const name of VENDOR_TOP_LEVEL) {
  if (fs.existsSync(path.join(asarNodeModules, name))) vendorNames.push(name);
}

function rewriteManifest(pkgDir, vendoredSet) {
  const manifestPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.types;
  // The vendor tree is the exact runtime file set; `files` would make package
  // managers filter the copy (better-sqlite3's `files` omits `build/`).
  delete manifest.files;
  delete manifest.publishConfig;
  delete manifest.resolutions;
  delete manifest.pnpm;
  delete manifest.repository;
  delete manifest.bugs;
  delete manifest.homepage;
  if (manifest.exports && typeof manifest.exports === "object") {
    for (const value of Object.values(manifest.exports)) {
      if (value && typeof value === "object") delete value.types;
    }
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[section];
    if (!deps) continue;
    for (const [depName, spec] of Object.entries(deps)) {
      const target = path.join(vendorRoot, depName);
      const local = `file:${path.relative(pkgDir, target).replace(/\\/g, "/")}`;
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        if (fs.existsSync(target)) deps[depName] = local;
        else delete deps[depName];
      } else if (vendoredSet.has(depName)) {
        deps[depName] = local;
      }
    }
    if (Object.keys(deps).length === 0) delete manifest[section];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return true;
}

console.log(`[restore] vendoring ${vendorNames.length} packages`);
const vendoredSet = new Set(vendorNames);
for (const name of vendorNames) {
  const from = path.join(asarNodeModules, name);
  const to = path.join(vendorRoot, name);
  vendorPackage(from, to);
  const overlay = path.join(unpackedDir, "node_modules", name);
  if (fs.existsSync(overlay)) vendorPackage(overlay, to);
  if (!rewriteManifest(to, vendoredSet)) {
    fs.rmSync(to, { recursive: true, force: true });
    console.log(`  skipped (no package.json): ${name}`);
  }
}

// ---- 5. environment lane ----------------------------------------------------
const envLane = path.join(outDir, "env", "prod-zh.env");
fs.mkdirSync(path.dirname(envLane), { recursive: true });
fs.copyFileSync(path.join(extracted, ".env.local"), envLane);
console.log(`[restore] wrote ${envLane}`);

console.log("[restore] done. Next: review the diff, then run `pnpm install --ignore-workspace`");
console.log("          and `pnpm build` inside the output directory.");
