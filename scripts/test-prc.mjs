import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `apps/prc` is deliberately outside the pnpm workspace: it has its own lockfile
// and is installed on its own, so its suite runs on its own too. The gateway
// executes TypeScript directly through Node's type stripping, so there is no
// build step between the sources and the test runner.
const prcDir = fileURLToPath(new URL("../apps/prc/", import.meta.url));

// `npm_execpath` may be a JavaScript entry point or a native package-manager
// binary depending on how pnpm was installed, so dispatch on what it actually is
// instead of assuming it can be passed to node.
function runPnpm(args) {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/u.test(execPath))
    return spawnSync(process.execPath, [execPath, ...args], {
      stdio: "inherit",
      cwd: prcDir,
    });
  return spawnSync(execPath ?? "pnpm", args, {
    stdio: "inherit",
    cwd: prcDir,
    shell: process.platform === "win32",
  });
}

// A cold checkout has no dependencies for the app. Keep the installer's own
// output on stdout so a failed install is diagnosable from the job log.
function exitCode(result) {
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (!existsSync(path.join(prcDir, "node_modules"))) {
  console.error("[test:prc] apps/prc has no node_modules; installing with pnpm");
  const installed = exitCode(runPnpm(["install", "--ignore-workspace"]));
  if (installed !== 0) {
    console.error(`[test:prc] pnpm install --ignore-workspace exited ${installed}`);
    process.exit(installed);
  }
}

// The glob is passed through verbatim: Node's test runner expands it itself, so
// the same command works in a POSIX shell and in cmd.exe.
const tested = spawnSync(process.execPath, ["--test", "test/*.test.ts"], {
  stdio: "inherit",
  cwd: prcDir,
});
process.exit(exitCode(tested));
