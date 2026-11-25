import { constants as fsConstants } from 'node:fs';
import { mkdir, open, opendir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createExtensionDiagnostic } from '../sdk/diagnostics.js';
import { computePluginDirectoryDigest, isMiniMaxPluginName, materializeContentAddressedDirectory, PluginPackageContractError, } from '../../plugin-system/index.js';
const EXCLUDED_PREFIXES = ['.minimax-plugin/types', 'dist', 'node_modules'];
const EXCLUDED_FILES = new Set(['tsconfig.json']);
const LINK_CODES = new Set([
    'SYMLINK_NOT_ALLOWED',
    'HARDLINK_NOT_ALLOWED',
    'SPECIAL_ENTRY_NOT_ALLOWED',
]);
/**
 * Editor-only and host-written paths: they never enter the digest, the snapshot or an install,
 * so code may only `import type` from them.
 */
export function isDigestExcludedPath(relativePath) {
    if (EXCLUDED_FILES.has(relativePath))
        return true;
    return EXCLUDED_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}
/** Digest of a dev directory as its snapshot would have it; used to detect source changes. */
export async function computeExtensionSourceDigest(sourceDir) {
    const { contentDigest } = await computePluginDirectoryDigest(sourceDir, {
        rejectHardlinks: true,
        exclude: isDigestExcludedPath,
    });
    return contentDigest;
}
/**
 * preview ①: copies the dev directory into `<candidatesRoot>/<pluginId>/<cacheKey>/`. The copy
 * refuses symlinks, hardlinks and special files; the digest of the copy enforces the package
 * limits. The snapshot is content-addressed; an existing directory is reused only if its digest
 * still holds.
 */
export async function createExtensionCandidate(input) {
    const pluginRoot = path.join(input.candidatesRoot, pluginDirectoryName(input.pluginId));
    try {
        const files = [];
        const { root, contentDigest } = await materializeContentAddressedDirectory({
            parent: pluginRoot,
            stagingPrefix: '.staging-',
            digestOptions: { rejectHardlinks: true },
            populate: (staging) => copyTree(input.sourceDir, staging, '', files),
        });
        files.sort();
        return { ok: true, candidate: { root, digest: contentDigest, files } };
    }
    catch (error) {
        await removeIfEmpty(pluginRoot);
        return { ok: false, diagnostics: [candidateDiagnostic(error)] };
    }
}
/** A plugin id that passes the manifest name rule is a safe path segment as it is. */
export function pluginDirectoryName(pluginId) {
    if (!isMiniMaxPluginName(pluginId)) {
        throw new TypeError(`Invalid extension plugin id ${JSON.stringify(pluginId)}`);
    }
    return pluginId;
}
/** Removes candidate snapshots `<candidatesRoot>/<pluginId>/<cacheKey>`; best effort. */
export async function discardExtensionCandidates(candidatesRoot, roots) {
    const parent = path.resolve(candidatesRoot);
    for (const root of roots) {
        const pluginRoot = path.dirname(path.resolve(root));
        if (path.dirname(pluginRoot) !== parent)
            continue;
        try {
            await rm(root, { recursive: true, force: true });
        }
        catch {
            // Still open elsewhere (Windows); the next runtime start clears it.
        }
        await removeIfEmpty(pluginRoot);
    }
}
async function removeIfEmpty(directory) {
    try {
        await rmdir(directory);
    }
    catch {
        // Another snapshot of this plugin lives there.
    }
}
async function copyTree(sourceRoot, targetRoot, relativeDirectory, files) {
    const directory = path.join(sourceRoot, ...splitRelative(relativeDirectory));
    for await (const child of await opendir(directory)) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        if (isDigestExcludedPath(relativePath))
            continue;
        if (child.isSymbolicLink()) {
            throw new PluginPackageContractError('SYMLINK_NOT_ALLOWED', `${relativePath} is a symlink`);
        }
        if (child.isDirectory()) {
            await mkdir(path.join(targetRoot, ...splitRelative(relativePath)));
            await copyTree(sourceRoot, targetRoot, relativePath, files);
            continue;
        }
        if (!child.isFile()) {
            throw new PluginPackageContractError('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} is not a regular file`);
        }
        await writeFile(path.join(targetRoot, ...splitRelative(relativePath)), await readRegularFile(path.join(sourceRoot, ...splitRelative(relativePath)), relativePath));
        files.push(relativePath);
    }
}
async function readRegularFile(absolutePath, relativePath) {
    const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const info = await handle.stat();
        if (!info.isFile()) {
            throw new PluginPackageContractError('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} is not a regular file`);
        }
        if (info.nlink > 1) {
            throw new PluginPackageContractError('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
        }
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
function splitRelative(relativePath) {
    return relativePath ? relativePath.split('/') : [];
}
function candidateDiagnostic(error) {
    if (error instanceof PluginPackageContractError) {
        return createExtensionDiagnostic(LINK_CODES.has(error.code) ? 'EXTENSION_IMPORT_FORBIDDEN' : 'EXTENSION_COMPILE_FAILED', { detail: `${error.code}: ${error.detail}` });
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
        return createExtensionDiagnostic('HOOK_MODULES_INVALID', {
            detail: 'extension source directory not found',
        });
    }
    throw error;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=candidate.js.map