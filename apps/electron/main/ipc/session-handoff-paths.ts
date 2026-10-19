import { lstat, realpath, opendir } from "node:fs/promises";
import { isAbsolute, basename, resolve, relative, sep } from "node:path";
const MAX_SELECTED_ROOTS = 100;
const MAX_HANDOFF_FILES = 10000;
const MAX_VISITED_ENTRIES = 100000;
export async function inspectSessionHandoffPaths(value) {
    const input = parseInput(value);
    if (!input) {
        return { files: [], rejected: [{ path: '', reason: 'invalid_request' }] };
    }
    let workspaceRoot;
    try {
        if (!isAbsolute(input.workspaceDir))
            throw new Error('invalid_workspace');
        const workspaceMetadata = await lstat(input.workspaceDir);
        if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
            throw new Error('invalid_workspace');
        }
        workspaceRoot = await realpath(input.workspaceDir);
    }
    catch {
        return {
            files: [],
            rejected: [{ path: input.workspaceDir, reason: 'invalid_workspace' }],
        };
    }
    const filesByPhysicalPath = new Map();
    const rejected = [];
    let visitedEntries = 0;
    let fileLimitExceeded = false;
    const addFile = async (path, sourceRoot) => {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
            rejected.push({ path, reason: 'symbolic_link' });
            return true;
        }
        if (!metadata.isFile()) {
            rejected.push({ path, reason: 'not_regular_file' });
            return true;
        }
        const physicalPath = await realpath(path);
        if (!pathWithin(workspaceRoot, physicalPath)) {
            rejected.push({ path, reason: 'outside_workspace' });
            return true;
        }
        const relativePath = toSafeRelativePath(workspaceRoot, physicalPath);
        if (!relativePath) {
            rejected.push({ path, reason: 'unsafe_path' });
            return true;
        }
        if (filesByPhysicalPath.has(physicalPath))
            return true;
        if (filesByPhysicalPath.size >= MAX_HANDOFF_FILES) {
            rejected.push({ path, reason: 'too_many_files' });
            fileLimitExceeded = true;
            return false;
        }
        filesByPhysicalPath.set(physicalPath, {
            path: physicalPath,
            relativePath,
            name: basename(physicalPath),
            sizeBytes: metadata.size,
            sourceRoot,
        });
        return true;
    };
    for (const selectedRoot of input.paths) {
        if (fileLimitExceeded)
            break;
        const path = selectedRoot.trim();
        if (!path || !isAbsolute(path)) {
            rejected.push({ path: selectedRoot, reason: 'invalid_path' });
            continue;
        }
        try {
            const rootMetadata = await lstat(path);
            if (rootMetadata.isSymbolicLink()) {
                rejected.push({ path, reason: 'symbolic_link' });
                continue;
            }
            const physicalRoot = await realpath(path);
            if (!pathWithin(workspaceRoot, physicalRoot)) {
                rejected.push({ path, reason: 'outside_workspace' });
                continue;
            }
            if (rootMetadata.isFile()) {
                await addFile(physicalRoot, physicalRoot);
                continue;
            }
            if (!rootMetadata.isDirectory()) {
                rejected.push({ path, reason: 'not_regular_file' });
                continue;
            }
            const pending = [physicalRoot];
            while (pending.length > 0) {
                const directoryPath = pending.pop();
                if (!directoryPath)
                    break;
                const directory = await opendir(directoryPath);
                for await (const entry of directory) {
                    visitedEntries += 1;
                    if (visitedEntries > MAX_VISITED_ENTRIES) {
                        rejected.push({ path: physicalRoot, reason: 'directory_too_large' });
                        pending.length = 0;
                        break;
                    }
                    const entryPath = resolve(directoryPath, entry.name);
                    const entryMetadata = await lstat(entryPath);
                    if (entryMetadata.isSymbolicLink()) {
                        rejected.push({ path: entryPath, reason: 'symbolic_link' });
                        continue;
                    }
                    const physicalPath = await realpath(entryPath);
                    if (!pathWithin(workspaceRoot, physicalPath)) {
                        rejected.push({ path: entryPath, reason: 'outside_workspace' });
                        continue;
                    }
                    const relativePath = toSafeRelativePath(workspaceRoot, physicalPath);
                    if (!relativePath) {
                        rejected.push({ path: entryPath, reason: 'unsafe_path' });
                        continue;
                    }
                    if (entryMetadata.isDirectory()) {
                        pending.push(physicalPath);
                    }
                    else if (entryMetadata.isFile()) {
                        const shouldContinue = await addFile(physicalPath, physicalRoot);
                        if (!shouldContinue) {
                            pending.length = 0;
                            break;
                        }
                    }
                    else {
                        rejected.push({ path: entryPath, reason: 'not_regular_file' });
                    }
                }
            }
        }
        catch (error) {
            rejected.push({ path, reason: issueReasonForError(error) });
        }
    }
    return {
        files: [...filesByPhysicalPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
        rejected,
    };
}
function parseInput(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const candidate = value;
    if (typeof candidate.workspaceDir !== 'string' || !Array.isArray(candidate.paths)) {
        return undefined;
    }
    return {
        workspaceDir: candidate.workspaceDir,
        paths: candidate.paths
            .filter((item) => typeof item === 'string')
            .slice(0, MAX_SELECTED_ROOTS),
    };
}
function toSafeRelativePath(workspaceRoot, path) {
    const value = relative(workspaceRoot, path).split(sep).join('/');
    if (!value || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value))
        return undefined;
    const segments = value.split('/');
    if (segments.some((segment) => {
        const lower = segment.toLowerCase();
        return (segment === '' ||
            segment === '.' ||
            segment === '..' ||
            lower === '.git' ||
            lower === '.mavis');
    })) {
        return undefined;
    }
    return value;
}
function pathWithin(root, candidate) {
    const value = relative(resolve(root), resolve(candidate));
    return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function issueReasonForError(error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return 'not_found';
    return 'inspect_failed';
}
