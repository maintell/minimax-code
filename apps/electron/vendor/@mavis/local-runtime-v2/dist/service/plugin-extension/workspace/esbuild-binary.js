import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { unpackedAsarPath } from '../../../infra/util/asar-unpacked-path.js';
const BINARY_PATH_ENV = 'ESBUILD_BINARY_PATH';
let loaded;
/**
 * Loads the native esbuild JS API. A packaged app keeps the platform binary in `app.asar.unpacked`
 * because `child_process.spawn` cannot execute from inside the archive; esbuild reads
 * `ESBUILD_BINARY_PATH` once at module init, so the override only exists while it is required and
 * child processes never inherit it.
 */
export function loadEsbuild() {
    if (loaded)
        return loaded;
    let binaryPath;
    try {
        const require = createRequire(import.meta.url);
        const main = require.resolve('esbuild');
        const resolved = resolvePlatformBinary(main);
        const unpacked = resolved === undefined ? undefined : unpackedAsarPath(resolved);
        binaryPath = process.env[BINARY_PATH_ENV] || unpacked || resolved;
        if (unpacked !== undefined && !existsSync(unpacked)) {
            return { ok: false, detail: `esbuild is unavailable: binary not found at ${unpacked}` };
        }
        const esbuild = withBinaryPathOverride(process.env, unpacked, () => require('esbuild'));
        loaded = { ok: true, esbuild, binaryPath };
        return loaded;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            detail: `esbuild is unavailable (binary: ${binaryPath ?? 'unresolved'}): ${reason}`,
        };
    }
}
/** Mirrors esbuild's own platform-package lookup, resolved from esbuild's install location. */
function resolvePlatformBinary(esbuildMain) {
    try {
        return createRequire(esbuildMain).resolve(esbuildBinarySpecifier());
    }
    catch {
        return undefined;
    }
}
/** @internal Exported for focused tests. */
export function esbuildBinarySpecifier(platform = process.platform, arch = process.arch) {
    return platform === 'win32'
        ? `@esbuild/win32-${arch}/esbuild.exe`
        : `@esbuild/${platform}-${arch}/bin/esbuild`;
}
/** @internal Sets the override only when it is not configured already, and restores it after. */
export function withBinaryPathOverride(env, binaryPath, load) {
    const previous = env[BINARY_PATH_ENV];
    if (binaryPath === undefined || previous)
        return load();
    env[BINARY_PATH_ENV] = binaryPath;
    try {
        return load();
    }
    finally {
        if (previous === undefined)
            delete env[BINARY_PATH_ENV];
        else
            env[BINARY_PATH_ENV] = previous;
    }
}
//# sourceMappingURL=esbuild-binary.js.map