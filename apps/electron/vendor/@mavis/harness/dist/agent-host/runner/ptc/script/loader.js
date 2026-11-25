// Runs inside the packaged QuickJS Worker, which is loaded from
// app.asar.unpacked: only node: builtins and type-only imports are allowed in
// this directory (see execution/ptc/contracts.ts). This is the first file read
// under runner/ptc/; the allowlist in ./allowlist.ts is what replaces the read
// permission check for these paths.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, win32 } from 'node:path';
import { realPathOf, scopeOf } from './allowlist.js';
import { PtcScriptLoadError, ptcScriptError, withDirectories } from './errors.js';
const ALLOWED_EXTENSIONS = new Set(['.mjs', '.js']);
/** Schemes the loader refuses before touching the disk. */
const REJECTED_SPECIFIER = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;
/**
 * A Windows drive-letter path, recognized before the scheme rule: `C:` and
 * `C:/` are file paths, not URI schemes. It is resolved with Windows rules on
 * every platform, so the answer does not depend on where the loader runs; off
 * Windows nothing can match such a path, and the allowlist refuses it as
 * missing instead of as a bad scheme.
 */
const WINDOWS_DRIVE_SPECIFIER = /^[A-Za-z]:[\\/]/u;
/**
 * A Windows UNC path (`\\\\server\\share\\…`). Refused outright rather than
 * resolved: it names a remote host, so following it would make the allowlist
 * depend on a network share the user never granted, and `realpath` on one can
 * block the Worker for as long as the host is unreachable.
 *
 * The forward-slash spelling (`//server/share/…`) names the same host: Windows
 * accepts it and `path.win32.resolve` turns it into `\\\\server\\share\\…`, so
 * both spellings are refused here, and the check runs again on the resolved
 * path in case a base directory was itself a UNC path.
 */
const WINDOWS_UNC_SPECIFIER = /^(?:\\\\|\/\/)/u;
/**
 * Resolves a specifier the way the proposal's table says: a relative path in
 * the program or in `run_code`'s `path` starts at the workspace root, a
 * relative path inside a module starts at that module's directory, `~/` starts
 * at the home directory and an absolute path is used as is.
 */
export function normalizePtcScriptSpecifier(base, requested, roots) {
    const specifier = requested.trim();
    if (!specifier)
        throw ptcScriptError('run_code script specifier is empty.', roots);
    // Before the scheme rule: a UNC path and a drive letter are file paths.
    refuseUnc(specifier, roots);
    if (WINDOWS_DRIVE_SPECIFIER.test(specifier))
        return refuseResolvedUnc(win32.resolve(specifier), roots);
    if (REJECTED_SPECIFIER.test(specifier)) {
        throw ptcScriptError(`run_code scripts cannot import ${specifier}; only file paths are supported.`, roots);
    }
    const fromHome = homeRelativePath(specifier, roots);
    if (fromHome !== undefined)
        return refuseResolvedUnc(fromHome, roots);
    if (isAbsolute(specifier))
        return refuseResolvedUnc(resolve(specifier), roots);
    if (isBareModuleName(specifier)) {
        throw ptcScriptError(`run_code scripts cannot import the bare module name ${specifier}; use a file path.`, roots);
    }
    // A module's own name is its absolute path; the program's is `run_code.js`.
    const baseDirectory = isAbsolute(base) ? dirname(base) : roots.workspaceDir;
    return refuseResolvedUnc(resolve(baseDirectory, specifier), roots);
}
/** A UNC specifier, in either spelling, never reaches the disk. */
function refuseUnc(specifier, roots) {
    if (!WINDOWS_UNC_SPECIFIER.test(specifier))
        return;
    throw uncError(specifier, roots);
}
/**
 * Resolution can still produce a UNC path when the base directory is one, so
 * the resolved path is checked again before it is handed to the allowlist.
 */
function refuseResolvedUnc(resolved, roots) {
    if (WINDOWS_UNC_SPECIFIER.test(resolved))
        throw uncError(resolved, roots);
    return resolved;
}
function uncError(specifier, roots) {
    return ptcScriptError(`run_code scripts cannot import the UNC path ${specifier}; only local file paths are supported.`, roots);
}
/** `~` and `~/…` resolved against the home directory, or undefined. */
function homeRelativePath(specifier, roots) {
    if (specifier === '~')
        return resolve(roots.homeDir);
    if (specifier.startsWith('~/') || specifier.startsWith('~\\')) {
        return resolve(roots.homeDir, specifier.slice(2));
    }
    return undefined;
}
/** No separator and no script extension: a package name, never a file path. */
function isBareModuleName(specifier) {
    if (specifier.includes('/') || specifier.includes('\\'))
        return false;
    return !ALLOWED_EXTENSIONS.has(extname(specifier).toLowerCase());
}
/**
 * Reads one script file after the three checks, in order: inside an allowed
 * directory (this also stops `../` and symlink escapes, because the path is
 * resolved first), `.mjs` or `.js`, and a regular file. Script length is not
 * one of them. Throws a plain Error, which QuickJS turns into a catchable
 * guest error.
 */
export function loadPtcScript(absolutePath, roots) {
    const realPath = realPathOf(absolutePath, roots);
    const scope = scopeOf(realPath, roots);
    if (!ALLOWED_EXTENSIONS.has(extname(realPath).toLowerCase())) {
        throw ptcScriptError(`run_code script must be a .mjs or .js file: ${absolutePath}`, roots);
    }
    const source = readScriptFile(realPath, absolutePath, roots);
    return {
        path: realPath,
        scope,
        sha256: createHash('sha256').update(source).digest('hex'),
        source,
    };
}
/**
 * Opens the file once and reads it whole from that descriptor, so the source
 * always comes from the file the checks accepted: reading by path again would
 * leave a window in which the target could be swapped after the checks.
 *
 * The `lstat` before the open and the `O_NONBLOCK` flag are what keep a FIFO
 * or a device from blocking the Worker forever: opening a FIFO for reading
 * waits for a writer, and this runs on the Worker's only thread. `O_NONBLOCK`
 * makes that open fail instead, and the `fstat` after it re-checks the opened
 * descriptor, so a regular file swapped in between the two calls is still
 * refused.
 */
function readScriptFile(realPath, absolutePath, roots) {
    let link;
    try {
        link = lstatSync(realPath);
    }
    catch {
        throw new PtcScriptLoadError('not_found', withDirectories(`run_code script was not found: ${absolutePath}`, roots));
    }
    if (!link.isFile()) {
        throw ptcScriptError(`run_code script is not a regular file: ${absolutePath}`, roots);
    }
    let handle;
    try {
        handle = openSync(realPath, constants.O_RDONLY | constants.O_NONBLOCK);
    }
    catch {
        throw new PtcScriptLoadError('not_found', withDirectories(`run_code script was not found: ${absolutePath}`, roots));
    }
    try {
        if (!fstatSync(handle).isFile()) {
            throw ptcScriptError(`run_code script is not a regular file: ${absolutePath}`, roots);
        }
        return readFileSync(handle, 'utf8');
    }
    finally {
        closeSync(handle);
    }
}
//# sourceMappingURL=loader.js.map