import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
}
/**
 * Validate a backend-produced resource without following a symlink at any
 * path component.  `realpath` is used for the containment decision while the
 * lexical path is walked with `lstat` and opened with `O_NOFOLLOW`; together
 * these checks reject traversal, symlink aliases (including aliases which
 * point back inside the work directory), directories and special files.
 */
export async function validateArtifactPathWithinWorkDir(workDir, candidatePath, expectedSizeBytes) {
    if (!path.isAbsolute(workDir) || !path.isAbsolute(candidatePath))
        return null;
    if (expectedSizeBytes !== undefined &&
        (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0)) {
        return null;
    }
    const resolvedRoot = path.resolve(workDir);
    const resolvedCandidate = path.resolve(candidatePath);
    if (!isContained(resolvedRoot, resolvedCandidate))
        return null;
    try {
        const rootInfo = await lstat(resolvedRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
            return null;
        // Resolve the full path before opening it.  A symlink which points outside
        // is rejected by containment; a symlink which points inside is rejected by
        // the component walk below.
        const canonicalRoot = await realpath(resolvedRoot);
        const canonicalCandidate = await realpath(resolvedCandidate);
        if (!isContained(canonicalRoot, canonicalCandidate))
            return null;
        const relative = path.relative(resolvedRoot, resolvedCandidate);
        const components = relative.split(path.sep).filter(Boolean);
        if (components.length === 0)
            return null;
        let current = resolvedRoot;
        let finalInfo = null;
        for (const [index, component] of components.entries()) {
            current = path.join(current, component);
            const info = await lstat(current);
            if (info.isSymbolicLink())
                return null;
            if (index < components.length - 1) {
                if (!info.isDirectory())
                    return null;
            }
            else {
                if (!info.isFile())
                    return null;
                finalInfo = info;
            }
        }
        if (!finalInfo)
            return null;
        if (expectedSizeBytes !== undefined && finalInfo.size !== expectedSizeBytes)
            return null;
        let handle = null;
        try {
            handle = await open(resolvedCandidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() ||
                opened.isSymbolicLink() ||
                opened.dev !== BigInt(finalInfo.dev) ||
                opened.ino !== BigInt(finalInfo.ino) ||
                opened.size !== BigInt(finalInfo.size) ||
                (expectedSizeBytes !== undefined && opened.size !== BigInt(expectedSizeBytes))) {
                return null;
            }
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
        return { canonicalPath: canonicalCandidate, sizeBytes: finalInfo.size };
    }
    catch {
        return null;
    }
}
/**
 * Transform directories are created by `mkdtemp`; callers which supply a
 * directory directly (notably backend unit tests) still get the same
 * no-symlink boundary.
 */
export async function ensureRealWorkDir(workDir) {
    if (!path.isAbsolute(workDir))
        return null;
    const resolved = path.resolve(workDir);
    try {
        const info = await lstat(resolved);
        if (!info.isDirectory() || info.isSymbolicLink())
            return null;
        const canonical = await realpath(resolved);
        // `realpath` may normalize an OS-owned alias (for example macOS `/var`
        // to `/private/var`).  The final directory was already checked with
        // `lstat`; parent aliases are not backend-controlled symlinks and are
        // therefore safe to canonicalize here.
        return canonical;
    }
    catch {
        return null;
    }
}
