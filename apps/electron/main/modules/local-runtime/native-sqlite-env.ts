import { spawnSync } from "node:child_process";
import { realpathSync, existsSync, rmSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import * as path from "node:path";
import logger from "../../utils/logger";
export function prepareLocalRuntimeNativeSqliteEnv(electronApp = getElectronApp()) {
    if (process.env.MAVIS_SQLITE3_MODULE_PATH?.trim())
        return;
    if (!electronApp || !shouldUseDevNativeSqlite({ kind: 'compiled' }, electronApp))
        return;
    const repoRoot = resolveLocalRuntimeRepoRoot(electronApp);
    if (!repoRoot)
        return;
    const nativeSqlite = ensureDevNativeBetterSqlite3(repoRoot, electronApp);
    if (!nativeSqlite)
        return;
    process.env.MAVIS_SQLITE3_MODULE_PATH = nativeSqlite.modulePath;
    process.env.NODE_PATH = nativeSqlite.nodePath;
}
export function resolveLocalRuntimeRepoRoot(electronApp) {
    const packageJsonPath = firstExisting(resolveLocalRuntimePackageJsonCandidates(electronApp));
    if (!packageJsonPath) {
        logger.error('[LocalRuntime] @mavis/local-runtime package not found for native sqlite');
        return undefined;
    }
    return resolveRuntimeRoot(path.dirname(realpathSync(packageJsonPath)));
}
export function shouldUseDevNativeSqlite(entryPoint, electronApp) {
    if (entryPoint.kind === 'typescript')
        return true;
    if (electronApp.isPackaged === false)
        return true;
    return !electronApp.getAppPath().includes('app.asar');
}
function resolveRuntimeRoot(packageDir) {
    return path.basename(path.dirname(packageDir)) === '@mavis'
        ? path.resolve(packageDir, '..', '..', '..')
        : path.resolve(packageDir, '..', '..');
}
function firstExisting(candidates) {
    return candidates.find((candidate) => existsSync(candidate));
}
function resolveLocalRuntimePackageJsonCandidates(electronApp) {
    const appPath = electronApp?.getAppPath();
    return uniqueNonEmpty([
        appPath ? path.join(appPath, 'node_modules', '@mavis', 'local-runtime', 'package.json') : '',
        appPath ? path.join(appPath, '..', '..', 'packages', 'local-runtime', 'package.json') : '',
        path.join(process.cwd(), 'node_modules', '@mavis', 'local-runtime', 'package.json'),
        path.join(process.cwd(), 'packages', 'local-runtime', 'package.json'),
        path.join(process.cwd(), '..', '..', 'packages', 'local-runtime', 'package.json'),
    ]);
}
function uniqueNonEmpty(values) {
    return [...new Set(values.filter(Boolean))];
}
function ensureDevNativeBetterSqlite3(repoRoot, electronApp) {
    const sourceModuleDir = path.join(repoRoot, 'node_modules', 'better-sqlite3');
    const sourcePkgPath = path.join(sourceModuleDir, 'package.json');
    if (!existsSync(sourcePkgPath)) {
        logger.error(`[LocalRuntime] better-sqlite3 package not found: ${sourcePkgPath}`);
        return undefined;
    }
    const sourcePkg = readPackageJson(sourcePkgPath);
    const electronVersion = process.versions.electron || 'unknown';
    const runtimeRoot = path.join(electronApp.getPath('userData'), 'native-modules', `better-sqlite3-${sourcePkg.version ?? 'unknown'}-electron-${electronVersion}`);
    const runtimeNodeModules = path.join(runtimeRoot, 'node_modules');
    const runtimeModuleDir = path.join(runtimeNodeModules, 'better-sqlite3');
    const runtimeBinary = path.join(runtimeModuleDir, 'build', 'Release', 'better_sqlite3.node');
    const runtimeMarker = path.join(runtimeRoot, '.minimax-electron-native.json');
    const runtimeDependencyNames = Object.keys(sourcePkg.dependencies ?? {});
    const runtimeDependenciesPresent = runtimeDependencyNames.every((dependencyName) => existsSync(path.join(resolveNodeModulesPackageDir(runtimeNodeModules, dependencyName), 'package.json')));
    const marker = readNativeModuleMarker(runtimeMarker);
    const markerMatches = marker?.electronVersion === electronVersion &&
        marker?.modules === process.versions.modules &&
        marker?.sourceVersion === sourcePkg.version &&
        runtimeDependenciesPresent;
    if (!existsSync(runtimeBinary) || !markerMatches) {
        const installBin = resolvePrebuildInstallBin(repoRoot);
        if (!installBin) {
            logger.error('[LocalRuntime] prebuild-install binary not found');
            return undefined;
        }
        logger.info(`[LocalRuntime] Preparing Electron-native better-sqlite3 in ${runtimeRoot}`);
        rmSync(runtimeRoot, { recursive: true, force: true });
        mkdirSync(runtimeNodeModules, { recursive: true });
        writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'mavis-electron-dev-native', private: true }, null, 2) + '\n');
        cpSync(sourceModuleDir, runtimeModuleDir, { recursive: true });
        copyNativeRuntimeDependencies(repoRoot, runtimeNodeModules, runtimeDependencyNames);
        const result = spawnSync(installBin, ['--runtime', 'electron', '--target', electronVersion, '--tag-prefix', 'v', '--force'], {
            cwd: runtimeModuleDir,
            windowsHide: true,
            shell: process.platform === 'win32',
            env: {
                ...process.env,
                PATH: buildRuntimePath(repoRoot),
            },
            encoding: 'utf-8',
        });
        if (result.status !== 0 || !existsSync(runtimeBinary)) {
            logger.error(`[LocalRuntime] Failed to prepare Electron-native better-sqlite3: ${result.stderr || result.stdout || 'unknown error'}`);
            return undefined;
        }
        logger.info(`[LocalRuntime] Electron-native better-sqlite3 ready: ${runtimeModuleDir}`);
        writeFileSync(runtimeMarker, JSON.stringify({
            electronVersion,
            modules: process.versions.modules,
            sourceVersion: sourcePkg.version ?? 'unknown',
            rebuiltAt: new Date().toISOString(),
        }, null, 2) + '\n');
    }
    return {
        modulePath: runtimeModuleDir,
        nodePath: buildNodePath([
            runtimeNodeModules,
            path.join(repoRoot, 'node_modules'),
            process.env.NODE_PATH,
        ]),
    };
}
function copyNativeRuntimeDependencies(repoRoot, runtimeNodeModules, dependencyNames) {
    const repoNodeModules = path.join(repoRoot, 'node_modules');
    const seen = new Set();
    for (const dependencyName of dependencyNames) {
        copyNativeRuntimeDependency(repoNodeModules, runtimeNodeModules, dependencyName, seen);
    }
}
function copyNativeRuntimeDependency(repoNodeModules, runtimeNodeModules, dependencyName, seen) {
    if (seen.has(dependencyName))
        return;
    seen.add(dependencyName);
    const sourceDir = resolveNodeModulesPackageDir(repoNodeModules, dependencyName);
    const targetDir = resolveNodeModulesPackageDir(runtimeNodeModules, dependencyName);
    const sourcePkgPath = path.join(sourceDir, 'package.json');
    if (!existsSync(sourcePkgPath)) {
        logger.warn(`[LocalRuntime] Native sqlite dependency missing: ${dependencyName}`);
        return;
    }
    mkdirSync(path.dirname(targetDir), { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true });
    const pkg = readPackageJson(sourcePkgPath);
    for (const transitiveName of Object.keys(pkg.dependencies ?? {})) {
        copyNativeRuntimeDependency(repoNodeModules, runtimeNodeModules, transitiveName, seen);
    }
}
function resolveNodeModulesPackageDir(nodeModulesDir, packageName) {
    return path.join(nodeModulesDir, ...packageName.split('/'));
}
function readPackageJson(packageJsonPath) {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
}
function readNativeModuleMarker(markerPath) {
    try {
        return JSON.parse(readFileSync(markerPath, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
function getElectronApp() {
    if (process.env.VITEST === 'true')
        return undefined;
    try {
        const electron = require('electron');
        return electron.app;
    }
    catch {
        return undefined;
    }
}
function resolvePrebuildInstallBin(repoRoot) {
    const candidate = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install');
    return existsSync(candidate) ? candidate : undefined;
}
function buildRuntimePath(repoRoot) {
    const parts = [
        path.join(repoRoot, 'node_modules', '.bin'),
        getUserShellPath(),
        process.env.PATH || '',
    ];
    const seen = new Set();
    const ordered = [];
    for (const part of parts) {
        for (const segment of part.split(path.delimiter)) {
            const value = segment.trim();
            if (value && !seen.has(value)) {
                seen.add(value);
                ordered.push(value);
            }
        }
    }
    return ordered.join(path.delimiter);
}
function buildNodePath(entries) {
    const seen = new Set();
    const ordered = [];
    for (const entry of entries) {
        if (!entry)
            continue;
        for (const segment of entry.split(path.delimiter)) {
            const value = segment.trim();
            if (value && !seen.has(value)) {
                seen.add(value);
                ordered.push(value);
            }
        }
    }
    return ordered.join(path.delimiter);
}
function getUserShellPath() {
    if (process.platform === 'win32')
        return process.env.PATH || '';
    try {
        const shell = process.env.SHELL || '/bin/zsh';
        return spawnSync(shell, ['-ilc', 'echo -n "$PATH"'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        }).stdout.trim();
    }
    catch {
        return '';
    }
}
